-- ============================================================
-- Qlinic — migration 101: fix a second real bug in the display-board
-- QR feature, caught by live testing after 100 was already run.
--
-- Migration 100 fixed hmac()'s argument types (bytea, not text) but
-- the call still failed: "function hmac(bytea, bytea, unknown) does
-- not exist". Root cause is Supabase-specific — pgcrypto is installed
-- into the `extensions` schema here, not `public`, and both functions
-- below pin `search_path = public` (deliberately, to avoid the same
-- "REVOKE FROM PUBLIC isn't enough" class of surprise this codebase
-- already hit once this session for a different reason) — which
-- excludes `extensions`, so hmac() can't be resolved at all. Confirmed
-- live: calling public.get_daily_board_code() as a real staff session
-- threw exactly that error.
--
-- Run this once in the Supabase SQL Editor, after 100_fix_hmac_bytea_cast.sql.
-- ============================================================

create or replace function public.get_daily_board_code()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_clinic_id uuid;
  v_day date;
  v_code text;
begin
  if public.my_role() is null then
    raise exception 'Must be an active clinic staff member.';
  end if;
  v_clinic_id := public.my_clinic_id();
  v_day := public.board_day();
  v_code := encode(
    hmac(
      (v_clinic_id::text || '|' || v_day::text)::bytea,
      'qlinic-display-board-pepper-8f3a1c9e2b7d4f60'::bytea,
      'sha256'
    ),
    'hex'
  );
  return jsonb_build_object('clinicId', v_clinic_id, 'code', v_code);
end;
$$;

create or replace function public.redeem_daily_board_code(p_clinic_id uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_expected text;
  v_session_id uuid;
  v_expires timestamptz;
begin
  v_expected := encode(
    hmac(
      (p_clinic_id::text || '|' || public.board_day()::text)::bytea,
      'qlinic-display-board-pepper-8f3a1c9e2b7d4f60'::bytea,
      'sha256'
    ),
    'hex'
  );
  if p_code is null or p_code <> v_expected then
    return jsonb_build_object('error', 'invalid_code');
  end if;

  v_expires := now() + interval '4 hours';
  insert into public.display_board_sessions (clinic_id, expires_at)
    values (p_clinic_id, v_expires)
    returning id into v_session_id;

  delete from public.display_board_sessions
    where clinic_id = p_clinic_id and expires_at < now() - interval '1 day';

  return jsonb_build_object('sessionId', v_session_id, 'expiresAt', v_expires);
end;
$$;
