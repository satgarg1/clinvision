-- ============================================================
-- Qlinic — migration 064: medicine batches.
--
-- One row per batch of stock a clinic has received for a medicine —
-- batch number, MFG/expiry dates, purchase price, and how much of that
-- specific batch is still on hand. A sale deducts FEFO (first-expiry-
-- first-out) across these rows (see create_pharmacy_invoice in
-- 068_medicine_rpcs.sql), not FIFO — standard pharmacy practice to
-- minimize expired write-offs, and worth calling out because it's a
-- real behavioral difference from a generic inventory model's default.
--
-- No client insert/update/delete policy on this table at all — every
-- write goes through record_stock_purchase()/create_pharmacy_invoice()/
-- adjust_stock() in 068_medicine_rpcs.sql, same "server computes it,
-- client never writes it directly" rule invoices already follows.
--
-- Run this once in the Supabase SQL Editor, after 063_medicines.sql.
-- ============================================================

create table public.medicine_batches (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  medicine_id uuid not null references public.medicines(id) on delete cascade,
  batch_number text not null,
  mfg_date date,
  expiry_date date,
  purchase_price numeric(10, 2) not null default 0,
  mrp numeric(10, 2) not null default 0,
  quantity_received integer not null default 0,
  quantity_remaining integer not null default 0 check (quantity_remaining >= 0),
  created_at timestamptz not null default now()
);

-- FEFO deduction reads batches for one medicine ordered by expiry —
-- this index is exactly that access pattern.
create index medicine_batches_fefo_idx on public.medicine_batches (medicine_id, expiry_date asc nulls last, created_at asc);
create unique index medicine_batches_unique_idx on public.medicine_batches (medicine_id, batch_number);

alter table public.medicine_batches enable row level security;

create policy "pharmacy staff select medicine_batches" on public.medicine_batches
  for select using (clinic_id = public.my_clinic_id() and public.my_role() in ('admin', 'reception', 'pharmacist'));
