-- ============================================================
-- ClinVision, migration 120: security hardening from the whole codebase review.
--
--  1. A suspended clinic, or one whose trial has ended, loses access in the DATABASE, not only on the screens
--     (before this, anyone from such a clinic could carry on through the API).
--  2. The platform owner's private note and negotiated fee on a clinic move to a table clinic staff cannot read.
--  3. The public contact form and the error log get size limits, the error log can no longer be pointed at
--     another clinic, and old error rows are cleaned up.
--  4. The clinic logo storage accepts only PNG, JPEG and WebP files.
--
-- Safe to run more than once. Run this once in the Supabase SQL Editor, after 119.
--
-- To undo part 1 if it ever misbehaves, run this (it puts back the old behaviour):
--   create or replace function public.my_clinic_id() returns uuid language sql stable security definer
--   set search_path = public as $fn$ select clinic_id from public.profiles where id = auth.uid() and is_active = true; $fn$;
-- ============================================================

-- ---- 1. subscription enforced in the database ----
-- my_own_clinic_id(): the clinic the signed-in person belongs to, whatever its subscription state. Only the two
-- policies that the "account suspended" page needs (reading your own clinic and your own profile) use it.
create or replace function public.my_own_clinic_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select clinic_id from public.profiles where id = auth.uid() and is_active = true;
$$;

-- my_clinic_id(): every other policy and function uses this. It now returns nothing for a clinic that is
-- suspended or whose trial has ended, which is the same rule the screens already apply (isSubscriptionActive):
-- active, or trialing with no end date or an end date still ahead.
create or replace function public.my_clinic_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.clinic_id
  from public.profiles p
  join public.clinics c on c.id = p.clinic_id
  where p.id = auth.uid()
    and p.is_active = true
    and (
      c.subscription_status = 'active'
      or (c.subscription_status = 'trialing' and (c.trial_ends_at is null or c.trial_ends_at > now()))
    );
$$;

drop policy if exists "select own clinic" on public.clinics;
create policy "select own clinic" on public.clinics
  for select using (id = public.my_own_clinic_id());

drop policy if exists "select own clinic profiles" on public.profiles;
create policy "select own clinic profiles" on public.profiles
  for select using (clinic_id = public.my_own_clinic_id());

-- ---- 2. the platform owner's private fields ----
create table if not exists public.clinic_private (
  clinic_id uuid primary key references public.clinics(id) on delete cascade,
  subscription_fee_inr int null,
  admin_note text null
);
alter table public.clinic_private enable row level security;
revoke all on public.clinic_private from anon, authenticated;

insert into public.clinic_private (clinic_id, subscription_fee_inr, admin_note)
  select id, subscription_fee_inr, admin_note from public.clinics
  where subscription_fee_inr is not null or admin_note is not null
on conflict (clinic_id) do nothing;

update public.clinics set subscription_fee_inr = null, admin_note = null
  where subscription_fee_inr is not null or admin_note is not null;

create or replace function public.admin_list_clinics()
returns table (
  id uuid, name text, admin_email text, phone text,
  subscription_status text, trial_ends_at timestamptz,
  subscription_fee_inr int, admin_note text,
  subscription_paid_from date, subscription_paid_to date,
  last_patient_added_at timestamptz,
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
      cp.subscription_fee_inr, cp.admin_note,
      c.subscription_paid_from, c.subscription_paid_to,
      (select max(p.created_at) from public.patients p where p.clinic_id = c.id),
      c.created_at
    from public.clinics c
    left join public.clinic_private cp on cp.clinic_id = c.id
    order by c.created_at desc;
end;
$$;

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
      trial_ends_at = case when new_status = 'trialing' then new_trial_ends_at else trial_ends_at end
  where id = target_clinic_id;

  if not found then
    raise exception 'Clinic not found.';
  end if;

  -- the fee and the private note live in clinic_private, which clinic staff cannot read
  insert into public.clinic_private (clinic_id, subscription_fee_inr, admin_note)
    values (target_clinic_id, new_fee_inr, new_note)
  on conflict (clinic_id) do update
    set subscription_fee_inr = excluded.subscription_fee_inr, admin_note = excluded.admin_note;
end;
$$;

-- ---- 3. public forms and the error log ----
alter table public.contact_enquiries drop constraint if exists contact_enquiries_size_check;
alter table public.contact_enquiries add constraint contact_enquiries_size_check check (
  char_length(name) <= 100 and char_length(phone) <= 20
  and char_length(coalesce(clinic_name, '')) <= 150 and char_length(coalesce(city, '')) <= 100
  and char_length(coalesce(message, '')) <= 2000 and char_length(source) <= 50
) not valid;

alter table public.client_errors drop constraint if exists client_errors_size_check;
alter table public.client_errors add constraint client_errors_size_check check (
  char_length(page) <= 200 and char_length(message) <= 2000
  and char_length(coalesce(stack, '')) <= 4000 and char_length(coalesce(user_agent, '')) <= 500
) not valid;

-- An error report can only name the reporter's own clinic (or none), never someone else's, and old rows are
-- cleared out now and then so the table cannot grow without limit.
create or replace function public.limit_client_errors_rate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recent_count bigint;
begin
  select count(*) into v_recent_count
    from public.client_errors
    where created_at > now() - interval '1 minute';
  if v_recent_count >= 200 then
    raise exception 'Too many error reports right now, please try again shortly.';
  end if;

  if auth.uid() is null then
    new.clinic_id := null;
  else
    new.clinic_id := (select p.clinic_id from public.profiles p where p.id = auth.uid());
  end if;

  if random() < 0.02 then
    delete from public.client_errors where created_at < now() - interval '30 days';
  end if;
  return new;
end;
$$;

-- The one-per-phone limit now counts digits only, so adding a space or a dash no longer gets around it.
create or replace function public.limit_contact_enquiries_rate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.contact_enquiries where created_at > now() - interval '1 minute') >= 20 then
    raise exception 'Too many enquiries right now. Please try again shortly.';
  end if;
  if (select count(*) from public.contact_enquiries
        where regexp_replace(phone, '[^0-9]', '', 'g') = regexp_replace(new.phone, '[^0-9]', '', 'g')
          and created_at > now() - interval '1 hour') >= 3 then
    raise exception 'We already have your details. We will get back to you soon.';
  end if;
  return new;
end;
$$;

-- ---- 4. logo storage: pictures only ----
update storage.buckets
  set allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp']
  where id = 'clinic-logos';
