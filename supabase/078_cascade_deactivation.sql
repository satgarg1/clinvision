-- ============================================================
-- Cascade doctor <-> staff-login deactivation.
--
-- Until now, doctors.is_active (the roster entry: shows up in
-- Reception's picker, Doctor View, the display board) and
-- profiles.is_active (the actual login: gates every RLS check via
-- my_clinic_id()/my_role()/my_doctor_id(), see 003_staff_roles.sql and
-- 032_profile_doctor_link.sql) were two completely independent flags.
-- An admin deactivating a doctor's roster entry believed that fully
-- removed them; their linked staff login, if they had one, kept working
-- end to end, since no RLS check anywhere keys off doctors.is_active.
--
-- These two RPCs replace the raw table updates the client used to make
-- directly, and flip both sides atomically: deactivating (or
-- reactivating) either the doctor roster entry or the linked staff
-- login now does both at once, for the same real person.
--
-- Run this once in the Supabase SQL Editor, after 032_profile_doctor_link.sql.
-- ============================================================

create or replace function public.set_doctor_active_cascade(target_doctor_id uuid, new_active boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.my_role() <> 'admin' then
    raise exception 'Only a clinic admin can change a doctor''s status.';
  end if;

  update public.doctors
  set is_active = new_active
  where id = target_doctor_id and clinic_id = public.my_clinic_id();

  -- Same person's login, if they have one linked, moves with them.
  update public.profiles
  set is_active = new_active
  where doctor_id = target_doctor_id and clinic_id = public.my_clinic_id();
end;
$$;

grant execute on function public.set_doctor_active_cascade(uuid, boolean) to authenticated;

create or replace function public.set_staff_active_cascade(target_profile_id uuid, new_active boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  linked_doctor uuid;
begin
  if public.my_role() <> 'admin' then
    raise exception 'Only a clinic admin can change a staff member''s status.';
  end if;

  select doctor_id into linked_doctor
  from public.profiles
  where id = target_profile_id and clinic_id = public.my_clinic_id();

  update public.profiles
  set is_active = new_active
  where id = target_profile_id and clinic_id = public.my_clinic_id();

  -- If this login belongs to a doctor, their roster entry moves with them
  -- too, so Reception/Doctor View/the display board stay in sync with
  -- whether this person can actually log in.
  if linked_doctor is not null then
    update public.doctors
    set is_active = new_active
    where id = linked_doctor and clinic_id = public.my_clinic_id();
  end if;
end;
$$;

grant execute on function public.set_staff_active_cascade(uuid, boolean) to authenticated;
