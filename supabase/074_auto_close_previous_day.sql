-- ============================================================
-- Qlinic — migration 074: automatic end-of-day no-show closing.
--
-- closeDayNoShows() (clinic-data.js) has always been a manual action —
-- someone on staff has to remember to open End of day and click it. If
-- nobody does, a booked-but-never-arrived patient sits in 'booked'
-- forever, silently wrong from the moment midnight passes. This adds
-- the same close, run automatically every night via pg_cron, so a
-- forgotten click no longer matters — every booked appointment whose
-- day has ended without the patient ever being marked arrived becomes
-- a no-show by default, clinic-wide, across every clinic, no login
-- required. Only 'booked' rows are touched (never arrived at all) —
-- 'waiting'/'in_consult' patients who did arrive but were never seen
-- are a different problem, not what this closes out.
--
-- Requires the pg_cron extension. On Supabase, enable it once via
-- Database -> Extensions -> search "pg_cron" -> Enable (some projects
-- expose this as Database -> Cron instead) before running this
-- migration — the check below fails loudly with that exact fix rather
-- than an obscure permissions error if it's missing.
--
-- Scheduled at 18:35 UTC = 00:05 Asia/Kolkata (a few minutes past
-- local midnight, not exactly on the stroke of it, so a booking or
-- arrival already in flight right at midnight isn't caught mid-write).
-- Asia/Kolkata is the same timezone every other "which day is this"
-- calculation in the app already anchors to (get_queue_status,
-- 062_queue_status_daily_summary.sql), not the database's own default
-- (typically UTC) clock.
--
-- Run this once in the Supabase SQL Editor, after 073_pack_aware_pharmacy_rpcs.sql.
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'pg_cron is not enabled on this project. Enable it first: Supabase dashboard -> Database -> Extensions -> search "pg_cron" -> Enable. Then re-run this migration.';
  end if;
end $$;

-- security definer, no grant to authenticated/anon — this touches
-- every clinic's data in one call, something no logged-in user should
-- ever be able to trigger directly the way admin/reception trigger
-- their OWN clinic's closeDayNoShows() via a plain client update.
-- Only the cron job below can call it.
create or replace function public.auto_close_previous_day()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_date date;
begin
  v_target_date := ((now() at time zone 'Asia/Kolkata')::date) - 1;

  update public.patients
  set status = 'no_show'
  where status = 'booked'
    and booked_date = v_target_date;

  -- Skips any clinic that already manually closed this same date earlier
  -- in the evening (its last_closed_date already matches) — only
  -- clinics that never closed, or are still showing a stale older date,
  -- get touched.
  update public.clinics
  set last_closed_date = v_target_date, closed_at = now()
  where last_closed_date is distinct from v_target_date;
end;
$$;

-- Safe to re-run this migration: drop any previous schedule of the
-- same name first rather than accumulating duplicate cron jobs.
do $$
begin
  perform cron.unschedule('auto-close-previous-day');
exception when others then
  null;
end $$;

select cron.schedule(
  'auto-close-previous-day',
  '35 18 * * *',
  $$select public.auto_close_previous_day();$$
);
