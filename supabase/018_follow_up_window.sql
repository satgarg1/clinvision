-- ============================================================
-- Qlinic — migration 018: follow-up fee waiver window.
--
-- Why: a patient who returns to the SAME doctor soon after their last
-- completed visit often shouldn't pay again (the doctor told them to
-- come back to check on something). Reception has no way to know that
-- without asking the patient to remember, or digging through past
-- days manually. This adds one clinic-wide setting (admin-controlled,
-- via Settings) for how many days count as "soon," so Reception can
-- see it as a heads-up while booking instead.
--
-- This column is read/written entirely client-side (no new RPC): it's
-- just another clinic setting, same as grace_window_mins etc, already
-- covered by the clinics table's existing RLS policies.
--
-- Run this once in the Supabase SQL Editor, after 017_end_of_day.sql.
-- ============================================================

alter table public.clinics
  add column if not exists follow_up_buffer_days integer not null default 0;
