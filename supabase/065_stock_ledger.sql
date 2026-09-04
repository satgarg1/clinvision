-- ============================================================
-- Qlinic — migration 065: stock ledger.
--
-- The append-only audit trail behind a medicine's "Stock details" view
-- — every purchase, sale, opening balance, and manual adjustment, each
-- row snapshotting the medicine's total closing stock right after it,
-- so history renders without recomputing a running sum. Never edited
-- or deleted after insert — a correction is a new 'adjustment' row,
-- not a rewrite of an old one. This is also what makes the Schedule H1
-- register (a later milestone) possible as a derived report instead of
-- a separate table, since every sale is already logged here with a
-- reference back to its invoice.
--
-- Run this once in the Supabase SQL Editor, after 064_medicine_batches.sql.
-- ============================================================

create table public.stock_ledger (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  medicine_id uuid not null references public.medicines(id) on delete cascade,
  batch_id uuid references public.medicine_batches(id) on delete set null,
  movement_type text not null check (movement_type in ('opening', 'purchase', 'sale', 'adjustment')),
  quantity_delta integer not null,
  closing_stock_after integer not null,
  reference_invoice_id uuid references public.invoices(id) on delete set null,
  note text not null default '',
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create index stock_ledger_medicine_idx on public.stock_ledger (medicine_id, created_at desc);

alter table public.stock_ledger enable row level security;

create policy "pharmacy staff select stock_ledger" on public.stock_ledger
  for select using (clinic_id = public.my_clinic_id() and public.my_role() in ('admin', 'reception', 'pharmacist'));
-- No client write policy — every row is inserted by the RPCs in
-- 068_medicine_rpcs.sql, which run security definer.
