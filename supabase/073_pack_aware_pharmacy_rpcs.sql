-- ============================================================
-- Qlinic — migration 073: pack-aware stock-in and sale pricing.
--
-- record_stock_purchase() now takes "packs received" (how many strips/
-- bottles/vials actually arrived) instead of a bare quantity — it
-- looks up the medicine's own pack_size server-side (never trusts a
-- client-supplied conversion) and multiplies to get the real dispense-
-- unit count to add to stock. "40 packs of 10 tablets" now genuinely
-- means +400 tablets, not +40 of something ambiguous.
--
-- create_pharmacy_invoice() now divides the medicine's pack-level
-- selling_price by its pack_size to get a real per-dispense-unit price
-- before multiplying by the quantity actually sold — selling 4 tablets
-- out of a ₹40-per-strip-of-10 medicine now correctly charges ₹16, not
-- ₹160 (the old code priced every unit sold as if it were a whole pack).
--
-- Run this once in the Supabase SQL Editor, after 072_medicine_pack_units.sql.
-- ============================================================

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

  -- Same batch number arriving again (a second delivery of the same
  -- purchase) tops up that batch's own quantity rather than creating a
  -- duplicate row — medicine_batches_unique_idx (064) is what makes
  -- this ON CONFLICT target valid.
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
        purchase_price = excluded.purchase_price,
        mrp = excluded.mrp
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

grant execute on function public.record_stock_purchase(uuid, text, date, date, integer, numeric, numeric) to authenticated;

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
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one medicine before completing the sale.';
  end if;
  v_payment_mode := coalesce(p_payment_mode, 'cash');
  if v_payment_mode not in ('cash', 'upi', 'card') then
    raise exception 'Invalid payment mode.';
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

  for v_item in select * from jsonb_array_elements(p_items) loop
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

    -- selling_price is per PACK (how a clinic prices things: "a strip
    -- costs ₹40") — v_qty_needed is in dispense units (tablets), so the
    -- actual charge needs the per-unit price, not the pack price.
    v_unit_price := round(v_medicine.selling_price / nullif(v_medicine.pack_size, 0), 2);
    v_running_stock := v_medicine.stock_quantity;

    for v_batch in
      select * from public.medicine_batches
        where medicine_id = v_medicine_id and clinic_id = v_clinic_id and quantity_remaining > 0
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
      raise exception 'Stock records for % are out of sync -- batches did not cover the full quantity.', v_medicine.name;
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

grant execute on function public.create_pharmacy_invoice(uuid, text, text, text, numeric, jsonb) to authenticated;
