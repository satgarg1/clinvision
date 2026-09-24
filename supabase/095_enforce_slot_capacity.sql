-- ============================================================
-- Close the slot-capacity race condition.
--
-- countActiveAtSlot() in clinic-data.js reads the current count for a
-- slot bucket, the caller decides the slot has room, then inserts —
-- classic read-then-write race: two bookings for the same doctor/date/
-- time bucket submitted within the same instant can both pass the
-- client-side check and both insert, exceeding clinic.slot_capacity.
--
-- Same class of bug 007_token_numbers.sql already closes for token
-- numbers (an atomic before-insert trigger instead of a client-side
-- read-then-write), applied here to slot capacity. An advisory lock
-- keyed on (clinic, doctor, date, bucket) serializes concurrent
-- inserts/updates into the same slot within one transaction, so the
-- capacity check and the row it's guarding can never race.
-- ============================================================

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

-- "update of ..." only fires when one of these columns is part of the
-- UPDATE's SET list, so a plain name/phone/address edit (updatePatientContact
-- with no reschedule) or an arrived_at-only write never takes the lock.
-- Status transitions OUT of the active set (done/no_show) still fire this,
-- but always pass: the check excludes the row's own id, so a row leaving
-- the active set can never be blocked by the count it's no longer part of.
drop trigger if exists patients_enforce_slot_capacity on public.patients;
create trigger patients_enforce_slot_capacity
  before insert or update of doctor_id, booked_date, booked_time, status on public.patients
  for each row
  execute function public.enforce_slot_capacity();
