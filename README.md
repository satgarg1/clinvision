# Qlinic — Clinic Queue & Billing Management

Qlinic is a clinic queue-management and billing product aimed at clinics in
Tier 2 & Tier 3 India. It gives patients an honest, updating estimate of when
to arrive, keeps the reception desk out of "how much longer" conversations,
lets the doctor broadcast delays with one tap, and handles walk-in/appointment
billing with GST-compliant receipts.

The frontend is plain static HTML/CSS/JS - no build step, no bundler, no
framework. The backend is a real [Supabase](https://supabase.com) project
(Postgres + Auth + Row Level Security), with the ABDM/ABHA integration (see
below) adding a small set of Supabase Edge Functions on top. The site itself
deploys to GitHub Pages.

## Pages

Grouped by who uses them - most pages redirect based on role
(`Qlinic.isAdmin()`/`isDoctor()`), so this is what exists, not what every
signed-in user sees.

**Public / marketing:** `index.html`, `contact.html`, `how-it-works.html`,
`whats-inside.html`, `who-its-for.html`

**Auth:** `login.html`, `signup.html` (real clinic registration, not a demo
account), `forgot-password.html`, `reset-password.html`

**Day-to-day operation:** `dashboard.html` (clinic overview), `reception.html`
(check-in/booking desk), `doctor.html` (a doctor's own queue + full-schedule
modal), `display.html` (waiting-room TV board), `queue.html` (the
patient-facing, unauthenticated live-queue link sent out per booking)

**Billing:** `billing.html`, `billing-consultation.html` (the actual billing
form + printed receipt), `revenue.html`, `billing-audit.html`
(receipt-numbering integrity check)

**Analytics:** `trends.html`

**Settings:** `settings.html` (hub), `clinic-settings.html`,
`manage-doctors.html`, `team.html`, `account-security.html`,
`closed-dates.html`, `doctor-holidays.html`, `patient-directory.html`,
`no-shows.html`, `end-of-day.html`, `patient-breakdown.html` (every
Dashboard/Doctor-View "view all" link lands here, one page instead of a
near-identical one per metric)

## Running it locally

Still no build step for the frontend - it's plain HTML/CSS/JS. Serve the
folder with any static file server and open `index.html`:

```bash
npx serve .
```

You'll need your own Supabase project's URL/anon key in `clinic-config.js`
(see below) for anything past the login screen to work - there's no demo
account or mock data mode.

## How the backend works

`clinic-config.js` holds two public values from your Supabase project
(Project Settings → API): `SUPABASE_URL` and `SUPABASE_ANON_KEY`. The anon
key is meant to be public - real security comes from Postgres Row Level
Security policies (`supabase/schema.sql` + every numbered migration after
it), not from keeping that key secret.

`clinic-data.js` exposes a `window.Qlinic` global with async functions like
`addAppointment`, `markArrived`, and `setDoctorStatus` - every page loads
`clinic-config.js` then `clinic-data.js?v=N` and calls into that global.
State lives in Postgres, scoped per clinic via RLS (`clinic_id =
my_clinic_id()`), not in `localStorage` - it's shared across every device
(reception desk, doctor, waiting-room display) that's signed in to the same
clinic.

`clinic-data.js` and `styles.css` are cache-busted by hand: every HTML page
that loads them does `clinic-data.js?v=N` / `styles.css?v=N`, and that `N`
gets bumped across **every referencing page** whenever the file changes -
there's no bundler to do this automatically. `supabase/*.sql` files are
migrations, numbered in the order they were written; each one is run by hand
once in the Supabase SQL Editor (not via the CLI's own migration tooling) -
never edit a migration that's already shipped, always add a new numbered one.

## ABDM/ABHA integration - a second, separate deploy path

`supabase/functions/` (added for ABDM/ABHA integration - see
`plans/robust-questing-walrus.md` for the full scope) is **not** part
of the static-site deploy above. Every other change in this repo ships
by editing a file, bumping its cache-bust `?v=N` if it's a shared
file, and pushing to `main` - GitHub Pages builds the rest
automatically. Edge Functions don't work that way:

- They require the [Supabase CLI](https://supabase.com/docs/guides/cli)
  installed locally, and `supabase link` run once against this
  project.
- A change to any file under `supabase/functions/` is **invisible**
  until someone runs `supabase functions deploy <function-name>` by
  hand - `git push` alone does not ship it, and there is no CI/CD here
  automating that step.
- The ABDM bridge's `clientId`/`clientSecret` (one pair for the whole
  Qlinic vendor bridge, not per-clinic) and related config live in
  Edge Function secrets, set via:
  ```bash
  supabase secrets set ABDM_CLIENT_ID=... ABDM_CLIENT_SECRET=... \
    ABDM_BASE_URL=https://dev.abdm.gov.in/gateway ABDM_MOCK=true
  ```
  never in `clinic-config.js` or any database table - unlike the
  Supabase anon key (deliberately public, protected by RLS), these are
  genuinely sensitive and only ever injected into the Edge Functions
  runtime.
- `ABDM_MOCK=true` (the default) makes every function's logic
  exercisable without live ABDM sandbox credentials - real network
  calls to ABDM only happen once that flag is explicitly set to
  `false`, which itself requires the external NHA bridge registration
  described in the plan.

## What's still missing

- Real SMS/WhatsApp delivery to patients - the `notifications` table logs
  message text today, nothing actually sends it. This also blocks ABDM's
  OTP-based care-context linking flow (`hip-link-init`/`hip-link-confirm`),
  which needs a real channel to get an OTP to a patient.
- ABDM Milestone D (real sandbox wiring, live `ABDM_MOCK=false` traffic) -
  blocked on completing NHA's bridge registration, which only the clinic's
  own business entity can do (see `plans/robust-questing-walrus.md`).
- M3 (HIU - pulling other providers' records into Qlinic) and M4 (NHCX
  insurance claims) aren't planned - they don't fit a queue/billing tool's
  job.
