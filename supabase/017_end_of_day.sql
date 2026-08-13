-- ============================================================
-- Qlinic — migration 017: end-of-day close/reopen toggle,
-- and a doctor's own "closed for the day" signal.
--
-- Why: closeDayNoShows() had no persisted state, so the button couldn't
-- grey itself out or offer an undo — clicking it twice just re-ran a
-- no-op query. last_closed_date gives the admin/reception "End of day"
-- panel (now on the Revenue page, not Dashboard) something to check.
-- Reopening only clears this flag; it deliberately does not try to
-- un-flip the no-shows closing just created, since there's no reliable
-- way to tell those apart from no-shows marked manually earlier.
--
-- day_closed_at is a separate signal from doctors.status on purpose:
-- it's "I'm done for today," not a live-availability state like
-- running_late/on_break, so it lives in its own column rather than
-- overloading status (which the "Your status" panel already owns).
-- The display screen fades a doctor out 10 minutes after this is set,
-- checked client-side against the existing refresh loop — no cron
-- needed.
--
-- Run this once in the Supabase SQL Editor, after 016_auto_invoice_on_arrival.sql.
-- ============================================================

alter table public.clinics add column if not exists last_closed_date date;

alter table public.doctors add column if not exists day_closed_at timestamptz;
