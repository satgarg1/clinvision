-- ============================================================
-- Per-staff phone numbers, so any staff member (not just the clinic
-- admin) can log in with their phone instead of typing their email.
--
-- Until now the only phone number anywhere was the clinic's own
-- registration-time contact number (pending_clinic_phone), stored once
-- for whoever signed up -- reception and doctor accounts had no phone
-- of their own. This adds one to every individual profile instead.
--
-- Uniqueness is global (not scoped by clinic_id): the phone-login
-- lookup below runs BEFORE anyone is authenticated, so there's no
-- clinic context yet to filter by. A phone number has to map to
-- exactly one email, clinic-wide across the whole product, or the
-- lookup would be ambiguous.
--
-- Run this once in the Supabase SQL Editor, after 053_clinic_subscription_status.sql.
-- ============================================================

alter table public.profiles add column phone text null;

create unique index profiles_phone_idx on public.profiles (phone) where phone is not null;

-- create_staff_profile()'s real current signature (set by
-- 032_profile_doctor_link.sql) is 5 args, ending in staff_doctor_id
-- uuid. Postgres treats a different arity as a distinct function, not
-- a replacement -- 032's own comment on this exact point -- so the
-- 5-arg version has to be dropped explicitly before redefining with a
-- 6th param, the same way 032 dropped the 4-arg version before it.
drop function if exists public.create_staff_profile(uuid, text, text, text, uuid);

create or replace function public.create_staff_profile(
  new_user_id uuid, staff_email text, staff_full_name text, staff_role text,
  staff_doctor_id uuid default null, staff_phone text default null
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

  insert into public.profiles (id, clinic_id, email, full_name, role, doctor_id, phone)
  values (new_user_id, caller_clinic_id, staff_email, staff_full_name, staff_role, staff_doctor_id, nullif(staff_phone, ''));
end;
$$;

grant execute on function public.create_staff_profile(uuid, text, text, text, uuid, text) to authenticated;

-- Lets an admin add/change a staff member's own phone after the fact,
-- without going through the full staff-role update path. Same admin-
-- only + same-clinic guard as updateStaffRole/setStaffActive's own
-- direct-table-update calls.
create or replace function public.update_staff_phone(staff_id uuid, new_phone text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.my_role() <> 'admin' then
    raise exception 'Only a clinic admin can update a staff phone number.';
  end if;

  update public.profiles
  set phone = nullif(new_phone, '')
  where id = staff_id and clinic_id = public.my_clinic_id();
end;
$$;

grant execute on function public.update_staff_phone(uuid, text) to authenticated;

-- The actual phone-login lookup: called PRE-login (anon), from a
-- temporary/non-persisted client, never the shared authenticated one.
-- Returns only the matching email, nothing else about the clinic or
-- the account -- same shape as a "forgot password" flow leaking the
-- minimum possible information about whether an identifier exists.
create or replace function public.email_for_staff_phone(staff_phone text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select email from public.profiles
  where phone = staff_phone and is_active = true
  limit 1;
$$;

grant execute on function public.email_for_staff_phone(text) to anon, authenticated;
