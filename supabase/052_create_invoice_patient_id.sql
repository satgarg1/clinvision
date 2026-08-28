-- ============================================================
-- Qlinic — migration 052: link a manually-created invoice back to the
-- real patient row it's for.
--
-- Why: create_invoice() (013_billing.sql, extended by 024_invoice_date.sql)
-- has only ever inserted patient_name/patient_phone/etc. as free-typed
-- fields, never invoices.patient_id itself - by design, for the genuine
-- case of a walk-in-manual bill with no queue row to link to at all.
-- But it's ALSO the only path reception has for billing someone who
-- shows up on Billing Audit's "seen without an invoice" list (a real
-- patients row that auto_create_invoice_on_arrival() skipped, usually
-- because the doctor's fee wasn't configured yet at the moment they
-- arrived). Billing them through this form left the new invoice with no
-- patient_id, so get_billing_audit()'s `not exists (select 1 from
-- invoices where patient_id = p.id)` check never saw it as theirs - the
-- same patient stayed stuck on the audit list forever, even though a
-- real invoice for them now existed and the receipt-number counter had
-- moved on. Confirmed bug, reported after billing several patients off
-- that exact list and watching the count/list not shrink while the
-- receipt-number range kept climbing.
--
-- Fix: a new, optional, backward-compatible trailing parameter
-- (default null - same pattern p_invoice_date used in 024), populated
-- by billing-consultation.html only when its phone lookup found a real
-- visit on the selected billing date (getBillingPatientLookup's
-- todayPatientId, migration-paired with a clinic-data.js change, not a
-- schema one). A genuinely walk-in-manual bill still gets patient_id =
-- null exactly as before - nothing about that case changes.
--
-- Run this once in the Supabase SQL Editor, after 051_health_information_requests.sql.
-- ============================================================

drop function if exists public.create_invoice(uuid, text, text, text, text, int, text, text, numeric, date);

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

  v_clinic_id := public.my_clinic_id();

  select case when p_fee_type = 'consultation' then fee_normal else fee_emergency end
    into v_amount
    from public.doctors
    where id = p_doctor_id and clinic_id = v_clinic_id;

  if v_amount is null then
    raise exception 'Doctor not found in this clinic.';
  end if;

  -- A patient_id supplied from outside this clinic (shouldn't happen
  -- through the real UI, but this function is security definer and
  -- callable directly) must never silently link an invoice to someone
  -- else's patient - same defensive shape as the doctor check above.
  if p_patient_id is not null then
    if not exists (select 1 from public.patients where id = p_patient_id and clinic_id = v_clinic_id) then
      raise exception 'Patient not found in this clinic.';
    end if;
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

grant execute on function public.create_invoice(uuid, text, text, text, text, int, text, text, numeric, date, uuid) to authenticated;
