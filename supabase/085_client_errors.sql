-- ============================================================
-- Qlinic — migration 085: platform admin panel, part D2
-- (operational telemetry — client-side error reporting).
--
-- Today, nothing catches a JavaScript error anywhere in this app; it
-- just fails silently for whoever hit it. This adds a place for that
-- error to land and a way for a platform admin to see it, grouped, not
-- 40 individual identical rows for the same bug.
--
-- Insert-only for anon and authenticated alike, same treatment
-- contact_enquiries (061) already gets: an error can happen before
-- login exists at all (login.html, queue.html, display.html all have
-- unauthenticated visitors), so this can't be scoped to authenticated
-- only. No select policy for anyone but a platform admin — the write
-- side (Qlinic's global window.onerror/unhandledrejection handler,
-- clinic-data.js) is a plain client-side insert, not an RPC; the read
-- side is the one, deliberate, checked exception below.
--
-- The page-load cap (clinic-data.js, CLIENT_ERROR_CAP = 5) is what
-- actually stops a looping bug from writing thousands of rows in
-- seconds — this table has no server-side rate limit of its own,
-- same known-limitation shape as contact_enquiries' own honeypot-only
-- protection.
--
-- Run this once in the Supabase SQL Editor, after
-- 084_platform_admin_insights.sql.
-- ============================================================

create table public.client_errors (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid null references public.clinics(id) on delete cascade,
  page text not null,
  message text not null,
  stack text null,
  user_agent text null,
  created_at timestamptz not null default now()
);

create index client_errors_created_at_idx on public.client_errors (created_at desc);

alter table public.client_errors enable row level security;

create policy "anyone can report a client error" on public.client_errors
  for insert
  to anon, authenticated
  with check (true);

-- Grouped by (page, message), most recently seen first — "this error
-- happened 40 times across 3 clinics this week" is the actual useful
-- signal, not a raw row dump a platform admin has to mentally group
-- themselves.
create or replace function public.admin_list_client_errors()
returns table (
  page text, message text, occurrence_count bigint,
  first_seen timestamptz, last_seen timestamptz, clinic_count bigint
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
    select e.page, e.message, count(*)::bigint,
      min(e.created_at), max(e.created_at), count(distinct e.clinic_id)::bigint
    from public.client_errors e
    group by e.page, e.message
    order by max(e.created_at) desc;
end;
$$;

grant execute on function public.admin_list_client_errors() to authenticated;
