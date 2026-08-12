-- ============================================================
-- Qlinic — migration 013: consultation billing.
--
-- Why: fees are already set per-doctor (012_doctor_fees.sql). This adds
-- the actual billing action — reception or admin picks a patient and a
-- fee type, and gets a printable receipt — plus the clinic address
-- fields that receipt needs in its header.
--
-- The amount is never trusted from the client: create_invoice() looks
-- it up itself from the doctor's row, the same way 011's roster guard
-- never trusts a client-supplied role change. Invoice numbering is a
-- single atomic UPDATE on the clinic row, so two people billing at the
-- same clinic at the same moment can't collide on the same number.
--
-- Run this once in the Supabase SQL Editor, after 012_doctor_fees.sql.
-- ============================================================

alter table public.clinics
  add column if not exists address_line text not null default '',
  add column if not exists city text not null default '',
  add column if not exists pincode text not null default '',
  add column if not exists state text not null default '',
  add column if not exists next_invoice_number integer not null default 1;

-- Invoices are per-visit snapshots, not a live join to doctors/patients:
-- patient_name/address/age/gender are copied in at billing time so a
-- receipt already printed never changes if the doctor's fee or a later
-- visit's details change afterwards.
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  invoice_number integer not null,
  doctor_id uuid not null references public.doctors(id),
  fee_type text not null check (fee_type in ('consultation', 'emergency')),
  amount numeric(10, 2) not null,
  patient_name text not null,
  patient_phone text not null default '',
  patient_address text not null default '',
  patient_age int,
  patient_gender text not null default '',
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create index invoices_clinic_created_idx on public.invoices (clinic_id, created_at desc);
create unique index invoices_clinic_number_idx on public.invoices (clinic_id, invoice_number);

alter table public.invoices enable row level security;

-- Read access only for admin/reception, matching "not doctors" — there is
-- deliberately no select policy for any other role, and no insert/update
-- policy at all: every write goes through create_invoice() below.
create policy "billing staff select invoices" on public.invoices
  for select using (clinic_id = public.my_clinic_id() and public.my_role() in ('admin', 'reception'));

create or replace function public.create_invoice(
  p_doctor_id uuid,
  p_fee_type text,
  p_patient_name text,
  p_patient_phone text,
  p_patient_address text,
  p_patient_age int,
  p_patient_gender text
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
    patient_name, patient_phone, patient_address, patient_age, patient_gender, created_by
  ) values (
    v_clinic_id, v_invoice_number, p_doctor_id, p_fee_type, v_amount,
    p_patient_name, p_patient_phone, p_patient_address, p_patient_age, p_patient_gender, auth.uid()
  )
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.create_invoice(uuid, text, text, text, text, int, text) to authenticated;
