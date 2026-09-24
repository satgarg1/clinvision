-- ============================================================
-- Qlinic — migration 093: date-range filtering for Prescriptions.
--
-- The Prescriptions page's date tab only ever showed a single day
-- (get_clinic_prescriptions_by_date's p_date) — a doctor reviewing what
-- they've written over a period (this week, this month, or a custom
-- range) had no way to ask for that. Rather than a second RPC, this
-- generalizes the existing function with a trailing, optional
-- p_end_date: omitted (the only way anything already calls it), it
-- behaves exactly as before — a single day. Given, it widens the window
-- to an inclusive [p_date, p_end_date] range.
--
-- Run this once in the Supabase SQL Editor, after 089-092.
-- ============================================================

create or replace function public.get_clinic_prescriptions_by_date(p_date date, p_doctor_id uuid default null, p_end_date date default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid;
  v_caller_doctor_id uuid;
  v_end_date date := coalesce(p_end_date, p_date);
begin
  if public.my_role() not in ('admin', 'doctor') then
    raise exception 'Only a doctor or admin can view prescription history.';
  end if;
  v_clinic_id := public.my_clinic_id();
  if public.my_role() = 'doctor' then
    select doctor_id into v_caller_doctor_id from public.profiles where id = auth.uid();
  end if;

  return (
    select coalesce(jsonb_agg(row_to_json(p) order by p.created_at desc), '[]'::jsonb)
    from (
      select
        pr.id, pr.created_at, pr.complaints, pr.diagnosis, pr.advice, pr.follow_up_date,
        pr.vitals_bp, pr.vitals_pulse, pr.vitals_temp, pr.vitals_weight, pr.tests_ordered,
        pat.name as patient_name, pat.age as patient_age, pat.gender as patient_gender, pat.phone as patient_phone,
        doc.id as doctor_id, doc.name as doctor_name, doc.specialty as doctor_specialty, doc.qualification as doctor_qualification, doc.registration_number as doctor_registration_number,
        (
          select coalesce(jsonb_agg(jsonb_build_object(
            'name', coalesce(cm.name, gm.name, pi.free_text_name),
            'composition', nullif(coalesce(cm.generic_name, concat_ws(' + ', nullif(gm.composition_1, ''), nullif(gm.composition_2, ''))), ''),
            'frequency', pi.frequency,
            'durationText', pi.duration_text,
            'instructions', pi.instructions
          ) order by pi.sort_order), '[]'::jsonb)
          from public.prescription_items pi
          left join public.medicines cm on cm.id = pi.clinic_medicine_id
          left join public.generic_medicines gm on gm.id = pi.generic_medicine_id
          where pi.prescription_id = pr.id
        ) as items
      from public.prescriptions pr
      join public.patients pat on pat.id = pr.patient_id
      join public.doctors doc on doc.id = pr.doctor_id
      where pr.clinic_id = v_clinic_id
        and pr.created_at::date between p_date and v_end_date
        and (p_doctor_id is null or pr.doctor_id = p_doctor_id)
        and (v_caller_doctor_id is null or pr.doctor_id = v_caller_doctor_id)
    ) p
  );
end;
$$;
