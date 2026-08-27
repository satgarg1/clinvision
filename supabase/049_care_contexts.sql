-- ============================================================
-- Qlinic — migration 049: care_contexts, ABDM's discoverable link
-- between one visit and a patient's (future) ABHA.
--
-- Why: a "care context" is ABDM's term for a single clinical encounter
-- an HIP can later be asked to share - here, one billed visit. This
-- table exists so every visit has a stable, permanent reference to
-- attach an ABHA to later (once real linking exists), rather than
-- trying to reconstruct "which invoices count as encounters" after
-- the fact from the invoices table directly.
--
-- Populated entirely server-side via an AFTER INSERT trigger on
-- invoices, not a client-side follow-up call - invoices are only ever
-- created through create_invoice() (013_billing.sql),
-- auto_create_invoice_on_arrival() (016), or its emergency-fee variant
-- (031), and all three do a plain insert into public.invoices. A
-- trigger there guarantees a care_context is produced no matter which
-- path created the bill, with no risk of a separate client call being
-- skipped. Invoices with no patient_id (e.g. one billed through a path
-- that predates that column, or without a linked patient row) are
-- silently skipped - there is no ABHA to eventually attach without a
-- real patient to attach it to.
--
-- No client insert/update/delete policy exists on care_contexts at
-- all - every row is written by record_care_context() below, running
-- as part of an already-guarded invoice insert. Select is open to
-- clinic staff the same way every other clinic-scoped table is.
--
-- Run this once in the Supabase SQL Editor, after 048_doctor_hpr_clinic_hfr.sql.
-- ============================================================

create table public.care_contexts (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null references public.patients(id) on delete cascade,
  invoice_id uuid null references public.invoices(id) on delete set null,
  reference_number text not null,
  display text not null,
  hi_type text not null default 'OPConsultation',
  status text not null default 'pending' check (status in ('pending', 'linked', 'failed')),
  linked_at timestamptz null,
  created_at timestamptz not null default now(),
  unique (clinic_id, reference_number)
);

create index care_contexts_patient_idx on public.care_contexts (patient_id);
create index care_contexts_invoice_idx on public.care_contexts (invoice_id);

alter table public.care_contexts enable row level security;

create policy "clinic care_contexts select" on public.care_contexts
  for select using (clinic_id = public.my_clinic_id());

create or replace function public.record_care_context(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
  v_doctor_name text;
begin
  select * into v_invoice from public.invoices where id = p_invoice_id;
  -- No row, or no linked patient to eventually attach an ABHA to -
  -- nothing to record.
  if v_invoice.id is null or v_invoice.patient_id is null then
    return;
  end if;
  -- Defensive: the trigger below only ever fires once per invoice
  -- insert, but a guard here costs nothing and keeps this function
  -- safe to call by hand if ever needed.
  if exists (select 1 from public.care_contexts where invoice_id = v_invoice.id) then
    return;
  end if;

  select name into v_doctor_name from public.doctors where id = v_invoice.doctor_id;

  insert into public.care_contexts (clinic_id, patient_id, invoice_id, reference_number, display, hi_type)
  values (
    v_invoice.clinic_id,
    v_invoice.patient_id,
    v_invoice.id,
    'invoice-' || v_invoice.id::text,
    coalesce(v_doctor_name, 'Consultation') || ' - ' || to_char(v_invoice.invoice_date, 'DD Mon YYYY'),
    'OPConsultation'
  );
end;
$$;

create or replace function public.record_care_context_on_invoice_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.record_care_context(new.id);
  return new;
end;
$$;

drop trigger if exists invoices_record_care_context on public.invoices;
create trigger invoices_record_care_context
  after insert on public.invoices
  for each row
  execute function public.record_care_context_on_invoice_insert();
