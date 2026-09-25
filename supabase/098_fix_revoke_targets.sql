-- ============================================================
-- Qlinic — migration 098: fix ineffective REVOKEs from 097.
--
-- Live-tested after running 097: auto_suspend_expired_clinics() and
-- record_care_context() were STILL callable by an ordinary authenticated
-- session after "revoke execute ... from public". Root cause: this
-- Supabase project has auto_expose_new_tables-equivalent behavior for
-- functions too — every new function gets EXECUTE granted directly to
-- anon/authenticated at creation time, separate from (and in addition
-- to) the implicit PUBLIC grant Postgres also adds by default.
-- "REVOKE ... FROM PUBLIC" only removes the PUBLIC-pseudo-role grant;
-- it never touches that separate direct anon/authenticated grant, so
-- both functions stayed fully callable despite 097's fix. Naming the
-- actual roles closes it for real. Verified live: after this migration,
-- calling either RPC as an ordinary authenticated user must return a
-- permission-denied error, not a silent 204 success.
--
-- Run this once in the Supabase SQL Editor, after 097_review_findings_round3.sql.
-- ============================================================

revoke execute on function public.auto_suspend_expired_clinics() from public, anon, authenticated;
revoke execute on function public.record_care_context(uuid) from public, anon, authenticated;

-- create_prescription() (097) re-granted to authenticated explicitly,
-- so it was never actually open to a logged-in caller — but the same
-- anon/authenticated-separate-from-PUBLIC gap meant anon ALSO kept
-- independent execute access (harmless in practice, since the
-- function's own internal role check rejects every anon caller
-- regardless — but not what "revoke from public" was meant to
-- achieve). Revoke from anon explicitly for correctness.
revoke execute on function public.create_prescription(
  uuid, text, text, text, date, jsonb, uuid, text, text, text, text, text[], text, int, text, text
) from anon;

-- Also still live-exploitable right now, discovered while verifying the
-- above: auto_close_previous_day() (074, "revoke from public" fix
-- attempted in 077) has the exact same gap — confirmed callable by an
-- ordinary authenticated session moments before this migration was
-- written. Calling it directly force-closes EVERY clinic's previous
-- day (marks every still-'booked' patient no_show, platform-wide),
-- not just the caller's own clinic — a real, currently-live cross-
-- tenant availability bug, not a hypothetical one.
revoke execute on function public.auto_close_previous_day() from public, anon, authenticated;

