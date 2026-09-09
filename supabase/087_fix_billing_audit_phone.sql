-- ============================================================
-- Qlinic — migration 087: restore phone to the billing audit's
-- unbilled-patient list.
--
-- Real bug found from a live report ("the phone numbers used to show,
-- now every row says —"), same root cause and shape as
-- 079_fix_trial_period.sql's trial_ends_at regression: migration 075
-- (excluding pharmacy invoices from this same audit) redefined
-- get_billing_audit() by copying 045's ORIGINAL body — the one before
-- 046 added phone to the unbilled-patients JSON — instead of 046's own
-- version. 075's own fix (invoice_type = 'consultation' filtering on
-- both the numbering check and the unbilled-patients check) is real
-- and correct and stays; it just silently dropped phone along the way,
-- and every row has shown "—" for it since 075 ran.
--
-- This redefines get_billing_audit() one more time: 075's body,
-- unchanged, with 'phone', p.phone restored to the unbilled-patients
-- jsonb_build_object.
--
-- Run this once in the Supabase SQL Editor, after
-- 086_clinic_activity_signal.sql.
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
    where clinic_id = v_clinic_id
      and invoice_type = 'consultation';

  -- waiting/in_consult/done = actually seen (same definition
  -- getDailySummary and every trends.html chart already use) - a
  -- patient still 'booked' or a 'no_show' was never meant to have an
  -- invoice, so neither belongs on this list. Only a CONSULTATION
  -- invoice counts as "billed" here — a pharmacy-only sale against the
  -- same patient_id doesn't mean their visit was billed.
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
