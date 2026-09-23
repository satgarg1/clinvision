-- ============================================================
-- Qlinic — migration 088: prescription module.
--
-- New territory: this is the first table set that captures what
-- actually happens during a consultation (complaints, diagnosis, the
-- medicines prescribed), not just queue/billing metadata around it.
--
-- generic_medicines is deliberately NOT clinic-scoped — it's a shared,
-- national reference list (name/composition/manufacturer), the same
-- for every clinic, so a doctor whose clinic runs a separate pharmacy
-- system (or none at all) can still search a real medicine list on day
-- one instead of an empty clinic-specific catalog. It's seeded
-- separately (see the accompanying CSV — deliberately not pasted as
-- inline INSERTs here, the row count is too large for a SQL Editor
-- paste; import it via the Table Editor's CSV import instead once this
-- file has been run). RLS still applies -- read-only for any
-- authenticated user, no clinic check, since there's no clinic-specific
-- data in it to leak.
--
-- prescription_items can point at EITHER the clinic's own medicines
-- catalog OR a generic_medicines row, or neither (free_text_name) --
-- never more than one, enforced by the check constraint below. This
-- mirrors why prescriptions doesn't just reuse invoice_items: a
-- prescription line isn't a billable, priced item, it's a frequency/
-- duration/instruction triple against a drug that may or may not be
-- something this clinic stocks.
--
-- doctor_rx_templates exists now (Phase 2 in the scope doc) even
-- though this migration's own UI doesn't wire it up yet, so the shape
-- is settled once rather than adding a second migration for it later.
--
-- qualification/registration_number are new on doctors -- every real
-- Indian prescription carries the prescribing doctor's own degree and
-- medical registration number (see the Chandra Skin Centre reference
-- prescriptions this feature was scoped against); doctors had nowhere
-- to store either until now.
--
-- Run this once in the Supabase SQL Editor, after 087_fix_billing_audit_phone.sql.
-- Then import the generic-medicines CSV via Table Editor -> generic_medicines -> Import data.
-- ============================================================

alter table public.doctors
  add column if not exists qualification text not null default '',
  add column if not exists registration_number text not null default '';

create table public.generic_medicines (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  manufacturer text not null default '',
  form text not null default '',
  pack_size_label text not null default '',
  composition_1 text not null default '',
  composition_2 text not null default '',
  source text not null default '',
  created_at timestamptz not null default now()
);

create extension if not exists pg_trgm;
create index generic_medicines_name_idx on public.generic_medicines using gin (name gin_trgm_ops);

alter table public.generic_medicines enable row level security;

create policy "any authenticated user can read generic medicines" on public.generic_medicines
  for select using (auth.role() = 'authenticated');

create table public.prescriptions (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null references public.patients(id) on delete cascade,
  doctor_id uuid not null references public.doctors(id) on delete cascade,
  complaints text not null default '',
  diagnosis text not null default '',
  advice text not null default '',
  follow_up_date date null,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id)
);

create index prescriptions_clinic_patient_idx on public.prescriptions (clinic_id, patient_id, created_at desc);

alter table public.prescriptions enable row level security;

create policy "clinic staff select prescriptions" on public.prescriptions
  for select using (clinic_id = public.my_clinic_id());
create policy "admin or doctor insert prescriptions" on public.prescriptions
  for insert with check (clinic_id = public.my_clinic_id() and public.my_role() in ('admin', 'doctor'));

create table public.prescription_items (
  id uuid primary key default gen_random_uuid(),
  prescription_id uuid not null references public.prescriptions(id) on delete cascade,
  clinic_medicine_id uuid null references public.medicines(id) on delete set null,
  generic_medicine_id uuid null references public.generic_medicines(id) on delete set null,
  free_text_name text null,
  frequency text not null default '',
  duration_text text not null default '',
  instructions text not null default '',
  sort_order int not null default 0,
  constraint one_medicine_reference check (
    (case when clinic_medicine_id is not null then 1 else 0 end
     + case when generic_medicine_id is not null then 1 else 0 end
     + case when free_text_name is not null and free_text_name <> '' then 1 else 0 end) = 1
  )
);

create index prescription_items_prescription_idx on public.prescription_items (prescription_id, sort_order);

alter table public.prescription_items enable row level security;

create policy "clinic staff select prescription items" on public.prescription_items
  for select using (
    exists (select 1 from public.prescriptions p where p.id = prescription_id and p.clinic_id = public.my_clinic_id())
  );
create policy "admin or doctor insert prescription items" on public.prescription_items
  for insert with check (
    exists (select 1 from public.prescriptions p where p.id = prescription_id and p.clinic_id = public.my_clinic_id()
      and public.my_role() in ('admin', 'doctor'))
  );

create table public.doctor_rx_templates (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  doctor_id uuid not null references public.doctors(id) on delete cascade,
  name text not null,
  items jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.doctor_rx_templates enable row level security;

create policy "doctor manages own templates" on public.doctor_rx_templates
  for all using (clinic_id = public.my_clinic_id())
  with check (clinic_id = public.my_clinic_id());

-- create_prescription(): same trust model as create_invoice()/
-- create_pharmacy_invoice() -- the server resolves clinic_id/doctor_id
-- from the caller's own profile, never trusts a client-supplied clinic
-- or doctor id, and writes the header + every item in one transaction
-- so a prescription can never exist with zero items or vice versa.
create or replace function public.create_prescription(
  p_patient_id uuid,
  p_complaints text,
  p_diagnosis text,
  p_advice text,
  p_follow_up_date date,
  p_items jsonb  -- array of {clinic_medicine_id, generic_medicine_id, free_text_name, frequency, duration_text, instructions}
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid;
  v_doctor_id uuid;
  v_prescription_id uuid;
  v_item jsonb;
  v_sort int := 0;
begin
  if public.my_role() not in ('admin', 'doctor') then
    raise exception 'Only a doctor or admin can write a prescription.';
  end if;
  v_clinic_id := public.my_clinic_id();

  select doctor_id into v_doctor_id from public.profiles where id = auth.uid();
  if v_doctor_id is null then
    raise exception 'Your account is not linked to a doctor profile.';
  end if;

  if not exists (select 1 from public.patients where id = p_patient_id and clinic_id = v_clinic_id) then
    raise exception 'Patient not found in this clinic.';
  end if;
  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    raise exception 'A prescription needs at least one medicine.';
  end if;

  insert into public.prescriptions (clinic_id, patient_id, doctor_id, complaints, diagnosis, advice, follow_up_date, created_by)
  values (v_clinic_id, p_patient_id, v_doctor_id, coalesce(p_complaints, ''), coalesce(p_diagnosis, ''), coalesce(p_advice, ''), p_follow_up_date, auth.uid())
  returning id into v_prescription_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    insert into public.prescription_items (
      prescription_id, clinic_medicine_id, generic_medicine_id, free_text_name,
      frequency, duration_text, instructions, sort_order
    ) values (
      v_prescription_id,
      nullif(v_item->>'clinic_medicine_id', '')::uuid,
      nullif(v_item->>'generic_medicine_id', '')::uuid,
      nullif(v_item->>'free_text_name', ''),
      coalesce(v_item->>'frequency', ''),
      coalesce(v_item->>'duration_text', ''),
      coalesce(v_item->>'instructions', ''),
      v_sort
    );
    v_sort := v_sort + 1;
  end loop;

  return v_prescription_id;
end;
$$;
