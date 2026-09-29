-- ============================================================
-- Qlinic -- migration 106: database fixes from the whole-codebase
-- review. Run once in the Supabase SQL Editor, after 105.
--
--  1. clinics: a clinic admin's own UPDATE policy is row-scoped only, so
--     they could rewrite subscription/billing columns straight through
--     the REST API. A guard trigger now blocks direct changes to those
--     columns unless the caller is a platform admin (security definer
--     functions such as create_invoice and admin_update_clinic_
--     subscription run as the function owner and are unaffected).
--  2. get_display_board_by_session: stop returning real patient uuids
--     (they are the only secret behind get_queue_status and
--     submit_visit_feedback) and stop honouring an arbitrary date.
--  3. get_billing_audit: restore migration 087's body (consultation
--     invoices only, phone in the unbilled list); 097 had copied 045's.
--  4. enforce_slot_capacity: only check when a row enters or moves
--     within the active set, so over-capacity buckets can't block
--     check-in/done/no-show updates or abort the nightly auto-close.
--  5. patients: re-assign the token number when the doctor, date or
--     type changes, instead of keeping the old number.
--  6. clinics.review_link_url must be an http(s) URL.
--  7. update_invoice_payment: keep the invoice's stored amount when
--     the fee type is unchanged instead of repricing at today's fee.
--  8. record_stock_purchase: merged lots keep the earlier expiry.
--  9. profiles: a direct role change or deactivation can't remove the
--     clinic's last active admin.
-- 10. invoices.invoice_date defaults to the India date, not the server
--     (UTC) date.
-- ============================================================

-- ---------------- 1. clinics billing-column guard ----------------
create or replace function public.guard_clinic_billing_columns()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('authenticated', 'anon') and not public.is_platform_admin() then
    if new.subscription_status is distinct from old.subscription_status
       or new.trial_ends_at is distinct from old.trial_ends_at
       or new.subscription_fee_inr is distinct from old.subscription_fee_inr
       or new.subscription_paid_from is distinct from old.subscription_paid_from
       or new.subscription_paid_to is distinct from old.subscription_paid_to
       or new.admin_note is distinct from old.admin_note
       or new.next_invoice_number is distinct from old.next_invoice_number
       or new.next_pharmacy_invoice_number is distinct from old.next_pharmacy_invoice_number then
      raise exception 'Subscription and billing counters can only be changed by the platform admin.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists clinics_guard_billing_columns on public.clinics;
create trigger clinics_guard_billing_columns
  before update on public.clinics
  for each row
  execute function public.guard_clinic_billing_columns();

-- ---------------- 2. display board: no real patient ids ----------------
create or replace function public.get_display_board_by_session(p_session_id uuid, p_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid;
  v_today date := public.board_day();
  v_date date;
begin
  select clinic_id into v_clinic_id
    from public.display_board_sessions
    where id = p_session_id and expires_at > now();

  if v_clinic_id is null then
    return jsonb_build_object('error', 'expired');
  end if;

  -- The board only ever shows today; a client-supplied date is honoured
  -- only within a day either side (clock/timezone slack), never for
  -- arbitrary past or future days.
  v_date := least(greatest(coalesce(p_date, v_today), v_today - 1), v_today + 1);

  return jsonb_build_object(
    'clinic', (
      select jsonb_build_object(
        'id', c.id, 'name', c.name, 'display_language', c.display_language,
        'closed_at', c.closed_at, 'logo_url', c.logo_url
      )
      from public.clinics c where c.id = v_clinic_id
    ),
    'doctors', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', d.id, 'name', d.name, 'specialty', d.specialty, 'status', d.status,
        'delay_mins', d.delay_mins, 'status_note', d.status_note,
        'status_updated_at', d.status_updated_at, 'is_active', d.is_active,
        'day_closed_at', d.day_closed_at
      ) order by d.created_at), '[]'::jsonb)
      from public.doctors d
      where d.clinic_id = v_clinic_id and d.is_active = true
    ),
    'patients', (
      select coalesce(jsonb_agg(jsonb_build_object(
        -- A one-way, per-session key: unique enough for the board to
        -- tell rows apart, but not the patient's real id, which is the
        -- bearer secret behind get_queue_status / submit_visit_feedback.
        'id', md5(p.id::text || p_session_id::text),
        'doctor_id', p.doctor_id, 'name', p.name, 'status', p.status,
        'type', p.type, 'token_number', p.token_number, 'token_date', p.token_date,
        'is_priority', p.is_priority, 'booked_date', p.booked_date, 'booked_time', p.booked_time,
        'arrived_at', p.arrived_at, 'called_at', p.called_at, 'created_at', p.created_at
      )), '[]'::jsonb)
      from public.patients p
      where p.clinic_id = v_clinic_id and p.token_date = v_date
    )
  );
end;
$$;

revoke execute on function public.get_display_board_by_session(uuid, date) from public;
grant execute on function public.get_display_board_by_session(uuid, date) to anon, authenticated;

-- ---------------- 3. get_billing_audit (087 body + feature gate) ----------------
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
    where clinic_id = v_clinic_id
      and invoice_type = 'consultation';

  -- Only a CONSULTATION invoice counts as "billed" -- a pharmacy-only
  -- sale against the same patient_id doesn't mean their visit was billed.
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id,
      'name', p.name,
      'phone', p.phone,
      'tokenDate', p.token_date,
      'status', p.status,
      'doctorId', p.doctor_id
    ) order by p.token_date desc, p.created_at desc), '[]'::jsonb)
    into v_unbilled
    from public.patients p
    where p.clinic_id = v_clinic_id
      and p.status in ('waiting', 'in_consult', 'done')
      and not exists (
        select 1 from public.invoices i
        where i.patient_id = p.id and i.invoice_type = 'consultation'
      );

  return jsonb_build_object(
    'totalInvoices', v_total,
    'minInvoiceNumber', v_min,
    'maxInvoiceNumber', v_max,
    'unbilledPatients', v_unbilled
  );
end;
$$;

-- ---------------- 4. slot capacity: only check when entering / moving ----------------
create or replace function public.enforce_slot_capacity()
returns trigger
language plpgsql
as $$
declare
  clinic_row record;
  interval_mins int;
  bucket_start int;
  active_count int;
  lock_key bigint;
begin
  if new.booked_time is null then
    return new;
  end if;

  -- A row that is not (or no longer) active never takes a slot.
  if new.status not in ('booked', 'waiting', 'in_consult') then
    return new;
  end if;

  -- Same doctor, day and time, still active: a status move within the
  -- active set (booked -> waiting -> in_consult) doesn't change slot
  -- occupancy, so it can't be refused because the bucket was already
  -- full or over capacity.
  if tg_op = 'UPDATE'
     and old.status in ('booked', 'waiting', 'in_consult')
     and new.doctor_id = old.doctor_id
     and new.booked_date is not distinct from old.booked_date
     and new.booked_time is not distinct from old.booked_time then
    return new;
  end if;

  select * into clinic_row from public.clinics where id = new.clinic_id;
  interval_mins := greatest(coalesce(clinic_row.slot_interval_mins, 15), 1);
  bucket_start := (
    (extract(hour from new.booked_time)::int * 60 + extract(minute from new.booked_time)::int)
    / interval_mins
  ) * interval_mins;

  lock_key := hashtextextended(
    new.clinic_id::text || ':' || new.doctor_id::text || ':' || new.booked_date::text || ':' || bucket_start::text,
    0
  );
  perform pg_advisory_xact_lock(lock_key);

  select count(*) into active_count
  from public.patients
  where clinic_id = new.clinic_id
    and doctor_id = new.doctor_id
    and booked_date = new.booked_date
    and booked_time is not null
    and status in ('booked', 'waiting', 'in_consult')
    and id is distinct from new.id
    and (
      (extract(hour from booked_time)::int * 60 + extract(minute from booked_time)::int)
      / interval_mins
    ) * interval_mins = bucket_start;

  if active_count >= coalesce(clinic_row.slot_capacity, 1) then
    raise exception 'This time slot just got full — please pick another time.';
  end if;

  return new;
end;
$$;

-- ---------------- 5. re-assign the token when the queue changes ----------------
create or replace function public.reassign_token_on_reschedule()
returns trigger
language plpgsql
as $$
begin
  if new.token_number is not null
     and (new.doctor_id is distinct from old.doctor_id
          or new.token_date is distinct from old.token_date
          or new.type is distinct from old.type) then
    perform pg_advisory_xact_lock(hashtext(new.doctor_id::text || ':' || new.token_date::text)::bigint);

    if new.type = 'walkin' then
      select coalesce(max(token_number), 100000) + 1
      into new.token_number
      from public.patients
      where clinic_id = new.clinic_id
        and doctor_id = new.doctor_id
        and token_date = new.token_date
        and type = 'walkin'
        and id is distinct from new.id;
    else
      select coalesce(max(token_number), 0) + 1
      into new.token_number
      from public.patients
      where clinic_id = new.clinic_id
        and doctor_id = new.doctor_id
        and token_date = new.token_date
        and type = 'appointment'
        and id is distinct from new.id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists patients_reassign_token_on_reschedule on public.patients;
create trigger patients_reassign_token_on_reschedule
  before update of doctor_id, token_date, type on public.patients
  for each row
  execute function public.reassign_token_on_reschedule();

-- ---------------- 6. review link must be an http(s) URL ----------------
alter table public.clinics drop constraint if exists clinics_review_link_url_scheme;
alter table public.clinics
  add constraint clinics_review_link_url_scheme
  check (review_link_url is null or review_link_url ~* '^https?://') not valid;

-- ---------------- 7. update_invoice_payment keeps the stored amount ----------------
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
  v_old_fee_type text;
  v_old_amount numeric(10, 2);
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

  select doctor_id, fee_type, amount into v_doctor_id, v_old_fee_type, v_old_amount
    from public.invoices
    where id = p_invoice_id and clinic_id = v_clinic_id;

  if v_doctor_id is null then
    raise exception 'Invoice not found in this clinic.';
  end if;

  if p_fee_type = 'waived' then
    v_amount := 0;
  elsif p_fee_type = v_old_fee_type then
    -- Same fee type as billed: keep the amount that was charged. Only
    -- switching the fee type reprices, at the doctor's current fee.
    v_amount := v_old_amount;
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

-- ---------------- 8. record_stock_purchase: merged lots keep the earlier expiry ----------------
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
        mrp = case when excluded.mrp > 0 then excluded.mrp else medicine_batches.mrp end,
        -- Lots merged into one batch keep the EARLIER expiry, not the first
        -- receipt's by default: a short-dated lot received under the same (or
        -- blank) batch number must not be sold as if it carried the older
        -- lot's later date.
        expiry_date = case
          when medicine_batches.expiry_date is null then excluded.expiry_date
          when excluded.expiry_date is null then medicine_batches.expiry_date
          else least(medicine_batches.expiry_date, excluded.expiry_date)
        end,
        mfg_date = coalesce(medicine_batches.mfg_date, excluded.mfg_date)
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

-- ---------------- 9. never remove the last active admin ----------------
create or replace function public.guard_last_admin()
returns trigger
language plpgsql
as $$
begin
  -- Direct edits through the API only; security definer functions run as
  -- the owner (platform-level clinic deactivation cascades through those).
  if current_user in ('authenticated', 'anon')
     and old.role = 'admin' and old.is_active
     and (new.role is distinct from 'admin' or not new.is_active) then
    if not exists (
      select 1 from public.profiles
      where clinic_id = old.clinic_id and role = 'admin' and is_active and id <> old.id
    ) then
      raise exception 'A clinic needs at least one active admin.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_last_admin on public.profiles;
create trigger profiles_guard_last_admin
  before update of role, is_active on public.profiles
  for each row
  execute function public.guard_last_admin();

-- ---------------- 10. invoice_date defaults to the India date ----------------
alter table public.invoices alter column invoice_date set default ((now() at time zone 'Asia/Kolkata')::date);
