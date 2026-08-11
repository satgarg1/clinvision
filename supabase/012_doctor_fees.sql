-- ============================================================
-- Qlinic — migration 012: per-doctor consultation fees.
--
-- Why: every doctor in a clinic can charge a different fee, and it's
-- set by the admin, not typed in by reception each visit. Storing it
-- on the doctor row means it's there in the backend once billing is
-- built, so reception can just pick the doctor and print the bill.
--
-- fee_normal / fee_emergency are plain amounts (whatever currency the
-- clinic uses), not tied to any tier or currency table — that keeps
-- this simple and matches how clinics actually set fees.
--
-- Run this once in the Supabase SQL Editor, after 011_reception_can_update_doctor_status.sql.
-- ============================================================

alter table public.doctors
  add column if not exists fee_normal numeric(10, 2) not null default 0,
  add column if not exists fee_emergency numeric(10, 2) not null default 0;

-- Fees are roster data (admin-set), same as name/specialty/active flag,
-- so the existing roster-edit guard from 011 needs to protect them too,
-- otherwise reception/doctor could change fees via the "staff update
-- doctor status" policy from that same migration.
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
     or new.clinic_id is distinct from old.clinic_id
     or new.fee_normal is distinct from old.fee_normal
     or new.fee_emergency is distinct from old.fee_emergency then
    raise exception 'Only a clinic admin can edit the doctor roster.';
  end if;
  return new;
end;
$$;
