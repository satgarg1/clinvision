-- ============================================================
-- Qlinic — migration 002: doctors can be deactivated, not just deleted
--
-- Run this once in your Supabase project's SQL Editor, same as schema.sql.
--
-- Why: doctors.id is referenced by patients.doctor_id with
-- `on delete cascade` — hard-deleting a doctor would permanently wipe
-- every patient record ever tied to them. A clinic admin removing a
-- doctor who left the practice should not lose that doctor's entire
-- patient history. Deactivated doctors are hidden from reception, the
-- doctor view, and the display board, but can be reactivated at any
-- time with their history intact.
-- ============================================================

alter table public.doctors add column is_active boolean not null default true;
