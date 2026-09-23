-- ============================================================
-- Qlinic — migration 090: admin can write a prescription for any
-- doctor in their clinic, same trust model create_invoice() already
-- uses (052_create_invoice_patient_id.sql: admin/reception pass an
-- explicit p_doctor_id, validated against their own clinic).
--
-- create_prescription() originally only resolved doctor_id from the
-- CALLER's own profiles.doctor_id link, which meant an admin account
-- (never linked to a doctor row) could never save a prescription at
-- all, even when helping a doctor print one during a busy clinic —
-- a real workflow, not a misuse of the feature. A doctor caller still
-- can only ever write for themselves; only admin gets to pick.
--
-- Adding p_doctor_id as a new trailing parameter with a default keeps
-- this a plain create-or-replace (same name, same leading parameters,
-- in the same order) rather than a drop+recreate.
--
-- Run this once in the Supabase SQL Editor, after 089_medicines_doctor_read.sql.
-- ============================================================

create or replace function public.create_prescription(
  p_patient_id uuid,
  p_complaints text,
  p_diagnosis text,
  p_advice text,
  p_follow_up_date date,
  p_items jsonb,  -- array of {clinic_medicine_id, generic_medicine_id, free_text_name, frequency, duration_text, instructions}
  p_doctor_id uuid default null
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
    -- A doctor can only ever write for themselves, regardless of what
    -- p_doctor_id the client sent.
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

  insert into public.prescriptions (clinic_id, patient_id, doctor_id, complaints, diagnosis, advice, follow_up_date, created_by)
  values (v_clinic_id, p_patient_id, v_doctor_id, coalesce(p_complaints, ''), coalesce(p_diagnosis, ''), coalesce(p_advice, ''), p_follow_up_date, auth.uid())
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
