-- ============================================================
-- Qlinic — migration 099: public display-board access, time-boxed.
--
-- Why: display.html requires a staff login today (Qlinic.requireLogin),
-- so a QR code pointing patients at it would just bounce them to the
-- login page — it can't actually show a patient anything. This adds a
-- capability-URL path for it, the same pattern get_queue_status()
-- (007_token_numbers.sql) already uses for one patient's own status:
-- knowing an unguessable token authorizes seeing the board, no login
-- required, no clinic browsing possible.
--
-- Different from that precedent in one way, deliberately: rather than
-- reusing clinics.id directly as the capability token (which would
-- never expire — a clinic's id is permanent), this mints a SEPARATE
-- token row with its own expiry, so the QR the board shows patients is
-- time-boxed rather than a permanent, forever-shareable link. The
-- board is an always-on screen, not a printed sticker, so refreshing
-- the QR it displays every so often costs nothing.
--
-- Run this once in the Supabase SQL Editor, after 098_fix_revoke_targets.sql.
-- ============================================================

create table public.display_board_tokens (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index display_board_tokens_expiry_idx on public.display_board_tokens (expires_at);
create index display_board_tokens_clinic_idx on public.display_board_tokens (clinic_id, expires_at desc);

-- No RLS policies at all, on purpose — every access goes through the
-- two security-definer functions below. A direct client select/insert
-- against this table is rejected by RLS regardless of role.
alter table public.display_board_tokens enable row level security;

-- Called by the TV/board itself (an authenticated staff session — the
-- board still requires login to RUN the live view; only WATCHING it
-- via the QR is anonymous). Reuses the current token if it still has
-- over an hour of life left, so the QR shown on screen doesn't change
-- on every routine refresh — only rotates once truly close to expiry.
create or replace function public.mint_display_board_token()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid;
  v_existing record;
  v_token_id uuid;
  v_expires timestamptz;
begin
  if public.my_role() is null then
    raise exception 'Must be an active clinic staff member.';
  end if;
  v_clinic_id := public.my_clinic_id();

  select id, expires_at into v_existing
    from public.display_board_tokens
    where clinic_id = v_clinic_id and expires_at > now() + interval '1 hour'
    order by expires_at desc
    limit 1;

  if v_existing.id is not null then
    return jsonb_build_object('token', v_existing.id, 'expiresAt', v_existing.expires_at);
  end if;

  v_expires := now() + interval '24 hours';
  insert into public.display_board_tokens (clinic_id, expires_at)
    values (v_clinic_id, v_expires)
    returning id into v_token_id;

  -- Housekeeping: this clinic's own long-expired tokens never get
  -- cleaned up otherwise — nothing else ever deletes from this table.
  delete from public.display_board_tokens
    where clinic_id = v_clinic_id and expires_at < now() - interval '7 days';

  return jsonb_build_object('token', v_token_id, 'expiresAt', v_expires);
end;
$$;

revoke execute on function public.mint_display_board_token() from public, anon;
grant execute on function public.mint_display_board_token() to authenticated;

-- Called anonymously by a patient's phone after scanning the board's QR.
-- Returns only what the physical TV already shows publicly — no phone,
-- address, age, gender, or reason for visit, even though those columns
-- exist on patients; this function's own select list never reads them,
-- not just hides them after the fact.
create or replace function public.get_display_board_by_token(p_token uuid, p_date date)
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
    from public.display_board_tokens
    where id = p_token and expires_at > now();

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

revoke execute on function public.get_display_board_by_token(uuid, date) from public;
grant execute on function public.get_display_board_by_token(uuid, date) to anon, authenticated;
