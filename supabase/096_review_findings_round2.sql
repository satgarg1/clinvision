-- ============================================================
-- Qlinic — migration 096: full-codebase multi-agent review, round 2.
--
-- Five confirmed findings, bundled since none touch overlapping objects.
-- (Client-side/JS findings from the same review — age-0 autofill, unescaped
-- search filters, money-reset-on-edit, walk-in-after-close, the BP legend
-- text, the forgot-password redirect, unpaginated reports, and the two
-- Insights drill-down mismatches — are fixed directly in the HTML/JS files,
-- not here.)
--
-- Run this once in the Supabase SQL Editor, after 095_enforce_slot_capacity.sql.
-- ============================================================

-- ---------------------------------------------------------------
-- 1. prescriptions INSERT policy checked clinic_id + role only, never that
--    patient_id/doctor_id actually belong to that clinic. create_prescription()
--    (088) already validates this procedurally, but a doctor/admin calling
--    supabase.from('prescriptions').insert() directly bypasses the RPC
--    entirely — RLS is the only backstop for that path, and it had none.
-- ---------------------------------------------------------------
drop policy if exists "admin or doctor insert prescriptions" on public.prescriptions;
create policy "admin or doctor insert prescriptions" on public.prescriptions
  for insert with check (
    clinic_id = public.my_clinic_id()
    and public.my_role() in ('admin', 'doctor')
    and exists (select 1 from public.patients p where p.id = patient_id and p.clinic_id = clinic_id)
    and exists (select 1 from public.doctors d where d.id = doctor_id and d.clinic_id = clinic_id)
  );

-- ---------------------------------------------------------------
-- 2. doctor_rx_templates' only policy checked clinic_id alone — no role
--    check (any authenticated clinic member, not just admin/doctor) and no
--    doctor_id ownership check (any doctor could edit/delete any other
--    doctor's saved templates in the same clinic).
-- ---------------------------------------------------------------
drop policy if exists "doctor manages own templates" on public.doctor_rx_templates;
create policy "doctor manages own templates" on public.doctor_rx_templates
  for all using (
    clinic_id = public.my_clinic_id()
    and (public.my_role() = 'admin' or doctor_id = public.my_doctor_id())
  )
  with check (
    clinic_id = public.my_clinic_id()
    and (public.my_role() = 'admin' or doctor_id = public.my_doctor_id())
  );

-- ---------------------------------------------------------------
-- 3. restrict_doctor_roster_edits() (011/012, extended by 076) never
--    learned about qualification/registration_number, added later by
--    088_prescriptions.sql — a non-admin (reception or doctor role) could
--    update either column directly via the API, forging the credentials
--    that print on that doctor's prescriptions.
-- ---------------------------------------------------------------
create or replace function public.restrict_doctor_roster_edits()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.my_role() = 'admin' then
    return new;
  end if;
  if new.name is distinct from old.name
     or new.specialty is distinct from old.specialty
     or new.is_active is distinct from old.is_active
     or new.clinic_id is distinct from old.clinic_id
     or new.fee_normal is distinct from old.fee_normal
     or new.fee_emergency is distinct from old.fee_emergency
     or new.hpr_id is distinct from old.hpr_id
     or new.qualification is distinct from old.qualification
     or new.registration_number is distinct from old.registration_number then
    raise exception 'Only a clinic admin can edit the doctor roster.';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------
-- 4. set_staff_active_cascade() (078) had no guard against
--    target_profile_id = auth.uid(), unlike the equivalent platform-admin
--    deactivation path. An admin (especially a clinic's only admin) could
--    deactivate their own login via this RPC directly, losing admin access
--    with no client-side undo path.
-- ---------------------------------------------------------------
create or replace function public.set_staff_active_cascade(target_profile_id uuid, new_active boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  linked_doctor uuid;
begin
  if public.my_role() <> 'admin' then
    raise exception 'Only a clinic admin can change a staff member''s status.';
  end if;
  if target_profile_id = auth.uid() and new_active = false then
    raise exception 'You can''t deactivate your own account.';
  end if;

  select doctor_id into linked_doctor
  from public.profiles
  where id = target_profile_id and clinic_id = public.my_clinic_id();

  update public.profiles
  set is_active = new_active
  where id = target_profile_id and clinic_id = public.my_clinic_id();

  -- If this login belongs to a doctor, their roster entry moves with them
  -- too, so Reception/Doctor View/the display board stay in sync with
  -- whether this person can actually log in.
  if linked_doctor is not null then
    update public.doctors
    set is_active = new_active
    where id = linked_doctor and clinic_id = public.my_clinic_id();
  end if;
end;
$$;

-- ---------------------------------------------------------------
-- 5. create_invoice() (the manual reception path, 076) had no guard
--    against a second consultation invoice for the same patient_id — two
--    staff members (or two tabs) submitting billing-consultation.html for
--    the same "seen without an invoice" patient within the same race
--    window could both pass the client-side todayInvoiceId=null check and
--    both call create_invoice, producing two invoices for one visit.
--    auto_create_invoice_on_arrival (016/077) already guards this for the
--    automatic path with an existence check; a partial unique index closes
--    it here at the DB level so the check can't race regardless of timing.
--    Scoped to invoice_type = 'consultation' only, since one patient_id
--    can legitimately also carry a separate pharmacy invoice.
-- ---------------------------------------------------------------
create unique index if not exists invoices_patient_consultation_unique
  on public.invoices (patient_id)
  where patient_id is not null and invoice_type = 'consultation';

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
