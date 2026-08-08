-- ============================================================
-- Token numbers — Phase 1 of the public live-queue feature.
--
-- Every booking (walk-in or appointment) gets a token number, assigned
-- the moment they're added — not when reception marks them "arrived."
-- Numbers are per doctor, per day (token_date), starting at 1, so they
-- match the "take a number" mental model patients already expect.
--
-- token_date is separate from booked_date: booked_date is null for
-- walk-ins (existing, appointment-specific meaning used elsewhere) and
-- is always the client's real local "today"/appointment date here, so
-- token numbering never depends on the server's timezone.
--
-- No public page reads any of this yet (that's Phase 2) — this only
-- adds the column, the auto-assignment trigger, and one narrow,
-- anonymous-callable function that returns just a token's own number,
-- position, and the next few tokens ahead of it. Never a patient's
-- name, phone, or address.
-- ============================================================

alter table public.patients add column token_number int;
alter table public.patients add column token_date date not null default current_date;

create or replace function public.assign_token_number()
returns trigger
language plpgsql
as $$
begin
  if new.token_number is null then
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

create trigger patients_assign_token_number
  before insert on public.patients
  for each row
  execute function public.assign_token_number();

-- Anonymous, capability-URL-style lookup: knowing a patient's own
-- (unguessable UUID) id is what authorizes seeing this — no login, no
-- clinic browsing/directory. Returns only a sanitized subset; every
-- other table stays exactly as locked down as it already is.
create or replace function public.get_queue_status(p_patient_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  patient_row record;
  clinic_row record;
  doctor_row record;
  my_position int;
  nearby jsonb;
begin
  select * into patient_row from public.patients where id = p_patient_id;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;

  select * into clinic_row from public.clinics where id = patient_row.clinic_id;
  select * into doctor_row from public.doctors where id = patient_row.doctor_id;

  select count(*) + 1 into my_position
  from public.patients
  where doctor_id = patient_row.doctor_id
    and token_date = patient_row.token_date
    and status = 'waiting'
    and token_number < patient_row.token_number;

  select coalesce(jsonb_agg(t.token_number order by t.token_number), '[]'::jsonb)
  into nearby
  from (
    select token_number
    from public.patients
    where doctor_id = patient_row.doctor_id
      and token_date = patient_row.token_date
      and status = 'waiting'
    order by token_number
    limit 5
  ) t;

  return jsonb_build_object(
    'clinicName', clinic_row.name,
    'doctorName', doctor_row.name,
    'tokenNumber', patient_row.token_number,
    'status', patient_row.status,
    'position', case when patient_row.status = 'waiting' then my_position else null end,
    'nearbyTokens', nearby
  );
end;
$$;

grant execute on function public.get_queue_status(uuid) to anon, authenticated;
