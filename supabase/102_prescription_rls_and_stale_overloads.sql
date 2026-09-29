-- ============================================================
-- Qlinic — migration 102: drop stale create_prescription /
-- get_clinic_prescriptions_by_date overloads, fix a self-referential
-- clinic_id check, and add per-doctor scoping to the prescriptions
-- SELECT policies.
--
-- Verified live against the actual database (via `supabase db query
-- --linked`) before writing this, not just inferred from migration
-- files -- all three problems below are confirmed to exist today,
-- not theoretical:
--
-- 1. create_prescription has FOUR live overloads (6/7/12/16 params),
--    because 090/092/094 each changed the function's *parameter list*
--    via `create or replace`. Postgres identifies a function by name
--    + parameter TYPES, so a changed signature creates a new,
--    separate function rather than replacing the old one -- no
--    migration ever dropped 088's original 6-arg version, 090's
--    7-arg version, or 092's 12-arg version. Only the current 16-arg
--    version (last replaced in 097) has every later security check
--    (clinic-scoped patient/doctor/medicine, the doctor-must-be-
--    linked guard); the three older ones predate those fixes and are
--    still independently callable via PostgREST's normal function-
--    overload resolution. Same issue, smaller blast radius, on
--    get_clinic_prescriptions_by_date (2-arg vs. current 3-arg).
--
-- 2. The "admin or doctor insert prescriptions" policy added in 096
--    to check that patient_id/doctor_id actually belong to the
--    prescription's own clinic has a copy-paste bug: inside each
--    EXISTS subquery, the clinic_id comparison reads `p.clinic_id =
--    p.clinic_id` / `d.clinic_id = d.clinic_id` -- comparing a column
--    to itself, not to the prescription's clinic_id, because the
--    bare `clinic_id` reference resolves to the subquery's own
--    matching column instead of the outer table. That makes both
--    checks pass unconditionally (for any non-null clinic_id), so
--    this backstop currently does nothing. create_prescription()'s
--    own procedural checks (which use local PL/pgSQL variables, not
--    ambiguous bare column names) are unaffected and still correct --
--    this only matters for a direct table insert that bypasses the
--    RPC.
--
-- 3. The SELECT policies on prescriptions/prescription_items check
--    only clinic_id + role ('admin' or 'doctor'), never doctor_id --
--    so a direct table read (bypassing the app's own RPCs, which DO
--    correctly narrow a doctor to their own rows) would return every
--    doctor's prescriptions clinic-wide. The RPCs are SECURITY
--    DEFINER, so they already bypass this policy entirely for their
--    own queries -- this migration only closes the "what if someone
--    reads the table directly" gap, and changes no behavior any
--    existing RPC or page relies on.
--
-- Run this once in the Supabase SQL Editor.
-- ============================================================

-- ---- 1. Drop the three stale create_prescription overloads ----
-- Signatures below are the exact stale ones confirmed live via
-- pg_get_function_identity_arguments -- the current 16-arg version
-- (with every parameter now DEFAULT-valued) is untouched.
drop function if exists public.create_prescription(
  uuid, text, text, text, date, jsonb
);
drop function if exists public.create_prescription(
  uuid, text, text, text, date, jsonb, uuid
);
drop function if exists public.create_prescription(
  uuid, text, text, text, date, jsonb, uuid, text, text, text, text, text[]
);

-- ---- 2. Drop the stale get_clinic_prescriptions_by_date overload ----
-- Confirmed unused by the client (superseded by get_clinic_prescriptions,
-- per 094's own comment) even in its current 3-arg form -- but the
-- 2-arg version specifically predates 093's date-range support and
-- 097's "doctor not linked" fail-closed fix, so it's dropped rather
-- than left as one more unpatched, callable copy.
drop function if exists public.get_clinic_prescriptions_by_date(
  date, uuid
);

-- ---- 3. Fix the self-referential clinic_id check on the INSERT policy ----
drop policy if exists "admin or doctor insert prescriptions" on public.prescriptions;
create policy "admin or doctor insert prescriptions" on public.prescriptions
  for insert with check (
    clinic_id = public.my_clinic_id()
    and public.my_role() in ('admin', 'doctor')
    and exists (
      select 1 from public.patients p
      where p.id = prescriptions.patient_id and p.clinic_id = prescriptions.clinic_id
    )
    and exists (
      select 1 from public.doctors d
      where d.id = prescriptions.doctor_id and d.clinic_id = prescriptions.clinic_id
    )
  );

-- ---- 4. Add per-doctor scoping to the SELECT policies ----
-- Mirrors the doctor-scoping every read RPC already applies
-- procedurally (`v_caller_doctor_id is null or pr.doctor_id =
-- v_caller_doctor_id`) -- admin still sees the whole clinic, a doctor
-- now only sees their own rows even on a direct table read.
drop policy if exists "admin or doctor select prescriptions" on public.prescriptions;
create policy "admin or doctor select prescriptions" on public.prescriptions
  for select using (
    clinic_id = public.my_clinic_id()
    and (
      public.my_role() = 'admin'
      or (public.my_role() = 'doctor' and doctor_id = public.my_doctor_id())
    )
  );

drop policy if exists "admin or doctor select prescription items" on public.prescription_items;
create policy "admin or doctor select prescription items" on public.prescription_items
  for select using (
    exists (
      select 1 from public.prescriptions p
      where p.id = prescription_items.prescription_id
        and p.clinic_id = public.my_clinic_id()
        and (
          public.my_role() = 'admin'
          or (public.my_role() = 'doctor' and p.doctor_id = public.my_doctor_id())
        )
    )
  );
