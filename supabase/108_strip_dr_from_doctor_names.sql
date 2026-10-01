-- ============================================================
-- ClinVision, migration 108: remove a typed "Dr." from existing doctor names.
--
-- Doctor names are saved without a title and every screen adds "Dr." itself,
-- so a name saved as "Dr. Asha Rao" showed as "Dr. Dr. Asha Rao" on several
-- screens. New saves are already cleaned in the app (clinic-data.js); this
-- cleans the rows that were saved before that.
--
-- Safe to run more than once. A name that is only a title is left alone.
-- Run this once in the Supabase SQL Editor, after 107.
-- ============================================================

update public.doctors
   set name = btrim(regexp_replace(name, '^\s*dr\.?\s+', '', 'i'))
 where name ~* '^\s*dr\.?\s+'
   and btrim(regexp_replace(name, '^\s*dr\.?\s+', '', 'i')) <> '';
