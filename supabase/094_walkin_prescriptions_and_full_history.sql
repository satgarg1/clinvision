-- ============================================================
-- Qlinic — migration 094: Quick Walk-In prescriptions + full-history list.
--
-- Part A — Quick Walk-In Rx (Option A from the reviewed scope): a
-- prescription no longer strictly needs a linked patients row. patient_id
-- becomes nullable, and four walkin_* columns hold the identity for a
-- prescription written for someone outside the queue/appointment system
-- entirely — a doctor who doesn't manage appointments through this app
-- at all. Deliberately NOT touching the patients table: that table's
-- rows double as queue entries in this schema (status/token_number/
-- arrived_at all live there — see addWalkIn/addAppointment in
-- clinic-data.js), so inserting into it for a walk-in Rx would risk that
-- patient surfacing on Reception's queue or the Display Screen, which is
-- exactly what this feature exists to avoid. The tradeoff, accepted
-- explicitly: no automatic "same person, different visit" linking for a
-- walk-in Rx patient — each one is its own record, searchable by name/
-- phone but not unified into one patient timeline the way a real
-- patients row would be.
--
-- Part B — the Prescriptions page stops defaulting to "today only": it's
-- a history feature, so the default (empty search) view is now every
-- prescription the caller can see, most recent first, not just today's.
-- get_clinic_prescriptions_by_date is left as-is (unused by the client
-- after this, but harmless to keep) rather than removed.
--
-- Run this once in the Supabase SQL Editor, after 089-093.
-- ============================================================

alter table public.prescriptions
  alter column patient_id drop not null;

alter table public.prescriptions
  add column if not exists walkin_name text,
  add column if not exists walkin_age int,
  add column if not exists walkin_gender text,
  add column if not exists walkin_phone text;

alter table public.prescriptions
  drop constraint if exists prescriptions_patient_or_walkin_chk;
alter table public.prescriptions
  add constraint prescriptions_patient_or_walkin_chk
  check (patient_id is not null or walkin_name is not null);

create or replace function public.create_prescription(
  p_patient_id uuid default null,
  p_complaints text default '',
  p_diagnosis text default '',
  p_advice text default '',
  p_follow_up_date date default null,
  p_items jsonb default '[]'::jsonb,
  p_doctor_id uuid default null,
  p_vitals_bp text default '',
  p_vitals_pulse text default '',
  p_vitals_temp text default '',
  p_vitals_weight text default '',
  p_tests_ordered text[] default '{}',
  p_walkin_name text default null,
  p_walkin_age int default null,
  p_walkin_gender text default null,
  p_walkin_phone text default null
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

-- New: every prescription the caller can see, most recent first, capped
-- at a generous limit rather than unbounded — this is the Prescriptions
-- page's new default (empty search) view, replacing the old "today only"
-- default. Same doctor-scoping shape as the other two clinic-wide
-- history functions.
create or replace function public.get_clinic_prescriptions(p_doctor_id uuid default null, p_limit int default 300)
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

-- The two existing clinic-wide history functions need the same
-- LEFT JOIN + walk-in fallback so a walk-in Rx shows up (and is
-- findable by search) the same as a normal one.
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
    select doctor_id into v_caller_doctor_id from public.profiles where id = auth.uid();
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
