-- ============================================================
-- Self-service login phone: a doctor or staff member could always be
-- GIVEN a phone number by their admin (team.html -> update_staff_phone,
-- 054_staff_phone.sql), but had no way to add or change it themselves --
-- update_staff_phone is deliberately admin-only, so a self-call to it
-- is rejected outright. This adds the missing self-service counterpart.
--
-- Run this once in the Supabase SQL Editor, after 059_staff_holidays.sql.
-- ============================================================

-- No role check needed -- unlike update_staff_phone (which can touch
-- ANY profile in the clinic, hence the admin gate), this only ever
-- touches the caller's own row via auth.uid(), so there's nothing to
-- authorize beyond "you're logged in." Same uniqueness constraint as
-- 054 (profiles_phone_idx) still applies; caught here for a clean
-- message instead of a raw constraint-violation error.
create or replace function public.update_my_phone(new_phone text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
  set phone = nullif(new_phone, '')
  where id = auth.uid();
exception
  when unique_violation then
    raise exception 'That phone number is already in use by another account.';
end;
$$;

grant execute on function public.update_my_phone(text) to authenticated;
