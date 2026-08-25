-- ============================================================
-- Qlinic — migration 038: fix a real insert failure introduced by 037.
--
-- Why: 037 split appointment and walk-in token numbers into two
-- independent counters, relying on walk-ins being offset by 100000 to
-- keep the two sequences from ever colliding under the existing unique
-- index on (doctor_id, token_date, token_number). That's true for any
-- walk-in created AFTER 037 ran — but walk-ins created BEFORE it keep
-- their OLD small token_number (037 deliberately doesn't renumber
-- history). On any clinic/day where old-scheme walk-ins and today's
-- appointments coexist, a brand new walk-in's freshly-computed small
-- number (max among today's OLD walk-ins, plus one) can land on a
-- number an appointment already has for that same doctor/day — and the
-- unique index silently rejects the insert. addWalkIn has no try/catch
-- around it, so this surfaced as "Add walk-in does nothing, no error,
-- no toast" — exactly the failure mode reported.
--
-- Fix: scope the uniqueness constraint by type too, so an appointment
-- and a walk-in can share a number for the same doctor/day without
-- conflict — which is fine, since they're displayed with different
-- prefixes ("#12" vs "W3") and were never meant to share one number
-- space to begin with once 037 split them.
--
-- Run this once in the Supabase SQL Editor, after 037_split_appointment_walkin_tokens.sql.
-- ============================================================

drop index if exists public.patients_doctor_token_date_number_key;

create unique index if not exists patients_doctor_token_date_type_number_key
  on public.patients (doctor_id, token_date, type, token_number);
