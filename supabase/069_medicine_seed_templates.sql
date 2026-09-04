-- ============================================================
-- Qlinic — migration 069: medicine seed templates.
--
-- Global reference data (no clinic_id, no RLS — never queried by the
-- client directly, only copied by 070's register_clinic hook), so the
-- ~500-item starter catalog BACKLOG.md describes lives in one place
-- rather than being re-typed into every new clinic by hand.
--
-- IMPORTANT: this migration seeds only 25 common medicines, not the
-- full ~500-item list BACKLOG.md scoped — compiling that real list
-- (with the care it needs on Schedule H/H1/X classification and MRP
-- currency) is its own content task, not something to draft inline in
-- a migration. This unblocks building and testing the actual pharmacy
-- feature now; a later migration appends the rest without touching
-- this one, and re-running the copy in 070 for clinics that already
-- exist is safe since it's idempotent.
--
-- MRPs below are illustrative, current as of when this was written —
-- exactly the "editable starting point, not authoritative live
-- pricing" BACKLOG.md flags. HSN 3004 (pharmaceutical preparations) is
-- used throughout except supplements at their own general goods rate;
-- a clinic should treat every seeded row as a draft to check, not a
-- fact to trust blindly.
--
-- Run this once in the Supabase SQL Editor, after 068_medicine_rpcs.sql.
-- ============================================================

create table public.medicine_seed_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  generic_name text not null default '',
  form text not null default '',
  strength text not null default '',
  unit_of_sale text not null default '',
  schedule text not null default 'none' check (schedule in ('none', 'h', 'h1', 'x')),
  reference_number text not null,
  mrp numeric(10, 2) not null default 0,
  gst_rate numeric(4, 2) not null default 12,
  hsn_code text not null default '3004',
  sort_order integer not null default 0
);

insert into public.medicine_seed_templates
  (name, generic_name, form, strength, unit_of_sale, schedule, reference_number, mrp, gst_rate, sort_order)
values
  ('Paracetamol 650mg', 'Paracetamol', 'Tablet', '650mg', 'Strip of 15', 'none', 'PCM001', 30, 12, 10),
  ('Paracetamol Syrup', 'Paracetamol', 'Syrup', '125mg/5ml', 'Bottle of 60ml', 'none', 'PCM002', 45, 12, 20),
  ('Amoxicillin 500mg', 'Amoxicillin', 'Capsule', '500mg', 'Strip of 10', 'h', 'AMX001', 40, 5, 30),
  ('Azithromycin 500mg', 'Azithromycin', 'Tablet', '500mg', 'Strip of 3', 'h1', 'AZM001', 120, 5, 40),
  ('Ciprofloxacin 500mg', 'Ciprofloxacin', 'Tablet', '500mg', 'Strip of 10', 'h', 'CIP001', 55, 5, 50),
  ('Cetirizine 10mg', 'Cetirizine', 'Tablet', '10mg', 'Strip of 10', 'none', 'CTZ001', 35, 12, 60),
  ('Levocetirizine 5mg', 'Levocetirizine', 'Tablet', '5mg', 'Strip of 10', 'none', 'LCZ001', 38, 12, 70),
  ('Pantoprazole 40mg', 'Pantoprazole', 'Tablet', '40mg', 'Strip of 10', 'h', 'PAN001', 95, 12, 80),
  ('Omeprazole 20mg', 'Omeprazole', 'Capsule', '20mg', 'Strip of 10', 'h', 'OMP001', 60, 12, 90),
  ('Rabeprazole 20mg', 'Rabeprazole', 'Tablet', '20mg', 'Strip of 10', 'h', 'RAB001', 90, 12, 100),
  ('Metformin 500mg', 'Metformin', 'Tablet', '500mg', 'Strip of 15', 'h', 'MET001', 40, 12, 110),
  ('Amlodipine 5mg', 'Amlodipine', 'Tablet', '5mg', 'Strip of 10', 'h', 'AML001', 30, 12, 120),
  ('Atorvastatin 10mg', 'Atorvastatin', 'Tablet', '10mg', 'Strip of 10', 'h', 'ATV001', 85, 12, 130),
  ('Ibuprofen 400mg', 'Ibuprofen', 'Tablet', '400mg', 'Strip of 10', 'none', 'IBU001', 30, 12, 140),
  ('Diclofenac 50mg', 'Diclofenac Sodium', 'Tablet', '50mg', 'Strip of 10', 'h', 'DIC001', 25, 12, 150),
  ('ORS Sachet', 'Oral Rehydration Salts', 'Powder', 'Standard', 'Sachet', 'none', 'ORS001', 20, 5, 160),
  ('Domperidone 10mg', 'Domperidone', 'Tablet', '10mg', 'Strip of 10', 'h', 'DOM001', 32, 12, 170),
  ('Metronidazole 400mg', 'Metronidazole', 'Tablet', '400mg', 'Strip of 10', 'h', 'MTZ001', 28, 12, 180),
  ('Cough Syrup', 'Dextromethorphan', 'Syrup', '10mg/5ml', 'Bottle of 100ml', 'h', 'COU001', 85, 12, 190),
  ('Vitamin D3 60000 IU', 'Cholecalciferol', 'Sachet', '60000 IU', 'Sachet', 'none', 'VTD001', 32, 5, 200),
  ('Multivitamin Tablet', 'Multivitamin', 'Tablet', 'Standard', 'Strip of 15', 'none', 'MVT001', 60, 18, 210),
  ('Calcium + Vitamin D3', 'Calcium Carbonate', 'Tablet', '500mg', 'Strip of 15', 'none', 'CAL001', 75, 18, 220),
  ('Salbutamol Inhaler', 'Salbutamol', 'Inhaler', '100mcg', 'Inhaler', 'h', 'SAL001', 150, 12, 230),
  ('Insulin Glargine', 'Insulin Glargine', 'Injection', '100 IU/ml', 'Vial', 'h', 'INS001', 450, 5, 240),
  ('Povidone Iodine Solution', 'Povidone Iodine', 'Solution', '10%', 'Bottle of 100ml', 'none', 'PVI001', 55, 18, 250);
