-- ============================================================
-- Qlinic — migration 048: HPR id on doctors, HFR id on clinics.
--
-- Why: the other half of ABDM's identity layer - a clinic registers
-- once as a facility (HFR, Health Facility Registry) and each doctor
-- registers once as a practitioner (HPR, Health Professional Registry).
-- Both are real-world, Aadhaar-KYC'd government registrations the
-- clinic/doctor complete themselves outside this app - Qlinic only
-- has somewhere to record the resulting ID once it exists. Same shape
-- as clinics.gstin (044_clinic_gstin.sql): plain, optional, non-secret
-- reference identifiers, not something requiring service-role-only
-- writes the way ABHA verification does.
--
-- Run this once in the Supabase SQL Editor, after 047_abha_identity_columns.sql.
-- ============================================================

alter table public.doctors add column hpr_id text null;
alter table public.doctors add column hpr_verified_at timestamptz null;
alter table public.clinics add column hfr_id text null;
alter table public.clinics add column hfr_verified_at timestamptz null;
