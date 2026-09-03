-- Backend for BACKLOG.md's "Patient-facing queue details: how's today
-- going" item. Two independent pieces:
--   1. doctor_status_log: new table + trigger, tracks break/emergency
--      history that the schema has never recorded (doctors.status is
--      overwritten on every change, no history to count or sum).
--   2. get_queue_status() extended with 5 new fields, same
--      identical-body-plus-new-keys pattern migrations 056 and 058
--      already used -- purely additive, nothing existing changes shape.
-- queue.html's own UI work (re-anchored labels, the distance threshold,
-- rendering these new fields as sentences) is a separate follow-up, not
-- part of this migration.

-- ---------------- doctor_status_log ----------------
-- One row per break/emergency period, not one row per status change --
-- doctors.status has 4 values (on_time/running_late/on_break/emergency,
-- schema.sql), and only on_break/emergency are logged here.
-- running_late is deliberately excluded: it's a pace signal already
-- captured via doctors.delay_mins (returned as doctorDelayMins), not
-- the doctor being physically away, so it isn't "time away" in the
-- sense this table tracks. ended_at null means still ongoing (the
-- doctor hasn't come back yet) -- see log_doctor_status_change() below
-- for how the ongoing case counts toward "today's total so far."
create table public.doctor_status_log (
  id uuid primary key default gen_random_uuid(),
  doctor_id uuid not null references public.doctors(id) on delete cascade,
  status text not null check (status in ('on_break', 'emergency')),
  note text null,
  started_at timestamptz not null default now(),
  ended_at timestamptz null
);

create index doctor_status_log_doctor_started_idx on public.doctor_status_log (doctor_id, started_at desc);

alter table public.doctor_status_log enable row level security;
-- No select/insert/update/delete policy for anon or authenticated, on
-- purpose -- this is written only by the trigger below (which runs as
-- the table owner, RLS doesn't apply to it) and read only through
-- get_queue_status()'s own security definer function. Same
-- "deliberate, narrow, checked exception" shape as product_feedback
-- (migration 058).

-- Fires on every doctors.status change (setDoctorStatus in
-- clinic-data.js is the only call site today, but this is a trigger
-- specifically so it stays correct even if status is ever changed
-- another way -- a manual SQL update, a future admin tool -- rather
-- than depending on every future call site remembering to also write
-- here).
create or replace function public.log_doctor_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status then
    -- Close out whatever away period was open, regardless of what the
    -- doctor is transitioning to -- handles on_break -> emergency (or
    -- vice versa) without going through on_time in between, not just
    -- the away -> on_time case.
    update public.doctor_status_log
    set ended_at = now()
    where doctor_id = new.id and ended_at is null;

    -- Only open a new period if the new status is itself an away
    -- status -- transitioning to on_time/running_late closes the old
    -- period above and stops there.
    if new.status in ('on_break', 'emergency') then
      insert into public.doctor_status_log (doctor_id, status, note, started_at)
      values (new.id, new.status, new.status_note, now());
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists doctor_status_change_log on public.doctors;
create trigger doctor_status_change_log
after update of status on public.doctors
for each row execute function public.log_doctor_status_change();

-- ---------------- get_queue_status(): 5 new fields ----------------
-- Identical body to migration 058's version, plus:
--   firstCalledAtToday, bookedTodayCount, seenTodayCount,
--   noShowTodayCount, breaksTodayCount, awaySecondsToday
-- All scoped to patient_row.token_date (the same "today" the existing
-- window counts already use), not a separately-computed calendar date
-- -- keeps every number in this response anchored to the same clinic-
-- day definition.
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

  select exists(select 1 from public.product_feedback where patient_id = p_patient_id) into feedback_submitted;

  -- "How's today going" fields, all scoped to the same doctor + the
  -- same clinic-day (patient_row.token_date) as everything above.
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
    'feedbackSubmitted', feedback_submitted,
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
