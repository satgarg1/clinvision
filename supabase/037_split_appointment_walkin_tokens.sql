-- ============================================================
-- Qlinic — migration 037: separate token-number counters for
-- appointments and walk-ins.
--
-- Why: assign_token_number() (027) draws every patient — appointment
-- or walk-in — from ONE shared per-(doctor, day) counter. A walk-in
-- inserted between two phone bookings silently consumes the next
-- number, so an appointment booked afterward gets a higher number
-- than reception was told to expect (e.g. patient #21 quoted over the
-- phone actually lands on #22, because a walk-in took #21 in between).
-- This does NOT affect who's actually called next — actual serving
-- order has been based on scheduled time, not token_number, since 029
-- — but the ticket number itself visibly drifted, which is confusing
-- on its own.
--
-- Fix: scope the trigger's max() lookup by type, so appointments get a
-- clean 1, 2, 3... sequence untouched by walk-ins. Walk-ins get their
-- own 1, 2, 3... sequence too, offset by WALKIN_TOKEN_OFFSET (100000)
-- so the two numbering spaces can never collide within a single
-- (doctor, day) — a volume no real clinic will ever approach. This is
-- also exactly the "W1, W2..." rank doctor.html/display.html already
-- computed client-side for display, now made the REAL, stable number
-- instead of a derived one.
--
-- get_queue_status() is updated to match: any raw token_number over
-- the offset is a walk-in by construction, so 'nowServingToken',
-- 'nearbyTokens', and the patient's own token now come back as
-- ready-to-display strings ('#12' or 'W3') instead of bare integers —
-- queue.html no longer needs to guess a prefix itself.
--
-- Note for whoever runs this: existing walk-in rows from before this
-- migration keep their OLD small token_number (assigned under the
-- shared counter) — they will not retroactively land in the 100000+
-- range, so a very old/finished walk-in's queue.html link may briefly
-- show a small "W" number that looks odd if ever revisited. Only new
-- walk-ins created after this runs get the new, stable numbering.
--
-- Run this once in the Supabase SQL Editor, after 036_schedule_interval_mins.sql.
-- ============================================================

create or replace function public.assign_token_number()
returns trigger
language plpgsql
as $$
begin
  if new.token_number is null then
    perform pg_advisory_xact_lock(hashtext(new.doctor_id::text || ':' || new.token_date::text)::bigint);

    if new.type = 'walkin' then
      select coalesce(max(token_number), 100000) + 1
      into new.token_number
      from public.patients
      where clinic_id = new.clinic_id
        and doctor_id = new.doctor_id
        and token_date = new.token_date
        and type = 'walkin';
    else
      select coalesce(max(token_number), 0) + 1
      into new.token_number
      from public.patients
      where clinic_id = new.clinic_id
        and doctor_id = new.doctor_id
        and token_date = new.token_date
        and type = 'appointment';
    end if;
  end if;
  return new;
end;
$$;

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
  nearby jsonb;
begin
  select * into patient_row from public.patients where id = p_patient_id;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;

  select * into clinic_row from public.clinics where id = patient_row.clinic_id;
  select * into doctor_row from public.doctors where id = patient_row.doctor_id;

  -- token_number over 100000 is a walk-in by construction (see
  -- assign_token_number above) — no separate type lookup needed here.
  select case when token_number > 100000 then 'W' || (token_number - 100000) else '#' || token_number::text end
  into now_serving
  from public.patients
  where doctor_id = patient_row.doctor_id
    and token_date = patient_row.token_date
    and status = 'in_consult'
  limit 1;

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

  return jsonb_build_object(
    'clinicName', clinic_row.name,
    'doctorName', doctor_row.name,
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
    'position', my_position,
    'nowServingToken', now_serving,
    'nearbyTokens', nearby,
    'isPriority', patient_row.is_priority
  );
end;
$$;

grant execute on function public.get_queue_status(uuid) to anon, authenticated;
