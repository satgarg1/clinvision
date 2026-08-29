-- ============================================================
-- Qlinic — migration 053: manual subscription gate.
--
-- Why: every signed-up clinic gets full access forever right now -
-- there's no notion of "this clinic is actually paying." This is the
-- MVP version deliberately chosen over wiring a payment processor
-- immediately: no Razorpay/Stripe integration yet, just a field that
-- gates every authenticated page, which the clinic owner (you) flips
-- by hand once a clinic has actually paid. Automating the flip later
-- (a payment processor's webhook writing this same field) needs no
-- schema change and no changes to any page - only who/what writes to
-- subscription_status changes.
--
-- subscription_status:
--   'trialing'  - new signups land here, gated open only until
--                 trial_ends_at (set by register_clinic() below).
--   'active'    - paid and confirmed manually - full access, no
--                 trial_ends_at check.
--   'suspended' - manually set (payment lapsed, chargeback, abuse,
--                 etc.) - blocked immediately regardless of dates.
--
-- Run this once in the Supabase SQL Editor, after
-- 052_create_invoice_patient_id.sql.
-- ============================================================

alter table public.clinics add column if not exists subscription_status text not null default 'trialing'
  check (subscription_status in ('trialing', 'active', 'suspended'));
alter table public.clinics add column if not exists trial_ends_at timestamptz null;

-- Every clinic that already existed before this concept did (this
-- session's own test/demo clinics included) is grandfathered straight
-- to active - gating a clinic that's already been using the app, with
-- no warning and no way to pay yet, would just be a self-inflicted
-- lockout. Only clinics registered AFTER this migration runs start on
-- a real trial clock.
update public.clinics set subscription_status = 'active' where subscription_status = 'trialing';

-- register_clinic() now also starts a 14-day trial clock for a brand
-- new clinic - subscription_status stays at its column default
-- ('trialing'), only trial_ends_at is set here. Both real signup paths
-- (an immediate session, and the email-confirmation-deferred path in
-- finishClinicSetupIfNeeded) call this same function, so neither needs
-- its own copy of this logic.
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
  values (clinic_name, (select email from auth.users where id = auth.uid()), now() + interval '14 days')
  returning id into new_clinic_id;

  insert into public.profiles (id, clinic_id, email, role)
  values (auth.uid(), new_clinic_id, (select email from auth.users where id = auth.uid()), 'admin');

  return new_clinic_id;
end;
$$;
