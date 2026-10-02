-- ============================================================
-- ClinVision, migration 118: called but not here ("Not here" on the doctor screen).
--
-- When the doctor calls a patient who is not in the room, one tap on Not here moves that patient to
-- the new status 'skipped' (not a no-show, not done: the visit and its bill are untouched) and the
-- doctor's screen then calls the next waiting patient. Only reception or admin put a skipped patient
-- back in line (return_skipped_patient):
--   * back within the clinic's return window (clinics.return_window_mins, default 60 minutes) and not
--     skipped twice: the patient keeps their original place, so they are called right after the patient
--     who is inside;
--   * back later, or skipped a second time on the same visit: they join the end of the line (their
--     arrival time becomes now).
-- The minutes spent away are added to patients.away_seconds when the place is kept, so average waiting
-- times can leave them out.
-- A patient who is still skipped when the day is closed becomes a no-show (done in the app).
-- The patient's own link shows a "called, not here" screen through get_queue_status.
--
-- Safe to run more than once. Run this once in the Supabase SQL Editor, after 117.
-- ============================================================

alter table public.patients add column if not exists skipped_at timestamptz;
alter table public.patients add column if not exists skip_count int not null default 0;
alter table public.patients add column if not exists away_seconds int not null default 0;

alter table public.clinics add column if not exists return_window_mins int not null default 60;
alter table public.clinics drop constraint if exists clinics_return_window_mins_check;
alter table public.clinics add constraint clinics_return_window_mins_check check (return_window_mins between 5 and 240);

-- The new status. The old check list is found by what it contains, whatever it was named.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.patients'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%booked%' and pg_get_constraintdef(oid) ilike '%no_show%'
  loop
    execute format('alter table public.patients drop constraint %I', c.conname);
  end loop;
end
$$;
alter table public.patients add constraint patients_status_check
  check (status in ('booked', 'waiting', 'in_consult', 'done', 'no_show', 'skipped'));

-- ---- Not here: in_consult -> skipped (doctor or admin) ----
create or replace function public.skip_called_patient(p_patient_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_clinic_id uuid;
  v_patient public.patients;
begin
  v_role := coalesce(public.my_role(), '');
  if v_role not in ('admin', 'doctor') then
    raise exception 'Only the doctor or the clinic admin can mark a patient as not here.';
  end if;
  v_clinic_id := public.my_clinic_id();

  select * into v_patient from public.patients
    where id = p_patient_id and clinic_id = v_clinic_id and removed_at is null
    for update;
  if not found then
    raise exception 'That patient was not found.';
  end if;
  if v_role = 'doctor' and v_patient.doctor_id is distinct from public.my_doctor_id() then
    raise exception 'You can only mark your own patients as not here.';
  end if;
  if v_patient.status <> 'in_consult' then
    raise exception 'This patient was already updated on another screen. Please check the queue.';
  end if;

  update public.patients
    set status = 'skipped', skipped_at = now(), skip_count = skip_count + 1
    where id = v_patient.id;

  return jsonb_build_object('ok', true, 'skipCount', v_patient.skip_count + 1);
end;
$$;

-- ---- Undo: skipped -> in_consult again, and the patient called after them goes back to waiting ----
create or replace function public.undo_not_here(p_patient_id uuid, p_next_patient_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_clinic_id uuid;
  v_patient public.patients;
begin
  v_role := coalesce(public.my_role(), '');
  if v_role not in ('admin', 'doctor') then
    raise exception 'Only the doctor or the clinic admin can undo this.';
  end if;
  v_clinic_id := public.my_clinic_id();

  select * into v_patient from public.patients
    where id = p_patient_id and clinic_id = v_clinic_id and removed_at is null
    for update;
  if not found then
    raise exception 'That patient was not found.';
  end if;
  if v_role = 'doctor' and v_patient.doctor_id is distinct from public.my_doctor_id() then
    raise exception 'You can only undo your own patients.';
  end if;
  if v_patient.status <> 'skipped' or v_patient.skipped_at is null or v_patient.skipped_at < now() - interval '2 minutes' then
    raise exception 'It is too late to undo this. Reception can put the patient back in line.';
  end if;

  if p_next_patient_id is not null then
    update public.patients
      set status = 'waiting', called_at = null
      where id = p_next_patient_id and clinic_id = v_clinic_id and doctor_id = v_patient.doctor_id
        and status = 'in_consult' and removed_at is null;
  end if;

  if exists (
    select 1 from public.patients
    where doctor_id = v_patient.doctor_id and token_date = v_patient.token_date
      and status = 'in_consult' and removed_at is null
  ) then
    raise exception 'Someone else is already with the doctor. Reception can put the patient back in line.';
  end if;

  update public.patients
    set status = 'in_consult', skipped_at = null, skip_count = greatest(skip_count - 1, 0)
    where id = v_patient.id;

  return jsonb_build_object('ok', true);
end;
$$;

-- ---- Back in line: skipped -> waiting (reception or admin) ----
create or replace function public.return_skipped_patient(p_patient_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_clinic_id uuid;
  v_patient public.patients;
  v_window int;
  v_keep boolean;
begin
  v_role := coalesce(public.my_role(), '');
  if v_role not in ('admin', 'reception') then
    raise exception 'Only reception or the clinic admin can put a patient back in line.';
  end if;
  v_clinic_id := public.my_clinic_id();

  select * into v_patient from public.patients
    where id = p_patient_id and clinic_id = v_clinic_id and removed_at is null
    for update;
  if not found then
    raise exception 'That patient was not found.';
  end if;
  if v_patient.status <> 'skipped' then
    raise exception 'This patient was already updated by someone else. Refresh to see the latest.';
  end if;

  select coalesce(return_window_mins, 60) into v_window from public.clinics where id = v_clinic_id;

  v_keep := v_patient.skip_count <= 1
    and v_patient.skipped_at is not null
    and now() <= v_patient.skipped_at + make_interval(mins => v_window);

  if v_keep then
    update public.patients
      set status = 'waiting',
          arrived_at = coalesce(arrived_at, now()),
          away_seconds = away_seconds + greatest(0, extract(epoch from (now() - skipped_at))::int),
          skipped_at = null
      where id = v_patient.id;
  else
    update public.patients
      set status = 'waiting', arrived_at = now(), skipped_at = null
      where id = v_patient.id;
  end if;

  return jsonb_build_object('ok', true, 'keptPlace', v_keep);
end;
$$;

-- ---- the nightly close: a patient still skipped when the day ended becomes a no-show too ----
create or replace function public.auto_close_previous_day()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date;
begin
  v_today := (now() at time zone 'Asia/Kolkata')::date;

  update public.patients
  set status = 'no_show'
  where status = 'booked'
    and booked_date < v_today;

  update public.patients
  set status = 'no_show'
  where status = 'skipped'
    and token_date < v_today;

  update public.clinics
  set last_closed_date = v_today - 1, closed_at = now()
  where last_closed_date is distinct from v_today - 1;
end;
$$;

revoke execute on function public.skip_called_patient(uuid) from public, anon;
revoke execute on function public.undo_not_here(uuid, uuid) from public, anon;
revoke execute on function public.return_skipped_patient(uuid) from public, anon;
grant execute on function public.skip_called_patient(uuid) to authenticated;
grant execute on function public.undo_not_here(uuid, uuid) to authenticated;
grant execute on function public.return_skipped_patient(uuid) to authenticated;


-- ---- slot capacity: a skipped patient still counts as active, so coming back never trips the slot limit ----
create or replace function public.enforce_slot_capacity()
returns trigger
language plpgsql
as $$
declare
  clinic_row record;
  interval_mins int;
  bucket_start int;
  active_count int;
  lock_key bigint;
begin
  if new.booked_time is null then
    return new;
  end if;

  -- A row that is not (or no longer) active never takes a slot.
  if new.status not in ('booked', 'waiting', 'in_consult', 'skipped') then
    return new;
  end if;

  -- Same doctor, day and time, still active: a status move within the
  -- active set (booked -> waiting -> in_consult) doesn't change slot
  -- occupancy, so it can't be refused because the bucket was already
  -- full or over capacity.
  if tg_op = 'UPDATE'
     and old.status in ('booked', 'waiting', 'in_consult', 'skipped')
     and new.doctor_id = old.doctor_id
     and new.booked_date is not distinct from old.booked_date
     and new.booked_time is not distinct from old.booked_time then
    return new;
  end if;

  select * into clinic_row from public.clinics where id = new.clinic_id;
  interval_mins := greatest(coalesce(clinic_row.slot_interval_mins, 15), 1);
  bucket_start := (
    (extract(hour from new.booked_time)::int * 60 + extract(minute from new.booked_time)::int)
    / interval_mins
  ) * interval_mins;

  lock_key := hashtextextended(
    new.clinic_id::text || ':' || new.doctor_id::text || ':' || new.booked_date::text || ':' || bucket_start::text,
    0
  );
  perform pg_advisory_xact_lock(lock_key);

  select count(*) into active_count
  from public.patients
  where clinic_id = new.clinic_id
    and doctor_id = new.doctor_id
    and booked_date = new.booked_date
    and booked_time is not null
    and status in ('booked', 'waiting', 'in_consult', 'skipped')
    and id is distinct from new.id
    and (
      (extract(hour from booked_time)::int * 60 + extract(minute from booked_time)::int)
      / interval_mins
    ) * interval_mins = bucket_start;

  if active_count >= coalesce(clinic_row.slot_capacity, 1) then
    raise exception 'This time slot just got full. Please pick another time.';
  end if;

  return new;
end;
$$;

-- ---- patient queue link: adds what the called, not here screen needs ----
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
    and removed_at is null
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
      and removed_at is null
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
      and removed_at is null
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
  where doctor_id = patient_row.doctor_id and token_date = patient_row.token_date and called_at is not null and removed_at is null;

  select
    count(*),
    count(*) filter (where status = 'done'),
    count(*) filter (where status = 'no_show')
  into booked_today_count, seen_today_count, noshow_today_count
  from public.patients
  where doctor_id = patient_row.doctor_id and token_date = patient_row.token_date and removed_at is null;

  select
    count(*),
    coalesce(sum(extract(epoch from (least(coalesce(ended_at, now()), ((started_at at time zone 'Asia/Kolkata')::date + 1)::timestamp at time zone 'Asia/Kolkata') - started_at))), 0)
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
    'doctorGender', doctor_row.gender,
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
    'awaySecondsToday', away_seconds_today,
    'skippedAt', patient_row.skipped_at,
    'skipCount', patient_row.skip_count,
    'calledAt', patient_row.called_at,
    'returnWindowMins', clinic_row.return_window_mins
  );
end;
$$;

grant execute on function public.get_queue_status(uuid) to anon, authenticated;
