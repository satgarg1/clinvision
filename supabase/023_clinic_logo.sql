-- ============================================================
-- Qlinic — migration 023: clinic logo (upload).
--
-- Why: an optional logo shown next to the clinic name in the sidebar,
-- during registration, and on printed invoices. Storage (not a base64
-- column) since these are real image files that need to be served
-- efficiently and cached by the browser.
--
-- Each clinic gets exactly one file at "{clinic_id}/logo" (no
-- extension — content-type is set explicitly on upload, so the
-- extension isn't needed for correct serving), always overwritten in
-- place on a new upload. Bucket is public-read (logos aren't
-- sensitive and need to load on the public-ish print/receipt view
-- without an auth header); writes are restricted to the clinic's own
-- folder, mirroring every other table's clinic_id-scoped RLS policy.
--
-- Run this once in the Supabase SQL Editor, after 022_clinic_closures.sql.
-- ============================================================

alter table public.clinics add column if not exists logo_url text;

insert into storage.buckets (id, name, public)
values ('clinic-logos', 'clinic-logos', true)
on conflict (id) do nothing;

alter table storage.objects enable row level security;

create policy "clinic logos public read" on storage.objects
  for select using (bucket_id = 'clinic-logos');

create policy "clinic logos own folder insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'clinic-logos' and (storage.foldername(name))[1]::uuid = public.my_clinic_id());

create policy "clinic logos own folder update" on storage.objects
  for update to authenticated
  using (bucket_id = 'clinic-logos' and (storage.foldername(name))[1]::uuid = public.my_clinic_id());

create policy "clinic logos own folder delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'clinic-logos' and (storage.foldername(name))[1]::uuid = public.my_clinic_id());
