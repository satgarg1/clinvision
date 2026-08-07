-- ============================================================
-- Qlinic — multi-tenant Postgres schema for Supabase
--
-- Run this once in your Supabase project's SQL Editor
-- (Project -> SQL Editor -> New query -> paste this whole file -> Run).
-- Safe to re-run only if the tables don't already exist; this does not
-- attempt to be idempotent on re-runs.
-- ============================================================

create extension if not exists "pgcrypto";

-- ---------------- clinics ----------------
-- One row per clinic (tenant). Slot rules are configurable per clinic
-- rather than hardcoded, since different clinics may want different
-- capacity limits.
create table public.clinics (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  admin_email text not null unique,
  grace_window_mins int not null default 25,
  slot_interval_mins int not null default 15,
  slot_capacity int not null default 3,
  created_at timestamptz not null default now()
);

-- ---------------- profiles ----------------
-- Links a Supabase auth user to the one clinic they belong to.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  full_name text not null default '',
  role text not null default 'admin', -- room to grow: 'admin' | 'reception' | 'doctor'
  created_at timestamptz not null default now()
);

-- ---------------- doctors ----------------
create table public.doctors (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  name text not null,
  specialty text not null default '',
  status text not null default 'on_time' check (status in ('on_time','running_late','on_break','emergency')),
  delay_mins int not null default 0,
  status_note text not null default '',
  status_updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- ---------------- patients ----------------
create table public.patients (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  doctor_id uuid not null references public.doctors(id) on delete cascade,
  name text not null,
  phone text not null,
  address text not null default '',
  type text not null check (type in ('appointment', 'walkin')),
  booked_date date,        -- null for walk-ins
  booked_time time,        -- null for walk-ins
  status text not null default 'booked' check (status in ('booked','waiting','in_consult','done','no_show')),
  arrived_at timestamptz,  -- when they actually checked in (walk-in or late/on-time appointment)
  reason text not null default '',
  created_at timestamptz not null default now()
);

create index patients_clinic_doctor_idx on public.patients (clinic_id, doctor_id);
create index patients_clinic_date_idx on public.patients (clinic_id, booked_date);

-- ============================================================
-- Row Level Security — every table is scoped to the caller's clinic.
-- This is what makes multi-tenancy actually safe: without it, any
-- authenticated user could read or write any other clinic's data.
-- ============================================================

alter table public.clinics enable row level security;
alter table public.profiles enable row level security;
alter table public.doctors enable row level security;
alter table public.patients enable row level security;

create or replace function public.my_clinic_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select clinic_id from public.profiles where id = auth.uid();
$$;

create policy "select own clinic" on public.clinics
  for select using (id = public.my_clinic_id());
create policy "update own clinic" on public.clinics
  for update using (id = public.my_clinic_id());

create policy "select own clinic profiles" on public.profiles
  for select using (clinic_id = public.my_clinic_id());

create policy "clinic doctors select" on public.doctors
  for select using (clinic_id = public.my_clinic_id());
create policy "clinic doctors insert" on public.doctors
  for insert with check (clinic_id = public.my_clinic_id());
create policy "clinic doctors update" on public.doctors
  for update using (clinic_id = public.my_clinic_id()) with check (clinic_id = public.my_clinic_id());
create policy "clinic doctors delete" on public.doctors
  for delete using (clinic_id = public.my_clinic_id());

create policy "clinic patients select" on public.patients
  for select using (clinic_id = public.my_clinic_id());
create policy "clinic patients insert" on public.patients
  for insert with check (clinic_id = public.my_clinic_id());
create policy "clinic patients update" on public.patients
  for update using (clinic_id = public.my_clinic_id()) with check (clinic_id = public.my_clinic_id());
create policy "clinic patients delete" on public.patients
  for delete using (clinic_id = public.my_clinic_id());

-- ============================================================
-- Signup: atomically create a clinic + profile for a brand-new user.
-- Called from the client immediately after supabase.auth.signUp()
-- succeeds. SECURITY DEFINER lets it insert into clinics/profiles even
-- though the new user has no clinic yet (RLS would otherwise block that
-- — a user with no profile row has no my_clinic_id() to satisfy any
-- policy).
-- ============================================================
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

  insert into public.profiles (id, clinic_id, role)
  values (auth.uid(), new_clinic_id, 'admin');

  return new_clinic_id;
end;
$$;

grant execute on function public.register_clinic(text) to authenticated;

-- ============================================================
-- Realtime — lets reception/doctor/display subscribe to live changes,
-- scoped by the same RLS policies above (a client only receives change
-- events for rows it's allowed to select).
-- ============================================================
alter publication supabase_realtime add table public.doctors;
alter publication supabase_realtime add table public.patients;
