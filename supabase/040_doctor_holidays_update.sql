-- ============================================================
-- Qlinic — migration 040: allow editing a doctor holiday, not just delete.
--
-- Why: doctor_holidays (033) only ever had select/insert/delete
-- policies — a wrong date or typo'd note had no fix short of deleting
-- and re-adding it. Same gap clinic_closures had before
-- 039_clinic_closures_update.sql. Mirrors that same fix here: same
-- role check as the existing insert/delete policies (a doctor edits
-- their own, admin edits any doctor's).
--
-- Run this once in the Supabase SQL Editor, after 039_clinic_closures_update.sql.
-- ============================================================

create policy "doctor holidays update" on public.doctor_holidays
  for update
  using (
    clinic_id = public.my_clinic_id()
    and (doctor_id = public.my_doctor_id() or public.my_role() = 'admin')
  )
  with check (
    clinic_id = public.my_clinic_id()
    and (doctor_id = public.my_doctor_id() or public.my_role() = 'admin')
  );
