-- ============================================================
-- Qlinic — migration 103: reuse public.my_doctor_id() instead of each
-- prescription RPC hand-rolling its own copy of the same lookup.
--
-- create_prescription, get_clinic_prescriptions,
-- get_clinic_prescriptions_by_date, and search_clinic_prescriptions each
-- independently re-derive "which doctor is the caller" with their own
-- copy of:
--
--   select doctor_id into v_doctor_id from public.profiles where id = auth.uid();
--
-- instead of calling public.my_doctor_id() (032_profile_doctor_link.sql),
-- which does exactly this. Four copies of the same lookup, verified live
-- via pg_get_functiondef -- not a bug (every copy computes the same
-- answer), just four places to keep in sync by hand instead of one.
--
-- Behaviorally identical: my_doctor_id() additionally filters
-- `is_active = true`, but every call site below only reaches this line
-- after public.my_role() has already returned 'doctor' or 'admin' --
-- and my_role() itself already requires is_active = true to return
-- anything but null -- so that extra filter never changes the outcome
-- here. get_patient_prescriptions has no such lookup (it doesn't scope
-- by caller doctor at all) and is untouched.
--
-- Each function below is recreated with its EXACT current live
-- signature (confirmed via pg_get_functiondef right before writing
-- this) -- only the doctor-lookup line changes in each; everything
-- else is byte-for-byte identical to what's live today.
--
-- Run this once in the Supabase SQL Editor, after 102_prescription_rls_and_stale_overloads.sql.
-- ============================================================

create or replace function public.create_prescription(
  p_patient_id uuid default null::uuid, p_complaints text default ''::text, p_diagnosis text default ''::text,
  p_advice text default ''::text, p_follow_up_date date default null::date, p_items jsonb default '[]'::jsonb,
  p_doctor_id uuid default null::uuid, p_vitals_bp text default ''::text, p_vitals_pulse text default ''::text,
  p_vitals_temp text default ''::text, p_vitals_weight text default ''::text, p_tests_ordered text[] default '{}'::text[],
  p_walkin_name text default null::text, p_walkin_age integer default null::integer, p_walkin_gender text default null::text,
  p_walkin_phone text default null::text
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
  v_walkin_name text := nullif(trim(coalesce(p_walkin_name, '')), '');
  v_clinic_medicine_id uuid;
begin
  v_clinic_id := public.my_clinic_id();

  if public.my_role() = 'doctor' then
    v_doctor_id := public.my_doctor_id();
    if v_doctor_id is null then
      raise exception 'Your account is not linked to a doctor profile.';
    end if;
  elsif public.my_role() = 'admin' then
    if p_doctor_id is null then
      raise exception 'Choose which doctor this prescription is for.';
    end if;
    if not exists (select 1 from public.doctors where id = p_doctor_id and clinic_id = v_clinic_id and is_active = true) then
      raise exception 'Doctor not found in this clinic.';
    end if;
    v_doctor_id := p_doctor_id;
  else
    raise exception 'Only a doctor or admin can write a prescription.';
  end if;

  if p_patient_id is not null then
    if not exists (select 1 from public.patients where id = p_patient_id and clinic_id = v_clinic_id) then
      raise exception 'Patient not found in this clinic.';
    end if;
  elsif v_walkin_name is null then
    raise exception 'A prescription needs a linked patient or a walk-in name.';
  end if;

  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    raise exception 'A prescription needs at least one medicine.';
  end if;

  insert into public.prescriptions (
    clinic_id, patient_id, doctor_id, complaints, diagnosis, advice, follow_up_date, created_by,
    vitals_bp, vitals_pulse, vitals_temp, vitals_weight, tests_ordered,
    walkin_name, walkin_age, walkin_gender, walkin_phone
  )
  values (
    v_clinic_id, p_patient_id, v_doctor_id, coalesce(p_complaints, ''), coalesce(p_diagnosis, ''), coalesce(p_advice, ''), p_follow_up_date, auth.uid(),
    coalesce(p_vitals_bp, ''), coalesce(p_vitals_pulse, ''), coalesce(p_vitals_temp, ''), coalesce(p_vitals_weight, ''), coalesce(p_tests_ordered, '{}'),
    v_walkin_name, p_walkin_age, nullif(trim(coalesce(p_walkin_gender, '')), ''), nullif(trim(coalesce(p_walkin_phone, '')), '')
  )
  returning id into v_prescription_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_clinic_medicine_id := nullif(v_item->>'clinic_medicine_id', '')::uuid;
    if v_clinic_medicine_id is not null
       and not exists (select 1 from public.medicines where id = v_clinic_medicine_id and clinic_id = v_clinic_id) then
      raise exception 'One of the selected medicines was not found in this clinic.';
    end if;

    insert into public.prescription_items (
      prescription_id, clinic_medicine_id, generic_medicine_id, free_text_name,
      frequency, duration_text, instructions, sort_order
    ) values (
      v_prescription_id,
      v_clinic_medicine_id,
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

create or replace function public.get_clinic_prescriptions(p_doctor_id uuid default null::uuid, p_limit integer default 300)
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
    v_caller_doctor_id := public.my_doctor_id();
    if v_caller_doctor_id is null then
      raise exception 'Your account is not linked to a doctor profile.';
    end if;
  end if;

  return (
    select coalesce(jsonb_agg(row_to_json(p) order by p.created_at desc), '[]'::jsonb)
    from (
      select
        pr.id, pr.created_at, pr.complaints, pr.diagnosis, pr.advice, pr.follow_up_date,
        pr.vitals_bp, pr.vitals_pulse, pr.vitals_temp, pr.vitals_weight, pr.tests_ordered,
        pr.patient_id is null as is_walkin,
        coalesce(pat.name, pr.walkin_name) as patient_name,
        coalesce(pat.age, pr.walkin_age) as patient_age,
        coalesce(pat.gender, pr.walkin_gender) as patient_gender,
        coalesce(pat.phone, pr.walkin_phone) as patient_phone,
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
      left join public.patients pat on pat.id = pr.patient_id
      join public.doctors doc on doc.id = pr.doctor_id
      where pr.clinic_id = v_clinic_id
        and (p_doctor_id is null or pr.doctor_id = p_doctor_id)
        and (v_caller_doctor_id is null or pr.doctor_id = v_caller_doctor_id)
      order by pr.created_at desc
      limit greatest(p_limit, 1)
    ) p
  );
end;
$$;

create or replace function public.get_clinic_prescriptions_by_date(p_date date, p_doctor_id uuid default null::uuid, p_end_date date default null::date)
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
    v_caller_doctor_id := public.my_doctor_id();
    if v_caller_doctor_id is null then
      raise exception 'Your account is not linked to a doctor profile.';
    end if;
  end if;

  return (
    select coalesce(jsonb_agg(row_to_json(p) order by p.created_at desc), '[]'::jsonb)
    from (
      select
        pr.id, pr.created_at, pr.complaints, pr.diagnosis, pr.advice, pr.follow_up_date,
        pr.vitals_bp, pr.vitals_pulse, pr.vitals_temp, pr.vitals_weight, pr.tests_ordered,
        pr.patient_id is null as is_walkin,
        coalesce(pat.name, pr.walkin_name) as patient_name,
        coalesce(pat.age, pr.walkin_age) as patient_age,
        coalesce(pat.gender, pr.walkin_gender) as patient_gender,
        coalesce(pat.phone, pr.walkin_phone) as patient_phone,
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
      left join public.patients pat on pat.id = pr.patient_id
      join public.doctors doc on doc.id = pr.doctor_id
      where pr.clinic_id = v_clinic_id
        and pr.created_at::date between p_date and v_end_date
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
    v_caller_doctor_id := public.my_doctor_id();
    if v_caller_doctor_id is null then
      raise exception 'Your account is not linked to a doctor profile.';
    end if;
  end if;

  return (
    select coalesce(jsonb_agg(row_to_json(p) order by p.created_at desc), '[]'::jsonb)
    from (
      select
        pr.id, pr.created_at, pr.complaints, pr.diagnosis, pr.advice, pr.follow_up_date,
        pr.vitals_bp, pr.vitals_pulse, pr.vitals_temp, pr.vitals_weight, pr.tests_ordered,
        pr.patient_id is null as is_walkin,
        coalesce(pat.name, pr.walkin_name) as patient_name,
        coalesce(pat.age, pr.walkin_age) as patient_age,
        coalesce(pat.gender, pr.walkin_gender) as patient_gender,
        coalesce(pat.phone, pr.walkin_phone) as patient_phone,
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
      left join public.patients pat on pat.id = pr.patient_id
      join public.doctors doc on doc.id = pr.doctor_id
      where pr.clinic_id = v_clinic_id
        and (
          pat.name ilike '%' || v_query || '%' or pat.phone ilike v_query || '%'
          or pr.walkin_name ilike '%' || v_query || '%' or pr.walkin_phone ilike v_query || '%'
        )
        and (v_caller_doctor_id is null or pr.doctor_id = v_caller_doctor_id)
      order by pr.created_at desc
      limit 50
    ) p
  );
end;
$$;
