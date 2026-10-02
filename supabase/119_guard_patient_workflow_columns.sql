-- ============================================================
-- ClinVision, migration 119: staff can no longer write the removal and not-here columns directly.
--
-- Found by the security review after 117 and 118: the patients UPDATE policy lets admin, reception and doctor
-- update any column of their clinic's patients, so a reception or doctor login could call the API directly and
-- set removed_at (hiding a patient everywhere, which is meant to be admin only), or set skipped_at, skip_count,
-- away_seconds or status = 'skipped' on another doctor's patient, or change queue_code.
--
-- A BEFORE UPDATE trigger now refuses those changes for logged-in users (authenticated or anon sessions). The
-- server functions remove_patient_visit, skip_called_patient, undo_not_here and return_skipped_patient run as the
-- database owner, so they pass. The only direct status moves left are the ones the app still makes itself:
-- skipped to no_show (No-show button, closing the day). Platform admins are exempt.
--
-- Safe to run more than once. Run this once in the Supabase SQL Editor, after 118.
-- ============================================================

create or replace function public.guard_patient_workflow_columns()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('authenticated', 'anon') and not public.is_platform_admin() then
    if new.removed_at is distinct from old.removed_at
       or new.removed_by is distinct from old.removed_by
       or new.skipped_at is distinct from old.skipped_at
       or new.skip_count is distinct from old.skip_count
       or new.away_seconds is distinct from old.away_seconds
       or new.queue_code is distinct from old.queue_code then
      raise exception 'That change can only be made through the clinic workflow, not directly.';
    end if;
    if new.status is distinct from old.status
       and (new.status = 'skipped' or (old.status = 'skipped' and new.status <> 'no_show')) then
      raise exception 'A patient is marked not here by the doctor and put back in line by reception.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists patients_guard_workflow_columns on public.patients;
create trigger patients_guard_workflow_columns
  before update on public.patients
  for each row
  execute function public.guard_patient_workflow_columns();

-- Same protection for the removal columns on invoices (there is no update policy today, this keeps it that way).
create or replace function public.guard_invoice_removal_columns()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('authenticated', 'anon') and not public.is_platform_admin() then
    if new.removed_at is distinct from old.removed_at or new.removed_by is distinct from old.removed_by then
      raise exception 'A bill can only be removed together with its patient, by the clinic admin.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists invoices_guard_removal_columns on public.invoices;
create trigger invoices_guard_removal_columns
  before update on public.invoices
  for each row
  execute function public.guard_invoice_removal_columns();
