-- ============================================================
-- ClinVision — reference query: check product_feedback
--
-- Not a migration. This table (migration 058) deliberately has no
-- select policy for the authenticated role at all, so the only way to
-- read it is here (SQL Editor / service role, which bypasses RLS) or
-- through whatever admin-only tooling eventually reads it in-app.
-- ============================================================

-- 1. Most recent submissions, across all clinics, newest first.
select
  pf.id,
  pf.rating,
  pf.feedback_text,
  pf.submitted_at,
  p.name as patient_name,
  c.name as clinic_name
from product_feedback pf
join patients p on p.id = pf.patient_id
join clinics c on c.id = pf.clinic_id
order by pf.submitted_at desc
limit 20;

-- 2. Running average rating + count, overall.
select
  count(*) as total_ratings,
  round(avg(rating)::numeric, 2) as avg_rating,
  count(*) filter (where feedback_text is not null) as with_written_feedback
from product_feedback;

-- 3. Average rating broken out per clinic — a quick way to spot
-- whether the experience is worse at any one clinic specifically
-- (queue congestion, a slow connection at that location, etc.).
select
  c.name as clinic_name,
  count(*) as total_ratings,
  round(avg(pf.rating)::numeric, 2) as avg_rating
from product_feedback pf
join clinics c on c.id = pf.clinic_id
group by c.name
order by avg_rating asc;
