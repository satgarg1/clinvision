-- ============================================================
-- Phase 2 of the live-queue feature — the public queue.html page
-- needs more than just numbers to give someone a real sense of when
-- to leave home: the doctor's current on_time/running_late/on_break/
-- emergency status (same field reception and the display board
-- already show) is exactly that signal, so get_queue_status() now
-- returns it too. Still nothing that identifies any other patient.
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
  nearby jsonb;
begin
  select * into patient_row from public.patients where id = p_patient_id;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;

  select * into clinic_row from public.clinics where id = patient_row.clinic_id;
  select * into doctor_row from public.doctors where id = patient_row.doctor_id;

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
    'tokenNumber', patient_row.token_number,
    'status', patient_row.status,
    'position', case when patient_row.status = 'waiting' then my_position else null end,
    'nearbyTokens', nearby
  );
end;
$$;
