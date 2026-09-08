-- ============================================================
-- Qlinic — migration 084: platform admin panel, part C.
--
-- Four pieces, three of them reading data that already exists (nothing
-- new is collected by this migration, only a way for a platform admin
-- to see it):
--   1. admin_get_clinic_team() — a clinic's own staff roster (name,
--      email, role), for the manage-clinic popover's new Team section.
--      Headcount is just the length of this list client-side, no
--      separate query.
--   2. admin_get_clinic_patient_volume() — booked vs seen counts for
--      one clinic over a date range, same shape as the per-doctor
--      numbers getDailySummary() already computes client-side for a
--      clinic's own dashboard, just run server-side across an
--      arbitrary clinic and period instead of "today, my own clinic."
--   3. admin_list_contact_enquiries()/admin_set_enquiry_status() —
--      contact_enquiries (061_contact_enquiries.sql) has had zero
--      select policy since it was created, with a comment literally
--      saying this waits on "the Platform admin panel... with its own
--      is_platform_admin() gate." This is that.
--   4. admin_list_product_feedback() — product_feedback
--      (058_product_feedback.sql) is, by design, unreadable through
--      the normal app connection even by the clinic that generated it
--      ("the data belongs to ClinVision, not the clinic") — a
--      platform admin is the one reader this table was always meant
--      to eventually have.
--
-- All four are is_platform_admin()-gated, security definer, same shape
-- as every other admin_* function in this series.
--
-- Run this once in the Supabase SQL Editor, after
-- 083_clinic_feature_flags.sql.
-- ============================================================

-- ---------------- 1. clinic team roster ----------------
create or replace function public.admin_get_clinic_team(target_clinic_id uuid)
returns table (id uuid, full_name text, email text, role text, is_active boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Not authorized.';
  end if;
  return query
    select p.id, p.full_name, p.email, p.role, p.is_active
    from public.profiles p
    where p.clinic_id = target_clinic_id
    order by p.role, p.full_name;
end;
$$;

grant execute on function public.admin_get_clinic_team(uuid) to authenticated;

-- ---------------- 2. clinic patient volume ----------------
-- p_start/p_end null means unbounded on that side ("All time" from the
-- same PERIOD_PRESETS list patient-directory.html already uses).
-- "Booked" counts every visit whose booked_date (appointments) or
-- created_at::date (walk-ins) falls in range; "seen" is the same set
-- narrowed to status = 'done' -- matches getDailySummary()'s own
-- totalBookedToday/doneCount split, just over a range instead of one day.
create or replace function public.admin_get_clinic_patient_volume(
  target_clinic_id uuid, p_start date default null, p_end date default null
)
returns table (booked_count int, seen_count int)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Not authorized.';
  end if;
  return query
    select
      count(*)::int,
      count(*) filter (where status = 'done')::int
    from public.patients
    where clinic_id = target_clinic_id
      and (p_start is null or coalesce(booked_date, created_at::date) >= p_start)
      and (p_end is null or coalesce(booked_date, created_at::date) <= p_end);
end;
$$;

grant execute on function public.admin_get_clinic_patient_volume(uuid, date, date) to authenticated;

-- ---------------- 3. contact/enquiry inbox ----------------
create or replace function public.admin_list_contact_enquiries()
returns table (
  id uuid, created_at timestamptz, name text, phone text,
  clinic_type text, clinic_name text, city text, message text, status text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Not authorized.';
  end if;
  return query
    select e.id, e.created_at, e.name, e.phone, e.clinic_type, e.clinic_name, e.city, e.message, e.status
    from public.contact_enquiries e
    order by e.created_at desc;
end;
$$;

grant execute on function public.admin_list_contact_enquiries() to authenticated;

create or replace function public.admin_set_enquiry_status(target_id uuid, new_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Not authorized.';
  end if;
  if new_status not in ('new', 'contacted', 'closed') then
    raise exception 'Invalid status.';
  end if;
  update public.contact_enquiries set status = new_status where id = target_id;
end;
$$;

grant execute on function public.admin_set_enquiry_status(uuid, text) to authenticated;

-- ---------------- 4. product feedback (ClinVision's own, not the clinic's) ----------------
create or replace function public.admin_list_product_feedback()
returns table (
  id uuid, clinic_name text, patient_name text, rating int,
  feedback_text text, submitted_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Not authorized.';
  end if;
  return query
    select f.id, c.name, p.name, f.rating, f.feedback_text, f.submitted_at
    from public.product_feedback f
    join public.clinics c on c.id = f.clinic_id
    join public.patients p on p.id = f.patient_id
    order by f.submitted_at desc;
end;
$$;

grant execute on function public.admin_list_product_feedback() to authenticated;
