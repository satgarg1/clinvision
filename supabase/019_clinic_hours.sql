-- ============================================================
-- Qlinic — migration 019: clinic opening/closing hours.
--
-- Why: Reception's appointment time picker currently offers every slot
-- from 12:00 AM to 11:55 PM, which makes no sense for a clinic that's
-- only open, say, 9 AM to 6 PM. This adds clinic-wide opening/closing
-- times (admin-set, via Settings) so the time picker can be bounded to
-- real business hours.
--
-- Run this once in the Supabase SQL Editor, after 018_follow_up_window.sql.
-- ============================================================

alter table public.clinics
  add column if not exists opening_time time not null default '09:00',
  add column if not exists closing_time time not null default '18:00';
