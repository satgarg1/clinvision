-- ============================================================
-- ClinVision, migration 117: remove a patient added by mistake (Revenue, Adjust, Remove patient).
--
-- A removed visit is hidden, not deleted. The patient row and its consultation bill get a
-- removed_at time and the admin who did it, and every screen stops showing them:
--   * patients and invoices: the row level security select policies now skip removed rows, so every
--     page that reads those tables directly (Reception, Dashboard, Revenue, Insights, No-shows, End
--     of day, Doctor View) drops them without any change;
--   * the database functions that bypass that security (patient link counts, waiting room board,
--     Patient Directory, Billing Audit, pharmacy patient search, prescriptions, platform admin
--     volume) now filter removed rows themselves;
--   * a rating from a removed patient is kept but never shown on Patient Feedback;
--   * the removed patient's own queue link keeps working exactly as before.
-- The receipt number stays reserved: Billing Audit counts removed bills so there is never a false gap.
-- A later booking with the same phone number does not find the removed patient (the lookup reads the
-- patients table, which now hides the row), so details are entered afresh and a new patient is created.
--
-- There is no restore screen. The rows stay in the database for the audit trail.
--
-- Token numbers: removed visits keep their token so a new booking can never reuse it. The two token
-- functions are now SECURITY DEFINER for that reason (they must see removed rows to count past them).
--
-- Safe to run more than once. Run this once in the Supabase SQL Editor, after 116.
-- ============================================================

alter table public.patients add column if not exists removed_at timestamptz;
alter table public.patients add column if not exists removed_by uuid;
alter table public.invoices add column if not exists removed_at timestamptz;
alter table public.invoices add column if not exists removed_by uuid;
-- Bumped on every removal so every open page (the clinics table is already watched live) refreshes.
alter table public.clinics add column if not exists last_data_change_at timestamptz;

-- ---- row level security: removed rows are invisible ----
drop policy if exists "clinic patients select" on public.patients;
create policy "clinic patients select" on public.patients
  for select using (
    clinic_id = public.my_clinic_id()
    and public.my_role() in ('admin', 'reception', 'doctor')
    and removed_at is null
  );

drop policy if exists "billing staff select invoices" on public.invoices;
create policy "billing staff select invoices" on public.invoices
  for select using (
    clinic_id = public.my_clinic_id()
    and public.my_role() in ('admin', 'reception')
    and removed_at is null
  );

drop policy if exists "pharmacist select pharmacy invoices" on public.invoices;
create policy "pharmacist select pharmacy invoices" on public.invoices
  for select using (
    clinic_id = public.my_clinic_id()
    and public.my_role() = 'pharmacist'
    and invoice_type = 'pharmacy'
    and removed_at is null
  );

-- A rating shows on Patient Feedback only while its patient is visible (the subquery runs under the
-- same security, so a removed patient is not found).
drop policy if exists "clinic select own visit feedback" on public.visit_feedback;
create policy "clinic select own visit feedback" on public.visit_feedback
  for select using (
    clinic_id = public.my_clinic_id()
    and exists (select 1 from public.patients p where p.id = visit_feedback.patient_id)
  );

-- ---- the removal itself (admin only) ----
create or replace function public.remove_patient_visit(p_invoice_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid;
  v_invoice public.invoices;
begin
  if coalesce(public.my_role(), '') <> 'admin' then
    raise exception 'Only the clinic admin can remove a patient.';
  end if;
  v_clinic_id := public.my_clinic_id();

  select * into v_invoice from public.invoices
    where id = p_invoice_id and clinic_id = v_clinic_id and invoice_type = 'consultation' and removed_at is null;
  if not found then
    raise exception 'That bill was not found.';
  end if;

  update public.invoices set removed_at = now(), removed_by = auth.uid() where id = v_invoice.id;

  if v_invoice.patient_id is not null then
    -- Every consultation bill of this visit goes with it. Pharmacy sales are left alone: their stock was already taken.
    update public.invoices set removed_at = now(), removed_by = auth.uid()
      where patient_id = v_invoice.patient_id and invoice_type = 'consultation' and removed_at is null;
    update public.patients set removed_at = now(), removed_by = auth.uid()
      where id = v_invoice.patient_id and clinic_id = v_clinic_id and removed_at is null;
  end if;

  update public.clinics set last_data_change_at = now() where id = v_clinic_id;
  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.remove_patient_visit(uuid) from public, anon;
grant execute on function public.remove_patient_visit(uuid) to authenticated;


-- ---- patient queue link: counts for everyone else skip removed visits ----
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
    and removed_at is null
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
      and removed_at is null
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
      and removed_at is null
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
  where doctor_id = patient_row.doctor_id and token_date = patient_row.token_date and called_at is not null and removed_at is null;

  select
    count(*),
    count(*) filter (where status = 'done'),
    count(*) filter (where status = 'no_show')
  into booked_today_count, seen_today_count, noshow_today_count
  from public.patients
  where doctor_id = patient_row.doctor_id and token_date = patient_row.token_date and removed_at is null;

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

-- ---- Billing Audit: removed bills keep their number, so there is no false gap ----
create or replace function public.get_billing_audit()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid;
  v_total int;
  v_removed int;
  v_min int;
  v_max int;
  v_unbilled jsonb;
begin
  if public.my_role() != 'admin' then
    raise exception 'Only clinic admin can view the billing audit.';
  end if;
  if not public.has_feature('billing_audit') then
    raise exception 'Billing audit is not enabled for this clinic.';
  end if;
  v_clinic_id := public.my_clinic_id();

  select count(*) filter (where removed_at is null), count(*) filter (where removed_at is not null),
         min(invoice_number), max(invoice_number)
    into v_total, v_removed, v_min, v_max
    from public.invoices
    where clinic_id = v_clinic_id
      and invoice_type = 'consultation';

  -- Only a CONSULTATION invoice counts as "billed" -- a pharmacy-only
  -- sale against the same patient_id doesn't mean their visit was billed.
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id,
      'name', p.name,
      'phone', p.phone,
      'tokenDate', p.token_date,
      'status', p.status,
      'doctorId', p.doctor_id
    ) order by p.token_date desc, p.created_at desc), '[]'::jsonb)
    into v_unbilled
    from public.patients p
    where p.clinic_id = v_clinic_id
      and p.removed_at is null
      and p.status in ('waiting', 'in_consult', 'done')
      and not exists (
        select 1 from public.invoices i
        where i.patient_id = p.id and i.invoice_type = 'consultation'
      );

  return jsonb_build_object(
    'totalInvoices', v_total,
    'removedInvoices', v_removed,
    'minInvoiceNumber', v_min,
    'maxInvoiceNumber', v_max,
    'unbilledPatients', v_unbilled
  );
end;
$$;

-- ---- Patient Directory ----
create or replace function public.get_patient_directory()
returns table (
  name text, phone text, age int, gender text, address text,
  doctor_id uuid, token_date date, status text, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if public.my_role() not in ('admin', 'reception', 'doctor') then
    raise exception 'Not authorized.';
  end if;
  if not public.has_feature('patient_directory') then
    raise exception 'Patient directory is not enabled for this clinic.';
  end if;
  return query
    select p.name, p.phone, p.age, p.gender, p.address, p.doctor_id, p.token_date, p.status, p.created_at
    from public.patients p
    where p.clinic_id = public.my_clinic_id()
      and p.removed_at is null
    order by p.created_at desc, p.id asc;
end;
$$;

-- ---- waiting room board ----
create or replace function public.get_display_board_by_session(p_session_id uuid, p_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid;
  v_today date := public.board_day();
  v_date date;
begin
  select clinic_id into v_clinic_id
    from public.display_board_sessions
    where id = p_session_id and expires_at > now();

  if v_clinic_id is null then
    return jsonb_build_object('error', 'expired');
  end if;

  -- The board only ever shows today; a client-supplied date is honoured
  -- only within a day either side (clock/timezone slack), never for
  -- arbitrary past or future days.
  v_date := least(greatest(coalesce(p_date, v_today), v_today - 1), v_today + 1);

  return jsonb_build_object(
    'clinic', (
      select jsonb_build_object(
        'id', c.id, 'name', c.name, 'display_language', c.display_language,
        'closed_at', c.closed_at, 'logo_url', c.logo_url
      )
      from public.clinics c where c.id = v_clinic_id
    ),
    'doctors', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', d.id, 'name', d.name, 'specialty', d.specialty, 'status', d.status,
        'delay_mins', d.delay_mins, 'status_note', d.status_note,
        'status_updated_at', d.status_updated_at, 'is_active', d.is_active,
        'day_closed_at', d.day_closed_at
      ) order by d.created_at), '[]'::jsonb)
      from public.doctors d
      where d.clinic_id = v_clinic_id and d.is_active = true
    ),
    'patients', (
      select coalesce(jsonb_agg(jsonb_build_object(
        -- A one-way, per-session key: unique enough for the board to
        -- tell rows apart, but not the patient's real id, which is the
        -- bearer secret behind get_queue_status / submit_visit_feedback.
        'id', md5(p.id::text || p_session_id::text),
        'doctor_id', p.doctor_id, 'name', p.name, 'status', p.status,
        'type', p.type, 'token_number', p.token_number, 'token_date', p.token_date,
        'is_priority', p.is_priority, 'booked_date', p.booked_date, 'booked_time', p.booked_time,
        'arrived_at', p.arrived_at, 'called_at', p.called_at, 'created_at', p.created_at
      )), '[]'::jsonb)
      from public.patients p
      where p.clinic_id = v_clinic_id and p.token_date = v_date and p.removed_at is null
    )
  );
end;
$$;

-- ---- pharmacy patient search ----
create or replace function public.search_patients_for_pharmacy(p_query text)
returns table (id uuid, name text, phone text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid;
  v_query text := trim(coalesce(p_query, ''));
begin
  if public.my_role() not in ('admin', 'reception', 'pharmacist') then
    raise exception 'Only clinic admin, reception, or pharmacist can search patients.';
  end if;
  if v_query = '' then
    return;
  end if;
  v_clinic_id := public.my_clinic_id();

  return query
    select distinct on (coalesce(nullif(p.phone, ''), p.id::text)) p.id, p.name, p.phone
    from public.patients p
    where p.clinic_id = v_clinic_id
      and p.removed_at is null
      and (p.name ilike '%' || v_query || '%' or p.phone ilike '%' || v_query || '%')
    order by coalesce(nullif(p.phone, ''), p.id::text), p.created_at desc
    limit 20;
end;
$$;

-- ---- platform admin patient volume ----
create or replace function public.admin_get_clinic_patient_volume(
  target_clinic_id uuid, p_start date default null, p_end date default null
)
returns table (booked_count int, seen_count int)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Not authorized.';
  end if;
  return query
    select
      count(*)::int,
      count(*) filter (where status = 'done')::int
    from public.patients
    where clinic_id = target_clinic_id
      and removed_at is null
      and (p_start is null or coalesce(booked_date, created_at::date) >= p_start)
      and (p_end is null or coalesce(booked_date, created_at::date) <= p_end);
end;
$$;

-- ---- prescriptions ----
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
        and pat.removed_at is null
    ) p
  );
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
        and (pat.id is null or pat.removed_at is null)
        and (p_doctor_id is null or pr.doctor_id = p_doctor_id)
        and (v_caller_doctor_id is null or pr.doctor_id = v_caller_doctor_id)
      order by pr.created_at desc
      limit greatest(p_limit, 1)
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
        and (pat.id is null or pat.removed_at is null)
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
        and (pat.id is null or pat.removed_at is null)
        and (pr.created_at at time zone 'Asia/Kolkata')::date between p_date and v_end_date
        and (p_doctor_id is null or pr.doctor_id = p_doctor_id)
        and (v_caller_doctor_id is null or pr.doctor_id = v_caller_doctor_id)
    ) p
  );
end;
$$;

-- ---- token numbers: count removed visits too, so a token is never reused ----
create or replace function public.assign_token_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $
begin
  if new.token_number is null then
    perform pg_advisory_xact_lock(hashtext(new.doctor_id::text || ':' || new.token_date::text)::bigint);

    if new.type = 'walkin' then
      select coalesce(max(token_number), 100000) + 1
      into new.token_number
      from public.patients
      where clinic_id = new.clinic_id
        and doctor_id = new.doctor_id
        and token_date = new.token_date
        and type = 'walkin';
    else
      select coalesce(max(token_number), 0) + 1
      into new.token_number
      from public.patients
      where clinic_id = new.clinic_id
        and doctor_id = new.doctor_id
        and token_date = new.token_date
        and type = 'appointment';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.reassign_token_on_reschedule()
returns trigger
language plpgsql
security definer
set search_path = public
as $
begin
  if new.token_number is not null
     and (new.doctor_id is distinct from old.doctor_id
          or new.token_date is distinct from old.token_date
          or new.type is distinct from old.type) then
    perform pg_advisory_xact_lock(hashtext(new.doctor_id::text || ':' || new.token_date::text)::bigint);

    if new.type = 'walkin' then
      select coalesce(max(token_number), 100000) + 1
      into new.token_number
      from public.patients
      where clinic_id = new.clinic_id
        and doctor_id = new.doctor_id
        and token_date = new.token_date
        and type = 'walkin'
        and id is distinct from new.id;
    else
      select coalesce(max(token_number), 0) + 1
      into new.token_number
      from public.patients
      where clinic_id = new.clinic_id
        and doctor_id = new.doctor_id
        and token_date = new.token_date
        and type = 'appointment'
        and id is distinct from new.id;
    end if;
  end if;
  return new;
end;
$$;
