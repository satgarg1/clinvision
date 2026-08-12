-- ============================================================
-- Qlinic — migration 014: capture patient age at booking time.
--
-- Why: billing was capturing age itself (patient_age on invoices), but
-- that only exists after a patient's first bill. Capturing it at
-- Reception, same as name/phone/gender, means it's already on file
-- for the appointment/walk-in flow and for billing's phone lookup on
-- day one, not just from the second visit onward.
--
-- Run this once in the Supabase SQL Editor, after 013_billing.sql.
-- ============================================================

alter table public.patients
  add column if not exists age int;
