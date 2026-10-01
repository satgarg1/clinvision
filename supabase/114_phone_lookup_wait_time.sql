-- ============================================================
-- ClinVision, migration 114: the phone login limit message now says how long to wait.
--
-- Same limits as migration 112 (5 lookups per number in 10 minutes, 60 a minute overall),
-- but the message tells the person when to try again instead of "in a few minutes".
--
-- Safe to run more than once. Run this once in the Supabase SQL Editor, after 113.
-- ============================================================

create or replace function public.email_for_staff_phone(staff_phone text)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_email text;
  v_oldest timestamptz;
  v_wait_minutes integer;
begin
  delete from public.staff_phone_lookups where looked_up_at < now() - interval '1 day';

  if (select count(*) from public.staff_phone_lookups where looked_up_at > now() - interval '1 minute') >= 60 then
    raise exception 'Too many login attempts right now. Please try again in 1 minute.';
  end if;

  if (select count(*) from public.staff_phone_lookups
        where phone = coalesce(staff_phone, '') and looked_up_at > now() - interval '10 minutes') >= 5 then
    -- The oldest attempt in the window leaves it first; that is when one more try is allowed.
    select min(looked_up_at) into v_oldest from public.staff_phone_lookups
      where phone = coalesce(staff_phone, '') and looked_up_at > now() - interval '10 minutes';
    v_wait_minutes := greatest(1, ceil(extract(epoch from (v_oldest + interval '10 minutes' - now())) / 60.0)::integer);
    raise exception 'Too many login attempts for this number. Please try again in % minute%.',
      v_wait_minutes, case when v_wait_minutes = 1 then '' else 's' end;
  end if;

  insert into public.staff_phone_lookups (phone) values (coalesce(staff_phone, ''));

  select email into v_email from public.profiles
    where phone = staff_phone and is_active = true
    limit 1;
  return v_email;
end;
$$;

grant execute on function public.email_for_staff_phone(text) to anon, authenticated;
