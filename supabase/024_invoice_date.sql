-- ============================================================
-- Qlinic — migration 024: a bill's own date, separate from when it
-- was actually printed.
--
-- Why: reception sometimes bills a patient after the fact — they forgot
-- at the time, or are catching up at the end of the day for someone who
-- was actually seen yesterday. created_at is (and stays) the honest
-- audit timestamp of when the row was inserted; invoice_date is the new,
-- separate, editable field for "which day this consultation is for,"
-- which is what revenue reporting should actually group by. Backfilled
-- from created_at for every existing row, so nothing already billed
-- silently moves to a different day in past revenue reports.
--
-- Backward compatible on its own: create_invoice() gets p_invoice_date
-- as a new trailing parameter with a default of current_date, so the
-- currently-deployed client code (which doesn't send it yet) keeps
-- working unchanged after this runs. The client-side date field and the
-- revenue.html query change that actually uses this column are a
-- separate, later change — safe to deploy only after this migration is
-- confirmed applied, never before.
--
-- Run this once in the Supabase SQL Editor, after 023_clinic_logo.sql.
-- ============================================================

alter table public.invoices add column if not exists invoice_date date;

update public.invoices set invoice_date = created_at::date where invoice_date is null;

alter table public.invoices alter column invoice_date set default current_date;
alter table public.invoices alter column invoice_date set not null;

create index if not exists invoices_invoice_date_idx on public.invoices (invoice_date);

drop function if exists public.create_invoice(uuid, text, text, text, text, int, text, text, numeric);

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
  p_invoice_date date default current_date
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
    payment_mode, amount_received, invoice_date, created_by
  ) values (
    v_clinic_id, v_invoice_number, p_doctor_id, p_fee_type, v_amount,
    p_patient_name, p_patient_phone, p_patient_address, p_patient_age, p_patient_gender,
    p_payment_mode, coalesce(p_amount_received, v_amount), coalesce(p_invoice_date, current_date), auth.uid()
  )
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.create_invoice(uuid, text, text, text, text, int, text, text, numeric, date) to authenticated;
