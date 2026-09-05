-- ============================================================
-- Qlinic — migration 075: exclude pharmacy invoices from the
-- billing-numbering audit.
--
-- get_billing_audit() (045_billing_audit.sql) checks that
-- invoice_number forms one gap-free 1..N run per clinic — true when
-- every invoice was a consultation, sharing one counter
-- (next_invoice_number). Now that pharmacy invoices exist on their own
-- separate counter (next_pharmacy_invoice_number, 066_pharmacy_invoices.sql)
-- but the SAME invoices table, this function's count(*)/min/max query
-- silently mixes both sequences together — a clinic with 50
-- consultation invoices and 10 pharmacy ones would show count=60,
-- min=1, max=50, and get flagged as having "gaps" that don't actually
-- exist. The unbilled-patients check has the opposite failure mode: a
-- patient who only bought medicine (a pharmacy invoice, no consultation
-- bill) would wrongly count as "billed" and hide a real missing
-- consultation invoice. Same root cause as the Revenue/Insights leak
-- fixed alongside this in clinic-data.js — this audit is about
-- consultation billing integrity specifically, not pharmacy sales.
--
-- Run this once in the Supabase SQL Editor, after 074_auto_close_previous_day.sql.
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
