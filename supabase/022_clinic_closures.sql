-- ============================================================
-- Qlinic — migration 022: clinic closures (one-off closed dates).
--
-- Why: weekly_off_days (021) covers a recurring day of the week, but a
-- clinic also closes for specific one-off dates — national holidays, a
-- doctor's leave, etc. Reception gets the same booking-time warning for
-- these dates that it already gets for a weekly off day.
--
-- RLS follows doctors' pattern (clinic-scoped, not role-restricted at the
-- DB level): every role can read the list (Reception needs it for the
-- booking check), and admin-only write access is enforced in the UI the
-- same way the rest of Settings already is, not at the DB layer.
--
-- Run this once in the Supabase SQL Editor, after 021_weekly_off_day.sql.
-- ============================================================

create table if not exists public.clinic_closures (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  closure_date date not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  unique (clinic_id, closure_date)
);

create index if not exists clinic_closures_clinic_date_idx on public.clinic_closures (clinic_id, closure_date);

alter table public.clinic_closures enable row level security;

create policy "clinic closures select" on public.clinic_closures
  for select using (clinic_id = public.my_clinic_id());
create policy "clinic closures insert" on public.clinic_closures
  for insert with check (clinic_id = public.my_clinic_id());
create policy "clinic closures delete" on public.clinic_closures
  for delete using (clinic_id = public.my_clinic_id());
