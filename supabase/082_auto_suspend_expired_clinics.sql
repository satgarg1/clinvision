-- ============================================================
-- Qlinic — migration 082: automatic subscription suspension.
--
-- A platform admin sets a paid-to date (Active) or a trial length
-- (Trialing, via trial_ends_at) in admin.html and should never have to
-- remember to come back and flip a switch when it lapses. This runs
-- the same nightly pg_cron pattern as 074_auto_close_previous_day.sql:
-- once a day, suspend any clinic whose paid-to or trial-ends date is
-- more than GRACE_DAYS days in the past and hasn't been renewed since.
--
-- Grace window: a clinic isn't cut off the instant its date passes —
-- service keeps running for 3 more days (a paid_to of 10 Sep keeps the
-- clinic active through 13 Sep) before this suspends it, in case
-- payment is only a day or two late. This mirrors exactly what
-- admin.html's popover tells the platform admin will happen.
--
-- Only ever moves a clinic FROM active/trialing TO suspended — never
-- touches a clinic a platform admin already suspended by hand, and
-- never reactivates one on its own (that always requires a human to
-- set a new paid/trial period).
--
-- Requires pg_cron (already enabled if 074_auto_close_previous_day.sql
-- is live on this project — same extension, nothing new to turn on).
--
-- Run this once in the Supabase SQL Editor, after
-- 081_clinic_subscription_fields.sql.
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'pg_cron is not enabled on this project. Enable it first: Supabase dashboard -> Database -> Extensions -> search "pg_cron" -> Enable. Then re-run this migration.';
  end if;
end $$;

create or replace function public.auto_suspend_expired_clinics()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grace_days constant int := 3;
begin
  update public.clinics
  set subscription_status = 'suspended'
  where subscription_status = 'active'
    and subscription_paid_to is not null
    and subscription_paid_to + (v_grace_days || ' days')::interval < now();

  update public.clinics
  set subscription_status = 'suspended'
  where subscription_status = 'trialing'
    and trial_ends_at is not null
    and trial_ends_at + (v_grace_days || ' days')::interval < now();
end;
$$;

-- Safe to re-run this migration: drop any previous schedule of the
-- same name first rather than accumulating duplicate cron jobs.
do $$
begin
  perform cron.unschedule('auto-suspend-expired-clinics');
exception when others then
  null;
end $$;

-- 18:40 UTC = 00:10 Asia/Kolkata — a few minutes after
-- auto-close-previous-day's own 18:35 UTC slot, so the two nightly
-- jobs don't land in the same minute.
select cron.schedule(
  'auto-suspend-expired-clinics',
  '40 18 * * *',
  $$select public.auto_suspend_expired_clinics();$$
);
