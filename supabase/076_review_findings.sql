-- ============================================================
-- Qlinic — migration 076: pre-deployment review fixes.
--
-- Six of the eight findings from the pre-deployment code review,
-- bundled into one migration since none of them touch overlapping
-- objects. The other two (the Insights drill-down layout bug, and
-- create_pharmacy_invoice's rate/amount consistency, which turned out
-- on a second look to already be correct standard invoicing practice —
-- rate × qty = amount on the printed receipt, exactly as it should be)
-- are not schema changes.
--
-- Run this once in the Supabase SQL Editor, after 075_billing_audit_pharmacy_leak.sql.
-- ============================================================

-- ---------------------------------------------------------------
-- 1. patients table had no role restriction at all — any authenticated
--    clinic member (including the newer, deliberately narrower
--    pharmacist role) could write to the entire queue directly via the
--    API. Read access stays open to all four roles (reception, doctor,
--    and pharmacist all legitimately search/look up patients); writes
--    narrow to the three roles that actually touch the queue.
-- ---------------------------------------------------------------
drop policy if exists "clinic patients insert" on public.patients;
create policy "clinic staff patients insert" on public.patients
  for insert with check (clinic_id = public.my_clinic_id() and public.my_role() in ('admin', 'reception', 'doctor'));

drop policy if exists "clinic patients update" on public.patients;
create policy "clinic staff patients update" on public.patients
  for update using (clinic_id = public.my_clinic_id() and public.my_role() in ('admin', 'reception', 'doctor'))
  with check (clinic_id = public.my_clinic_id() and public.my_role() in ('admin', 'reception', 'doctor'));

drop policy if exists "clinic patients delete" on public.patients;
create policy "clinic staff patients delete" on public.patients
  for delete using (clinic_id = public.my_clinic_id() and public.my_role() in ('admin', 'reception', 'doctor'));

-- ---------------------------------------------------------------
-- 2. restrict_doctor_roster_edits() (011/012) never learned about
--    hpr_id (048) — a reception or doctor-role session could silently
--    overwrite another doctor's ABDM registry id via the API.
-- ---------------------------------------------------------------
create or replace function public.restrict_doctor_roster_edits()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.my_role() = 'admin' then
    return new;
  end if;
  if new.name is distinct from old.name
     or new.specialty is distinct from old.specialty
     or new.is_active is distinct from old.is_active
     or new.clinic_id is distinct from old.clinic_id
     or new.fee_normal is distinct from old.fee_normal
     or new.fee_emergency is distinct from old.fee_emergency
     or new.hpr_id is distinct from old.hpr_id then
    raise exception 'Only a clinic admin can edit the doctor roster.';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------
-- 3. profiles.role had no database-level constraint at all — only
--    create_staff_profile()'s procedural guard validated it, and only
--    at creation time. updateStaffRole() (clinic-data.js) writes it
--    directly with no validation of its own. A CHECK constraint closes
--    this regardless of which code path writes the column.
-- ---------------------------------------------------------------
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin', 'reception', 'doctor', 'pharmacist'));

-- ---------------------------------------------------------------
-- 5. amount_received was stored from the client with no range check,
--    on both the consultation and pharmacy paths. A negative value
--    would silently corrupt Revenue totals and permanently flag an
--    invoice as "outstanding". create_invoice's signature/params are
--    unchanged, so create or replace is enough — no drop needed.
-- ---------------------------------------------------------------
create or replace function public.create_invoice(
  p_doctor_id uuid,
  p_fee_type text,
  p_patient_name text,
  p_patient_phone text,
  p_patient_address text,
  p_patient_age int,
  p_patient_gender text,
  p_payment_mode text,
  p_amount_received numeric,
  p_invoice_date date default current_date,
  p_patient_id uuid default null
)
returns public.invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid;
  v_amount numeric(10, 2);
  v_invoice_number integer;
  v_row public.invoices;
begin
  if public.my_role() not in ('admin', 'reception') then
    raise exception 'Only clinic admin or reception can create a bill.';
  end if;
  if p_fee_type not in ('consultation', 'emergency') then
    raise exception 'Invalid fee type.';
  end if;
  if p_payment_mode not in ('cash', 'upi', 'card') then
    raise exception 'Invalid payment mode.';
  end if;
  if p_amount_received is not null and p_amount_received < 0 then
    raise exception 'Amount received cannot be negative.';
  end if;

  v_clinic_id := public.my_clinic_id();

  if p_patient_id is not null then
    if not exists (select 1 from public.patients where id = p_patient_id and clinic_id = v_clinic_id) then
      raise exception 'Patient not found in this clinic.';
    end if;
  end if;

  select case when p_fee_type = 'consultation' then fee_normal else fee_emergency end
    into v_amount
    from public.doctors
    where id = p_doctor_id and clinic_id = v_clinic_id;

  if v_amount is null then
    raise exception 'Doctor not found in this clinic.';
  end if;

  update public.clinics
    set next_invoice_number = next_invoice_number + 1
    where id = v_clinic_id
    returning next_invoice_number - 1 into v_invoice_number;

  insert into public.invoices (
    clinic_id, invoice_number, doctor_id, fee_type, amount,
    patient_name, patient_phone, patient_address, patient_age, patient_gender,
    payment_mode, amount_received, invoice_date, created_by, patient_id
  ) values (
    v_clinic_id, v_invoice_number, p_doctor_id, p_fee_type, v_amount,
    p_patient_name, p_patient_phone, p_patient_address, p_patient_age, p_patient_gender,
    p_payment_mode, coalesce(p_amount_received, v_amount), coalesce(p_invoice_date, current_date), auth.uid(), p_patient_id
  )
  returning * into v_row;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------
-- 6. create_pharmacy_invoice took FOR UPDATE locks on medicines (and
--    their batches) in whatever order the client's cart happened to
--    list them — two concurrent sales referencing the same two
--    medicines in opposite order could deadlock. Sorting p_items by
--    medicine_id before the loop makes every transaction acquire locks
--    in the same order, which eliminates the deadlock possibility
--    outright rather than just making it less likely. Also folds in
--    fix 5's amount_received check.
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

  -- Deterministic lock order across every concurrent call, regardless
  -- of the cart's own item order client-side.
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

-- ---------------------------------------------------------------
-- 7. auto_close_previous_day() only ever targeted exactly "yesterday" —
--    if the cron missed more than one day (extension disabled, project
--    paused), older stale 'booked' rows were never caught up. Widened
--    to close out everything still 'booked' with a booked_date in the
--    past, however far back, in one pass.
-- ---------------------------------------------------------------
create or replace function public.auto_close_previous_day()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date;
begin
  v_today := (now() at time zone 'Asia/Kolkata')::date;

  update public.patients
  set status = 'no_show'
  where status = 'booked'
    and booked_date < v_today;

  update public.clinics
  set last_closed_date = v_today - 1, closed_at = now()
  where last_closed_date is distinct from v_today - 1;
end;
$$;

-- ---------------------------------------------------------------
-- 8. medicine_seed_templates never had RLS enabled — readable by any
--    authenticated client directly via the API, not just through
--    register_clinic()'s security-definer copy. Content isn't
--    sensitive, but it broke the "every table has RLS" convention
--    every other table in this schema follows. No policies needed —
--    register_clinic() is security definer and bypasses RLS entirely,
--    so enabling it with zero policies is enough to close direct
--    client access, same pattern doctor_status_log/product_feedback
--    already use for "written only by trusted server-side code."
-- ---------------------------------------------------------------
alter table public.medicine_seed_templates enable row level security;
