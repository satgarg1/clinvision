-- ============================================================
-- Qlinic — migration 091: prescription history.
--
-- Backs two things: the "View past prescriptions" shortcut inside
-- Write Prescription (continuity of care for a single patient, any
-- doctor's prescriptions for them), and the new Prescriptions page
-- (a clinic-wide Today view + patient search, admin/doctor only).
--
-- 088_prescriptions.sql's own select policies never checked role at
-- all ("clinic staff select prescriptions" — any clinic staff,
-- reception included). That was fine when nothing in the UI actually
-- read this data back; now that something does, it's tightened to
-- admin/doctor, same as every RPC below re-checks internally too
-- (security definer bypasses RLS for its own queries, so the function
-- body is the real gate, not just the table policy).
--
-- Run this once in the Supabase SQL Editor, after 090_prescriptions_admin_write.sql.
-- ============================================================

drop policy if exists "clinic staff select prescriptions" on public.prescriptions;
create policy "admin or doctor select prescriptions" on public.prescriptions
  for select using (
    clinic_id = public.my_clinic_id()
    and public.my_role() in ('admin', 'doctor')
  );

drop policy if exists "clinic staff select prescription items" on public.prescription_items;
create policy "admin or doctor select prescription items" on public.prescription_items
  for select using (
    exists (
      select 1 from public.prescriptions p
      where p.id = prescription_id and p.clinic_id = public.my_clinic_id()
    )
    and public.my_role() in ('admin', 'doctor')
  );

-- One patient's full history, any doctor's prescriptions for them — a
-- doctor seeing a colleague's prescription for a shared patient is the
-- actual point (continuity of care), so this one is deliberately not
-- narrowed to "my own prescriptions only" the way the two below are.
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

grant execute on function public.get_patient_prescriptions(uuid) to authenticated;

-- Clinic-wide, one calendar day — the Prescriptions page's "Today" tab.
-- A doctor only sees their own written prescriptions here (not a
-- colleague's) — unlike get_patient_prescriptions above, this is
-- browsing the whole clinic's activity, not one shared patient's care.
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

grant execute on function public.get_clinic_prescriptions_by_date(date, uuid) to authenticated;

-- Clinic-wide, by patient name or phone — the Prescriptions page's
-- "Search a patient" tab. Same doctor-narrowing as the by-date function
-- above, same reasoning.
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

grant execute on function public.search_clinic_prescriptions(text) to authenticated;
