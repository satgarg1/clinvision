-- ============================================================
-- Qlinic — migration 036: configurable bucket size for the reception
-- day-schedule popup ("View day's schedule").
--
-- Why: the popup originally bucketed a doctor's day into a fixed
-- 30-minute grid. Staff want to choose a coarser or finer view (15/30/
-- 45/60 min) depending on how busy a doctor's day is. Deliberately a
-- separate column from slot_interval_mins, which drives the existing
-- single-slot capacity hint/override flow and is untouched by this —
-- the two serve different UI, so a change to one shouldn't move the
-- other. Editable by admin and reception; the check constraint keeps
-- it to the same four options exposed in Settings' dropdown.
--
-- Run this once in the Supabase SQL Editor, after 035_closed_dates_reception_write.sql.
-- ============================================================

alter table public.clinics
  add column if not exists schedule_interval_mins int not null default 30
    check (schedule_interval_mins in (15, 30, 45, 60));
