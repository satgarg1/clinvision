-- ============================================================
-- Fix a real race condition in token number assignment.
--
-- 007_token_numbers.sql's trigger reads `max(token_number) + 1` and
-- writes it in two separate steps with no locking in between. When two
-- bookings for the same doctor/day are inserted close together (two
-- reception tabs, a phone booking landing right as a walk-in is being
-- added, etc.), both transactions can read the same max before either
-- commits, so both compute the same "next" number — two different
-- patients end up with the identical token, which is exactly what was
-- seen live (two of Rajeev Gupta's patients both showing #2).
--
-- Fix: take a transaction-scoped advisory lock keyed on (doctor_id,
-- token_date) before reading the max. The lock forces any concurrent
-- insert for the same doctor/day to wait its turn instead of racing;
-- it's released automatically at the end of the transaction, so it
-- can't be left held by a failed/aborted insert.
--
-- Also adds a unique index as a hard backstop: even if some future
-- code path ever bypasses this trigger, the database itself will
-- refuse to store two patients with the same (doctor, day, token).
-- ============================================================

create or replace function public.assign_token_number()
returns trigger
language plpgsql
as $$
begin
  if new.token_number is null then
    perform pg_advisory_xact_lock(hashtext(new.doctor_id::text || ':' || new.token_date::text)::bigint);

    select coalesce(max(token_number), 0) + 1
    into new.token_number
    from public.patients
    where clinic_id = new.clinic_id
      and doctor_id = new.doctor_id
      and token_date = new.token_date;
  end if;
  return new;
end;
$$;

-- Existing data can already contain the exact duplicate this migration
-- is fixing (that's what triggered writing it), and the unique index
-- below will refuse to create itself while a duplicate exists. This
-- renumbers only the (doctor, day) groups that actually have a
-- collision today — every clean group is left completely untouched —
-- preserving booking order (oldest row keeps the lower number) so the
-- fix is a minimal, order-preserving relabeling, not a reshuffle.
--
-- Note for whoever runs this: any patient already told their token
-- number by SMS/WhatsApp for one of these affected (doctor, day)
-- groups may see a different number on the live queue/display screen
-- after this runs than what they were originally sent. That's an
-- acceptable one-time side effect of deduplicating — there's no way to
-- resolve a genuine duplicate without changing at least one of the two
-- identical numbers.
with dupes as (
  select doctor_id, token_date
  from public.patients
  where token_number is not null
  group by doctor_id, token_date, token_number
  having count(*) > 1
),
affected_groups as (
  select distinct doctor_id, token_date from dupes
),
ranked as (
  select p.id,
         row_number() over (partition by p.doctor_id, p.token_date order by p.created_at, p.id) as rn
  from public.patients p
  join affected_groups g on g.doctor_id = p.doctor_id and g.token_date = p.token_date
)
update public.patients p
set token_number = r.rn
from ranked r
where p.id = r.id;

create unique index if not exists patients_doctor_token_date_number_key
  on public.patients (doctor_id, token_date, token_number);
