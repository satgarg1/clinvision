-- ============================================================
-- ClinVision, migration 112: three hardening fixes from the pre deployment review.
--
-- 1. Phone login lookup. email_for_staff_phone() is open to anyone who is not logged in and
--    returns the staff email for a phone number. It now refuses to answer more than 5 times
--    for the same number in 10 minutes, or more than 60 times a minute overall, so it can no
--    longer be used to sweep through numbers. A normal login (one lookup per attempt) is
--    never affected.
-- 2. Patient deletion. The doctor role could delete patient rows. Only admin and reception can
--    now (nothing in the doctor screens deletes patients).
-- 3. Contact form. The public contact form insert had no limit. It now allows at most 20
--    enquiries a minute overall and 3 an hour from the same phone number.
--
-- Safe to run more than once. Run this once in the Supabase SQL Editor, after 111.
-- ============================================================

-- 1. phone login lookup rate limit -------------------------------------------------------
create table if not exists public.staff_phone_lookups (
  id bigserial primary key,
  phone text not null,
  looked_up_at timestamptz not null default now()
);
create index if not exists staff_phone_lookups_phone_idx on public.staff_phone_lookups (phone, looked_up_at desc);
create index if not exists staff_phone_lookups_at_idx on public.staff_phone_lookups (looked_up_at desc);
alter table public.staff_phone_lookups enable row level security;
-- No policies: only the function below (security definer) can read or write this table.

create or replace function public.email_for_staff_phone(staff_phone text)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  delete from public.staff_phone_lookups where looked_up_at < now() - interval '1 day';

  if (select count(*) from public.staff_phone_lookups where looked_up_at > now() - interval '1 minute') >= 60 then
    raise exception 'Too many login attempts right now. Please try again in a minute.';
  end if;
  if (select count(*) from public.staff_phone_lookups
        where phone = coalesce(staff_phone, '') and looked_up_at > now() - interval '10 minutes') >= 5 then
    raise exception 'Too many login attempts for this number. Please try again in a few minutes.';
  end if;

  insert into public.staff_phone_lookups (phone) values (coalesce(staff_phone, ''));

  select email into v_email from public.profiles
    where phone = staff_phone and is_active = true
    limit 1;
  return v_email;
end;
$$;

grant execute on function public.email_for_staff_phone(text) to anon, authenticated;

-- 2. patients: the doctor role can no longer delete ---------------------------------------
drop policy if exists "clinic staff patients delete" on public.patients;
create policy "clinic staff patients delete" on public.patients
  for delete using (clinic_id = public.my_clinic_id() and public.my_role() in ('admin', 'reception'));

-- 3. contact form flood limit -------------------------------------------------------------
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
        where phone = new.phone and created_at > now() - interval '1 hour') >= 3 then
    raise exception 'We already have your details. We will get back to you soon.';
  end if;
  return new;
end;
$$;

drop trigger if exists contact_enquiries_limit_rate on public.contact_enquiries;
create trigger contact_enquiries_limit_rate
  before insert on public.contact_enquiries
  for each row execute function public.limit_contact_enquiries_rate();
