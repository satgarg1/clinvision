-- ============================================================
-- ClinVision, migration 116: the free trial for a new clinic is 30 days, not 7.
--
-- The pricing page promises one month free. A clinic that signs up now gets a trial that ends
-- 30 days after it registers. This changes new sign ups only; clinics that already exist keep
-- the trial end date they have (a platform admin can change it in the admin panel, Manage clinic,
-- trial length).
--
-- Trial and paid status are separate: a trial is the status "Trialing" with an end date. When a
-- platform admin activates a clinic (status "Active" with a paid to date), the trial length no
-- longer matters, and the clinic runs until the paid to date plus the 3 day grace period.
--
-- Safe to run more than once. Run this once in the Supabase SQL Editor, after 115.
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

  insert into public.clinics (name, admin_email, trial_ends_at)
  values (clinic_name, (select email from auth.users where id = auth.uid()), now() + interval '30 days')
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
