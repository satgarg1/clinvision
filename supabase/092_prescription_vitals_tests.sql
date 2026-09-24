-- ============================================================
-- Qlinic — migration 092: vitals + tests ordered on a prescription.
--
-- Most Indian clinics record a quick set of vitals (BP/pulse/temp/
-- weight) at the top of a prescription, and often order a lab or
-- radiology test right there too (see the Chandra Skin & Maternity
-- Centre reference prescription this feature was scoped against) —
-- both were entirely missing from the prescription module until now.
--
-- Vitals are plain text columns, not numeric: BP is "120/80" (not a
-- single number), and text keeps this from fighting a doctor who
-- writes "98.6" vs "37" for temperature, "afebrile", etc. Tests
-- ordered is a plain text array — these are descriptive labels picked
-- from a fixed list on the client, not billable/priced items that
-- would need their own table.
--
-- Run this once in the Supabase SQL Editor, after 091_prescription_history.sql.
-- ============================================================

alter table public.prescriptions
  add column if not exists vitals_bp text not null default '',
  add column if not exists vitals_pulse text not null default '',
  add column if not exists vitals_temp text not null default '',
  add column if not exists vitals_weight text not null default '',
  add column if not exists tests_ordered text[] not null default '{}';

create or replace function public.create_prescription(
  p_patient_id uuid,
  p_complaints text,
  p_diagnosis text,
  p_advice text,
  p_follow_up_date date,
  p_items jsonb,  -- array of {clinic_medicine_id, generic_medicine_id, free_text_name, frequency, duration_text, instructions}
  p_doctor_id uuid default null,
  p_vitals_bp text default '',
  p_vitals_pulse text default '',
  p_vitals_temp text default '',
  p_vitals_weight text default '',
  p_tests_ordered text[] default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid;
  v_doctor_id uuid;
  v_prescription_id uuid;
  v_item jsonb;
  v_sort int := 0;
begin
  v_clinic_id := public.my_clinic_id();

  if public.my_role() = 'doctor' then
    select doctor_id into v_doctor_id from public.profiles where id = auth.uid();
    if v_doctor_id is null then
      raise exception 'Your account is not linked to a doctor profile.';
    end if;
  elsif public.my_role() = 'admin' then
    if p_doctor_id is null then
      raise exception 'Choose which doctor this prescription is for.';
    end if;
    if not exists (select 1 from public.doctors where id = p_doctor_id and clinic_id = v_clinic_id) then
      raise exception 'Doctor not found in this clinic.';
    end if;
    v_doctor_id := p_doctor_id;
  else
    raise exception 'Only a doctor or admin can write a prescription.';
  end if;

  if not exists (select 1 from public.patients where id = p_patient_id and clinic_id = v_clinic_id) then
    raise exception 'Patient not found in this clinic.';
  end if;
  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    raise exception 'A prescription needs at least one medicine.';
  end if;

  insert into public.prescriptions (
    clinic_id, patient_id, doctor_id, complaints, diagnosis, advice, follow_up_date, created_by,
    vitals_bp, vitals_pulse, vitals_temp, vitals_weight, tests_ordered
  )
  values (
    v_clinic_id, p_patient_id, v_doctor_id, coalesce(p_complaints, ''), coalesce(p_diagnosis, ''), coalesce(p_advice, ''), p_follow_up_date, auth.uid(),
    coalesce(p_vitals_bp, ''), coalesce(p_vitals_pulse, ''), coalesce(p_vitals_temp, ''), coalesce(p_vitals_weight, ''), coalesce(p_tests_ordered, '{}')
  )
  returning id into v_prescription_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    insert into public.prescription_items (
      prescription_id, clinic_medicine_id, generic_medicine_id, free_text_name,
      frequency, duration_text, instructions, sort_order
    ) values (
      v_prescription_id,
      nullif(v_item->>'clinic_medicine_id', '')::uuid,
      nullif(v_item->>'generic_medicine_id', '')::uuid,
      nullif(v_item->>'free_text_name', ''),
      coalesce(v_item->>'frequency', ''),
      coalesce(v_item->>'duration_text', ''),
      coalesce(v_item->>'instructions', ''),
      v_sort
    );
    v_sort := v_sort + 1;
  end loop;

  return v_prescription_id;
end;
$$;

-- The three prescription-history read functions (091) all select
-- pr.* implicitly via named columns, none of which included vitals/
-- tests yet — re-create each adding those fields to its own result row.
create or replace function public.get_patient_prescriptions(p_patient_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid;
begin
  if public.my_role() not in ('admin', 'doctor') then
    raise exception 'Only a doctor or admin can view prescription history.';
  end if;
  v_clinic_id := public.my_clinic_id();
  if not exists (select 1 from public.patients where id = p_patient_id and clinic_id = v_clinic_id) then
    raise exception 'Patient not found in this clinic.';
  end if;

  return (
    select coalesce(jsonb_agg(row_to_json(p) order by p.created_at desc), '[]'::jsonb)
    from (
      select
        pr.id, pr.created_at, pr.complaints, pr.diagnosis, pr.advice, pr.follow_up_date,
        pr.vitals_bp, pr.vitals_pulse, pr.vitals_temp, pr.vitals_weight, pr.tests_ordered,
        pat.name as patient_name, pat.age as patient_age, pat.gender as patient_gender, pat.phone as patient_phone,
        doc.name as doctor_name, doc.specialty as doctor_specialty, doc.qualification as doctor_qualification, doc.registration_number as doctor_registration_number,
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
      where pr.patient_id = p_patient_id and pr.clinic_id = v_clinic_id
    ) p
  );
end;
$$;

create or replace function public.get_clinic_prescriptions_by_date(p_date date, p_doctor_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid;
  v_caller_doctor_id uuid;
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
        and pr.created_at::date = p_date
        and (p_doctor_id is null or pr.doctor_id = p_doctor_id)
        and (v_caller_doctor_id is null or pr.doctor_id = v_caller_doctor_id)
    ) p
  );
end;
$$;

create or replace function public.search_clinic_prescriptions(p_query text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid;
  v_caller_doctor_id uuid;
  v_query text := trim(coalesce(p_query, ''));
begin
  if public.my_role() not in ('admin', 'doctor') then
    raise exception 'Only a doctor or admin can view prescription history.';
  end if;
  if length(v_query) < 2 then
    return '[]'::jsonb;
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
        and (pat.name ilike '%' || v_query || '%' or pat.phone ilike v_query || '%')
        and (v_caller_doctor_id is null or pr.doctor_id = v_caller_doctor_id)
      order by pr.created_at desc
      limit 50
    ) p
  );
end;
$$;
