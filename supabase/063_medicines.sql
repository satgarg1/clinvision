-- ============================================================
-- Qlinic — migration 063: pharmacy medicine catalog.
--
-- First piece of the pharmacy billing & inventory feature (see
-- BACKLOG.md's "Pharmacy billing & inventory" section, Milestone A).
-- A medicine's identity and pricing live here; actual stock quantities
-- live in medicine_batches (064) instead of a plain quantity column
-- here, because Indian law requires a batch number + expiry date on
-- every pharmacy sale invoice (Drugs and Cosmetics Rules) — a version
-- without batches wouldn't produce a real, compliant invoice.
--
-- stock_quantity below is a denormalized cache of "sum of all this
-- medicine's batches' quantity_remaining", always written in lockstep
-- with batch changes inside the RPCs in 068_medicine_rpcs.sql, never
-- edited directly by the client — the same "fast read, correct write
-- path" shape clinics.next_invoice_number already uses.
--
-- track_batches exists because not every item a pharmacy counter sells
-- needs expiry tracking (a bandage roll, say) — it defaults true and
-- can be turned off per medicine, mirroring the "Enable Batching"
-- toggle real pharmacy software (myBillBook) ships with.
--
-- Run this once in the Supabase SQL Editor, after 062_queue_status_daily_summary.sql.
-- ============================================================

create table public.medicines (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  name text not null,
  generic_name text not null default '',
  manufacturer text not null default '',
  form text not null default '',
  strength text not null default '',
  unit_of_sale text not null default '',
  schedule text not null default 'none' check (schedule in ('none', 'h', 'h1', 'x')),
  track_batches boolean not null default true,
  reference_number text not null default '',
  mrp numeric(10, 2) not null default 0,
  selling_price numeric(10, 2) not null default 0,
  gst_rate numeric(4, 2) not null default 12,
  hsn_code text not null default '',
  stock_quantity integer not null default 0 check (stock_quantity >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index medicines_clinic_idx on public.medicines (clinic_id, is_active, name);

alter table public.medicines enable row level security;

-- Pharmacist gets full catalog control (add/edit medicines, prices,
-- GST, schedule) alongside admin/reception, not just billing — decided
-- 2026-09-04: "run their own counter end to end" rather than a
-- bottleneck through admin for every new item.
create policy "pharmacy staff select medicines" on public.medicines
  for select using (clinic_id = public.my_clinic_id() and public.my_role() in ('admin', 'reception', 'pharmacist'));
create policy "pharmacy staff insert medicines" on public.medicines
  for insert with check (clinic_id = public.my_clinic_id() and public.my_role() in ('admin', 'reception', 'pharmacist'));
create policy "pharmacy staff update medicines" on public.medicines
  for update using (clinic_id = public.my_clinic_id() and public.my_role() in ('admin', 'reception', 'pharmacist'))
  with check (clinic_id = public.my_clinic_id() and public.my_role() in ('admin', 'reception', 'pharmacist'));
-- No delete policy — deactivating (is_active = false) is how a medicine
-- goes away, never a hard delete, since invoice_items.medicine_id and
-- stock_ledger.medicine_id will reference these rows.
