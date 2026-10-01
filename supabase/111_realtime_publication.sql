-- ============================================================
-- ClinVision, migration 111: send live changes for bills and the other tables the pages watch.
--
-- The Dashboard, Revenue and Insights pages update on their own when a patient arrives
-- (patients is already live). A bill created or adjusted without a patient change, a pharmacy
-- sale, a new feedback rating, a closed date or a holiday did not reach them, because those
-- tables were not part of Supabase's realtime publication. This adds them. Row level security
-- still applies: a person only receives changes for rows they are allowed to read.
--
-- Safe to run more than once. Run this once in the Supabase SQL Editor, after 110.
-- ============================================================

do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  foreach t in array array[
    'patients', 'doctors', 'doctor_holidays', 'staff_holidays', 'clinic_closures',
    'invoices', 'visit_feedback', 'clinics'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;
