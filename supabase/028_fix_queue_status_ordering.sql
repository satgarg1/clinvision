-- ============================================================
-- Fix get_queue_status() to report real serving order, not booking order.
--
-- token_number is assigned once, at booking time, in booking order
-- (007_token_numbers.sql). But who's actually called next is decided
-- separately, client-side, by clinic-data.js's effectiveMoment()/
-- byMomentThenToken() — sorted by scheduled appointment time (plus the
-- doctor's live delay) or arrival time for walk-ins, whichever is
-- later. A patient who booked later for an earlier slot is correctly
-- served before someone who booked first for a later slot.
--
-- get_queue_status() — the RPC behind the patient's own, no-login
-- queue.html link — never knew about any of that: its "position" and
-- "nearbyTokens" queries compared raw token_number instead. So the one
-- page built specifically for a patient checking their wait from home
-- was answering with the wrong math, out of step with what reception
-- and the doctor actually see. This rewrite mirrors the exact same
-- effective-moment logic in SQL so both agree.
--
-- Effective moment per waiting patient:
--   walk-in:      coalesce(arrived_at, now())
--   appointment:  greatest(
--                   (booked_date + booked_time) at time zone 'Asia/Kolkata'
--                     + doctor's current delay_mins,
--                   coalesce(arrived_at, '-infinity')
--                 )
-- booked_date/booked_time are naive date/time columns interpreted by
-- the client as local wall-clock time; this app is India-only, so an
-- explicit Asia/Kolkata cast is used rather than trusting Supabase's
-- session timezone (UTC by default), which would shift every
-- appointment's effective moment by 5.5 hours.
--
-- Ties (same effective moment) fall back to token_number, same as
-- byMomentThenToken() client-side.
--
-- No schema change. token_number assignment itself (007, and the race
-- fix in 027) is untouched — only how "position"/"nearbyTokens" order
-- the *already-assigned* tokens changes. nearbyTokens can now
-- legitimately return a non-ascending list (e.g. #3, #2, #1) when
-- booking order and slot order disagree — that's correct, not a bug:
-- it's the same order reception/doctor's waiting tables already show.
-- ============================================================

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
  now_serving int;
  nearby jsonb;
begin
  select * into patient_row from public.patients where id = p_patient_id;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;

  select * into clinic_row from public.clinics where id = patient_row.clinic_id;
  select * into doctor_row from public.doctors where id = patient_row.doctor_id;

  select token_number into now_serving
  from public.patients
  where doctor_id = patient_row.doctor_id
    and token_date = patient_row.token_date
    and status = 'in_consult'
  limit 1;

  -- One CTE, reused by both the position count and the nearby-tokens
  -- list below — the waiting pool for this doctor/day, each row's
  -- effective moment computed the same way clinic-data.js computes it
  -- client-side (see header comment).
  with waiting as (
    select
      id,
      token_number,
      case
        when type = 'walkin' then coalesce(arrived_at, now())
        else greatest(
          ((booked_date + booked_time) at time zone 'Asia/Kolkata'),
          coalesce(arrived_at, '-infinity'::timestamptz)
        ) + (coalesce(doctor_row.delay_mins, 0) * interval '1 minute')
      end as eff_moment
    from public.patients
    where doctor_id = patient_row.doctor_id
      and token_date = patient_row.token_date
      and status = 'waiting'
      and token_number is not null
  )
  select
    case when patient_row.status = 'waiting' then (
      select count(*) + 1
      from waiting w, waiting me
      where me.id = p_patient_id
        and (w.eff_moment, w.token_number) < (me.eff_moment, me.token_number)
    ) end,
    (
      select coalesce(jsonb_agg(t.token_number), '[]'::jsonb)
      from (select token_number from waiting order by eff_moment, token_number limit 5) t
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
    'status', patient_row.status,
    'position', my_position,
    'nowServingToken', now_serving,
    'nearbyTokens', nearby
  );
end;
$$;

grant execute on function public.get_queue_status(uuid) to anon, authenticated;
