-- ============================================================
-- Qlinic — migration 044: optional GSTIN on the clinic profile.
--
-- Why: consultation fees are GST-exempt (Notification No. 12/2017-CT
-- (Rate), Entry 74) — nothing here is meant to enable tax calculation.
-- A GSTIN is still worth capturing for clinics that hold one for other
-- reasons (e.g. taxable ancillary services billed outside Qlinic) and
-- want it to show up on their own paperwork. Nullable and optional:
-- most clinics running only exempt consultations have no reason to
-- register for one at all.
--
-- Run this once in the Supabase SQL Editor, after 043_queue_status_patient_name.sql.
-- ============================================================

alter table public.clinics add column gstin text null;
