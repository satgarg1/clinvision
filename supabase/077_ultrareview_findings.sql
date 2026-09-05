-- ============================================================
-- Qlinic — migration 077: ultrareview findings.
--
-- Five SQL-level fixes from the cloud multi-agent review (the other
-- five findings were client-side, fixed directly in clinic-data.js/
-- manage-medicines.html/pharmacy.html alongside this).
--
-- Run this once in the Supabase SQL Editor, after 076_review_findings.sql.
-- ============================================================

-- ---------------------------------------------------------------
-- 1. auto_close_previous_day() was created with no REVOKE — Postgres
--    grants EXECUTE to PUBLIC by default on every new function, so
--    despite the migration's own comment claiming "only the cron job
--    can call it," any authenticated user of any clinic could invoke
--    it directly via PostgREST RPC. The function has no clinic_id
--    scoping at all (by design — it processes every clinic in one
--    pass), so this let any single clinic's staff member flip every
--    OTHER clinic's still-'booked' patients to 'no_show' on demand.
-- ---------------------------------------------------------------
revoke execute on function public.auto_close_previous_day() from public;

-- ---------------------------------------------------------------
-- 2. create_pharmacy_invoice's FEFO loop never excluded already-expired
--    batches — sorting by expiry_date ascending means an expired batch
--    (still with quantity_remaining > 0 because nobody ran adjust_stock
--    to zero it out) sorts FIRST and gets dispensed to the very next
--    customer. manage-medicines.html already flags an expired batch
--    with a red badge for a human to see, but the sale itself was never
--    actually blocked.
-- ---------------------------------------------------------------
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

    -- Only batches that are not already expired are FEFO-eligible.
    -- An expired batch with leftover quantity_remaining (nobody ran
    -- adjust_stock to zero it out yet) must never be dispensed.
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
      -- Either genuinely out of stock, or the only remaining stock is
      -- expired and correctly excluded above -- either way, refuse the
      -- sale rather than silently shorting or backfilling from expired
      -- batches.
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

-- ---------------------------------------------------------------
-- 3. record_stock_purchase's ON CONFLICT unconditionally overwrote
--    purchase_price/mrp with whatever the client sent — topping up an
--    existing batch number with the Purchase price field left blank
--    (manage-medicines.html sends 0 in that case) silently zeroed out
--    the batch's originally-recorded purchase price with no way to
--    recover it.
-- ---------------------------------------------------------------
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
        -- Only overwrite an existing batch's recorded price if the new
        -- value is actually positive -- a blank/zero field on a top-up
        -- keeps the batch's original price instead of erasing it.
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

-- ---------------------------------------------------------------
-- 4. auto_create_invoice_on_arrival() (016, redefined by 031) checked
--    "if exists (select 1 from invoices where patient_id = new.id)"
--    with no invoice_type filter. Once pharmacy invoices shared this
--    same table (066) and could carry a patient_id, a returning
--    customer who'd only ever bought medicine (never been billed for a
--    consultation) would be wrongly treated as "already billed" the
--    next time they arrived for an actual visit -- silently dropping
--    their consultation invoice and hiding them from get_billing_audit
--    (which is correctly consultation-scoped as of 075) forever, since
--    it too only sees the missing consultation invoice, never a reason
--    to flag it as missing when this trigger already skipped creating
--    one entirely.
-- ---------------------------------------------------------------
create or replace function public.auto_create_invoice_on_arrival()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount numeric(10, 2);
  v_fee_type text;
  v_invoice_number integer;
begin
  if exists (select 1 from public.invoices where patient_id = new.id and invoice_type = 'consultation') then
    return new;
  end if;

  v_fee_type := case when new.is_priority then 'emergency' else 'consultation' end;

  select case when new.is_priority then fee_emergency else fee_normal end
    into v_amount
    from public.doctors where id = new.doctor_id;
  if v_amount is null then
    return new;
  end if;

  update public.clinics
    set next_invoice_number = next_invoice_number + 1
    where id = new.clinic_id
    returning next_invoice_number - 1 into v_invoice_number;

  insert into public.invoices (
    clinic_id, invoice_number, doctor_id, fee_type, amount,
    patient_id, patient_name, patient_phone, patient_address, patient_age, patient_gender,
    payment_mode, amount_received, created_by
  ) values (
    new.clinic_id, v_invoice_number, new.doctor_id, v_fee_type, v_amount,
    new.id, new.name, new.phone, new.address, new.age, new.gender,
    'cash', v_amount, auth.uid()
  );

  return new;
end;
$$;

-- ---------------------------------------------------------------
-- 5. record_care_context() (049) fired for every invoice insert,
--    including pharmacy sales — a pharmacy invoice has no doctor_id,
--    so it produced a care_contexts row labeled "Consultation - <date>"
--    typed as an OPConsultation clinical encounter for a transaction
--    that was actually just a medicine purchase, corrupting the ABDM
--    data this table exists to eventually share.
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
  select * into v_invoice from public.invoices where id = p_invoice_id;
  -- No row, no linked patient, or not a consultation visit at all
  -- (a pharmacy sale is a goods transaction, not a clinical encounter) -
  -- nothing to record.
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
