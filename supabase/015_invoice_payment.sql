-- ============================================================
-- Qlinic — migration 015: payment mode + amount received on invoices.
--
-- Why: the receipt redesign needs "paid via cash/UPI/card" and an
-- amount-received/balance line, matching what a real clinic receipt
-- looks like. Amount received defaults to the full fee (consultations
-- are almost always paid in full) but stays editable on the billing
-- form for the rare partial-payment case, so balance isn't always
-- forced to zero.
--
-- Run this once in the Supabase SQL Editor, after 014_patient_age.sql.
-- ============================================================

alter table public.invoices
  add column if not exists payment_mode text not null default 'cash' check (payment_mode in ('cash', 'upi', 'card')),
  add column if not exists amount_received numeric(10, 2);

drop function if exists public.create_invoice(uuid, text, text, text, text, int, text);

create or replace function public.create_invoice(
  p_doctor_id uuid,
  p_fee_type text,
  p_patient_name text,
  p_patient_phone text,
  p_patient_address text,
  p_patient_age int,
  p_patient_gender text,
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

  update public.clinics
    set next_invoice_number = next_invoice_number + 1
    where id = v_clinic_id
    returning next_invoice_number - 1 into v_invoice_number;

  insert into public.invoices (
    clinic_id, invoice_number, doctor_id, fee_type, amount,
    patient_name, patient_phone, patient_address, patient_age, patient_gender,
    payment_mode, amount_received, created_by
  ) values (
    v_clinic_id, v_invoice_number, p_doctor_id, p_fee_type, v_amount,
    p_patient_name, p_patient_phone, p_patient_address, p_patient_age, p_patient_gender,
    p_payment_mode, coalesce(p_amount_received, v_amount), auth.uid()
  )
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.create_invoice(uuid, text, text, text, text, int, text, text, numeric) to authenticated;
