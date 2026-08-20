-- ============================================================
-- Unified, impartial queue ordering: doctor-delay clamping, walk-ins
-- with an optional intended time, and a true-emergency priority flag.
--
-- Three problems, worked through with the user across several stress
-- tests, get fixed together here because they're the same underlying
-- formula:
--
-- 1. A doctor's declared delay (running late / on a break, with a
--    duration) used to shift EVERY appointment's scheduled time by the
--    same flat amount, forever — so a 4:00 PM appointment got pushed
--    to 4:30 PM by a 3:05 PM, 30-minute break that's long over by then.
--    Fixed: a delay is a temporary "doctor unavailable until X" floor.
--    Only appointments that would otherwise fall inside that window
--    get pulled forward to X; everything safely after it is untouched.
--
-- 2. Once that clamp exists, a walk-in arriving during the break would
--    rank ahead of the ENTIRE backlog of already-delayed appointment
--    patients, since walk-ins were ordered by raw arrival time with no
--    clamp at all — confirmed with a 24-patient stress scenario where
--    3 of 5 walk-ins would leapfrog the whole backlog. Fixed: the same
--    floor now applies to anyone waiting, walk-in or appointment.
--
-- 3. Multiple patients landing on the exact same delay floor need a
--    tiebreak. token_number (booking order) was rejected — it has no
--    relationship to when someone is actually due to be seen, and can
--    rank an early-arriving patient behind someone who merely booked
--    earlier. Fixed: tiebreak by each patient's own unclamped intended
--    moment (their real slot, or a walk-in's real arrival/assigned
--    time) — this is what keeps a 1:55 PM patient ranked ahead of a
--    2:50 PM patient even when a break pins both to the same "back at
--    3:00" instant. token_number is never used for ordering anymore;
--    created_at is the final, purely technical tiebreak for a genuine
--    coincidence (identical intended moment, same doctor).
--
-- Walk-ins can now optionally carry a real booked_date/booked_time too
-- (a staff-assigned preferred time for a busy desk, instead of always
-- "as soon as possible") — type stays the authoritative walk-in-vs-
-- appointment marker; booked_time being set no longer implies "this is
-- an appointment." A true emergency (is_priority) bypasses all of the
-- above and always goes first.
--
-- This exactly mirrors intendedMoment/effectiveMoment/compareQueueOrder
-- in clinic-data.js — see that file for the client-side version of the
-- same formula, applied identically.
-- ============================================================

alter table public.patients add column if not exists is_priority boolean not null default false;

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
      select coalesce(jsonb_agg(t.token_number), '[]'::jsonb)
      from (
        select token_number
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
    'status', patient_row.status,
    'position', my_position,
    'nowServingToken', now_serving,
    'nearbyTokens', nearby,
    'isPriority', patient_row.is_priority
  );
end;
$$;

grant execute on function public.get_queue_status(uuid) to anon, authenticated;
