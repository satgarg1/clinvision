-- ============================================================
-- Qlinic — migration 031: auto-bill the emergency fee, not just
-- consultation, when a walk-in is flagged priority/emergency.
--
-- Why: reception already marks a walk-in "Emergency — see first" at
-- intake (is_priority, added by 029), but auto_create_invoice_on_arrival()
-- (016) has never looked at that flag — every arrival is auto-billed
-- as a plain consultation regardless, leaving admin/reception to catch
-- and manually correct the fee type via update_invoice_payment() every
-- single time. This teaches the trigger to charge fee_emergency and
-- tag the invoice 'emergency' up front when is_priority is set, so the
-- common case needs no correction at all — update_invoice_payment()
-- itself already handles both fee columns and is unchanged here.
--
-- Run this once in the Supabase SQL Editor, after 029_priority_and_unified_ordering.sql.
-- ============================================================

create or replace function public.auto_create_invoice_on_arrival()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount numeric(10, 2);
  v_fee_type text;
  v_invoice_number integer;
begin
  if exists (select 1 from public.invoices where patient_id = new.id) then
    return new;
  end if;

  v_fee_type := case when new.is_priority then 'emergency' else 'consultation' end;

  select case when new.is_priority then fee_emergency else fee_normal end
    into v_amount
    from public.doctors where id = new.doctor_id;
  if v_amount is null then
    return new;
  end if;

  update public.clinics
    set next_invoice_number = next_invoice_number + 1
    where id = new.clinic_id
    returning next_invoice_number - 1 into v_invoice_number;

  insert into public.invoices (
    clinic_id, invoice_number, doctor_id, fee_type, amount,
    patient_id, patient_name, patient_phone, patient_address, patient_age, patient_gender,
    payment_mode, amount_received, created_by
  ) values (
    new.clinic_id, v_invoice_number, new.doctor_id, v_fee_type, v_amount,
    new.id, new.name, new.phone, new.address, new.age, new.gender,
    'cash', v_amount, auth.uid()
  );

  return new;
end;
$$;

-- No trigger DDL changes needed: patients_auto_invoice_on_arrival_insert
-- and patients_auto_invoice_on_arrival_update (016) both call this
-- function by name with no arguments, so create or replace rebinds
-- both automatically.
