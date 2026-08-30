# Qlinic backlog

Everything pending that isn't tracked anywhere else in the repo. Kept in one file, on GitHub, so it survives across sessions instead of living only in chat history. Add to it as things come up; move an item to "Recently closed out" (or delete it) once it ships.

## Marketing site

- **About us page — real content.** `about-us.html` exists as a placeholder (nav link is live, page just says "still being written"). Needs the real story, mission, values, and team — written to build trust and credibility with a visitor deciding whether to book a demo. Waiting on the actual content, not a design or build blocker.
- **Founder's note**, on `index.html`, placed after the Final CTA band and before the footer — a short first-person "why we built this" note. Needs the founder's own real story/voice; do not draft this unprompted.
- **Login pages: premium redesign**, Razorpay-inspired. Scope: right-concentrated layout (login/register/forgot-password/reset-password all move their form onto the right side of the page, with an animated/illustrated left side), a gradient-pill email/phone toggle on login (phone default), a working "remember me", and login-with-phone as a real option. In progress as of 2026-08-30: the per-staff phone field (Settings → Team) is built and live; the login page's own two-pane redesign is still in mockup review (green "One system for every part of your day." headline, no clock/rotating claim), not yet built into the real site. Once approved, the same layout extends to signup/forgot-password/reset-password.

## Known bugs

- **Settings page layout flash on refresh** (raised 2026-08-30) — reloading `settings.html` briefly shows the full, un-grouped grid of setting cards, then the layout shifts/collapses into its actual grouped sections a moment later. Reads as broken and draws the eye to it. Not yet diagnosed — likely a client-side render/group-assignment step that runs after first paint; needs the actual grouping logic moved earlier (or the initial paint held back) so there's one correct layout, not two.

## Product features

- **Real WhatsApp/SMS delivery** — `notifications` table already logs message text but nothing actually sends it. Single biggest concrete gap versus competitor products researched so far (medcore.software, medicore.cc).
- **Phone-in IVR queue-status check** — call a number, hear your queue position via text-to-speech. Aimed at patients without a smartphone or app literacy; not something either researched competitor targets directly.
- **Simple no-show risk flagging** from existing visit history.
- **One-tap post-visit feedback/NPS**, sent via the already-built "visit complete" screen on `queue.html`.
- **Patient recall reminders** for recurring/chronic patients.
- **Custom date-picker component**, to replace the native `<input type="date">` used bare across reception booking/queue-filter, closed-dates, doctor-holidays, revenue, no-shows, and billing. Three mockup options were built and shown to the user (a calendar popover, quick-picks + calendar, an always-visible week strip) — waiting on a pick, not built yet.
- **AI summary for Revenue and Analytics pages** — an on-demand summary of the page's data for the selected date range, placed top-right in line with the existing Period selector on `revenue.html` and `trends.html`. Not scoped yet: what triggers generation, what data gets sent, where the call is made from (this is a static/vanilla-JS Supabase app with no server-side function layer today).
- **Visit-history popup during appointment/patient entry** — when reception adds an appointment/walk-in on `reception.html`, show total visit count and the last 3 visits (with dates), plus a link into `patient-directory.html` pre-filtered by phone. Not scoped in detail: exact trigger point, what counts as a "visit," and whether it's skipped for a first-time patient.
- **Clinic accent-color picker** — let each clinic pick a brand color from a fixed, pre-vetted swatch set (not a free picker, to avoid contrast failures). `--accent` in `styles.css` is a single token already threaded sitewide, so this is mostly a token-swap; `--accent-dark` and a couple of hardcoded tints would need a formula per swatch. Deprioritized at the user's request, not rejected.
- **Patient self-service booking/reschedule + pre-arrival digital consent forms** — explicitly on hold until the current reception/queue flow is proven out; don't build proactively. Needs an assisted/reception fallback whenever it does happen, not an app-only path (a meaningful share of patients, especially elderly ones, aren't comfortable with self-service app flows).
- **Consultation-duration / wait-time estimation by age bucket** — track actual consultation duration, bucketed by patient age, toward eventually predicting wait time. Explicit release gate: don't ship any time-estimate feature until there's at least 6 months of data from at least 10 clinics.

**Considered and rejected:** waitlist auto-fill for cancelled/no-show slots — doesn't fit Indian clinic behavior (patients overwhelmingly arrive late rather than genuinely no-show, so there's rarely a clean "slot freed up" moment).

**Explicitly out of scope for Qlinic:** EHR/FHIR beyond the ABDM work already shipped, pharmacy/lab modules, IPD/OT scheduling, HR/payroll, AI scribe/radiology AI, insurance/TPA claims, international-patient features — all hospital-scale scope that doesn't fit a solo/small-clinic queue-and-billing tool.

## ABDM / ABHA integration

Milestones A–C (schema, HFR/HPR capture, FHIR bundle builder, 7 Edge Functions) are built and deployed, running in `ABDM_MOCK=true`. Full technical plan lives in `plans/robust-questing-walrus.md`.

**Milestone D (real sandbox wiring) is blocked entirely on steps outside this codebase**, in order:
1. Register the company legally — current blocker as of 2026-08-28.
2. Register at sandbox.abdm.gov.in for a `clientId`/`clientSecret` (NHA typically replies in 3–4 days).
3. Functional testing against NHA's published test cases, via an empaneled agency (FIME India, Suma Soft, or Tata Communications) — paid.
4. A "Safe-to-Host" security certificate from an STQC/CERT-IN empaneled auditor — paid.
5. NHA final review (administrative, not a code review).
6. Production access. Realistic timeline: 12–20 weeks end to end.

Leaning toward using a third-party ABDM integration partner for the certification process itself rather than doing it in-house — it's a one-time compliance hurdle, not an area where in-house expertise compounds. The Milestone A–C code stays useful either way.

## Under consideration, not decided

- **Rebrand to "Linearr"** (LINE + ARR(ival)) — checked available in trademark classes 9, 42, 44, and the domain is free, but only via an imprecise "contains" search; needs an exact-match search and a professional opinion before filing anything. Current tagline ("Time is the one asset nobody gets back") is considered strong enough to keep through a rename. If a new tagline is wanted, the leading candidate is "Everyone's day, in order." Any positioning copy must serve clinic owner, doctor, staff, and patient roughly equally — never read as patient-only.
