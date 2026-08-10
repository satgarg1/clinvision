-- ============================================================
-- Qlinic — migration 011: let reception (and doctors themselves)
-- update a doctor's live status, without granting the doctor-roster
-- write access that's meant to stay admin-only.
--
-- Why: 003_staff_roles.sql made every write to public.doctors
-- admin-only, including changing status/delay/note. That's too broad:
-- clearing an "Emergency" status or flagging "Running late" needs to
-- happen all day, by whoever's at the desk, and an admin isn't always
-- available. The roster itself (name, specialty, active flag) should
-- stay admin-only; this migration keeps that split.
--
-- RLS alone can approve or reject a row, but can't see which columns
-- an UPDATE is actually changing, so a plain "reception can update
-- doctors" policy would also let reception rename a doctor or
-- deactivate them. The trigger below closes that gap: a non-admin
-- update is only allowed through if every roster field (name,
-- specialty, active flag, clinic) is unchanged.
--
-- Run this once in the Supabase SQL Editor, after 003_staff_roles.sql.
-- ============================================================

-- Additive to (not a replacement for) the existing admin-only update
-- policy from 003_staff_roles.sql — Postgres RLS policies are OR'd
-- together, so admins keep full roster access via that policy, and
-- reception/doctor roles get this narrower one.
create policy "staff update doctor status" on public.doctors
  for update using (clinic_id = public.my_clinic_id() and public.my_role() in ('reception', 'doctor'))
  with check (clinic_id = public.my_clinic_id() and public.my_role() in ('reception', 'doctor'));

create or replace function public.restrict_doctor_roster_edits()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.my_role() = 'admin' then
    return new;
  end if;
  if new.name is distinct from old.name
     or new.specialty is distinct from old.specialty
     or new.is_active is distinct from old.is_active
     or new.clinic_id is distinct from old.clinic_id then
    raise exception 'Only a clinic admin can edit the doctor roster.';
  end if;
  return new;
end;
$$;

drop trigger if exists doctors_restrict_roster_edits on public.doctors;
create trigger doctors_restrict_roster_edits
  before update on public.doctors
  for each row execute function public.restrict_doctor_roster_edits();
