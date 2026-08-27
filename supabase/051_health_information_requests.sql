-- ============================================================
-- Qlinic — migration 051: health_information_requests.
--
-- Why: every time an HIU actually asks for the records covered by a
-- consent, ABDM's Gateway calls this HIP's health-information/request
-- callback - which must ACK within 5 seconds and then do the real work
-- (build the FHIR bundle, encrypt it, push it, report status)
-- asynchronously. This table is what makes that async handoff safe:
-- the callback inserts a row immediately with status='received' before
-- returning its ACK, then the same request's later processing steps
-- update that row rather than needing to be tracked in memory across
-- a function invocation boundary.
--
-- Schema-only for now, same as 050 - populated once the
-- hip-health-info-request Edge Function and real sandbox credentials
-- exist. No client insert/update/delete policy for the same reason as
-- consent_artefacts: these rows are a record of external requests and
-- Qlinic's own processing of them, not user-editable data. Select is
-- open to clinic staff for the same future-audit-view reason.
--
-- Run this once in the Supabase SQL Editor, after 050_consent_artefacts.sql.
-- ============================================================

create table public.health_information_requests (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  consent_artefact_id uuid not null references public.consent_artefacts(id) on delete cascade,
  transaction_id text not null unique,
  hiu_callback_url text not null,
  care_context_ids uuid[] not null default '{}',
  status text not null default 'received'
    check (status in ('received', 'bundled', 'encrypted', 'pushed', 'acknowledged', 'failed')),
  error_detail text null,
  requested_at timestamptz not null default now(),
  pushed_at timestamptz null
);

create index health_information_requests_consent_idx on public.health_information_requests (consent_artefact_id);
create index health_information_requests_clinic_idx on public.health_information_requests (clinic_id);

alter table public.health_information_requests enable row level security;

create policy "clinic hi_requests select" on public.health_information_requests
  for select using (clinic_id = public.my_clinic_id());
