-- ============================================================
-- Qlinic — migration 016: bill automatically when a patient arrives.
--
-- Why: with 200+ patients a day, an extra click per patient for
-- billing is a real burden reception will resist. Patients pay in
-- cash the moment they arrive, before seeing the doctor, so this
-- makes that the default: the moment a patient's status becomes
-- "waiting" (walk-in added, or an appointment marked arrived), a
-- trigger creates the invoice itself — consultation fee, cash, paid
-- in full, linked straight to that patient's own row so nothing needs
-- retyping. Reception's workflow doesn't change at all.
--
-- This is deliberately a best-effort default, not a guess dressed up
-- as certain: fee_type can be 'waived' for genuinely free visits, and
-- update_invoice_payment() below lets admin/reception correct the
-- fee type, payment mode, or amount for the exceptions — wrong
-- payment method, an emergency fee, a comp visit — without that
-- correction ever being a required step.
--
-- Run this once in the Supabase SQL Editor, after 015_invoice_payment.sql.
-- ============================================================

alter table public.invoices
  add column if not exists patient_id uuid references public.patients(id) on delete set null;

create index if not exists invoices_patient_idx on public.invoices (patient_id);

alter table public.invoices drop constraint if exists invoices_fee_type_check;
alter table public.invoices add constraint invoices_fee_type_check
  check (fee_type in ('consultation', 'emergency', 'waived'));

create or replace function public.auto_create_invoice_on_arrival()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount numeric(10, 2);
  v_invoice_number integer;
begin
  if exists (select 1 from public.invoices where patient_id = new.id) then
    return new;
  end if;

  select fee_normal into v_amount from public.doctors where id = new.doctor_id;
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
    new.clinic_id, v_invoice_number, new.doctor_id, 'consultation', v_amount,
    new.id, new.name, new.phone, new.address, new.age, new.gender,
    'cash', v_amount, auth.uid()
  );

  return new;
end;
$$;

-- Split into two triggers rather than one combined INSERT-OR-UPDATE
-- trigger: a WHEN clause referencing OLD isn't valid for an INSERT
-- event, so the insert case (walk-ins, added straight into 'waiting')
-- and the update case (an appointment marked arrived) need separate
-- WHEN conditions even though they call the same function.
drop trigger if exists patients_auto_invoice_on_arrival_insert on public.patients;
create trigger patients_auto_invoice_on_arrival_insert
  after insert on public.patients
  for each row
  when (new.status = 'waiting')
  execute function public.auto_create_invoice_on_arrival();

drop trigger if exists patients_auto_invoice_on_arrival_update on public.patients;
create trigger patients_auto_invoice_on_arrival_update
  after update on public.patients
  for each row
  when (new.status = 'waiting' and old.status is distinct from 'waiting')
  execute function public.auto_create_invoice_on_arrival();

-- Lets admin/reception correct an auto-billed invoice: fee type
-- (including 'waived', which zeroes the amount for a genuinely free
-- visit), payment mode, and amount received. Same role check and
-- server-computed fee lookup as create_invoice() — the client still
-- never gets to just declare an amount for consultation/emergency.
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

  v_clinic_id := public.my_clinic_id();

  select doctor_id into v_doctor_id
    from public.invoices
    where id = p_invoice_id and clinic_id = v_clinic_id;

  if v_doctor_id is null then
    raise exception 'Invoice not found in this clinic.';
  end if;

  if p_fee_type = 'waived' then
    v_amount := 0;
  else
    select case when p_fee_type = 'consultation' then fee_normal else fee_emergency end
      into v_amount
      from public.doctors
      where id = v_doctor_id;
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

grant execute on function public.update_invoice_payment(uuid, text, text, numeric) to authenticated;
