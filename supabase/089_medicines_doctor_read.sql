-- ============================================================
-- Qlinic — migration 089: doctors can read the medicine catalog.
--
-- 063_medicines.sql's own select policy only covered
-- admin/reception/pharmacist, since at the time nothing outside the
-- pharmacy counter needed to read this table. The prescription module
-- (088_prescriptions.sql, Qlinic.searchMedicinesForRx) has a doctor
-- search the clinic's own stocked medicines first, before falling back
-- to the national generic_medicines list — without this, that half of
-- the search silently returns nothing for every doctor.
--
-- Run this once in the Supabase SQL Editor, after 088_prescriptions.sql.
-- ============================================================

drop policy if exists "pharmacy staff select medicines" on public.medicines;
create policy "clinic staff select medicines" on public.medicines
  for select using (
    clinic_id = public.my_clinic_id()
    and public.my_role() in ('admin', 'reception', 'pharmacist', 'doctor')
  );
