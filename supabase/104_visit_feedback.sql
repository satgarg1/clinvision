-- ============================================================
-- Qlinic — migration 104: visit feedback, with routing to the
-- clinic's own public review link.
--
-- This is the "rate the clinic" idea migration 058 explicitly set
-- aside (see that file's own comment) -- that one asks about
-- ClinVision's own queue link/display and is deliberately walled off
-- from the clinic; this one asks about the visit itself, and the
-- clinic needs to read it, so it gets its own table with normal
-- clinic-read RLS rather than reusing product_feedback's RLS (which
-- was designed on purpose to keep the clinic out).
--
-- Scoped 2026-09-28, with two decisions made explicit here so a later
-- reader doesn't have to reverse-engineer them from the code:
--   1. The comment box is never gated behind declining the Google
--      prompt -- every rating gets a comment box; 4-5 stars additionally
--      gets the Google prompt, shown independently alongside it.
--   2. 1-3 stars never see a public-review prompt at all, not even a
--      softened one -- this is a router to a public review, not a
--      persuasion flow.
--
-- queue.html stops calling submit_product_feedback going forward;
-- that table and its data stay exactly as they are, untouched.
--
-- Run this once in the Supabase SQL Editor, after 103_prescription_rpcs_reuse_my_doctor_id.sql.
-- ============================================================

-- The clinic's own "get more reviews" link -- deliberately one plain
-- URL field, not a Google-specific integration. Works for a Google
-- Business Profile short link, or a Practo/Justdial/Facebook review
-- link, whatever the clinic actually uses. Null means the Google
-- prompt is simply never shown for that clinic; private feedback
-- collection works fine either way.
alter table public.clinics add column if not exists review_link_url text null;

create table public.visit_feedback (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null references public.patients(id) on delete cascade,
  rating int not null check (rating between 1 and 5),
  feedback_text text null,
  -- True once the patient has clicked through to the clinic's review
  -- link for this visit. Never flips back to false -- once shared,
  -- stays marked shared even if they later also send a private
  -- comment without re-triggering that click.
  routed_to_review boolean not null default false,
  submitted_at timestamptz not null default now(),
  -- One feedback row per visit -- the RPC below upserts onto this
  -- rather than select-then-insert, since "pick a rating" and "click
  -- share on Google" can each independently create or update the same
  -- row, in either order.
  unique (patient_id)
);

-- Normal clinic-read RLS, unlike product_feedback's deliberate lockout
-- above -- the whole point of this table is that the clinic can see
-- it, to act on it and to route happy patients onward.
alter table public.visit_feedback enable row level security;

create policy "clinic select own visit feedback" on public.visit_feedback
  for select using (clinic_id = public.my_clinic_id());

-- Anonymous, no login required -- same trust model as
-- submit_product_feedback and get_queue_status: knowing a patient's
-- own unguessable visit id is what authorizes submitting for that one
-- visit. Upserts rather than insert-only, since either the star
-- rating or the "share on Google" click can arrive first, and either
-- one needs to safely create or update the same row without clobbering
-- whichever half the other action already wrote. p_routed_to_review
-- only ever ORs forward, never backward.
create or replace function public.submit_visit_feedback(
  p_patient_id uuid,
  p_rating int,
  p_feedback_text text default null,
  p_routed_to_review boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  patient_row record;
begin
  if p_rating is null or p_rating < 1 or p_rating > 5 then
    raise exception 'Rating must be between 1 and 5';
  end if;

  select id, clinic_id, status into patient_row from public.patients where id = p_patient_id;
  if patient_row.id is null then
    raise exception 'Visit not found';
  end if;
  if patient_row.status <> 'done' then
    raise exception 'Feedback is only accepted for a completed visit';
  end if;

  insert into public.visit_feedback (clinic_id, patient_id, rating, feedback_text, routed_to_review)
  values (patient_row.clinic_id, p_patient_id, p_rating, nullif(trim(coalesce(p_feedback_text, '')), ''), coalesce(p_routed_to_review, false))
  on conflict (patient_id) do update set
    rating = excluded.rating,
    feedback_text = coalesce(excluded.feedback_text, visit_feedback.feedback_text),
    routed_to_review = visit_feedback.routed_to_review or excluded.routed_to_review;

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.submit_visit_feedback(uuid, int, text, boolean) to anon, authenticated;

-- get_queue_status() extended: drops the product_feedback-backed
-- feedbackSubmitted field (queue.html no longer shows that question at
-- all) and adds the three fields the new visit-rating block needs to
-- restore its own state correctly on reload -- the rating itself (so
-- the stars redraw already lit), whether it's been sent at least once
-- (so the comment box collapses to the thanks line), and whether the
-- patient already clicked through to the review link (so a returning
-- patient isn't asked to share twice). Otherwise identical to the
-- version in migration 058.
create or replace function public.get_queue_status(p_patient_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  patient_row record;
  clinic_row record;
  doctor_row record;
  my_position int;
  now_serving text;
  now_serving_called_at timestamptz;
  nearby jsonb;
  my_effective_moment timestamptz;
  window_booked_count int;
  window_arrived_count int;
  window_notarrived_count int;
  visit_feedback_row record;
begin
  select * into patient_row from public.patients where id = p_patient_id;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;

  select * into clinic_row from public.clinics where id = patient_row.clinic_id;
  select * into doctor_row from public.doctors where id = patient_row.doctor_id;

  select
    case when token_number > 100000 then 'W' || (token_number - 100000) else '#' || token_number::text end,
    called_at
  into now_serving, now_serving_called_at
  from public.patients
  where doctor_id = patient_row.doctor_id
    and token_date = patient_row.token_date
    and status = 'in_consult'
  limit 1;

  my_effective_moment := case
    when patient_row.booked_date is not null and patient_row.booked_time is not null
      then (patient_row.booked_date + patient_row.booked_time) at time zone 'Asia/Kolkata'
    else coalesce(patient_row.arrived_at, now())
  end;

  with window_patients as (
    select
      status,
      case
        when booked_date is not null and booked_time is not null
          then (booked_date + booked_time) at time zone 'Asia/Kolkata'
        else coalesce(arrived_at, now())
      end as effective_moment
    from public.patients
    where doctor_id = patient_row.doctor_id
      and token_date = patient_row.token_date
      and status in ('booked', 'waiting', 'in_consult')
  )
  select
    count(*) filter (where effective_moment <= my_effective_moment),
    count(*) filter (where effective_moment <= my_effective_moment and status in ('waiting', 'in_consult')),
    count(*) filter (where effective_moment <= my_effective_moment and status = 'booked')
  into window_booked_count, window_arrived_count, window_notarrived_count
  from window_patients;

  with waiting as (
    select
      id,
      token_number,
      is_priority,
      created_at,
      arrived_at,
      case
        when booked_date is not null and booked_time is not null
          then (booked_date + booked_time) at time zone 'Asia/Kolkata'
        else coalesce(arrived_at, now())
      end as intended_moment
    from public.patients
    where doctor_id = patient_row.doctor_id
      and token_date = patient_row.token_date
      and status = 'waiting'
      and token_number is not null
  ),
  computed as (
    select
      w.id,
      w.token_number,
      w.is_priority,
      w.created_at,
      w.intended_moment,
      greatest(
        case
          when doctor_row.delay_mins > 0 then greatest(
            w.intended_moment,
            doctor_row.status_updated_at + (doctor_row.delay_mins * interval '1 minute')
          )
          else w.intended_moment
        end,
        coalesce(w.arrived_at, w.intended_moment)
      ) as effective_moment
    from waiting w
  )
  select
    case when patient_row.status = 'waiting' then (
      select count(*) + 1
      from computed c, computed me
      where me.id = p_patient_id
        and ROW(not c.is_priority, c.effective_moment, c.intended_moment, c.created_at)
          < ROW(not me.is_priority, me.effective_moment, me.intended_moment, me.created_at)
    ) end,
    (
      select coalesce(jsonb_agg(t.display_token), '[]'::jsonb)
      from (
        select case when token_number > 100000 then 'W' || (token_number - 100000) else '#' || token_number::text end as display_token
        from computed
        order by (not is_priority), effective_moment, intended_moment, created_at
        limit 5
      ) t
    )
  into my_position, nearby;

  select rating, routed_to_review into visit_feedback_row from public.visit_feedback where patient_id = p_patient_id;

  return jsonb_build_object(
    'clinicName', clinic_row.name,
    'clinicClosedAt', clinic_row.closed_at,
    'reviewLinkUrl', clinic_row.review_link_url,
    'patientName', patient_row.name,
    'doctorName', doctor_row.name,
    'doctorSpecialty', doctor_row.specialty,
    'doctorStatus', doctor_row.status,
    'doctorDelayMins', doctor_row.delay_mins,
    'doctorStatusNote', doctor_row.status_note,
    'doctorStatusUpdatedAt', doctor_row.status_updated_at,
    'doctorDayClosedAt', doctor_row.day_closed_at,
    'tokenNumber', patient_row.token_number,
    'tokenDisplay', case when patient_row.token_number is null then null
                         when patient_row.token_number > 100000 then 'W' || (patient_row.token_number - 100000)
                         else '#' || patient_row.token_number::text end,
    'status', patient_row.status,
    'type', patient_row.type,
    'bookedDate', patient_row.booked_date,
    'bookedTime', patient_row.booked_time,
    'position', my_position,
    'nowServingToken', now_serving,
    'nowServingCalledAt', now_serving_called_at,
    'nearbyTokens', nearby,
    'windowBookedCount', window_booked_count,
    'windowArrivedCount', window_arrived_count,
    'windowNotArrivedCount', window_notarrived_count,
    'isPriority', patient_row.is_priority,
    'visitFeedbackRating', visit_feedback_row.rating,
    'visitFeedbackSubmitted', visit_feedback_row.rating is not null,
    'visitFeedbackRoutedToReview', coalesce(visit_feedback_row.routed_to_review, false)
  );
end;
$$;

grant execute on function public.get_queue_status(uuid) to anon, authenticated;
