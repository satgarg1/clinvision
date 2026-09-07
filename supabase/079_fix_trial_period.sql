-- ============================================================
-- Fix trial_ends_at, dropped by mistake, and shorten the trial to 7 days.
--
-- Real bug found while making the 14 -> 7 day change: 053 added
-- trial_ends_at to register_clinic()'s insert, but 070
-- (register_clinic's next redefinition, adding medicine seeding) based
-- its copy of the function body on 003's original version, from
-- BEFORE 053 existed, not on 053's own version. That silently dropped
-- the trial_ends_at column and value from the insert. Every clinic
-- registered since 070 ran has trial_ends_at = null, and
-- isSubscriptionActive() in clinic-data.js treats a null trial_ends_at
-- as "still inside the trial" forever:
--   if (clinic.subscription_status === 'trialing') {
--     return !clinic.trial_ends_at || new Date(clinic.trial_ends_at) > new Date();
--   }
-- So the 14-day gate has not actually been enforced on any clinic that
-- signed up after 070, they've all had an unintended indefinite trial.
--
-- This redefines register_clinic() one more time: same body as 072
-- (medicine seeding included), trial_ends_at restored, now at 7 days.
--
-- This migration does NOT touch any existing clinic row -- any clinic
-- that already signed up with a null trial_ends_at keeps it null (still
-- unintentionally ungated) until you decide by hand whether to backfill
-- a real trial_ends_at for them or leave them as is. Worth a manual
-- look: `select id, name, subscription_status, trial_ends_at from
-- clinics where subscription_status = 'trialing' and trial_ends_at is
-- null;` to see who's affected.
--
-- Run this once in the Supabase SQL Editor, after 072_medicine_pack_units.sql.
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
  values (clinic_name, (select email from auth.users where id = auth.uid()), now() + interval '7 days')
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
