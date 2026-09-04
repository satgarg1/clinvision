-- ============================================================
-- Qlinic — migration 066: pharmacy invoices.
--
-- Reuses invoices as the header row for a pharmacy sale too — same
-- clinic/patient/date/payment/total shape a consultation invoice
-- already has, just tagged by invoice_type, so revenue.html can roll
-- both together later. A pharmacy sale's actual medicine lines don't
-- fit invoices itself though — a consultation invoice is one flat fee,
-- a pharmacy sale is N medicines at N quantities/prices/tax rates — so
-- those live in the new invoice_items table below, genuinely new
-- territory (this codebase's first multi-line invoice).
--
-- doctor_id/fee_type go nullable because a pharmacy sale has neither —
-- OTC dispensing with no doctor visit is allowed (see BACKLOG.md's
-- "not decided yet" note, resolved by simply not requiring one).
--
-- Run this once in the Supabase SQL Editor, after 065_stock_ledger.sql.
-- ============================================================

alter table public.invoices add column invoice_type text not null default 'consultation'
  check (invoice_type in ('consultation', 'pharmacy'));

alter table public.invoices alter column doctor_id drop not null;
alter table public.invoices alter column fee_type drop not null;

-- fee_type's check was widened once already, in 016_auto_invoice_on_arrival.sql,
-- to add 'waived' for a genuinely free/follow-up visit — real live data
-- already has rows with that value, so it has to carry over here too, not
-- just the original ('consultation', 'emergency') from 013_billing.sql.
alter table public.invoices drop constraint if exists invoices_fee_type_check;
alter table public.invoices add constraint invoices_type_fee_check check (
  (invoice_type = 'consultation' and fee_type in ('consultation', 'emergency', 'waived'))
  or (invoice_type = 'pharmacy' and fee_type is null)
);

-- Pharmacy invoices get their own numbering sequence (displayed as
-- "PH-0043") so they read as visibly, structurally different documents
-- from a consultation receipt — not just a different label on the same
-- numbering, and so a busy pharmacy day doesn't burn gaps into the
-- consultation invoice sequence or vice versa.
alter table public.clinics add column next_pharmacy_invoice_number integer not null default 1;

create table public.invoice_items (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  medicine_id uuid references public.medicines(id) on delete set null,
  batch_id uuid references public.medicine_batches(id) on delete set null,
  -- Snapshotted at sale time, same "never let a later catalog edit
  -- change an already-printed receipt" convention invoices.patient_name
  -- already follows.
  medicine_name_snapshot text not null,
  hsn_code_snapshot text not null default '',
  quantity integer not null check (quantity > 0),
  unit_price numeric(10, 2) not null,
  gst_rate numeric(4, 2) not null default 0,
  line_total numeric(10, 2) not null,
  created_at timestamptz not null default now()
);

create index invoice_items_invoice_idx on public.invoice_items (invoice_id);

alter table public.invoice_items enable row level security;

create policy "pharmacy staff select invoice_items" on public.invoice_items
  for select using (clinic_id = public.my_clinic_id() and public.my_role() in ('admin', 'reception', 'pharmacist'));
-- No client write policy — every row is inserted by create_pharmacy_invoice()
-- in 068_medicine_rpcs.sql.
