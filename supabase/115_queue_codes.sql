-- ============================================================
-- ClinVision, migration 115: a short, neutral code for each patient's queue link.
--
-- The patient queue link used to carry the patient's database id:
--   https://clinvision.in/queue.html?id=563fef8e-ce18-4808-8ea8-dd3f29c81654
-- Each patient now also gets a random 10 character code (letters and digits, no look alike
-- characters), sent as https://clinvision.in/q/K7M2X9QD4F . The code is only a way to find the
-- visit; the database id is never shown in the link.
--
-- Old links that carry the id keep working exactly as before. Nothing about who can see what
-- changes: the code, like the id before it, opens only that one patient's queue page.
--
-- Safe to run more than once. Run this once in the Supabase SQL Editor, after 114.
-- ============================================================

create or replace function public.generate_queue_code()
returns text
language plpgsql
volatile
as $$
declare
  -- 31 characters: no 0, 1, I, L or O, so a code read aloud or typed from a screenshot is not mistaken.
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_bytes bytea := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
  v_code text := '';
  v_i int;
begin
  -- Bytes 6 and 8 of a v4 uuid carry fixed version bits, so they are skipped.
  for v_i in 0..15 loop
    continue when v_i in (6, 8);
    exit when length(v_code) >= 10;
    v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, v_i) % 31) + 1, 1);
  end loop;
  return v_code;
end;
$$;

alter table public.patients add column if not exists queue_code text;

-- Existing patients get a code too, so links sent from now on work for old visits as well.
update public.patients set queue_code = public.generate_queue_code() where queue_code is null;

alter table public.patients alter column queue_code set default public.generate_queue_code();
alter table public.patients alter column queue_code set not null;
create unique index if not exists patients_queue_code_key on public.patients (queue_code);

-- Turns a code from a link into the visit it belongs to. Open to anyone with the link (the
-- patient is not logged in), and returns nothing for a code that does not exist.
create or replace function public.resolve_queue_code(p_code text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.patients
  where queue_code = upper(trim(coalesce(p_code, '')))
  limit 1;
$$;

grant execute on function public.resolve_queue_code(text) to anon, authenticated;
