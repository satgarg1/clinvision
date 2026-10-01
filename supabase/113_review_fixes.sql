-- ============================================================
-- ClinVision, migration 113: fixes from the second pre deployment review.
--
--  1. patients: a visit must use a doctor of the same clinic. Staff of one clinic could point a
--     patient row at another clinic's doctor id (blocking that doctor's bookings for a day, or
--     reading that doctor's queue). A trigger now rejects it.
--  2. get_outstanding_invoices(): the unpaid bills, filtered in the database instead of the
--     browser downloading every bill ever created.
--  3. A bill can no longer record more received than the bill amount (a typo of 5000 for 500
--     inflated collected revenue). Consultation bills only; pharmacy sales are left as they are.
--  4. Prescriptions by date use the India day, not the UTC day.
--  5. The break time on the patient link stops at the end of its own day, so a break left open
--     when the doctor closed the day no longer grows all night.
--  6. A doctor can only insert a prescription in their own name (the create_prescription
--     function already enforced this; a direct insert did not).
--  7. Patient deletion is admin only (it also deletes the visit's prescriptions).
--  8. The old anonymous product feedback function is closed (the queue page stopped using it).
--  9. Clinic logos: only the clinic admin can change them, and anonymous visitors can no longer
--     list the folder names (the clinic ids). Public logo links keep working.
--
-- Safe to run more than once. Run this once in the Supabase SQL Editor, after 112.
-- ============================================================

-- 1. patients: doctor must belong to the same clinic -----------------------------------------
create or replace function public.patients_check_doctor_clinic()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.doctor_id is not null and not exists (
    select 1 from public.doctors d where d.id = new.doctor_id and d.clinic_id = new.clinic_id
  ) then
    raise exception 'That doctor does not belong to this clinic.';
  end if;
  return new;
end;
$$;

drop trigger if exists patients_check_doctor_clinic on public.patients;
create trigger patients_check_doctor_clinic
  before insert or update of doctor_id, clinic_id on public.patients
  for each row execute function public.patients_check_doctor_clinic();

-- 2. unpaid bills in the database ------------------------------------------------------------
create or replace function public.get_outstanding_invoices()
returns setof public.invoices
language sql
stable
security invoker
set search_path = public
as $$
  select * from public.invoices
  where invoice_type = 'consultation'
    and amount > coalesce(amount_received, amount)
  order by invoice_date asc, id asc;
$$;

grant execute on function public.get_outstanding_invoices() to authenticated;

-- 3. bills cannot receive more than the bill -------------------------------------------------
create or replace function public.create_invoice(
  p_doctor_id uuid,
  p_fee_type text,
  p_patient_name text,
  p_patient_phone text,
  p_patient_address text,
  p_patient_age int,
  p_patient_gender text,
  p_payment_mode text,
  p_amount_received numeric,
  p_invoice_date date default current_date,
  p_patient_id uuid default null
)
returns public.invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid;
  v_amount numeric(10, 2);
  v_invoice_number integer;
  v_row public.invoices;
begin
  if public.my_role() not in ('admin', 'reception') then
    raise exception 'Only clinic admin or reception can create a bill.';
  end if;
  if p_fee_type not in ('consultation', 'emergency') then
    raise exception 'Invalid fee type.';
  end if;
  if p_payment_mode not in ('cash', 'upi', 'card') then
    raise exception 'Invalid payment mode.';
  end if;
  if p_amount_received is not null and p_amount_received < 0 then
    raise exception 'Amount received cannot be negative.';
  end if;

  v_clinic_id := public.my_clinic_id();

  if p_patient_id is not null then
    if not exists (select 1 from public.patients where id = p_patient_id and clinic_id = v_clinic_id) then
      raise exception 'Patient not found in this clinic.';
    end if;
    if exists (select 1 from public.invoices where patient_id = p_patient_id and invoice_type = 'consultation') then
      raise exception 'An invoice for this visit has already been created.';
    end if;
  end if;

  select case when p_fee_type = 'consultation' then fee_normal else fee_emergency end
    into v_amount
    from public.doctors
    where id = p_doctor_id and clinic_id = v_clinic_id;

  if v_amount is null then
    raise exception 'Doctor not found in this clinic.';
  end if;
  if p_amount_received is not null and p_amount_received > v_amount then
    raise exception 'Amount received cannot be more than the bill amount.';
  end if;

  update public.clinics
    set next_invoice_number = next_invoice_number + 1
    where id = v_clinic_id
    returning next_invoice_number - 1 into v_invoice_number;

  insert into public.invoices (
    clinic_id, invoice_number, doctor_id, fee_type, amount,
    patient_name, patient_phone, patient_address, patient_age, patient_gender,
    payment_mode, amount_received, invoice_date, created_by, patient_id
  ) values (
    v_clinic_id, v_invoice_number, p_doctor_id, p_fee_type, v_amount,
    p_patient_name, p_patient_phone, p_patient_address, p_patient_age, p_patient_gender,
    p_payment_mode, coalesce(p_amount_received, v_amount), coalesce(p_invoice_date, current_date), auth.uid(), p_patient_id
  )
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.update_invoice_payment(
  p_invoice_id uuid,
  p_fee_type text,
  p_payment_mode text,
  p_amount_received numeric
)
returns public.invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid;
  v_doctor_id uuid;
  v_old_fee_type text;
  v_old_amount numeric(10, 2);
  v_amount numeric(10, 2);
  v_row public.invoices;
begin
  if public.my_role() not in ('admin', 'reception') then
    raise exception 'Only clinic admin or reception can edit a bill.';
  end if;
  if p_fee_type not in ('consultation', 'emergency', 'waived') then
    raise exception 'Invalid fee type.';
  end if;
  if p_payment_mode not in ('cash', 'upi', 'card') then
    raise exception 'Invalid payment mode.';
  end if;
  if p_amount_received is not null and p_amount_received < 0 then
    raise exception 'Amount received cannot be negative.';
  end if;

  v_clinic_id := public.my_clinic_id();

  select doctor_id, fee_type, amount into v_doctor_id, v_old_fee_type, v_old_amount
    from public.invoices
    where id = p_invoice_id and clinic_id = v_clinic_id;

  if v_doctor_id is null then
    raise exception 'Invoice not found in this clinic.';
  end if;

  if p_fee_type = 'waived' then
    v_amount := 0;
  elsif p_fee_type = v_old_fee_type then
    -- Same fee type as billed: keep the amount that was charged. Only
    -- switching the fee type reprices, at the doctor's current fee.
    v_amount := v_old_amount;
  else
    select case when p_fee_type = 'consultation' then fee_normal else fee_emergency end
      into v_amount
      from public.doctors
      where id = v_doctor_id;
  end if;

  if p_amount_received is not null and p_amount_received > v_amount then
    raise exception 'Amount received cannot be more than the bill amount.';
  end if;

  update public.invoices
    set fee_type = p_fee_type,
        amount = v_amount,
        payment_mode = p_payment_mode,
        amount_received = coalesce(p_amount_received, v_amount)
    where id = p_invoice_id and clinic_id = v_clinic_id
    returning * into v_row;

  return v_row;
end;
$$;

-- 4. prescriptions by India date ---------------------------------------------------------------
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
        and (pr.created_at at time zone 'Asia/Kolkata')::date between p_date and v_end_date
        and (p_doctor_id is null or pr.doctor_id = p_doctor_id)
        and (v_caller_doctor_id is null or pr.doctor_id = v_caller_doctor_id)
    ) p
  );
end;
$$;

-- 5. break time stops at the end of its own day -----------------------------------------------
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
  now_serving text;
  now_serving_called_at timestamptz;
  nearby jsonb;
  my_effective_moment timestamptz;
  window_booked_count int;
  window_arrived_count int;
  window_notarrived_count int;
  visit_feedback_row record;
  first_called_at_today timestamptz;
  booked_today_count int;
  seen_today_count int;
  noshow_today_count int;
  breaks_today_count int;
  away_seconds_today numeric;
begin
  select * into patient_row from public.patients where id = p_patient_id;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;

  select * into clinic_row from public.clinics where id = patient_row.clinic_id;
  select * into doctor_row from public.doctors where id = patient_row.doctor_id;

  select
    case when token_number > 100000 then 'W' || (token_number - 100000) else '#' || token_number::text end,
    called_at
  into now_serving, now_serving_called_at
  from public.patients
  where doctor_id = patient_row.doctor_id
    and token_date = patient_row.token_date
    and status = 'in_consult'
  limit 1;

  my_effective_moment := case
    when patient_row.booked_date is not null and patient_row.booked_time is not null
      then (patient_row.booked_date + patient_row.booked_time) at time zone 'Asia/Kolkata'
    else coalesce(patient_row.arrived_at, now())
  end;

  with window_patients as (
    select
      status,
      case
        when booked_date is not null and booked_time is not null
          then (booked_date + booked_time) at time zone 'Asia/Kolkata'
        else coalesce(arrived_at, now())
      end as effective_moment
    from public.patients
    where doctor_id = patient_row.doctor_id
      and token_date = patient_row.token_date
      and status in ('booked', 'waiting', 'in_consult')
  )
  select
    count(*) filter (where effective_moment <= my_effective_moment),
    count(*) filter (where effective_moment <= my_effective_moment and status in ('waiting', 'in_consult')),
    count(*) filter (where effective_moment <= my_effective_moment and status = 'booked')
  into window_booked_count, window_arrived_count, window_notarrived_count
  from window_patients;

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
      select coalesce(jsonb_agg(t.display_token), '[]'::jsonb)
      from (
        select case when token_number > 100000 then 'W' || (token_number - 100000) else '#' || token_number::text end as display_token
        from computed
        order by (not is_priority), effective_moment, intended_moment, created_at
        limit 5
      ) t
    )
  into my_position, nearby;

  select rating, routed_to_review into visit_feedback_row from public.visit_feedback where patient_id = p_patient_id;

  -- "How's today going" fields from migration 062, all scoped to the
  -- same doctor + clinic-day (patient_row.token_date) as everything above.
  select min(called_at) into first_called_at_today
  from public.patients
  where doctor_id = patient_row.doctor_id and token_date = patient_row.token_date and called_at is not null;

  select
    count(*),
    count(*) filter (where status = 'done'),
    count(*) filter (where status = 'no_show')
  into booked_today_count, seen_today_count, noshow_today_count
  from public.patients
  where doctor_id = patient_row.doctor_id and token_date = patient_row.token_date;

  select
    count(*),
    coalesce(sum(extract(epoch from (least(coalesce(ended_at, now()), ((started_at at time zone 'Asia/Kolkata')::date + 1)::timestamp at time zone 'Asia/Kolkata') - started_at))), 0)
  into breaks_today_count, away_seconds_today
  from public.doctor_status_log
  where doctor_id = patient_row.doctor_id
    and (started_at at time zone 'Asia/Kolkata')::date = patient_row.token_date;

  return jsonb_build_object(
    'clinicName', clinic_row.name,
    'clinicClosedAt', clinic_row.closed_at,
    'reviewLinkUrl', clinic_row.review_link_url,
    'patientName', patient_row.name,
    'doctorName', doctor_row.name,
    'doctorSpecialty', doctor_row.specialty,
    'doctorGender', doctor_row.gender,
    'doctorStatus', doctor_row.status,
    'doctorDelayMins', doctor_row.delay_mins,
    'doctorStatusNote', doctor_row.status_note,
    'doctorStatusUpdatedAt', doctor_row.status_updated_at,
    'doctorDayClosedAt', doctor_row.day_closed_at,
    'tokenNumber', patient_row.token_number,
    'tokenDisplay', case when patient_row.token_number is null then null
                         when patient_row.token_number > 100000 then 'W' || (patient_row.token_number - 100000)
                         else '#' || patient_row.token_number::text end,
    'status', patient_row.status,
    'type', patient_row.type,
    'bookedDate', patient_row.booked_date,
    'bookedTime', patient_row.booked_time,
    'position', my_position,
    'nowServingToken', now_serving,
    'nowServingCalledAt', now_serving_called_at,
    'nearbyTokens', nearby,
    'windowBookedCount', window_booked_count,
    'windowArrivedCount', window_arrived_count,
    'windowNotArrivedCount', window_notarrived_count,
    'isPriority', patient_row.is_priority,
    'visitFeedbackRating', visit_feedback_row.rating,
    'visitFeedbackSubmitted', visit_feedback_row.rating is not null,
    'visitFeedbackRoutedToReview', coalesce(visit_feedback_row.routed_to_review, false),
    'firstCalledAtToday', first_called_at_today,
    'bookedTodayCount', booked_today_count,
    'seenTodayCount', seen_today_count,
    'noShowTodayCount', noshow_today_count,
    'breaksTodayCount', breaks_today_count,
    'awaySecondsToday', away_seconds_today
  );
end;
$$;

grant execute on function public.get_queue_status(uuid) to anon, authenticated;


-- 6. prescriptions: a doctor writes in their own name only ------------------------------------
drop policy if exists "admin or doctor insert prescriptions" on public.prescriptions;
create policy "admin or doctor insert prescriptions" on public.prescriptions
  for insert with check (
    clinic_id = public.my_clinic_id()
    and public.my_role() in ('admin', 'doctor')
    and (public.my_role() = 'admin' or doctor_id = public.my_doctor_id())
    and exists (
      select 1 from public.patients p
      where p.id = prescriptions.patient_id and p.clinic_id = prescriptions.clinic_id
    )
    and exists (
      select 1 from public.doctors d
      where d.id = prescriptions.doctor_id and d.clinic_id = prescriptions.clinic_id
    )
  );

-- 7. patient deletion: admin only -------------------------------------------------------------
drop policy if exists "clinic staff patients delete" on public.patients;
create policy "clinic staff patients delete" on public.patients
  for delete using (clinic_id = public.my_clinic_id() and public.my_role() = 'admin');

-- 8. close the old anonymous product feedback function ---------------------------------------
revoke execute on function public.submit_product_feedback(uuid, int, text) from public, anon, authenticated;

-- 9. clinic logos -----------------------------------------------------------------------------
drop policy if exists "clinic logos public read" on storage.objects;
create policy "clinic logos own folder read" on storage.objects
  for select to authenticated
  using (bucket_id = 'clinic-logos' and (storage.foldername(name))[1]::uuid = public.my_clinic_id());

drop policy if exists "clinic logos own folder insert" on storage.objects;
create policy "clinic logos own folder insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'clinic-logos' and (storage.foldername(name))[1]::uuid = public.my_clinic_id() and public.my_role() = 'admin');

drop policy if exists "clinic logos own folder update" on storage.objects;
create policy "clinic logos own folder update" on storage.objects
  for update to authenticated
  using (bucket_id = 'clinic-logos' and (storage.foldername(name))[1]::uuid = public.my_clinic_id() and public.my_role() = 'admin');

drop policy if exists "clinic logos own folder delete" on storage.objects;
create policy "clinic logos own folder delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'clinic-logos' and (storage.foldername(name))[1]::uuid = public.my_clinic_id() and public.my_role() = 'admin');

update storage.buckets set file_size_limit = 2097152 where id = 'clinic-logos';
