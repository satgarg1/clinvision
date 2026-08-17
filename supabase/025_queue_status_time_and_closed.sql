-- ============================================================
-- Qlinic — migration 025: expose doctor status start-time and
-- day-closed state on the public per-patient queue link.
--
-- Why: get_queue_status() already returns doctorStatus/doctorDelayMins
-- (migration 009), which queue.html renders as a badge like "On a
-- break · +30m". Patients checking that link from home should have
-- the same information the waiting-room display screen has, which
-- already shows exactly when a delay/break started (not just its
-- length), and whether the doctor has closed for the day. Both
-- source columns (doctors.status_updated_at, doctors.day_closed_at)
-- already exist — this is purely additive to the RPC's return
-- payload, no schema change, no risk to any existing caller.
--
-- Run this once in the Supabase SQL Editor, after 024_invoice_date.sql.
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

  select count(*) + 1 into my_position
  from public.patients
  where doctor_id = patient_row.doctor_id
    and token_date = patient_row.token_date
    and status = 'waiting'
    and token_number is not null
    and token_number < patient_row.token_number;

  select coalesce(jsonb_agg(t.token_number order by t.token_number), '[]'::jsonb)
  into nearby
  from (
    select token_number
    from public.patients
    where doctor_id = patient_row.doctor_id
      and token_date = patient_row.token_date
      and status = 'waiting'
      and token_number is not null
    order by token_number
    limit 5
  ) t;

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
    'position', case when patient_row.status = 'waiting' then my_position else null end,
    'nowServingToken', now_serving,
    'nearbyTokens', nearby
  );
end;
$$;
