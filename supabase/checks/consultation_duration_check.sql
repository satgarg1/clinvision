-- ============================================================
-- ClinVision — reference query: check consultation_duration_seconds
--
-- Not a migration (nothing here changes schema) — just a saved query
-- for spot-checking that the wait-time data-collection column
-- (added in migration 057) is actually being written correctly.
-- Paste whichever query you need into the Supabase SQL Editor.
--
-- Reminder: the SQL Editor connects as a superuser role and bypasses
-- row-level security entirely, so every query below sees every
-- clinic's data, not just one — be careful what you export/share.
-- ============================================================

-- 1. Look up one specific patient by name, and confirm the stored
--    duration matches what the raw timestamps actually compute to.
--    If consultation_duration_seconds and recomputed_seconds don't
--    match (beyond a 0-1 second rounding difference), something's off.
select
  p.id,
  p.name,
  p.age,
  p.gender,
  p.clinic_id,
  c.name as clinic_name,
  p.called_at,
  p.done_at,
  p.consultation_duration_seconds,
  extract(epoch from (p.done_at - p.called_at))::int as recomputed_seconds
from patients p
join clinics c on c.id = p.clinic_id
where p.name ilike '%PATIENT NAME HERE%'  -- swap this in, or filter by p.id instead
order by p.done_at desc
limit 5;

-- 2. Broader sweep — most recent 20 rows across ALL clinics that have
--    a duration recorded. Good for eyeballing whether collection is
--    happening broadly, not just for one clinic you're testing with.
select
  p.name, p.age, p.gender, c.name as clinic_name,
  p.called_at, p.done_at, p.consultation_duration_seconds
from patients p
join clinics c on c.id = p.clinic_id
where p.consultation_duration_seconds is not null
order by p.done_at desc
limit 20;

-- 3. Coverage check — how many done visits per clinic actually have a
--    duration recorded vs. how many are missing one. A clinic showing
--    a lot of "missing" relative to "done" total is worth investigating
--    (a done visit should always get a duration via callNextPatient/
--    finishCurrentPatient — see clinic-data.js).
select
  c.name as clinic_name,
  count(*) filter (where p.status = 'done') as total_done,
  count(*) filter (where p.status = 'done' and p.consultation_duration_seconds is not null) as has_duration,
  count(*) filter (where p.status = 'done' and p.consultation_duration_seconds is null) as missing_duration
from patients p
join clinics c on c.id = p.clinic_id
group by c.name
order by missing_duration desc;
