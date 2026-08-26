-- ============================================================
-- Qlinic — migration 039: allow admin/reception to edit a closed date.
--
-- Why: clinic_closures only ever had insert/delete policies
-- (022_clinic_closures.sql, tightened to admin/reception in
-- 035_closed_dates_reception_write.sql) — there was no way to fix a
-- wrong date or typo'd note short of deleting and re-adding it. Same
-- role/clinic scoping as insert/delete, just for update.
--
-- Run this once in the Supabase SQL Editor, after 038_fix_token_unique_index_by_type.sql.
-- ============================================================

create policy "clinic closures update" on public.clinic_closures
  for update
  using (clinic_id = public.my_clinic_id() and public.my_role() in ('admin', 'reception'))
  with check (clinic_id = public.my_clinic_id() and public.my_role() in ('admin', 'reception'));
