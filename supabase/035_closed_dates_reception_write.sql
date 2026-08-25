-- ============================================================
-- Qlinic — migration 035: restrict clinic_closures writes to admin/reception.
--
-- Why: doctors now get read-only access to Closed Dates (they benefit
-- from seeing which days the clinic is shut, same as reception does),
-- but adding/removing a closed date stays reception/admin's call. The
-- existing insert/delete policies (022_clinic_closures.sql) were only
-- ever clinic-scoped, relying entirely on the UI to hide the form from
-- non-admins — once a doctor can load the page, that's no longer
-- enough, so the role check has to move into the policy itself. Mirrors
-- the role check doctor_holidays already uses (033_doctor_holidays.sql).
--
-- Run this once in the Supabase SQL Editor, after 034_queue_status_booked_date.sql.
-- ============================================================

drop policy "clinic closures insert" on public.clinic_closures;
drop policy "clinic closures delete" on public.clinic_closures;

create policy "clinic closures insert" on public.clinic_closures
  for insert with check (clinic_id = public.my_clinic_id() and public.my_role() in ('admin', 'reception'));
create policy "clinic closures delete" on public.clinic_closures
  for delete using (clinic_id = public.my_clinic_id() and public.my_role() in ('admin', 'reception'));
