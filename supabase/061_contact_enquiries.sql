-- Stores submissions from the public marketing site's Contact us page
-- (contact.html) -- the first table in this schema written to by a
-- fully anonymous visitor, not a logged-in clinic user. Every other
-- table is scoped by clinic_id via my_clinic_id(); this one has no
-- clinic yet, because the person submitting it isn't a ClinVision
-- customer yet either.
--
-- No select/update/delete policy for anon or authenticated, on purpose
-- -- same treatment product_feedback (058) already gets: "no select
-- policy for authenticated at all... a deliberate, narrow, checked
-- exception" once a real RPC needs one. Until the Platform admin panel
-- (BACKLOG.md) exists with its own is_platform_admin() gate, the only
-- way to read these rows is the Supabase dashboard directly (service
-- role) -- a real, working interim step, not a placeholder.
create table public.contact_enquiries (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  phone text not null,
  clinic_type text null check (
    clinic_type is null or clinic_type in (
      'Solo practice', 'Multi-doctor clinic', 'Polyclinic', 'Diagnostic center', 'Other'
    )
  ),
  clinic_name text null,
  city text null,
  message text null,
  -- Which page/flow this came from -- contact.html today, but a future
  -- "book a demo" button elsewhere could reuse this same table instead
  -- of needing its own.
  source text not null default 'contact_page',
  status text not null default 'new' check (status in ('new', 'contacted', 'closed'))
);

create index contact_enquiries_created_at_idx on public.contact_enquiries (created_at desc);

alter table public.contact_enquiries enable row level security;

-- Anonymous visitors (the anon key, same one already public in
-- clinic-config.js) may insert their own enquiry and nothing else --
-- no select, no update, no delete. with check (true): there's no
-- clinic_id or auth.uid() to validate against for a visitor who isn't
-- signed in, so the real validation is the column-level check
-- constraints above (clinic_type) plus not-null on name/phone.
create policy "anyone can submit a contact enquiry" on public.contact_enquiries
  for insert
  to anon, authenticated
  with check (true);

-- Known limitation, not fixed here: this endpoint has no CAPTCHA or
-- rate limiting, same exposure as any public form backed directly by a
-- database insert. The contact.html form should carry a simple hidden
-- honeypot field (a real anti-spam technique, not bot-detection
-- bypass) as cheap first-line mitigation; real rate limiting would need
-- an Edge Function in front of this instead of a direct client insert,
-- and isn't built here.
