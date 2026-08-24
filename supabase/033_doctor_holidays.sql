-- ============================================================
-- Qlinic — migration 033: per-doctor holidays/leave dates.
--
-- Why: clinic_closures (022) is clinic-wide only — there's never been
-- a way to say "Dr. X is out on this date" while the rest of the
-- clinic runs normally. Modeled directly on clinic_closures: same
-- shape, same one-date-per-row design, just scoped to a doctor. A
-- doctor manages their own (via my_doctor_id(), added in 032); admin
-- can manage any doctor's on their behalf (a doctor calling in sick
-- and not logging in themselves is a realistic front-desk scenario);
-- reception gets read access only, needed so reception.html can warn
-- at booking time, but no write access — holiday/leave reads as
-- roster data, not day-of-service status, matching how doctor
-- roster/fee edits are already admin-only.
--
-- Run this once in the Supabase SQL Editor, after 032_profile_doctor_link.sql.
-- ============================================================

create table if not exists public.doctor_holidays (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  doctor_id uuid not null references public.doctors(id) on delete cascade,
  holiday_date date not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  unique (doctor_id, holiday_date)
);

create index if not exists doctor_holidays_doctor_date_idx on public.doctor_holidays (doctor_id, holiday_date);

alter table public.doctor_holidays enable row level security;

create policy "doctor holidays select" on public.doctor_holidays
  for select using (clinic_id = public.my_clinic_id());

create policy "doctor holidays insert" on public.doctor_holidays
  for insert with check (
    clinic_id = public.my_clinic_id()
    and (doctor_id = public.my_doctor_id() or public.my_role() = 'admin')
  );

create policy "doctor holidays delete" on public.doctor_holidays
  for delete using (
    clinic_id = public.my_clinic_id()
    and (doctor_id = public.my_doctor_id() or public.my_role() = 'admin')
  );
