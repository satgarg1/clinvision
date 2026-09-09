-- ============================================================
-- Qlinic — migration 086: platform admin panel, clinic activity/
-- health signal.
--
-- subscription_status alone can't tell an active-but-genuinely-using-it
-- clinic apart from an active-but-gone-quiet one — a churn risk that's
-- invisible today unless the clinic itself calls or emails to say
-- something's wrong. Chosen the cheap way, per BACKLOG.md's own
-- framing: a live "when did this clinic last add a patient" query
-- computed on page load, not a new last_active_at column that would
-- need a trigger kept in sync everywhere a patient gets inserted.
-- Fine at current clinic counts; would need re-thinking (a real
-- maintained column, likely) if this ever runs against hundreds of
-- clinics, since it's one correlated subquery per clinic row.
--
-- Redefines admin_list_clinics() (081_clinic_subscription_fields.sql)
-- with one new column rather than a new RPC — every existing caller
-- (admin.html's clinic list) already re-fetches this whole list, so
-- there's nothing extra to wire up beyond reading the new field.
--
-- Run this once in the Supabase SQL Editor, after
-- 085_client_errors.sql.
-- ============================================================

-- CREATE OR REPLACE FUNCTION cannot change a function's return row
-- shape (adding a column to a RETURNS TABLE counts as a shape change,
-- not just a body edit) -- Postgres requires the old one dropped first.
-- Only this one call site (admin.html, via Qlinic.listPlatformClinics())
-- depends on it, so dropping it here is safe.
drop function if exists public.admin_list_clinics();

create function public.admin_list_clinics()
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
      c.subscription_fee_inr, c.admin_note,
      c.subscription_paid_from, c.subscription_paid_to,
      (select max(p.created_at) from public.patients p where p.clinic_id = c.id),
      c.created_at
    from public.clinics c
    order by c.created_at desc;
end;
$$;

grant execute on function public.admin_list_clinics() to authenticated;
