-- ============================================================
-- Qlinic — migration 080: platform admin panel, part A (auth).
--
-- A platform admin is a wholly separate permission from every existing
-- role in this app — never a clinic role, never scoped by
-- my_clinic_id(). A platform admin has no clinics/profiles row at all;
-- the only thing that marks an auth.users id as one is a row existing
-- in this table.
--
-- Same shape as my_clinic_id()/my_role() (003_staff_roles.sql):
-- security definer so it can be called by anyone logged in (including
-- someone who is NOT a platform admin — the function itself decides
-- that), used both by admin.html's page-level gate and, more
-- importantly, inside every admin_* RPC as the real server-side
-- enforcement — the lesson from this session's own deactivation-cascade
-- bug is that a UI-only gate is never enough.
--
-- is_active mirrors profiles.is_active (078_cascade_deactivation.sql):
-- revoking someone's platform access flips this rather than deleting
-- the row, so is_platform_admin() stops passing for them immediately
-- without losing the audit trail of who was ever a platform admin.
--
-- Run this once in the Supabase SQL Editor, after 079_fix_trial_period.sql.
-- ============================================================

create table public.platform_admins (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  phone text null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.platform_admins enable row level security;

-- Defined BEFORE the policy below on purpose: CREATE POLICY resolves and
-- validates its USING expression immediately (unlike a plpgsql function
-- body, which is opaque text until it's actually called), so
-- is_platform_admin() has to already exist or this file fails with
-- "function public.is_platform_admin() does not exist" the moment the
-- policy statement runs — a real ordering bug caught while testing this
-- migration, not a hypothetical one.
create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.platform_admins where id = auth.uid() and is_active
  );
$$;

grant execute on function public.is_platform_admin() to authenticated;

-- A platform admin can see the list of platform admins (to render
-- "Everyone with platform access" in admin.html); nobody else has any
-- policy here at all, so a normal clinic user's select simply returns
-- zero rows rather than erroring.
create policy "platform admins select platform admins" on public.platform_admins
  for select using (public.is_platform_admin());

-- ---------------- reading the platform-admin roster ----------------
-- auth.users isn't reachable from the client directly (no REST access
-- to the auth schema) — this joins it server-side, same trick
-- register_clinic() already uses to read the caller's own email.
create or replace function public.admin_list_platform_admins()
returns table (
  id uuid, email text, full_name text, phone text,
  is_active boolean, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Not authorized.';
  end if;
  return query
    -- ::text is load-bearing, not decoration -- auth.users.email is
    -- `character varying`, and RETURN QUERY requires an exact type
    -- match against the declared `returns table` column (no implicit
    -- varchar->text coercion the way a plain SELECT would allow), which
    -- is exactly the "structure of query does not match function result
    -- type" error this threw before the cast was added.
    select pa.id, u.email::text, pa.full_name, pa.phone, pa.is_active, pa.created_at
    from public.platform_admins pa
    join auth.users u on u.id = pa.id
    order by pa.created_at asc;
end;
$$;

grant execute on function public.admin_list_platform_admins() to authenticated;

-- ---------------- adding a partner admin ----------------
-- Two-step creation, same pattern as create_staff_profile()
-- (003_staff_roles.sql / 067_pharmacist_role.sql): the client creates a
-- real Supabase Auth account first (via a throwaway, non-persisted
-- client — see Qlinic.createPlatformAdmin() — so it never hijacks the
-- calling admin's own session), then this links that new user id into
-- platform_admins. Only an existing, active platform admin may call it.
create or replace function public.create_platform_admin(
  new_user_id uuid, admin_full_name text, admin_phone text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Only an existing platform admin can add another one.';
  end if;
  if exists (select 1 from public.platform_admins where id = new_user_id) then
    raise exception 'That account already has platform access.';
  end if;
  insert into public.platform_admins (id, full_name, phone)
  values (new_user_id, admin_full_name, nullif(admin_phone, ''));
end;
$$;

grant execute on function public.create_platform_admin(uuid, text, text) to authenticated;

create or replace function public.admin_update_platform_admin(
  target_id uuid, new_full_name text, new_phone text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Not authorized.';
  end if;
  update public.platform_admins
  set full_name = new_full_name, phone = nullif(new_phone, '')
  where id = target_id;
end;
$$;

grant execute on function public.admin_update_platform_admin(uuid, text, text) to authenticated;

-- A platform admin can never deactivate their own access this way —
-- the same kind of self-lockout guard this session's cascade work
-- (078_cascade_deactivation.sql) had to reason about for staff.
create or replace function public.set_platform_admin_active(
  target_id uuid, new_active boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Not authorized.';
  end if;
  if target_id = auth.uid() and new_active = false then
    raise exception 'You cannot deactivate your own platform admin access.';
  end if;
  update public.platform_admins set is_active = new_active where id = target_id;
end;
$$;

grant execute on function public.set_platform_admin_active(uuid, boolean) to authenticated;
