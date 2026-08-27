-- ============================================================
-- Qlinic — migration 050: consent_artefacts.
--
-- Why: when a patient grants an HIU (some other app/provider) access
-- to their records at this clinic, ABDM's Gateway pushes a signed
-- consent artefact to this HIP. This table is the durable record of
-- that grant - scope, purpose, date range, expiry - checked before
-- any health-information request is ever honored.
--
-- Schema-only for now: nothing writes to this table yet. It starts
-- being populated once the hip-consent-notify Edge Function exists
-- and Qlinic has real ABDM sandbox credentials to receive real
-- consent-notify callbacks from. Every column here mirrors what
-- ABDM's consent-notify payload actually contains, so that Edge
-- Function can be a near-direct mapping rather than needing its own
-- schema redesign later.
--
-- No client insert/update/delete policy - these rows represent an
-- externally-asserted fact (a real patient's real consent grant), not
-- something any Qlinic user edits. Select is open to clinic staff so
-- a future audit view (mirroring billing-audit.html's pattern) can
-- read them.
--
-- Run this once in the Supabase SQL Editor, after 049_care_contexts.sql.
-- ============================================================

create table public.consent_artefacts (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid null references public.patients(id) on delete set null,
  consent_id text not null unique,
  hiu_id text not null,
  purpose_code text not null,
  hi_types text[] not null,
  date_range_from timestamptz not null,
  date_range_to timestamptz not null,
  expiry_at timestamptz not null,
  status text not null default 'active' check (status in ('active', 'revoked', 'expired')),
  raw_artefact jsonb not null,
  received_at timestamptz not null default now()
);

create index consent_artefacts_patient_idx on public.consent_artefacts (patient_id);
create index consent_artefacts_clinic_idx on public.consent_artefacts (clinic_id);

alter table public.consent_artefacts enable row level security;

create policy "clinic consent_artefacts select" on public.consent_artefacts
  for select using (clinic_id = public.my_clinic_id());
