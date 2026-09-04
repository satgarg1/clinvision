-- ============================================================
-- Qlinic — migration 071: fix pharmacy invoice number collisions.
--
-- Real bug hit during the smoke test: 013_billing.sql's own unique
-- index, invoices_clinic_number_idx on (clinic_id, invoice_number),
-- has no idea invoice_type exists — it was written back when every
-- invoice was a consultation. Pharmacy invoices get their own separate
-- counter (next_pharmacy_invoice_number, 066_pharmacy_invoices.sql),
-- so a pharmacy sale numbered 1 collides with the clinic's own
-- pre-existing consultation invoice 1 under the OLD index, throwing
-- "duplicate key value violates unique constraint" on every pharmacy
-- sale once a consultation invoice with the same number already
-- exists (in practice: on the very first sale, since every clinic has
-- consultation invoices already).
--
-- Run this once in the Supabase SQL Editor, after 070_seed_medicines_on_register.sql.
-- ============================================================

drop index if exists public.invoices_clinic_number_idx;
create unique index invoices_clinic_type_number_idx on public.invoices (clinic_id, invoice_type, invoice_number);
