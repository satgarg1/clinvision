-- ============================================================
-- Qlinic — migration 099: public display-board access, daily code +
-- per-scan session grace period.
--
-- Supersedes an earlier draft of this same feature (a 24h rolling
-- token, reused until <1h left, refreshed by a 2-hour TV-side poll)
-- that never shipped — caught in review before it was ever run:
--
--   1. "Active patient kicked out": every scanner shared ONE token's
--      expiry. A patient who scanned at 8:59 AM had their session die
--      at 9:00 AM sharp, mid-visit, regardless of when THEY scanned.
--   2. Race condition at the rotation boundary: a scan seconds before
--      expiry got a near-dead token; any network lag around the
--      rotation moment handed out an already-broken link.
--   3. Relied on a `setInterval` surviving unattended for hours on
--      whatever device runs the board — smart TV browsers throttle or
--      suspend background JS timers, so a missed rotation could leave
--      a stale/dead QR on screen indefinitely with no fallback.
--   4. 24h shared validity was porous for privacy — one scan let
--      someone watch the live queue all day and night.
--
-- Fixed design: the QR encodes a code that's DETERMINISTIC for
-- (clinic, calendar day) — clinic_id + day + a server-only secret,
-- HMAC'd — so the TV never needs precise expiry math or a fragile
-- long-lived timer; it just recomputes the same value on every load
-- (and cheaply, on an hourly safety-net refresh). A phone that scans a
-- valid day-code is issued its OWN 4-hour session, anchored to when
-- THAT patient scanned, completely independent of the day-code's own
-- rotation — so a patient's visit never breaks mid-way just because
-- the wall-clock crossed the day boundary while they were sitting
-- there. The day boundary itself is 2:00 AM, not midnight, so it can
-- never rotate while a late-running clinic still has real patients in
-- the room (this app already uses the same reasoning elsewhere —
-- clinic-data.js's CLOSED_RESET_HOUR).
--
-- Run this once in the Supabase SQL Editor, after 098_fix_revoke_targets.sql.
-- ============================================================

create extension if not exists pgcrypto;

-- Per-scan patient sessions. No RLS policies — every access goes
-- through the security-definer functions below.
create table public.display_board_sessions (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index display_board_sessions_expiry_idx on public.display_board_sessions (expires_at);

alter table public.display_board_sessions enable row level security;

-- Shared helper: today's "board day" — a 2:00 AM to 1:59 AM window,
-- not midnight to midnight, so the day-code never rotates mid-shift
-- for a clinic still open past midnight. Not granted to any client
-- role; called only from the two functions below.
create or replace function public.board_day(p_at timestamptz default now())
returns date
language sql
stable
set search_path = public
as $$
  select ((p_at at time zone 'Asia/Kolkata') - interval '2 hours')::date;
$$;

revoke execute on function public.board_day(timestamptz) from public, anon, authenticated;

-- Staff-side (the TV itself): today's deterministic day-code for this
-- clinic. No table row, no expiry math — it's the same value all day,
-- every time this is called, and a different value once the board day
-- rolls over. The pepper below is a fixed, never-client-exposed secret
-- — only this function's OUTPUT (a one-way hash of it) ever crosses
-- the network, same trust boundary as any other server-side secret in
-- this codebase (e.g. abdm-token.ts's client secret).
create or replace function public.get_daily_board_code()
returns jsonb
language plpgsql
security definer
set search_path = public
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

revoke execute on function public.get_daily_board_code() from public, anon;
grant execute on function public.get_daily_board_code() to authenticated;

-- Patient-side, step 1: exchange a scanned day-code for a personal
-- 4-hour session — anchored to the moment of THIS scan, not to the
-- day-code's own rotation, which is the actual fix for the "kicked
-- out mid-visit" bug. Recomputes the same HMAC independently rather
-- than trusting the client's own clinicId/code pairing at face value.
create or replace function public.redeem_daily_board_code(p_clinic_id uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
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

revoke execute on function public.redeem_daily_board_code(uuid, text) from public;
grant execute on function public.redeem_daily_board_code(uuid, text) to anon, authenticated;

-- Patient-side, step 2: the actual board data, scoped by that
-- session. Returns only clinic/doctor/patient fields the board already
-- renders publicly — never phone, address, age, gender, or reason for
-- visit, even though those columns exist; this function's own select
-- list never reads them, not just hides them after the fact.
create or replace function public.get_display_board_by_session(p_session_id uuid, p_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid;
begin
  select clinic_id into v_clinic_id
    from public.display_board_sessions
    where id = p_session_id and expires_at > now();

  if v_clinic_id is null then
    return jsonb_build_object('error', 'expired');
  end if;

  return jsonb_build_object(
    'clinic', (
      select jsonb_build_object(
        'id', c.id, 'name', c.name, 'display_language', c.display_language,
        'closed_at', c.closed_at, 'logo_url', c.logo_url
      )
      from public.clinics c where c.id = v_clinic_id
    ),
    'doctors', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', d.id, 'name', d.name, 'specialty', d.specialty, 'status', d.status,
        'delay_mins', d.delay_mins, 'status_note', d.status_note,
        'status_updated_at', d.status_updated_at, 'is_active', d.is_active,
        'day_closed_at', d.day_closed_at
      ) order by d.created_at), '[]'::jsonb)
      from public.doctors d
      where d.clinic_id = v_clinic_id and d.is_active = true
    ),
    'patients', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', p.id, 'doctor_id', p.doctor_id, 'name', p.name, 'status', p.status,
        'type', p.type, 'token_number', p.token_number, 'token_date', p.token_date,
        'is_priority', p.is_priority, 'booked_date', p.booked_date, 'booked_time', p.booked_time,
        'arrived_at', p.arrived_at, 'called_at', p.called_at, 'created_at', p.created_at
      )), '[]'::jsonb)
      from public.patients p
      where p.clinic_id = v_clinic_id and p.token_date = p_date
    )
  );
end;
$$;

revoke execute on function public.get_display_board_by_session(uuid, date) from public;
grant execute on function public.get_display_board_by_session(uuid, date) to anon, authenticated;
