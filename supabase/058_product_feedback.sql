-- ============================================================
-- Qlinic — migration 058: post-visit rating of ClinVision itself,
-- internal product feedback only — NOT the clinic
--
-- Why: scoped in BACKLOG.md 2026-09-01, re-scoped from an earlier
-- "rate the clinic" idea. This is ClinVision's own product-feedback
-- loop, collected on queue.html's "visit complete" screen, asking
-- about the experience of checking status on this link — never about
-- the doctor or the visit itself. The data belongs to ClinVision, not
-- the clinic, which is the one genuinely unusual thing about this
-- table versus everything else in this schema (see the RLS section
-- below).
--
-- Run this once in the Supabase SQL Editor, after
-- 057_consultation_duration.sql.
-- ============================================================

create table public.product_feedback (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null references public.patients(id) on delete cascade,
  rating int not null check (rating between 1 and 5),
  feedback_text text null,
  submitted_at timestamptz not null default now(),
  -- One rating per visit, enforced here (not just client-side) — the
  -- submit_product_feedback() function below also relies on this to
  -- detect "already submitted" via ON CONFLICT rather than a
  -- select-then-insert race.
  unique (patient_id)
);

-- RLS, deliberately unlike every other table in this schema: no select
-- (or insert/update/delete) policy for authenticated at all. Every
-- other table here has a `clinic_id = my_clinic_id()` read policy so a
-- clinic can see its own data — this table has none on purpose, so a
-- logged-in clinic admin querying through the normal app connection
-- can't read it even by accident. The only way in is the Supabase SQL
-- Editor / service role (same access already used for the
-- supabase/checks/ reference queries), and the one write path is the
-- security-definer function below, which runs as the function's owner
-- and isn't blocked by the absence of a policy here.
alter table public.product_feedback enable row level security;

-- Anonymous, no login required — same trust model as get_queue_status:
-- knowing a patient's own id (an unguessable UUID, already the only
-- credential queue.html itself runs on) is what authorizes submitting
-- for that one visit. Validates the visit is actually a completed one
-- before accepting a rating, and is idempotent: calling it again for
-- an already-rated visit does not insert a second row or error, it
-- just reports back that one already exists.
create or replace function public.submit_product_feedback(
  p_patient_id uuid,
  p_rating int,
  p_feedback_text text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  patient_row record;
  inserted_id uuid;
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

  insert into public.product_feedback (clinic_id, patient_id, rating, feedback_text)
  values (patient_row.clinic_id, p_patient_id, p_rating, nullif(trim(p_feedback_text), ''))
  on conflict (patient_id) do nothing
  returning id into inserted_id;

  return jsonb_build_object('alreadySubmitted', inserted_id is null);
end;
$$;

grant execute on function public.submit_product_feedback(uuid, int, text) to anon, authenticated;

-- get_queue_status() extended with one more field — purely additive,
-- same pattern as migration 056: identical body, one new key on the
-- final jsonb_build_object, so queue.html can render the "already
-- rated" state without needing any select access to product_feedback
-- itself (which, per the RLS above, it deliberately can't have).
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
  feedback_submitted boolean;
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

  select exists(select 1 from public.product_feedback where patient_id = p_patient_id) into feedback_submitted;

  return jsonb_build_object(
    'clinicName', clinic_row.name,
    'clinicClosedAt', clinic_row.closed_at,
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
    'feedbackSubmitted', feedback_submitted
  );
end;
$$;

grant execute on function public.get_queue_status(uuid) to anon, authenticated;
