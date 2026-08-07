-- ============================================================
-- Staff accounts with roles.
--
-- Until now, every clinic had exactly one login (the admin who signed
-- up). This adds:
--   - a soft "is_active" flag on profiles, so an admin can revoke a staff
--     member's access without deleting their auth account or history
--   - a denormalized "email" column on profiles (Supabase Auth's own
--     auth.users table isn't reachable through the client, so without
--     this an admin's Team list couldn't show who's who)
--   - role-based write restrictions: only an active admin can change
--     clinic settings, manage the doctor roster, or manage other staff.
--     Reception/doctor roles keep the read access they need for their
--     own queue screens.
--   - create_staff_profile(): lets an admin link a staff member's
--     already-created auth account (created via a temporary, isolated
--     Supabase client on the admin's own device, so the admin's own
--     session is never disturbed) into their clinic with a chosen role.
--
-- Run this once in the Supabase SQL Editor, after schema.sql and
-- 002_doctor_active_flag.sql.
-- ============================================================

alter table public.profiles add column is_active boolean not null default true;
alter table public.profiles add column email text not null default '';

update public.profiles p
set email = u.email
from auth.users u
where p.id = u.id and p.email = '';

-- my_clinic_id() must also require is_active, so a deactivated staff
-- member's session loses clinic access immediately, not just visibility.
create or replace function public.my_clinic_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select clinic_id from public.profiles where id = auth.uid() and is_active = true;
$$;

-- Internal helper for RLS policies only (not granted to the client) —
-- which role the current user holds in their own clinic, or null if
-- they have no active profile.
create or replace function public.my_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid() and is_active = true;
$$;

-- Tighten writes that were previously open to any clinic member.
drop policy "update own clinic" on public.clinics;
create policy "admin update own clinic" on public.clinics
  for update using (id = public.my_clinic_id() and public.my_role() = 'admin');

drop policy "clinic doctors insert" on public.doctors;
create policy "admin clinic doctors insert" on public.doctors
  for insert with check (clinic_id = public.my_clinic_id() and public.my_role() = 'admin');
drop policy "clinic doctors update" on public.doctors;
create policy "admin clinic doctors update" on public.doctors
  for update using (clinic_id = public.my_clinic_id() and public.my_role() = 'admin')
  with check (clinic_id = public.my_clinic_id() and public.my_role() = 'admin');
drop policy "clinic doctors delete" on public.doctors;
create policy "admin clinic doctors delete" on public.doctors
  for delete using (clinic_id = public.my_clinic_id() and public.my_role() = 'admin');

-- Admins can deactivate/reactivate or change the role of another staff
-- profile in their own clinic (but never touch another clinic's rows).
create policy "admin update clinic profiles" on public.profiles
  for update using (clinic_id = public.my_clinic_id() and public.my_role() = 'admin')
  with check (clinic_id = public.my_clinic_id() and public.my_role() = 'admin');

-- register_clinic() now also stores the admin's own email on their profile,
-- for consistency with staff profiles created below.
create or replace function public.register_clinic(clinic_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_clinic_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Must be authenticated to register a clinic';
  end if;

  if exists (select 1 from public.profiles where id = auth.uid()) then
    raise exception 'This account is already linked to a clinic';
  end if;

  insert into public.clinics (name, admin_email)
  values (clinic_name, (select email from auth.users where id = auth.uid()))
  returning id into new_clinic_id;

  insert into public.profiles (id, clinic_id, email, role)
  values (auth.uid(), new_clinic_id, (select email from auth.users where id = auth.uid()), 'admin');

  return new_clinic_id;
end;
$$;

-- Links a staff member's auth account (already created by the admin, on the
-- admin's own device, via a temporary non-persisted Supabase client) into
-- the admin's clinic. SECURITY DEFINER because the new user has no profile
-- yet, so no ordinary RLS policy on profiles could authorize this insert.
create or replace function public.create_staff_profile(new_user_id uuid, staff_email text, staff_full_name text, staff_role text)
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

  insert into public.profiles (id, clinic_id, email, full_name, role)
  values (new_user_id, caller_clinic_id, staff_email, staff_full_name, staff_role);
end;
$$;

grant execute on function public.create_staff_profile(uuid, text, text, text) to authenticated;
