-- ============================================================
-- Patient notifications — the tech for "text the patient their
-- appointment time," built without a live SMS provider connected yet.
--
-- Every walk-in/appointment booking composes a message and logs it here
-- as 'pending'. There is deliberately no real send step: wiring up a
-- provider (Twilio, MSG91, etc.) later means adding a small Supabase
-- Edge Function that processes 'pending' rows and flips them to
-- 'sent'/'failed' — nothing about this schema or the booking flow needs
-- to change when that happens.
-- ============================================================

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid references public.patients(id) on delete cascade,
  phone text not null,
  message text not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index notifications_clinic_idx on public.notifications (clinic_id, created_at desc);

alter table public.notifications enable row level security;

create policy "clinic notifications select" on public.notifications
  for select using (clinic_id = public.my_clinic_id());
create policy "clinic notifications insert" on public.notifications
  for insert with check (clinic_id = public.my_clinic_id());
