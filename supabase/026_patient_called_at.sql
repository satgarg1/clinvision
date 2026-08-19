-- ============================================================
-- Qlinic — migration 026: record when a patient was actually called
-- into the room, not just that they currently are ("in_consult").
--
-- Why: doctor.html and the display board show who's "Now serving" but
-- not since when — a patient watching the board (or the doctor
-- themselves) has no way to tell if that consult just started or has
-- run long. called_at is set once, the moment callNextPatient moves
-- someone to in_consult; it's never touched again for that visit, so it
-- stays a fixed "since" time for the whole consultation.
--
-- Purely additive: a new nullable column, no trigger, no backfill
-- needed (existing in_consult rows just show no time until the next
-- "Call next patient").
--
-- Run this once in the Supabase SQL Editor, after 025_queue_status_time_and_closed.sql.
-- ============================================================

alter table public.patients add column if not exists called_at timestamptz;
