-- ============================================================
-- ClinVision, migration 110: use the clinic's calendar day (India time) for pharmacy sales.
--
-- The database clock runs in UTC. current_date therefore flips to the next day at 5:30 am
-- India time, not at midnight. Between midnight and 5:30 am a pharmacy sale was dated
-- the day before (so it showed in yesterday's revenue and day close), and a batch that
-- expires "today" was still treated as in date. Every other queue and board function
-- already uses Asia/Kolkata; this brings the pharmacy invoice in line.
--
-- Safe to run more than once. Run this once in the Supabase SQL Editor, after 109.
-- ============================================================

alter table public.invoices
  alter column invoice_date set default ((now() at time zone 'Asia/Kolkata')::date);

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
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
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
    v_clinic_id, v_invoice_number, 'pharmacy', null, null, 0, v_today,
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
          and (expiry_date is null or expiry_date >= v_today)
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
