-- ============================================================
-- Qlinic -- migration 105: fix two problems in migration 104.
--
-- 1. get_queue_status() regression. Migration 104 rewrote the function
--    from migration 058's body ("otherwise identical to 058"), but
--    migration 062 had since added six more fields -- firstCalledAtToday,
--    bookedTodayCount, seenTodayCount, noShowTodayCount,
--    breaksTodayCount, awaySecondsToday -- which queue.html still reads
--    for its "how's today going" lines. 104 silently dropped them.
--    This version is 104's function (review link + visit feedback
--    fields) with 062's fields put back, so nothing is lost.
--
-- 2. submit_visit_feedback(): the comment had no length limit (this RPC
--    is callable anonymously) and a comment could never be cleared,
--    since an empty value fell back to the saved one. Now the text is
--    capped at 2000 characters (also enforced by a table constraint),
--    NULL means "leave the saved comment alone", and an empty/blank
--    string clears it. Callers that only carry a star rating or the
--    "shared on Google" flag pass NULL.
--
-- Run once in the Supabase SQL Editor, after 104_visit_feedback.sql.
-- ============================================================

alter table public.visit_feedback drop constraint if exists visit_feedback_text_len;
alter table public.visit_feedback
  add constraint visit_feedback_text_len check (feedback_text is null or char_length(feedback_text) <= 2000);

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
  clean_text text;
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

  clean_text := case
    when p_feedback_text is null then null
    else nullif(left(trim(p_feedback_text), 2000), '')
  end;

  insert into public.visit_feedback (clinic_id, patient_id, rating, feedback_text, routed_to_review)
  values (patient_row.clinic_id, p_patient_id, p_rating, clean_text, coalesce(p_routed_to_review, false))
  on conflict (patient_id) do update set
    rating = excluded.rating,
    feedback_text = case when p_feedback_text is null then visit_feedback.feedback_text else clean_text end,
    routed_to_review = visit_feedback.routed_to_review or excluded.routed_to_review;

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.submit_visit_feedback(uuid, int, text, boolean) to anon, authenticated;

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
  first_called_at_today timestamptz;
  booked_today_count int;
  seen_today_count int;
  noshow_today_count int;
  breaks_today_count int;
  away_seconds_today numeric;
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

  -- "How's today going" fields from migration 062, all scoped to the
  -- same doctor + clinic-day (patient_row.token_date) as everything above.
  select min(called_at) into first_called_at_today
  from public.patients
  where doctor_id = patient_row.doctor_id and token_date = patient_row.token_date and called_at is not null;

  select
    count(*),
    count(*) filter (where status = 'done'),
    count(*) filter (where status = 'no_show')
  into booked_today_count, seen_today_count, noshow_today_count
  from public.patients
  where doctor_id = patient_row.doctor_id and token_date = patient_row.token_date;

  select
    count(*),
    coalesce(sum(extract(epoch from (coalesce(ended_at, now()) - started_at))), 0)
  into breaks_today_count, away_seconds_today
  from public.doctor_status_log
  where doctor_id = patient_row.doctor_id
    and (started_at at time zone 'Asia/Kolkata')::date = patient_row.token_date;

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
    'visitFeedbackRoutedToReview', coalesce(visit_feedback_row.routed_to_review, false),
    'firstCalledAtToday', first_called_at_today,
    'bookedTodayCount', booked_today_count,
    'seenTodayCount', seen_today_count,
    'noShowTodayCount', noshow_today_count,
    'breaksTodayCount', breaks_today_count,
    'awaySecondsToday', away_seconds_today
  );
end;
$$;

grant execute on function public.get_queue_status(uuid) to anon, authenticated;
