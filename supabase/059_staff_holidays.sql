-- ============================================================
-- Qlinic — migration 059: staff (admin/reception) holidays.
--
-- Why: doctor_holidays (033) is genuinely doctor-only — doctor_id is
-- the only reference column, and there's no equivalent for a staff
-- member, who has no roster table the way doctors do (a staff member
-- is just a profiles row). "Doctor Holidays" is being renamed "Team
-- Holidays" to cover both; this table is the staff half of that.
--
-- Deliberately its own table, not a merged/generalized schema covering
-- both doctors and staff in one — same shape as doctor_holidays,
-- just keyed to profiles.id instead of doctors.id. profiles.id
-- references auth.users(id) directly (see schema.sql), so
-- profile_id = auth.uid() is the correct self-service check, mirroring
-- doctor_id = my_doctor_id() on doctor_holidays exactly: a staff
-- member (admin or reception — both get holiday tracking, not just
-- reception) manages their own; admin can also manage anyone's on
-- their behalf, same as a doctor calling in sick and not logging in
-- themselves.
--
-- Run this once in the Supabase SQL Editor, after 058_product_feedback.sql.
-- ============================================================

create table if not exists public.staff_holidays (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  holiday_date date not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  unique (profile_id, holiday_date)
);

create index if not exists staff_holidays_profile_date_idx on public.staff_holidays (profile_id, holiday_date);

alter table public.staff_holidays enable row level security;

create policy "staff holidays select" on public.staff_holidays
  for select using (clinic_id = public.my_clinic_id());

create policy "staff holidays insert" on public.staff_holidays
  for insert with check (
    clinic_id = public.my_clinic_id()
    and (profile_id = auth.uid() or public.my_role() = 'admin')
  );

create policy "staff holidays update" on public.staff_holidays
  for update
  using (
    clinic_id = public.my_clinic_id()
    and (profile_id = auth.uid() or public.my_role() = 'admin')
  )
  with check (
    clinic_id = public.my_clinic_id()
    and (profile_id = auth.uid() or public.my_role() = 'admin')
  );

create policy "staff holidays delete" on public.staff_holidays
  for delete using (
    clinic_id = public.my_clinic_id()
    and (profile_id = auth.uid() or public.my_role() = 'admin')
  );
