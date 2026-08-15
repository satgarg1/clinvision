-- ============================================================
-- Qlinic — migration 020: clinic admin phone number.
--
-- Why: signup collected an email for login but no phone number for the
-- clinic's admin contact. Stored as the country code and the 10-digit
-- number combined (e.g. "+919876543210") — the +91 prefix is fixed in
-- the signup UI, not user-editable, so it's always present.
--
-- Run this once in the Supabase SQL Editor, after 019_clinic_hours.sql.
-- ============================================================

alter table public.clinics
  add column if not exists phone text;
