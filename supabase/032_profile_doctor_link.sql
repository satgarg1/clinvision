-- ============================================================
-- Qlinic — migration 032: link a doctor-role login to a specific
-- doctors row.
--
-- Why: role='doctor' on profiles has always just meant "this login
-- gets the doctor role" — nothing has ever said WHICH doctor. That's
-- fine while a doctor's own view (doctor.html) always lets them pick
-- any doctor from a dropdown, but it blocks ever giving a doctor a
-- dashboard scoped to just their own patients, or letting them manage
-- their own holidays, since there'd be no way to know whose data to
-- scope to. This adds that link, with server-side validation so it
-- can't drift into an inconsistent state no matter which of the two
-- write paths (create_staff_profile, or Team's per-row doctor-link
-- select via a direct table update) is used.
--
-- Run this once in the Supabase SQL Editor, after 029_priority_and_unified_ordering.sql.
-- ============================================================

alter table public.profiles add column if not exists doctor_id uuid references public.doctors(id) on delete set null;

-- One login per doctor: two logins both claiming to be the same doctor
-- would show identical dashboard/holiday data under two different
-- identities, which reads as a bug, not a feature.
create unique index if not exists profiles_doctor_id_unique on public.profiles (doctor_id) where doctor_id is not null;

-- Neither write path to profiles.doctor_id (create_staff_profile below,
-- or the direct table update Team's per-row picker uses) has its own
-- full validation, so this is the single point both funnel through:
-- a non-doctor role can never carry a doctor_id (demoting a doctor via
-- the existing role select auto-unlinks them, no extra client code
-- needed), and a non-null doctor_id must belong to the same clinic as
-- the profile.
create or replace function public.validate_profile_doctor_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role <> 'doctor' then
    new.doctor_id := null;
  elsif new.doctor_id is not null then
    if not exists (select 1 from public.doctors where id = new.doctor_id and clinic_id = new.clinic_id) then
      raise exception 'Linked doctor must be on this clinic''s own roster.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_validate_doctor_id on public.profiles;
create trigger profiles_validate_doctor_id
  before insert or update on public.profiles
  for each row execute function public.validate_profile_doctor_id();

-- Internal RLS helper only (not granted to the client directly),
-- mirroring my_clinic_id()/my_role() (003_staff_roles.sql) — the
-- logged-in user's own linked doctor, or null if they aren't a doctor
-- or aren't linked yet.
create or replace function public.my_doctor_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select doctor_id from public.profiles where id = auth.uid() and is_active = true;
$$;

-- create_staff_profile gains an optional 5th param. Postgres treats a
-- different arity as a distinct function, not a replacement, so the
-- 4-arg version must be dropped explicitly before redefining.
drop function if exists public.create_staff_profile(uuid, text, text, text);

create or replace function public.create_staff_profile(
  new_user_id uuid, staff_email text, staff_full_name text, staff_role text, staff_doctor_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_clinic_id uuid;
begin
  if public.my_role() <> 'admin' then
    raise exception 'Only a clinic admin can add staff.';
  end if;
  caller_clinic_id := public.my_clinic_id();

  if staff_role not in ('admin', 'reception', 'doctor') then
    raise exception 'Invalid role.';
  end if;

  if exists (select 1 from public.profiles where id = new_user_id) then
    raise exception 'That account is already linked to a clinic.';
  end if;

  if staff_role <> 'doctor' then
    staff_doctor_id := null;
  elsif staff_doctor_id is not null and not exists (
    select 1 from public.doctors where id = staff_doctor_id and clinic_id = caller_clinic_id
  ) then
    raise exception 'That doctor is not on this clinic''s roster.';
  end if;

  insert into public.profiles (id, clinic_id, email, full_name, role, doctor_id)
  values (new_user_id, caller_clinic_id, staff_email, staff_full_name, staff_role, staff_doctor_id);
end;
$$;

grant execute on function public.create_staff_profile(uuid, text, text, text, uuid) to authenticated;
