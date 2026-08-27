-- ============================================================
-- Qlinic — migration 047: ABHA identity columns on patients.
--
-- Why: first schema piece of ABDM/ABHA (Ayushman Bharat Digital
-- Mission) integration - the columns a patient's health ID lives in.
-- Deliberately schema-only for now: no client-callable write function
-- exists here, and no UI field is added anywhere yet. These columns
-- stay null until a later Edge Function (abha-verify, once real NHA
-- sandbox credentials exist) writes them via the service-role key
-- after an actual OTP verification - a client can never assert
-- "verified" on its own by writing to this table directly, since
-- abha_verified_at/abha_verification_method have no insert/update
-- policy path from the browser (patients' existing RLS is full CRUD
-- for clinic staff, but nothing in the app UI touches these columns).
--
-- Run this once in the Supabase SQL Editor, after 046_billing_audit_phone.sql.
-- ============================================================

alter table public.patients add column abha_number text null;
alter table public.patients add column abha_address text null;
alter table public.patients add column abha_verified_at timestamptz null;
alter table public.patients add column abha_verification_method text null
  check (abha_verification_method in ('aadhaar_otp', 'mobile_otp', 'demographic', 'qr_scan'));

-- Scoped per clinic, not globally unique - the same ABHA address could
-- in principle show up at two different clinics (a patient who visits
-- both), which is a real scenario, not a data error.
create unique index patients_abha_address_idx on public.patients (clinic_id, abha_address) where abha_address is not null;
