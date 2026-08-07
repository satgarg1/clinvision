-- ============================================================
-- Waiting-room display screen language.
--
-- Many patients reading the waiting-room TV board are more comfortable
-- in Hindi than English, but some clinics still want English. This is a
-- clinic-wide setting (not a personal device preference like the
-- day/night theme), since the display board is a shared screen in the
-- waiting room, not something any one staff member's device controls.
-- ============================================================

alter table public.clinics
  add column display_language text not null default 'en'
  check (display_language in ('en', 'hi'));
