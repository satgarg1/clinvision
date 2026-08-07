-- ============================================================
-- Patient gender, captured at intake (both walk-in and phoned-appointment
-- forms share the same "Add a patient" form, so this covers both).
-- ============================================================

alter table public.patients
  add column gender text not null default 'other'
  check (gender in ('male', 'female', 'other'));
