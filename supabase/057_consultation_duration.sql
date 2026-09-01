-- ============================================================
-- Qlinic — migration 057: capture actual consultation duration per visit
--
-- Why: the wait-time-estimation backlog item needs real per-visit
-- consultation duration, tagged with the patient's age/gender (already
-- captured at intake, migrations 005/014) and clinic (implicit via
-- clinic_id already on this row), to eventually bucket and average
-- per clinic. This is DATA COLLECTION ONLY -- nothing computes or
-- shows any estimate from this yet, and nothing should, per the
-- explicit release gate already on file: don't ship any time-estimate
-- feature until there's at least 6 months of data from at least 10
-- clinics.
--
-- Computed from the two timestamps this table already tracked before
-- this migration (called_at, set when a patient moves to in_consult;
-- done_at, set when they move to done) -- this just adds somewhere
-- durable to store the difference, so it doesn't need recomputing
-- from two raw timestamps later and survives even if how either
-- timestamp gets set ever changes.
--
-- Run this once in the Supabase SQL Editor, after
-- 056_queue_status_clinic_closed.sql.
-- ============================================================

alter table public.patients
  add column consultation_duration_seconds int null;
