-- ============================================================
-- Qlinic — migration 070: seed every clinic's medicine catalog.
--
-- register_clinic() (003_staff_roles.sql) is the one place a new
-- clinic + admin profile gets created — the natural hook to also copy
-- medicine_seed_templates (069) into that clinic's own medicines table,
-- right in the same transaction, no trigger or Edge Function needed.
-- stock_quantity starts at 0 — a brand-new clinic hasn't actually
-- stocked anything yet; real on-hand counts get entered as a real
-- stock-in (record_stock_purchase) once the pharmacy counter opens.
--
-- Also backfills any clinic that already exists (registered before
-- this migration ran) — guarded to skip a clinic that already has any
-- medicines row, so re-running this migration is harmless.
--
-- Run this once in the Supabase SQL Editor, after 069_medicine_seed_templates.sql.
-- ============================================================

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
    clinic_id, name, generic_name, form, strength, unit_of_sale, schedule,
    reference_number, mrp, selling_price, gst_rate, hsn_code, stock_quantity
  )
  select new_clinic_id, name, generic_name, form, strength, unit_of_sale, schedule,
    reference_number, mrp, mrp, gst_rate, hsn_code, 0
  from public.medicine_seed_templates
  order by sort_order;

  return new_clinic_id;
end;
$$;

-- Backfill: any clinic registered before this migration existed gets
-- the same seed, skipped if it somehow already has medicines rows.
insert into public.medicines (
  clinic_id, name, generic_name, form, strength, unit_of_sale, schedule,
  reference_number, mrp, selling_price, gst_rate, hsn_code, stock_quantity
)
select c.id, t.name, t.generic_name, t.form, t.strength, t.unit_of_sale, t.schedule,
  t.reference_number, t.mrp, t.mrp, t.gst_rate, t.hsn_code, 0
from public.clinics c
cross join public.medicine_seed_templates t
where not exists (select 1 from public.medicines m where m.clinic_id = c.id);
