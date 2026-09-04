-- ============================================================
-- Qlinic — migration 067: pharmacist role.
--
-- A 4th staff role, scoped narrowly: the pharmacy counter and catalog
-- only, per BACKLOG.md's Pharmacy billing & inventory section — full
-- run of that counter (sell, record stock in, manage the medicine
-- catalog, decided 2026-09-04) but no access to the queue, doctors,
-- staff management, or consultation invoices. Same kind of narrower
-- slice reception already models against admin-only actions.
--
-- profiles.role has no DB-level check constraint (schema.sql's own
-- comment: "room to grow") — validity is enforced only inside
-- create_staff_profile()'s guard, widened below. Its signature is
-- unchanged from 054_staff_phone.sql (6 args), so create or replace is
-- enough — no drop-and-recreate needed, unlike 054's own arity change.
--
-- Run this once in the Supabase SQL Editor, after 066_pharmacy_invoices.sql.
-- ============================================================

create or replace function public.create_staff_profile(
  new_user_id uuid, staff_email text, staff_full_name text, staff_role text,
  staff_doctor_id uuid default null, staff_phone text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_clinic_id uuid;
begin
  if public.my_role() <> 'admin' then
    raise exception 'Only a clinic admin can add staff.';
  end if;
  caller_clinic_id := public.my_clinic_id();

  if staff_role not in ('admin', 'reception', 'doctor', 'pharmacist') then
    raise exception 'Invalid role.';
  end if;

  if exists (select 1 from public.profiles where id = new_user_id) then
    raise exception 'That account is already linked to a clinic.';
  end if;

  if staff_role <> 'doctor' then
    staff_doctor_id := null;
  elsif staff_doctor_id is not null and not exists (
    select 1 from public.doctors where id = staff_doctor_id and clinic_id = caller_clinic_id
  ) then
    raise exception 'That doctor is not on this clinic''s roster.';
  end if;

  insert into public.profiles (id, clinic_id, email, full_name, role, doctor_id, phone)
  values (new_user_id, caller_clinic_id, staff_email, staff_full_name, staff_role, staff_doctor_id, nullif(staff_phone, ''));
end;
$$;

-- A pharmacist sees only pharmacy-type invoices, never a consultation
-- bill — admin/reception's own "billing staff select invoices" policy
-- (013_billing.sql) is left untouched; this is an additional permissive
-- policy scoped narrower, since Postgres OR's multiple permissive
-- select policies together.
create policy "pharmacist select pharmacy invoices" on public.invoices
  for select using (
    clinic_id = public.my_clinic_id()
    and public.my_role() = 'pharmacist'
    and invoice_type = 'pharmacy'
  );

-- patients' own "clinic patients select" policy (schema.sql) already
-- has no role restriction at all — a pharmacist can already read
-- patients for the counter's name/phone search with no change needed
-- here.
