-- ============================================================
-- Qlinic — migration 097: full-codebase multi-agent review, round 3.
--
-- Bundled fixes for the SQL-side findings from the codebase review PDF
-- (ABDM edge-function fixes are in the functions themselves, not here —
-- see gateway-auth.ts/staff-auth.ts and the six hip-*/abha-verify diffs).
--
-- Run this once in the Supabase SQL Editor, after 096_review_findings_round2.sql.
-- ============================================================

-- ---------------------------------------------------------------
-- 1. record_care_context(p_invoice_id) looked up the target invoice
--    with no clinic filter at all, then force-created a care_contexts
--    row scoped to THAT INVOICE's clinic — any authenticated user from
--    any clinic could pass another clinic's invoice id and write an
--    unauthorized ABDM care-context row for a victim clinic. It's also
--    an internal trigger helper (record_care_context_on_invoice_insert,
--    049) never meant to be called directly, and was never revoked from
--    PUBLIC the way its sibling auto_close_previous_day was in this
--    same migration set. Scoping the lookup to the caller's own clinic
--    makes the legitimate trigger-invoked case a no-op change (the
--    invoice being inserted already belongs to the inserting session's
--    own clinic) while making the cross-tenant misuse impossible: a
--    forged invoice id from another clinic simply resolves to no row.
-- ---------------------------------------------------------------
create or replace function public.record_care_context(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
  v_doctor_name text;
begin
  select * into v_invoice from public.invoices
    where id = p_invoice_id and clinic_id = public.my_clinic_id();
  if v_invoice.id is null or v_invoice.patient_id is null or v_invoice.invoice_type <> 'consultation' then
    return;
  end if;
  if exists (select 1 from public.care_contexts where invoice_id = v_invoice.id) then
    return;
  end if;

  select name into v_doctor_name from public.doctors where id = v_invoice.doctor_id;

  insert into public.care_contexts (clinic_id, patient_id, invoice_id, reference_number, display, hi_type)
  values (
    v_invoice.clinic_id,
    v_invoice.patient_id,
    v_invoice.id,
    'invoice-' || v_invoice.id::text,
    coalesce(v_doctor_name, 'Consultation') || ' - ' || to_char(v_invoice.invoice_date, 'DD Mon YYYY'),
    'OPConsultation'
  );
end;
$$;

revoke execute on function public.record_care_context(uuid) from public;

-- ---------------------------------------------------------------
-- 2. auto_suspend_expired_clinics() is SECURITY DEFINER, meant to be
--    cron-only, with zero role/clinic checks in its body — and was
--    never revoked from PUBLIC (Postgres grants EXECUTE to PUBLIC by
--    default on every new function). Any authenticated user of any
--    clinic could call it directly and force every OTHER clinic whose
--    grace period has lapsed into suspension immediately.
-- ---------------------------------------------------------------
revoke execute on function public.auto_suspend_expired_clinics() from public;

-- ---------------------------------------------------------------
-- 3. consent_artefacts and health_information_requests SELECT policies
--    check only clinic_id, with no role restriction — a pharmacist or
--    reception login (roles with no ABDM/consent responsibility) could
--    read the full raw ABDM consent payload / HI request detail for
--    every patient in the clinic.
-- ---------------------------------------------------------------
drop policy if exists "clinic consent_artefacts select" on public.consent_artefacts;
create policy "clinic consent_artefacts select" on public.consent_artefacts
  for select using (clinic_id = public.my_clinic_id() and public.my_role() in ('admin', 'doctor'));

drop policy if exists "clinic hi_requests select" on public.health_information_requests;
create policy "clinic hi_requests select" on public.health_information_requests
  for select using (clinic_id = public.my_clinic_id() and public.my_role() in ('admin', 'doctor'));

-- ---------------------------------------------------------------
-- 4. "staff update doctor status" (011) checks only role + clinic, never
--    id = my_doctor_id() for the doctor case — despite the migration's
--    own header stating the intent as "reception (and doctors
--    themselves)". Doctor A could mark Doctor B "emergency"/"on_break"
--    clinic-wide. Reception legitimately manages ANY doctor's status,
--    so only the doctor branch gets the added self-scoping.
-- ---------------------------------------------------------------
drop policy if exists "staff update doctor status" on public.doctors;
create policy "staff update doctor status" on public.doctors
  for update using (
    clinic_id = public.my_clinic_id()
    and (
      public.my_role() = 'reception'
      or (public.my_role() = 'doctor' and id = public.my_doctor_id())
    )
  )
  with check (
    clinic_id = public.my_clinic_id()
    and (
      public.my_role() = 'reception'
      or (public.my_role() = 'doctor' and id = public.my_doctor_id())
    )
  );

-- ---------------------------------------------------------------
-- 5. clinics' "admin update own clinic" (003) had a USING clause but no
--    WITH CHECK — an admin's UPDATE is restricted on which row it can
--    target, but not on what the row's new values can be afterward.
--    Mirrors the USING clause so the row must still belong to this
--    admin's own clinic post-update, same as every other UPDATE policy
--    in this schema already does.
-- ---------------------------------------------------------------
drop policy if exists "admin update own clinic" on public.clinics;
create policy "admin update own clinic" on public.clinics
  for update using (id = public.my_clinic_id() and public.my_role() = 'admin')
  with check (id = public.my_clinic_id() and public.my_role() = 'admin');

-- ---------------------------------------------------------------
-- 6. medicines.selling_price, mrp, and gst_rate had no CHECK constraint
--    anywhere — client-writable to negative (or, for gst_rate, absurd)
--    values via the plain RLS UPDATE policy, feeding directly into
--    create_pharmacy_invoice()'s unit_price/line_total math with no
--    floor/ceiling. A table-level constraint closes this regardless of
--    which code path writes the column, mirroring the existing
--    stock_quantity >= 0 check on the same table.
-- ---------------------------------------------------------------
alter table public.medicines drop constraint if exists medicines_selling_price_check;
alter table public.medicines add constraint medicines_selling_price_check check (selling_price >= 0);
alter table public.medicines drop constraint if exists medicines_mrp_check;
alter table public.medicines add constraint medicines_mrp_check check (mrp >= 0);
alter table public.medicines drop constraint if exists medicines_gst_rate_check;
alter table public.medicines add constraint medicines_gst_rate_check check (gst_rate >= 0 and gst_rate <= 100);

-- ---------------------------------------------------------------
-- 7. medicines' own UPDATE policy lets admin/reception/pharmacist
--    change stock_quantity directly via plain REST, bypassing the
--    stock_ledger audit trail that adjust_stock()/record_stock_purchase()/
--    create_pharmacy_invoice() are built to guarantee. A trigger blocks
--    any stock_quantity change unless the session carries the internal
--    flag those three RPCs now set right before they touch the column —
--    a direct client update can never set that flag itself.
-- ---------------------------------------------------------------
create or replace function public.protect_medicine_stock_column()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.stock_quantity is distinct from old.stock_quantity
     and coalesce(current_setting('qlinic.allow_direct_stock_write', true), 'false') <> 'true' then
    raise exception 'stock_quantity can only change via adjust_stock(), record_stock_purchase(), or a pharmacy sale — direct updates would bypass the stock ledger audit trail.';
  end if;
  return new;
end;
$$;

drop trigger if exists medicines_protect_stock_column on public.medicines;
create trigger medicines_protect_stock_column
  before update on public.medicines
  for each row execute function public.protect_medicine_stock_column();

create or replace function public.adjust_stock(
  p_medicine_id uuid,
  p_batch_id uuid,
  p_delta integer,
  p_note text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid;
  v_new_batch_qty integer;
  v_new_total integer;
begin
  if public.my_role() not in ('admin', 'reception', 'pharmacist') then
    raise exception 'Only clinic admin, reception, or pharmacist can adjust stock.';
  end if;
  if not public.has_feature('pharmacy') then
    raise exception 'Pharmacy is not enabled for this clinic.';
  end if;
  if p_delta is null or p_delta = 0 then
    raise exception 'Adjustment quantity cannot be zero.';
  end if;
  v_clinic_id := public.my_clinic_id();

  update public.medicine_batches
    set quantity_remaining = quantity_remaining + p_delta
    where id = p_batch_id and medicine_id = p_medicine_id and clinic_id = v_clinic_id
    returning quantity_remaining into v_new_batch_qty;

  if v_new_batch_qty is null then
    raise exception 'Batch not found in this clinic.';
  end if;
  if v_new_batch_qty < 0 then
    raise exception 'That adjustment would take this batch below zero stock.';
  end if;

  perform set_config('qlinic.allow_direct_stock_write', 'true', true);
  update public.medicines
    set stock_quantity = stock_quantity + p_delta
    where id = p_medicine_id
    returning stock_quantity into v_new_total;
  perform set_config('qlinic.allow_direct_stock_write', 'false', true);

  insert into public.stock_ledger (
    clinic_id, medicine_id, batch_id, movement_type, quantity_delta, closing_stock_after, note, created_by
  ) values (
    v_clinic_id, p_medicine_id, p_batch_id, 'adjustment', p_delta, v_new_total, coalesce(p_note, ''), auth.uid()
  );
end;
$$;

create or replace function public.record_stock_purchase(
  p_medicine_id uuid,
  p_batch_number text,
  p_mfg_date date,
  p_expiry_date date,
  p_packs_received integer,
  p_purchase_price_per_pack numeric,
  p_mrp_per_pack numeric
)
returns public.medicine_batches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid;
  v_pack_size integer;
  v_quantity integer;
  v_batch public.medicine_batches;
  v_new_total integer;
begin
  if public.my_role() not in ('admin', 'reception', 'pharmacist') then
    raise exception 'Only clinic admin, reception, or pharmacist can record stock.';
  end if;
  if not public.has_feature('pharmacy') then
    raise exception 'Pharmacy is not enabled for this clinic.';
  end if;
  if p_packs_received is null or p_packs_received <= 0 then
    raise exception 'Packs received must be greater than zero.';
  end if;
  v_clinic_id := public.my_clinic_id();

  select pack_size into v_pack_size from public.medicines
    where id = p_medicine_id and clinic_id = v_clinic_id;
  if v_pack_size is null then
    raise exception 'Medicine not found in this clinic.';
  end if;

  v_quantity := p_packs_received * v_pack_size;

  insert into public.medicine_batches (
    clinic_id, medicine_id, batch_number, mfg_date, expiry_date, purchase_price, mrp,
    quantity_received, quantity_remaining
  ) values (
    v_clinic_id, p_medicine_id, coalesce(nullif(p_batch_number, ''), 'STOCK-IN'), p_mfg_date, p_expiry_date,
    coalesce(p_purchase_price_per_pack, 0), coalesce(p_mrp_per_pack, 0), v_quantity, v_quantity
  )
  on conflict (medicine_id, batch_number) do update
    set quantity_received = medicine_batches.quantity_received + excluded.quantity_received,
        quantity_remaining = medicine_batches.quantity_remaining + excluded.quantity_remaining,
        purchase_price = case when excluded.purchase_price > 0 then excluded.purchase_price else medicine_batches.purchase_price end,
        mrp = case when excluded.mrp > 0 then excluded.mrp else medicine_batches.mrp end
  returning * into v_batch;

  perform set_config('qlinic.allow_direct_stock_write', 'true', true);
  update public.medicines
    set stock_quantity = stock_quantity + v_quantity
    where id = p_medicine_id
    returning stock_quantity into v_new_total;
  perform set_config('qlinic.allow_direct_stock_write', 'false', true);

  insert into public.stock_ledger (
    clinic_id, medicine_id, batch_id, movement_type, quantity_delta, closing_stock_after, created_by
  ) values (
    v_clinic_id, p_medicine_id, v_batch.id, 'purchase', v_quantity, v_new_total, auth.uid()
  );

  return v_batch;
end;
$$;

create or replace function public.create_pharmacy_invoice(
  p_patient_id uuid,
  p_patient_name text,
  p_patient_phone text,
  p_payment_mode text,
  p_amount_received numeric,
  p_items jsonb
)
returns public.invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid;
  v_invoice_number integer;
  v_invoice public.invoices;
  v_item jsonb;
  v_medicine_id uuid;
  v_qty_needed integer;
  v_medicine public.medicines;
  v_unit_price numeric(10, 2);
  v_running_stock integer;
  v_batch record;
  v_take integer;
  v_line_total numeric(10, 2);
  v_subtotal numeric(10, 2) := 0;
  v_payment_mode text;
begin
  if public.my_role() not in ('admin', 'reception', 'pharmacist') then
    raise exception 'Only clinic admin, reception, or pharmacist can bill a pharmacy sale.';
  end if;
  if not public.has_feature('pharmacy') then
    raise exception 'Pharmacy is not enabled for this clinic.';
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one medicine before completing the sale.';
  end if;
  v_payment_mode := coalesce(p_payment_mode, 'cash');
  if v_payment_mode not in ('cash', 'upi', 'card') then
    raise exception 'Invalid payment mode.';
  end if;
  if p_amount_received is not null and p_amount_received < 0 then
    raise exception 'Amount received cannot be negative.';
  end if;
  v_clinic_id := public.my_clinic_id();

  if p_patient_id is not null and not exists (
    select 1 from public.patients where id = p_patient_id and clinic_id = v_clinic_id
  ) then
    raise exception 'Patient not found in this clinic.';
  end if;

  update public.clinics
    set next_pharmacy_invoice_number = next_pharmacy_invoice_number + 1
    where id = v_clinic_id
    returning next_pharmacy_invoice_number - 1 into v_invoice_number;

  insert into public.invoices (
    clinic_id, invoice_number, invoice_type, doctor_id, fee_type, amount, invoice_date,
    patient_id, patient_name, patient_phone, payment_mode, amount_received, created_by
  ) values (
    v_clinic_id, v_invoice_number, 'pharmacy', null, null, 0, current_date,
    p_patient_id, coalesce(nullif(p_patient_name, ''), 'Walk-in'), coalesce(p_patient_phone, ''),
    v_payment_mode, p_amount_received, auth.uid()
  )
  returning * into v_invoice;

  for v_item in select elem from jsonb_array_elements(p_items) as elem order by elem->>'medicine_id' loop
    v_medicine_id := (v_item->>'medicine_id')::uuid;
    v_qty_needed := (v_item->>'quantity')::integer;
    if v_qty_needed is null or v_qty_needed <= 0 then
      raise exception 'Invalid quantity for one of the medicines in this sale.';
    end if;

    select * into v_medicine from public.medicines
      where id = v_medicine_id and clinic_id = v_clinic_id
      for update;
    if v_medicine.id is null then
      raise exception 'A medicine in this sale was not found in this clinic.';
    end if;
    if v_medicine.stock_quantity < v_qty_needed then
      raise exception 'Not enough stock of % — only % % left.', v_medicine.name, v_medicine.stock_quantity, v_medicine.dispense_unit;
    end if;

    v_unit_price := round(v_medicine.selling_price / nullif(v_medicine.pack_size, 0), 2);
    v_running_stock := v_medicine.stock_quantity;

    for v_batch in
      select * from public.medicine_batches
        where medicine_id = v_medicine_id and clinic_id = v_clinic_id and quantity_remaining > 0
          and (expiry_date is null or expiry_date >= current_date)
        order by expiry_date asc nulls last, created_at asc
        for update
    loop
      exit when v_qty_needed <= 0;
      v_take := least(v_qty_needed, v_batch.quantity_remaining);

      update public.medicine_batches
        set quantity_remaining = quantity_remaining - v_take
        where id = v_batch.id;

      v_line_total := round(v_take * v_unit_price * (1 + v_medicine.gst_rate / 100), 2);

      insert into public.invoice_items (
        clinic_id, invoice_id, medicine_id, batch_id, medicine_name_snapshot, hsn_code_snapshot,
        quantity, unit_price, gst_rate, line_total
      ) values (
        v_clinic_id, v_invoice.id, v_medicine_id, v_batch.id, v_medicine.name, v_medicine.hsn_code,
        v_take, v_unit_price, v_medicine.gst_rate, v_line_total
      );

      v_subtotal := v_subtotal + v_line_total;
      v_running_stock := v_running_stock - v_take;

      insert into public.stock_ledger (
        clinic_id, medicine_id, batch_id, movement_type, quantity_delta, closing_stock_after,
        reference_invoice_id, created_by
      ) values (
        v_clinic_id, v_medicine_id, v_batch.id, 'sale', -v_take, v_running_stock, v_invoice.id, auth.uid()
      );

      v_qty_needed := v_qty_needed - v_take;
    end loop;

    if v_qty_needed > 0 then
      raise exception 'Not enough valid (non-expired) stock of % to complete this sale — check for expired batches in Medicines.', v_medicine.name;
    end if;

    perform set_config('qlinic.allow_direct_stock_write', 'true', true);
    update public.medicines set stock_quantity = v_running_stock where id = v_medicine_id;
    perform set_config('qlinic.allow_direct_stock_write', 'false', true);
  end loop;

  update public.invoices
    set amount = v_subtotal, amount_received = coalesce(p_amount_received, v_subtotal)
    where id = v_invoice.id
    returning * into v_invoice;

  return v_invoice;
end;
$$;

-- ---------------------------------------------------------------
-- 8. get_billing_audit() checks my_role() = 'admin' but never the
--    billing_audit feature flag that billing-audit.html's own UI gate
--    is supposed to enforce — a clinic with billing_audit disabled by
--    the platform admin could still call this RPC directly for the
--    full paywalled report.
-- ---------------------------------------------------------------
create or replace function public.get_billing_audit()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid;
  v_total int;
  v_min int;
  v_max int;
  v_unbilled jsonb;
begin
  if public.my_role() != 'admin' then
    raise exception 'Only clinic admin can view the billing audit.';
  end if;
  if not public.has_feature('billing_audit') then
    raise exception 'Billing audit is not enabled for this clinic.';
  end if;
  v_clinic_id := public.my_clinic_id();

  select count(*), min(invoice_number), max(invoice_number)
    into v_total, v_min, v_max
    from public.invoices
    where clinic_id = v_clinic_id;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id,
      'name', p.name,
      'tokenDate', p.token_date,
      'status', p.status,
      'doctorId', p.doctor_id
    ) order by p.token_date desc, p.created_at desc), '[]'::jsonb)
    into v_unbilled
    from public.patients p
    where p.clinic_id = v_clinic_id
      and p.status in ('waiting', 'in_consult', 'done')
      and not exists (select 1 from public.invoices i where i.patient_id = p.id);

  return jsonb_build_object(
    'totalInvoices', v_total,
    'minInvoiceNumber', v_min,
    'maxInvoiceNumber', v_max,
    'unbilledPatients', v_unbilled
  );
end;
$$;

-- ---------------------------------------------------------------
-- 9. patients' SELECT policy has no role restriction at all — the
--    pharmacist role was explicitly designed (067) as "pharmacy counter
--    and catalog only... no access to consultation invoices", but the
--    base patients SELECT policy was never narrowed, so a pharmacist
--    could read the entire roster (name/phone/address/free-text visit
--    reason) for every patient. Pharmacy only ever needs name+phone via
--    search (clinic-data.js's searchPatientsForPharmacy) — moved to its
--    own narrow, security-definer RPC that returns just those columns,
--    so the base table can be locked down to the roles that actually
--    manage the queue.
-- ---------------------------------------------------------------
drop policy if exists "clinic patients select" on public.patients;
create policy "clinic patients select" on public.patients
  for select using (clinic_id = public.my_clinic_id() and public.my_role() in ('admin', 'reception', 'doctor'));

create or replace function public.search_patients_for_pharmacy(p_query text)
returns table (id uuid, name text, phone text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid;
  v_query text := trim(coalesce(p_query, ''));
begin
  if public.my_role() not in ('admin', 'reception', 'pharmacist') then
    raise exception 'Only clinic admin, reception, or pharmacist can search patients.';
  end if;
  if v_query = '' then
    return;
  end if;
  v_clinic_id := public.my_clinic_id();

  return query
    select distinct on (coalesce(nullif(p.phone, ''), p.id::text)) p.id, p.name, p.phone
    from public.patients p
    where p.clinic_id = v_clinic_id
      and (p.name ilike '%' || v_query || '%' or p.phone ilike '%' || v_query || '%')
    order by coalesce(nullif(p.phone, ''), p.id::text), p.created_at desc
    limit 20;
end;
$$;

grant execute on function public.search_patients_for_pharmacy(text) to authenticated;

-- ---------------------------------------------------------------
-- 10. Premium-tier paywalls enforced only client-side: getPatientDirectory
--     (clinic-data.js) was a plain sb.from('patients').select() with no
--     feature-flag check at the RLS/RPC layer, so a clinic with
--     patient_directory disabled could still pull the full directory by
--     calling Supabase directly. Moved to its own RPC with the check
--     server-side — the same treatment get_billing_audit() got above.
--     (insights' underlying reads — getInvoicesForDateRange,
--     getPatientsInRange, etc. — are shared by reception/billing/
--     dashboard for legitimate non-Insights purposes; gating those at
--     the table level would break those unrelated screens for a clinic
--     with only "insights" disabled. Closing that specific gap needs
--     dedicated insights-only RPCs to replace those shared table reads,
--     which is a larger refactor than this review batch — left as a
--     known, documented gap rather than a risky partial fix.)
-- ---------------------------------------------------------------
create or replace function public.get_patient_directory()
returns table (
  name text, phone text, age int, gender text, address text,
  doctor_id uuid, token_date date, status text, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if public.my_role() not in ('admin', 'reception', 'doctor') then
    raise exception 'Not authorized.';
  end if;
  if not public.has_feature('patient_directory') then
    raise exception 'Patient directory is not enabled for this clinic.';
  end if;
  return query
    select p.name, p.phone, p.age, p.gender, p.address, p.doctor_id, p.token_date, p.status, p.created_at
    from public.patients p
    where p.clinic_id = public.my_clinic_id()
    order by p.created_at desc, p.id asc;
end;
$$;

grant execute on function public.get_patient_directory() to authenticated;

-- ---------------------------------------------------------------
-- 11. update_invoice_payment() never got the negative-amount guard 076
--     added to its siblings (create_invoice/create_pharmacy_invoice).
-- ---------------------------------------------------------------
create or replace function public.update_invoice_payment(
  p_invoice_id uuid,
  p_fee_type text,
  p_payment_mode text,
  p_amount_received numeric
)
returns public.invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid;
  v_doctor_id uuid;
  v_amount numeric(10, 2);
  v_row public.invoices;
begin
  if public.my_role() not in ('admin', 'reception') then
    raise exception 'Only clinic admin or reception can edit a bill.';
  end if;
  if p_fee_type not in ('consultation', 'emergency', 'waived') then
    raise exception 'Invalid fee type.';
  end if;
  if p_payment_mode not in ('cash', 'upi', 'card') then
    raise exception 'Invalid payment mode.';
  end if;
  if p_amount_received is not null and p_amount_received < 0 then
    raise exception 'Amount received cannot be negative.';
  end if;

  v_clinic_id := public.my_clinic_id();

  select doctor_id into v_doctor_id
    from public.invoices
    where id = p_invoice_id and clinic_id = v_clinic_id;

  if v_doctor_id is null then
    raise exception 'Invoice not found in this clinic.';
  end if;

  if p_fee_type = 'waived' then
    v_amount := 0;
  else
    select case when p_fee_type = 'consultation' then fee_normal else fee_emergency end
      into v_amount
      from public.doctors
      where id = v_doctor_id;
  end if;

  update public.invoices
    set fee_type = p_fee_type,
        amount = v_amount,
        payment_mode = p_payment_mode,
        amount_received = coalesce(p_amount_received, v_amount)
    where id = p_invoice_id and clinic_id = v_clinic_id
    returning * into v_row;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------
-- 12/13/25. create_prescription() (094's 16-arg version, the currently
--     active one):
--     - never checked doctors.is_active on the admin-picks-a-doctor
--       branch, so an admin could attribute a fresh prescription to a
--       doctor who has left the practice or been deactivated.
--     - its item-insert loop took clinic_medicine_id from client JSON
--       with zero check it belongs to the caller's own clinic, unlike
--       patient_id/doctor_id a few lines above — a Clinic A doctor could
--       reference Clinic B's medicine_id, and every read RPC's unscoped
--       join on that column would then surface Clinic B's private
--       medicine catalog data back to Clinic A staff. Fixing the write
--       path closes the read-side leak too, since a clinic_medicine_id
--       can now never point outside its own clinic once it's stored.
-- ---------------------------------------------------------------
create or replace function public.create_prescription(
  p_patient_id uuid default null,
  p_complaints text default '',
  p_diagnosis text default '',
  p_advice text default '',
  p_follow_up_date date default null,
  p_items jsonb default '[]'::jsonb,
  p_doctor_id uuid default null,
  p_vitals_bp text default '',
  p_vitals_pulse text default '',
  p_vitals_temp text default '',
  p_vitals_weight text default '',
  p_tests_ordered text[] default '{}',
  p_walkin_name text default null,
  p_walkin_age int default null,
  p_walkin_gender text default null,
  p_walkin_phone text default null
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
  v_walkin_name text := nullif(trim(coalesce(p_walkin_name, '')), '');
  v_clinic_medicine_id uuid;
begin
  v_clinic_id := public.my_clinic_id();

  if public.my_role() = 'doctor' then
    select doctor_id into v_doctor_id from public.profiles where id = auth.uid();
    if v_doctor_id is null then
      raise exception 'Your account is not linked to a doctor profile.';
    end if;
  elsif public.my_role() = 'admin' then
    if p_doctor_id is null then
      raise exception 'Choose which doctor this prescription is for.';
    end if;
    if not exists (select 1 from public.doctors where id = p_doctor_id and clinic_id = v_clinic_id and is_active = true) then
      raise exception 'Doctor not found in this clinic.';
    end if;
    v_doctor_id := p_doctor_id;
  else
    raise exception 'Only a doctor or admin can write a prescription.';
  end if;

  if p_patient_id is not null then
    if not exists (select 1 from public.patients where id = p_patient_id and clinic_id = v_clinic_id) then
      raise exception 'Patient not found in this clinic.';
    end if;
  elsif v_walkin_name is null then
    raise exception 'A prescription needs a linked patient or a walk-in name.';
  end if;

  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    raise exception 'A prescription needs at least one medicine.';
  end if;

  insert into public.prescriptions (
    clinic_id, patient_id, doctor_id, complaints, diagnosis, advice, follow_up_date, created_by,
    vitals_bp, vitals_pulse, vitals_temp, vitals_weight, tests_ordered,
    walkin_name, walkin_age, walkin_gender, walkin_phone
  )
  values (
    v_clinic_id, p_patient_id, v_doctor_id, coalesce(p_complaints, ''), coalesce(p_diagnosis, ''), coalesce(p_advice, ''), p_follow_up_date, auth.uid(),
    coalesce(p_vitals_bp, ''), coalesce(p_vitals_pulse, ''), coalesce(p_vitals_temp, ''), coalesce(p_vitals_weight, ''), coalesce(p_tests_ordered, '{}'),
    v_walkin_name, p_walkin_age, nullif(trim(coalesce(p_walkin_gender, '')), ''), nullif(trim(coalesce(p_walkin_phone, '')), '')
  )
  returning id into v_prescription_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_clinic_medicine_id := nullif(v_item->>'clinic_medicine_id', '')::uuid;
    if v_clinic_medicine_id is not null
       and not exists (select 1 from public.medicines where id = v_clinic_medicine_id and clinic_id = v_clinic_id) then
      raise exception 'One of the selected medicines was not found in this clinic.';
    end if;

    insert into public.prescription_items (
      prescription_id, clinic_medicine_id, generic_medicine_id, free_text_name,
      frequency, duration_text, instructions, sort_order
    ) values (
      v_prescription_id,
      v_clinic_medicine_id,
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

-- 26. Never revoked from PUBLIC, unlike the fix pattern this exact
--     class of bug already got once for auto_close_previous_day (077).
revoke execute on function public.create_prescription(
  uuid, text, text, text, date, jsonb, uuid, text, text, text, text, text[], text, int, text, text
) from public;
grant execute on function public.create_prescription(
  uuid, text, text, text, date, jsonb, uuid, text, text, text, text, text[], text, int, text, text
) to authenticated;

-- ---------------------------------------------------------------
-- 12. get_clinic_prescriptions / get_clinic_prescriptions_by_date /
--     search_clinic_prescriptions all resolve v_caller_doctor_id from
--     profiles.doctor_id (nullable by design — a profile can exist
--     before being linked to a roster entry) and then treat a NULL as
--     "no restriction" via `v_caller_doctor_id is null or ...` — meant
--     only for the admin case (which never sets v_caller_doctor_id at
--     all), but a doctor-role account with no linked doctor_id yet hits
--     the exact same NULL and gets the exact same "see everything"
--     result instead of "see nothing". Fail closed instead, matching
--     create_prescription()'s own handling of the identical case.
-- ---------------------------------------------------------------
create or replace function public.get_clinic_prescriptions(p_doctor_id uuid default null, p_limit int default 300)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid;
  v_caller_doctor_id uuid;
begin
  if public.my_role() not in ('admin', 'doctor') then
    raise exception 'Only a doctor or admin can view prescription history.';
  end if;
  v_clinic_id := public.my_clinic_id();
  if public.my_role() = 'doctor' then
    select doctor_id into v_caller_doctor_id from public.profiles where id = auth.uid();
    if v_caller_doctor_id is null then
      raise exception 'Your account is not linked to a doctor profile.';
    end if;
  end if;

  return (
    select coalesce(jsonb_agg(row_to_json(p) order by p.created_at desc), '[]'::jsonb)
    from (
      select
        pr.id, pr.created_at, pr.complaints, pr.diagnosis, pr.advice, pr.follow_up_date,
        pr.vitals_bp, pr.vitals_pulse, pr.vitals_temp, pr.vitals_weight, pr.tests_ordered,
        pr.patient_id is null as is_walkin,
        coalesce(pat.name, pr.walkin_name) as patient_name,
        coalesce(pat.age, pr.walkin_age) as patient_age,
        coalesce(pat.gender, pr.walkin_gender) as patient_gender,
        coalesce(pat.phone, pr.walkin_phone) as patient_phone,
        doc.id as doctor_id, doc.name as doctor_name, doc.specialty as doctor_specialty, doc.qualification as doctor_qualification, doc.registration_number as doctor_registration_number,
        (
          select coalesce(jsonb_agg(jsonb_build_object(
            'name', coalesce(cm.name, gm.name, pi.free_text_name),
            'composition', nullif(coalesce(cm.generic_name, concat_ws(' + ', nullif(gm.composition_1, ''), nullif(gm.composition_2, ''))), ''),
            'frequency', pi.frequency,
            'durationText', pi.duration_text,
            'instructions', pi.instructions
          ) order by pi.sort_order), '[]'::jsonb)
          from public.prescription_items pi
          left join public.medicines cm on cm.id = pi.clinic_medicine_id
          left join public.generic_medicines gm on gm.id = pi.generic_medicine_id
          where pi.prescription_id = pr.id
        ) as items
      from public.prescriptions pr
      left join public.patients pat on pat.id = pr.patient_id
      join public.doctors doc on doc.id = pr.doctor_id
      where pr.clinic_id = v_clinic_id
        and (p_doctor_id is null or pr.doctor_id = p_doctor_id)
        and (v_caller_doctor_id is null or pr.doctor_id = v_caller_doctor_id)
      order by pr.created_at desc
      limit greatest(p_limit, 1)
    ) p
  );
end;
$$;

create or replace function public.get_clinic_prescriptions_by_date(p_date date, p_doctor_id uuid default null, p_end_date date default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid;
  v_caller_doctor_id uuid;
  v_end_date date := coalesce(p_end_date, p_date);
begin
  if public.my_role() not in ('admin', 'doctor') then
    raise exception 'Only a doctor or admin can view prescription history.';
  end if;
  v_clinic_id := public.my_clinic_id();
  if public.my_role() = 'doctor' then
    select doctor_id into v_caller_doctor_id from public.profiles where id = auth.uid();
    if v_caller_doctor_id is null then
      raise exception 'Your account is not linked to a doctor profile.';
    end if;
  end if;

  return (
    select coalesce(jsonb_agg(row_to_json(p) order by p.created_at desc), '[]'::jsonb)
    from (
      select
        pr.id, pr.created_at, pr.complaints, pr.diagnosis, pr.advice, pr.follow_up_date,
        pr.vitals_bp, pr.vitals_pulse, pr.vitals_temp, pr.vitals_weight, pr.tests_ordered,
        pr.patient_id is null as is_walkin,
        coalesce(pat.name, pr.walkin_name) as patient_name,
        coalesce(pat.age, pr.walkin_age) as patient_age,
        coalesce(pat.gender, pr.walkin_gender) as patient_gender,
        coalesce(pat.phone, pr.walkin_phone) as patient_phone,
        doc.id as doctor_id, doc.name as doctor_name, doc.specialty as doctor_specialty, doc.qualification as doctor_qualification, doc.registration_number as doctor_registration_number,
        (
          select coalesce(jsonb_agg(jsonb_build_object(
            'name', coalesce(cm.name, gm.name, pi.free_text_name),
            'composition', nullif(coalesce(cm.generic_name, concat_ws(' + ', nullif(gm.composition_1, ''), nullif(gm.composition_2, ''))), ''),
            'frequency', pi.frequency,
            'durationText', pi.duration_text,
            'instructions', pi.instructions
          ) order by pi.sort_order), '[]'::jsonb)
          from public.prescription_items pi
          left join public.medicines cm on cm.id = pi.clinic_medicine_id
          left join public.generic_medicines gm on gm.id = pi.generic_medicine_id
          where pi.prescription_id = pr.id
        ) as items
      from public.prescriptions pr
      left join public.patients pat on pat.id = pr.patient_id
      join public.doctors doc on doc.id = pr.doctor_id
      where pr.clinic_id = v_clinic_id
        and pr.created_at::date between p_date and v_end_date
        and (p_doctor_id is null or pr.doctor_id = p_doctor_id)
        and (v_caller_doctor_id is null or pr.doctor_id = v_caller_doctor_id)
    ) p
  );
end;
$$;

create or replace function public.search_clinic_prescriptions(p_query text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid;
  v_caller_doctor_id uuid;
  v_query text := trim(coalesce(p_query, ''));
begin
  if public.my_role() not in ('admin', 'doctor') then
    raise exception 'Only a doctor or admin can view prescription history.';
  end if;
  if length(v_query) < 2 then
    return '[]'::jsonb;
  end if;
  v_clinic_id := public.my_clinic_id();
  if public.my_role() = 'doctor' then
    select doctor_id into v_caller_doctor_id from public.profiles where id = auth.uid();
    if v_caller_doctor_id is null then
      raise exception 'Your account is not linked to a doctor profile.';
    end if;
  end if;

  return (
    select coalesce(jsonb_agg(row_to_json(p) order by p.created_at desc), '[]'::jsonb)
    from (
      select
        pr.id, pr.created_at, pr.complaints, pr.diagnosis, pr.advice, pr.follow_up_date,
        pr.vitals_bp, pr.vitals_pulse, pr.vitals_temp, pr.vitals_weight, pr.tests_ordered,
        pr.patient_id is null as is_walkin,
        coalesce(pat.name, pr.walkin_name) as patient_name,
        coalesce(pat.age, pr.walkin_age) as patient_age,
        coalesce(pat.gender, pr.walkin_gender) as patient_gender,
        coalesce(pat.phone, pr.walkin_phone) as patient_phone,
        doc.id as doctor_id, doc.name as doctor_name, doc.specialty as doctor_specialty, doc.qualification as doctor_qualification, doc.registration_number as doctor_registration_number,
        (
          select coalesce(jsonb_agg(jsonb_build_object(
            'name', coalesce(cm.name, gm.name, pi.free_text_name),
            'composition', nullif(coalesce(cm.generic_name, concat_ws(' + ', nullif(gm.composition_1, ''), nullif(gm.composition_2, ''))), ''),
            'frequency', pi.frequency,
            'durationText', pi.duration_text,
            'instructions', pi.instructions
          ) order by pi.sort_order), '[]'::jsonb)
          from public.prescription_items pi
          left join public.medicines cm on cm.id = pi.clinic_medicine_id
          left join public.generic_medicines gm on gm.id = pi.generic_medicine_id
          where pi.prescription_id = pr.id
        ) as items
      from public.prescriptions pr
      left join public.patients pat on pat.id = pr.patient_id
      join public.doctors doc on doc.id = pr.doctor_id
      where pr.clinic_id = v_clinic_id
        and (
          pat.name ilike '%' || v_query || '%' or pat.phone ilike v_query || '%'
          or pr.walkin_name ilike '%' || v_query || '%' or pr.walkin_phone ilike v_query || '%'
        )
        and (v_caller_doctor_id is null or pr.doctor_id = v_caller_doctor_id)
      order by pr.created_at desc
      limit 50
    ) p
  );
end;
$$;

-- ---------------------------------------------------------------
-- 16. prescription_items' INSERT policy checked only the parent
--     prescription's clinic_id + that the caller's role is admin/doctor
--     — not that a doctor caller owns that prescription. Any doctor
--     could append new medicine lines onto a colleague's already-issued
--     prescription. Admin keeps unrestricted insert (matches
--     create_prescription()'s own admin-picks-any-doctor model).
-- ---------------------------------------------------------------
drop policy if exists "admin or doctor insert prescription items" on public.prescription_items;
create policy "admin or doctor insert prescription items" on public.prescription_items
  for insert with check (
    exists (
      select 1 from public.prescriptions p
      where p.id = prescription_id
        and p.clinic_id = public.my_clinic_id()
        and (
          public.my_role() = 'admin'
          or (public.my_role() = 'doctor' and p.doctor_id = public.my_doctor_id())
        )
    )
  );

-- ---------------------------------------------------------------
-- 27. client_errors' INSERT policy is open to anon+authenticated with
--     no server-side rate limit at all (the "5 errors per page load"
--     cap is a JS-only variable that resets every page load) — an
--     unauthenticated visitor on any public page could script unlimited
--     direct inserts, inflating storage and burying real telemetry. A
--     generous global per-minute cap blocks a true flood script without
--     affecting real traffic (a real site-wide incident logging this
--     many distinct errors in a minute is itself already an emergency
--     worth investigating a different way).
-- ---------------------------------------------------------------
create or replace function public.limit_client_errors_rate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recent_count bigint;
begin
  select count(*) into v_recent_count
    from public.client_errors
    where created_at > now() - interval '1 minute';
  if v_recent_count >= 200 then
    raise exception 'Too many error reports right now — please try again shortly.';
  end if;
  return new;
end;
$$;

drop trigger if exists client_errors_limit_rate on public.client_errors;
create trigger client_errors_limit_rate
  before insert on public.client_errors
  for each row execute function public.limit_client_errors_rate();
