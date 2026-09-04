-- ============================================================
-- Qlinic — migration 072: pack vs. dispense-unit pricing.
--
-- Real gap found in the smoke test: medicines.selling_price/mrp were
-- priced per PACK (a strip of 10), but a sale's `quantity` was also
-- being read as "how many packs" — selling 1 pack of a 10-tablet strip
-- charged the whole strip's price even if the patient only needs 4
-- tablets. And stock was recorded the same ambiguous way: "100 units"
-- coming in never said whether that meant 100 tablets or 100 strips
-- (=1000 tablets).
--
-- Fix: keep medicines.mrp/selling_price meaning "price per pack" (how
-- a clinic naturally thinks about cost — "a strip costs ₹40"), but
-- track and sell STOCK in the actual dispensing unit (tablets, ml,
-- pieces) instead of packs:
--   - pack_label: what a pack is called ("Strip", "Bottle", "Vial")
--   - pack_size: how many dispense units are in one pack (10 for a
--     strip of 10 tablets; 1 for something sold as a whole container
--     — a bottle of syrup, an inhaler, a vial — nothing to subdivide)
--   - dispense_unit: the smallest unit a patient can actually be sold
--     ("tablet", "capsule", "ml", "bottle", "sachet"...)
-- Stock (medicine_batches.quantity_*, medicines.stock_quantity) now
-- counts in dispense_unit terms; record_stock_purchase() and
-- create_pharmacy_invoice() are rewritten in 073 to do the pack <->
-- dispense-unit math server-side rather than trusting the client.
--
-- unit_of_sale (the old free-text "Strip of 10" field) is renamed to
-- pack_label and repurposed to hold just "Strip" — the count moves
-- into its own pack_size column instead of being buried in a string.
--
-- Also adds medicines.barcode: a real EAN/GS1 barcode as printed on
-- the manufacturer's own packaging is a different value from
-- reference_number (ClinVision's own made-up internal code) — a
-- barcode scanner reading a real product's pack needs something to
-- match against that a clinic can actually scan and capture.
--
-- Run this once in the Supabase SQL Editor, after 071_fix_pharmacy_invoice_numbering.sql.
-- ============================================================

alter table public.medicines rename column unit_of_sale to pack_label;
alter table public.medicines add column pack_size integer not null default 1 check (pack_size > 0);
alter table public.medicines add column dispense_unit text not null default '';
alter table public.medicines add column barcode text default null;
create unique index medicines_clinic_barcode_idx on public.medicines (clinic_id, barcode) where barcode is not null;

-- medicine_seed_templates (069) needs the identical rename, both because
-- it's what register_clinic() copies from for every future signup (fixed
-- below) and because it's the source of truth the backfill UPDATE just
-- below reads pack_label/pack_size/dispense_unit from.
alter table public.medicine_seed_templates rename column unit_of_sale to pack_label;
alter table public.medicine_seed_templates add column pack_size integer not null default 1;
alter table public.medicine_seed_templates add column dispense_unit text not null default '';

update public.medicine_seed_templates set pack_label = 'Strip', pack_size = 15, dispense_unit = 'tablet' where reference_number in ('PCM001', 'MET001', 'MVT001', 'CAL001');
update public.medicine_seed_templates set pack_label = 'Strip', pack_size = 10, dispense_unit = 'tablet' where reference_number in ('CIP001', 'CTZ001', 'LCZ001', 'PAN001', 'RAB001', 'AML001', 'ATV001', 'IBU001', 'DIC001', 'DOM001', 'MTZ001');
update public.medicine_seed_templates set pack_label = 'Strip', pack_size = 10, dispense_unit = 'capsule' where reference_number in ('AMX001', 'OMP001');
update public.medicine_seed_templates set pack_label = 'Strip', pack_size = 3, dispense_unit = 'tablet' where reference_number = 'AZM001';
update public.medicine_seed_templates set pack_label = 'Sachet', pack_size = 1, dispense_unit = 'sachet' where reference_number in ('ORS001', 'VTD001');
update public.medicine_seed_templates set pack_label = 'Bottle', pack_size = 1, dispense_unit = 'bottle' where reference_number in ('PCM002', 'COU001', 'PVI001');
update public.medicine_seed_templates set pack_label = 'Inhaler', pack_size = 1, dispense_unit = 'inhaler' where reference_number = 'SAL001';
update public.medicine_seed_templates set pack_label = 'Vial', pack_size = 1, dispense_unit = 'vial' where reference_number = 'INS001';

update public.medicines m set pack_label = t.pack_label, pack_size = t.pack_size, dispense_unit = t.dispense_unit
  from public.medicine_seed_templates t
  where m.reference_number = t.reference_number and m.reference_number <> '';

-- register_clinic() (003_staff_roles.sql, extended by 070) referenced
-- unit_of_sale by name in its seed-copy INSERT — has to be redeclared
-- to select the renamed pack_label plus the two new columns, or every
-- clinic signup from here on breaks outright (column does not exist).
create or replace function public.register_clinic(clinic_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_clinic_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Must be authenticated to register a clinic';
  end if;

  if exists (select 1 from public.profiles where id = auth.uid()) then
    raise exception 'This account is already linked to a clinic';
  end if;

  insert into public.clinics (name, admin_email)
  values (clinic_name, (select email from auth.users where id = auth.uid()))
  returning id into new_clinic_id;

  insert into public.profiles (id, clinic_id, email, role)
  values (auth.uid(), new_clinic_id, (select email from auth.users where id = auth.uid()), 'admin');

  insert into public.medicines (
    clinic_id, name, generic_name, form, strength, pack_label, pack_size, dispense_unit,
    schedule, reference_number, mrp, selling_price, gst_rate, hsn_code, stock_quantity
  )
  select new_clinic_id, name, generic_name, form, strength, pack_label, pack_size, dispense_unit,
    schedule, reference_number, mrp, mrp, gst_rate, hsn_code, 0
  from public.medicine_seed_templates
  order by sort_order;

  return new_clinic_id;
end;
$$;
