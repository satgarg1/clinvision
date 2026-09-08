-- ============================================================
-- Qlinic — migration 083: platform admin panel, part B (per-clinic
-- feature licensing).
--
-- Four licensable modules: pharmacy (pharmacy.html + manage-medicines.html),
-- insights (revenue.html + trends.html), billing_audit (billing-audit.html),
-- patient_directory (patient-directory.html). Opt-out model, deliberately:
-- no row for a clinic+feature means enabled — matches every existing
-- clinic's current behavior exactly, nothing changes for anyone until a
-- platform admin explicitly flips something off. A row only needs to
-- exist to record an override.
--
-- No RLS policies on clinic_feature_flags at all, on purpose — every
-- access goes through has_feature()/admin_get_clinic_features()/
-- admin_set_clinic_features(), all security definer. A client-side
-- select/insert/update/delete straight against this table is rejected
-- by RLS regardless of role; there's nothing for a clinic to read here
-- directly, only "is X enabled for me," which has_feature() answers.
--
-- Enforcement is two layers, per the explicit requirement that a
-- disabled feature must have zero UI exposure, not just a redirect after
-- the fact — this session's own deactivation-cascade bug is the reason
-- a UI-only gate was rejected outright for this:
--   1. UI (admin.html, plus every gated page's own script + the settings
--      hub's panel cards) — not part of this SQL file.
--   2. Data layer, in THIS file: has_feature('pharmacy') added to
--      medicines' insert/update RLS policies (add_medicine/updateMedicine/
--      setMedicineActive are plain client-side table writes, not RPCs)
--      and to create_pharmacy_invoice()/record_stock_purchase()/
--      adjust_stock() (already RPCs, alongside their existing role
--      checks). medicine_batches and stock_ledger have no direct-client
--      write policies at all — every write to them already funnels
--      through those same three RPCs, so nothing else needs touching.
--      insights/billing_audit/patient_directory are read-only (nothing is
--      created or mutated by viewing a report or an audit list), so UI +
--      redirect alone is proportionate there, same reasoning as the
--      original plan — no RPC/RLS changes for those three in this file.
--
-- Run this once in the Supabase SQL Editor, after
-- 082_auto_suspend_expired_clinics.sql.
-- ============================================================

create table public.clinic_feature_flags (
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  feature_key text not null check (feature_key in ('pharmacy', 'insights', 'billing_audit', 'patient_directory')),
  enabled boolean not null,
  primary key (clinic_id, feature_key)
);

alter table public.clinic_feature_flags enable row level security;

create or replace function public.has_feature(target_feature_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select enabled from public.clinic_feature_flags
     where clinic_id = public.my_clinic_id() and feature_key = target_feature_key),
    true
  );
$$;

grant execute on function public.has_feature(text) to authenticated;

-- Always returns all four keys (defaulting missing ones to enabled),
-- so admin.html's feature-access toggles have something to render even
-- for a clinic with no overrides at all yet.
create or replace function public.admin_get_clinic_features(target_clinic_id uuid)
returns table (feature_key text, enabled boolean)
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
    select k.key, coalesce(f.enabled, true)
    from unnest(array['pharmacy', 'insights', 'billing_audit', 'patient_directory']) as k(key)
    left join public.clinic_feature_flags f
      on f.clinic_id = target_clinic_id and f.feature_key = k.key;
end;
$$;

grant execute on function public.admin_get_clinic_features(uuid) to authenticated;

-- One call sets all four at once, matching the manage-clinic popover's
-- single Save changes button.
create or replace function public.admin_set_clinic_features(
  target_clinic_id uuid,
  pharmacy_enabled boolean,
  insights_enabled boolean,
  billing_audit_enabled boolean,
  patient_directory_enabled boolean
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

  insert into public.clinic_feature_flags (clinic_id, feature_key, enabled)
  values
    (target_clinic_id, 'pharmacy', pharmacy_enabled),
    (target_clinic_id, 'insights', insights_enabled),
    (target_clinic_id, 'billing_audit', billing_audit_enabled),
    (target_clinic_id, 'patient_directory', patient_directory_enabled)
  on conflict (clinic_id, feature_key) do update set enabled = excluded.enabled;
end;
$$;

grant execute on function public.admin_set_clinic_features(uuid, boolean, boolean, boolean, boolean) to authenticated;

-- ============================================================
-- Data-layer enforcement for pharmacy — the part that actually matters.
-- ============================================================

-- medicines' insert/update policies (063_medicines.sql) gain the same
-- has_feature('pharmacy') check the RPCs below get — add_medicine/
-- updateMedicine/setMedicineActive in clinic-data.js are plain
-- sb.from('medicines').insert/update() calls, not RPCs, so RLS is the
-- only enforcement point available for them.
drop policy if exists "pharmacy staff insert medicines" on public.medicines;
create policy "pharmacy staff insert medicines" on public.medicines
  for insert with check (
    clinic_id = public.my_clinic_id()
    and public.my_role() in ('admin', 'reception', 'pharmacist')
    and public.has_feature('pharmacy')
  );

drop policy if exists "pharmacy staff update medicines" on public.medicines;
create policy "pharmacy staff update medicines" on public.medicines
  for update using (
    clinic_id = public.my_clinic_id()
    and public.my_role() in ('admin', 'reception', 'pharmacist')
  )
  with check (
    clinic_id = public.my_clinic_id()
    and public.my_role() in ('admin', 'reception', 'pharmacist')
    and public.has_feature('pharmacy')
  );

-- adjust_stock (068_medicine_rpcs.sql) — unchanged except the added check.
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

  update public.medicines
    set stock_quantity = stock_quantity + p_delta
    where id = p_medicine_id
    returning stock_quantity into v_new_total;

  insert into public.stock_ledger (
    clinic_id, medicine_id, batch_id, movement_type, quantity_delta, closing_stock_after, note, created_by
  ) values (
    v_clinic_id, p_medicine_id, p_batch_id, 'adjustment', p_delta, v_new_total, coalesce(p_note, ''), auth.uid()
  );
end;
$$;

-- record_stock_purchase (latest body: 077_ultrareview_findings.sql) —
-- unchanged except the added check.
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

  update public.medicines
    set stock_quantity = stock_quantity + v_quantity
    where id = p_medicine_id
    returning stock_quantity into v_new_total;

  insert into public.stock_ledger (
    clinic_id, medicine_id, batch_id, movement_type, quantity_delta, closing_stock_after, created_by
  ) values (
    v_clinic_id, p_medicine_id, v_batch.id, 'purchase', v_quantity, v_new_total, auth.uid()
  );

  return v_batch;
end;
$$;

-- create_pharmacy_invoice (latest body: 077_ultrareview_findings.sql) —
-- unchanged except the added check.
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

    update public.medicines set stock_quantity = v_running_stock where id = v_medicine_id;
  end loop;

  update public.invoices
    set amount = v_subtotal, amount_received = coalesce(p_amount_received, v_subtotal)
    where id = v_invoice.id
    returning * into v_invoice;

  return v_invoice;
end;
$$;
