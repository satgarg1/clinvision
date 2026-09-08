-- ============================================================
-- Qlinic — migration 081: platform admin panel, part A (clinic
-- billing fields + subscription period + admin RPCs).
--
-- subscription_status already exists and already gates every
-- authenticated page (053_clinic_subscription_status.sql), and
-- trial_ends_at already drives the trialing clock. This adds:
--   - subscription_fee_inr / admin_note: the CRM-lite fields the
--     platform admin panel edits per clinic (different clinics
--     realistically pay different negotiated amounts).
--   - subscription_paid_from / subscription_paid_to: the exact paid
--     period a platform admin enters when marking a clinic Active,
--     so migration 082's nightly job can auto-suspend a lapsed clinic
--     without a human remembering to come back and flip a switch.
--
-- admin_update_clinic_subscription() is the single RPC behind
-- admin.html's one "Save changes" button — status, dates, fee, and
-- note all land in one write, matching the mockup's "everything in
-- this popover saves together or not at all" behavior.
--
-- Run this once in the Supabase SQL Editor, after 080_platform_admins.sql.
-- ============================================================

alter table public.clinics add column if not exists subscription_fee_inr int null;
alter table public.clinics add column if not exists admin_note text null;
alter table public.clinics add column if not exists subscription_paid_from date null;
alter table public.clinics add column if not exists subscription_paid_to date null;

create or replace function public.admin_list_clinics()
returns table (
  id uuid, name text, admin_email text, phone text,
  subscription_status text, trial_ends_at timestamptz,
  subscription_fee_inr int, admin_note text,
  subscription_paid_from date, subscription_paid_to date,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Not authorized.';
  end if;
  return query
    select c.id, c.name, c.admin_email, c.phone,
      c.subscription_status, c.trial_ends_at,
      c.subscription_fee_inr, c.admin_note,
      c.subscription_paid_from, c.subscription_paid_to,
      c.created_at
    from public.clinics c
    order by c.created_at desc;
end;
$$;

grant execute on function public.admin_list_clinics() to authenticated;

-- new_trial_ends_at is a full timestamp (not just a date) since
-- trial_ends_at itself already is — admin.html computes it client-side
-- from "trial starts" + "trial length in days" the same way it computes
-- an Active clinic's paid-to date, then sends the result here.
create or replace function public.admin_update_clinic_subscription(
  target_clinic_id uuid,
  new_status text,
  new_paid_from date default null,
  new_paid_to date default null,
  new_trial_ends_at timestamptz default null,
  new_fee_inr int default null,
  new_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Not authorized.';
  end if;
  if new_status not in ('trialing', 'active', 'suspended') then
    raise exception 'Invalid subscription status.';
  end if;
  if new_status = 'active' and (new_paid_from is null or new_paid_to is null) then
    raise exception 'An active subscription needs both a paid-from and a paid-to date.';
  end if;
  if new_paid_from is not null and new_paid_to is not null and new_paid_to < new_paid_from then
    raise exception 'Paid-to date cannot be before paid-from date.';
  end if;

  update public.clinics
  set subscription_status = new_status,
      subscription_paid_from = case when new_status = 'active' then new_paid_from else subscription_paid_from end,
      subscription_paid_to = case when new_status = 'active' then new_paid_to else subscription_paid_to end,
      trial_ends_at = case when new_status = 'trialing' then new_trial_ends_at else trial_ends_at end,
      subscription_fee_inr = new_fee_inr,
      admin_note = new_note
  where id = target_clinic_id;

  if not found then
    raise exception 'Clinic not found.';
  end if;
end;
$$;

grant execute on function public.admin_update_clinic_subscription(uuid, text, date, date, timestamptz, int, text) to authenticated;
