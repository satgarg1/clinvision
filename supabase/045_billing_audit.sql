-- ============================================================
-- Qlinic — migration 045: billing-number coverage check.
--
-- Why: invoice_number is already structurally sound for compliance -
-- clinics.next_invoice_number increments atomically inside a single
-- UPDATE...RETURNING (013_billing.sql, 016_auto_invoice_on_arrival.sql,
-- 031_emergency_fee_auto_invoice.sql all share this pattern), it's
-- unique per clinic (invoices_clinic_number_idx), and there is no
-- delete/void path for an invoice anywhere in this schema - so every
-- number that was ever issued still exists, exactly once. What's
-- actually unprovable without a query is whether every VISIT that
-- should have been billed actually was: auto_create_invoice_on_arrival()
-- silently skips billing (no invoice, counter untouched) when the
-- doctor's fee_normal/fee_emergency was null at the moment a patient
-- arrived. This function surfaces both halves in one call: the number
-- range itself (to show it really is gap-free), and any patient who
-- was actually seen with no invoice on record at all.
--
-- Run this once in the Supabase SQL Editor, after 044_clinic_gstin.sql.
-- ============================================================

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
  v_clinic_id := public.my_clinic_id();

  select count(*), min(invoice_number), max(invoice_number)
    into v_total, v_min, v_max
    from public.invoices
    where clinic_id = v_clinic_id;

  -- waiting/in_consult/done = actually seen (same definition
  -- getDailySummary and every trends.html chart already use) - a
  -- patient still 'booked' or a 'no_show' was never meant to have an
  -- invoice, so neither belongs on this list.
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

grant execute on function public.get_billing_audit() to authenticated;
