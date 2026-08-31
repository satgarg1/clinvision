# Qlinic backlog

Everything pending that isn't tracked anywhere else in the repo. Kept in one file, on GitHub, so it survives across sessions instead of living only in chat history. Add to it as things come up; move an item to "Recently closed out" (or delete it) once it ships.

## Marketing site

- **About us page — real content.** `about-us.html` exists as a placeholder (nav link is live, page just says "still being written"). Needs the real story, mission, values, and team — written to build trust and credibility with a visitor deciding whether to book a demo. Waiting on the actual content, not a design or build blocker.
- **Founder's note**, on `index.html`, placed after the Final CTA band and before the footer — a short first-person "why we built this" note. Needs the founder's own real story/voice; do not draft this unprompted.
- ~~**Login pages: premium redesign**~~ — **DONE**, shipped 2026-08-30. Razorpay-inspired two-pane layout (illustrated left panel, form concentrated on the right) across all four auth pages — login, signup ("Register your clinic"), forgot-password, reset-password — with a bold green "One system for every part of your day." headline on all four. Login gets a gradient-pill phone/email toggle (phone default, wired to a real `email_for_staff_phone` lookup) and a working "remember me" (a real storage adapter on the shared Supabase client, not cosmetic).

## Known bugs

- **Settings page layout flash on refresh** (raised 2026-08-30) — reloading `settings.html` briefly shows the full, un-grouped grid of setting cards, then the layout shifts/collapses into its actual grouped sections a moment later. Reads as broken and draws the eye to it. Not yet diagnosed — likely a client-side render/group-assignment step that runs after first paint; needs the actual grouping logic moved earlier (or the initial paint held back) so there's one correct layout, not two.

## Product features

- **Site-wide translation via a real translation API** (raised 2026-08-31) — a language switch that translates every page (reception, doctor, dashboard, billing, settings, everything, not just the two patient-facing screens below), through an established translation API service, scoped so more languages beyond Hindi can be turned on later without re-architecting. This is a bigger thing than it might look: `display.html` (the waiting-room TV board) and `queue.html` (a patient's own live-status link) already ship a full English/Hindi toggle today, but it's bespoke and narrow — a hand-maintained dictionary of fixed UI strings plus a hand-written phonetic Latin-to-Devanagari transliterator for names/addresses (`toDevanagari`/`HI_WORD_DICT`/`phoneticToDevanagari` in both files), built specifically because those two screens are patient-facing and needed real Hindi rather than a rough machine pass. That approach doesn't scale to the rest of the app (reception's booking form, billing, settings, revenue, etc. — dozens of pages of staff-facing UI text) and doesn't extend to a third language without writing an entirely new dictionary by hand each time. Not scoped yet: which API (Google Cloud Translation vs Azure Translator vs DeepL — cost, quality on Indian-language transliteration of names specifically, and whether it can be called from a static frontend with no server layer beyond Supabase Edge Functions), what gets sent to it (never patient names/phone numbers/addresses to an external API without checking that's acceptable), caching translated strings vs. calling live, and whether the existing bespoke display/queue toggle gets replaced by this or stays as-is since it was purpose-built for exactly those two screens.
- **Real WhatsApp/SMS delivery** — `notifications` table already logs message text but nothing actually sends it. Single biggest concrete gap versus competitor products researched so far (medcore.software, medicore.cc).
- **"You're up soon" proximity alert** (raised 2026-08-30) — a push/SMS notification when a patient is within N people of being seen, instead of them having to keep re-checking their own `queue.html` link. Depends on real SMS/WhatsApp delivery existing first (the item above) — this is really "one more message the same pipeline sends," triggered by queue position crossing a threshold rather than only at booking time. N not yet decided.
- **Phone-in IVR queue-status check** — call a number, hear your queue position via text-to-speech. Aimed at patients without a smartphone or app literacy; not something either researched competitor targets directly.
- **Simple no-show risk flagging** from existing visit history.
- **One-tap post-visit feedback/NPS**, sent via the already-built "visit complete" screen on `queue.html`.
- **Patient recall reminders** for recurring/chronic patients.
- **Recurring/follow-up appointment booking** (raised 2026-08-30) — book a follow-up in one action from an existing patient/appointment ("same time next week," "in 3 months," "in 6 months") instead of rebuilding the booking from scratch each time. Has to check the target date against both `closed-dates.html` (one-off closures) and `doctor-holidays.html` (that specific doctor's own days away) before offering it, and needs a sensible fallback when the computed date lands on either (nearest open day? ask reception to pick?) — not decided yet.
- **Doctor visit note** (raised 2026-08-30) — a lightweight free-text field per visit (diagnosis/prescription notes) on `doctor.html`. Today the doctor side only broadcasts status ("running late," "on a break"); nothing clinical gets recorded anywhere in the product. Not scoped: who else can read it back (just the same doctor, or reception/admin too), whether it's editable after the visit closes, and how it interacts with the ABDM FHIR bundle builder (`supabase/functions/_shared/fhir-bundle.ts`) — a real diagnosis field would materially improve that bundle's content, currently the thinnest part of it.
- **Custom date-picker component**, to replace the native `<input type="date">` used bare across reception booking/queue-filter, closed-dates, doctor-holidays, revenue, no-shows, and billing. Three mockup options were built and shown to the user (a calendar popover, quick-picks + calendar, an always-visible week strip) — waiting on a pick, not built yet.
- **AI summary for Revenue and Analytics pages** — an on-demand summary of the page's data for the selected date range, placed top-right in line with the existing Period selector on `revenue.html` and `trends.html`. Not scoped yet: what triggers generation, what data gets sent, where the call is made from (this is a static/vanilla-JS Supabase app with no server-side function layer today).
- **Visit-history popup during appointment/patient entry** — when reception adds an appointment/walk-in on `reception.html`, show total visit count and the last 3 visits (with dates), plus a link into `patient-directory.html` pre-filtered by phone. `patient-directory.html` already tracks total-visits/last-visit-date as its own dedicated page, and `reception.html`'s booking form already shows a no-show-count warning and a follow-up hint on phone blur — this item is specifically about surfacing the last-3-visits detail inline, in the booking flow itself, without a trip to the directory. Not scoped in detail: exact trigger point, what counts as a "visit," and whether it's skipped for a first-time patient.
- **Clinic accent-color picker** — let each clinic pick a brand color from a fixed, pre-vetted swatch set (not a free picker, to avoid contrast failures). `--accent` in `styles.css` is a single token already threaded sitewide, so this is mostly a token-swap; `--accent-dark` and a couple of hardcoded tints would need a formula per swatch. Deprioritized at the user's request, not rejected.
- **Patient self-service booking/reschedule/cancel + pre-arrival digital consent forms** — explicitly on hold until the current reception/queue flow is proven out; don't build proactively. Needs an assisted/reception fallback whenever it does happen, not an app-only path (a meaningful share of patients, especially elderly ones, aren't comfortable with self-service app flows).
- **Consultation-duration / wait-time estimation, per clinic** — the actual mechanism, spelled out (raised again 2026-08-30 with more detail): record how long each consultation actually runs, tagged with the patient's age and gender at that visit, stored durably enough to aggregate later (a new column or table, not computed on the fly). Once there's enough of it, bucket by age+gender **within each clinic separately** (a fast city clinic and a slower rural one shouldn't share one global average), and use that clinic's own average consultation time × however many patients are ahead of a given token to produce a per-patient ETA. None of the collection or the estimation logic exists yet. Explicit release gate, unchanged: don't ship any time-estimate feature until there's at least 6 months of data from at least 10 clinics.
- **Day/night mode on the waiting-room display screen** (raised 2026-08-31) — `display.html` currently has exactly one look, a fixed dark theme, on purpose: the existing code comment on it explicitly calls this out as a deliberate product choice for a TV/monitor screen, separate from and unaffected by the logged-in app's own day/night toggle (Settings). Making the display board itself switchable means designing a real light variant (background, panel colors, the "all closed"/clinic-closed message panel, the brand mark — which was just given a dark-canvas-only inverted coloring, see the 2026-08-31 fix above, so a light mode would need its own version of that too) and a way to set it (a clinic setting, alongside the existing `display_language`, most likely — not the personal per-device toggle the rest of the app uses, since this screen is shared/unattended). Not scoped beyond that yet.

**Considered and rejected:** waitlist auto-fill for cancelled/no-show slots — doesn't fit Indian clinic behavior (patients overwhelmingly arrive late rather than genuinely no-show, so there's rarely a clean "slot freed up" moment).

**Explicitly out of scope for Qlinic:** EHR/FHIR beyond the ABDM work already shipped, pharmacy/lab modules, IPD/OT scheduling, HR/payroll, AI scribe/radiology AI, insurance/TPA claims, international-patient features — all hospital-scale scope that doesn't fit a solo/small-clinic queue-and-billing tool.

## Rebrand: ClinVision

Name and tagline decided 2026-08-31 (dropped the earlier "Linearr" idea, see the now-superseded item this replaces). Domain and hosting are live; the actual site-wide content swap has not started.

**Decided:**
- Name: **ClinVision** — written "ClinVision" (capital C, capital V) anywhere a person reads it as the brand name (logo, headers, hero copy). Lowercase "clinvision" only in technical strings (domain, email, repo/file names) — that's just standard convention for those, not a separate style choice.
- Tagline: **"Where Clinics Run Better"** — replaces "Time is the one asset nobody gets back" everywhere. Chosen over "Where Best Clinics Begin" (rejected — reads as aimed at clinics *opening*, a small slice of the real buyer, and is vaguer about what the product does). Checked and clean grammatically (plural subject "clinics," correctly unconjugated verb "run," adverb "better" modifying it — no error). Passes the same standing rule as always: must read the same to owner/doctor/staff/patient, never patient-only.
- Trademark: do an exact-match search + get a professional opinion before filing anything — same caution that applied to "Linearr," not yet done for "ClinVision."

**Done:**
- Domain `clinvision.in` registered on Namecheap, DNS pointed at GitHub Pages (4 A records + CNAME), WHOIS-verified, redacted in public lookups, live and serving.
- Repo renamed from `qlinic-prototype` to `clinvision`.

**Hosting decision (2026-08-31):** repo stays **public** for now. GitHub Pages does not serve from a private repository on GitHub's Free plan for a personal account — confirmed the hard way (making the repo private took the live site down; reverted immediately). Plan: upgrade to **GitHub Pro** ($48/year) once there's an active paying clinic — it adds "Pages in private repos," and the deployed site stays public either way, only the source becomes private. A free alternative exists if Pro ever feels like the wrong tradeoff: migrate the deploy target to **Cloudflare Pages** (or Netlify/Vercel), which serves a static site from a private GitHub repo at no cost — not done, since it's real migration work (re-pointing DNS, reconnecting the custom domain), not a toggle.

**Not started — the actual rebrand pass, scoped 2026-08-31:**
- Site-wide swap across every page: "Qlinic" → "ClinVision", the old tagline → "Where Clinics Run Better", remove the clock/circle logo mark. Per the usual convention here — scope → mockup → review → only then touch the real files — this hasn't been mocked up yet.
- **Logo — not designed.** Leading direction: an eye/lens mark (a vesica-shaped aperture outline with a single accent-colored dot at its center) — plays on "Vision," distinct, reads clearly at favicon size the way the current clock mark does. Two alternates considered: an ascending-sightline mark (a rising line ending in a focal dot), and a cross-that-opens-into-a-lens hybrid (weaker — risks reading as a generic medical cross). Full creative brief and an AI-generation prompt for all three were given directly to the user in chat on 2026-08-31, alongside a rendered sketch of all three — not duplicated here in full; ask again if it's needed and not in recent history.

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

## Qlinic subscription billing (Razorpay)

Scoped 2026-08-30, not started — this is Qlinic charging **clinics** for using Qlinic (the SaaS subscription), a completely different thing from `billing.html`/`billing-consultation.html`, which is a clinic billing **its own patients**. Today `clinics.subscription_status` (migration `053_clinic_subscription_status.sql`) is flipped by hand; this feature is what would make that real.

**The one hard rule this is scoped around: Qlinic's own servers/database must never see or store a raw card number, CVV, or full UPI-linked bank credential.** Every approach below routes actual payment-instrument capture through Razorpay's own hosted Checkout, and Qlinic only ever stores the *token* Razorpay hands back — this is both a PCI-DSS requirement and the only realistic path for a static-frontend app with no PCI-scoped infrastructure of its own.

**How saving a payment method actually works:**
1. Admin clicks "Add payment method" in the new Settings page below.
2. Frontend calls a new Edge Function (`razorpay-create-token-order`) that creates a Razorpay Customer (if one doesn't exist yet for this clinic) and a zero/token-amount order server-side, using the Razorpay secret key — which never reaches the browser.
3. Razorpay's own Checkout.js opens (hosted by Razorpay, not Qlinic) with `save=1`, collects the card or UPI details directly, and returns a `token_id`/payment method reference to the frontend.
4. Frontend hands that token to another Edge Function (`razorpay-save-payment-method`), which verifies it server-side against Razorpay's API and stores only the safe-to-keep parts in a new `clinic_payment_methods` table: Razorpay's `customer_id` and `token_id`, the card network + last 4 digits (or masked UPI VPA), and an `is_default`/`autopay_enabled` flag. No PAN, no CVV, ever, at any point, in Qlinic's own database.
5. Recurring charges (autopay) run entirely on Razorpay's side against that stored token, via Razorpay's Subscriptions API (cards) or UPI Autopay/e-mandate (UPI) — Qlinic's backend only reacts to Razorpay's webhooks (`payment.captured`, `subscription.charged`, `subscription.cancelled`, mandate revoked), which is what actually flips `clinics.subscription_status` automatically instead of by hand.

**New backend pieces needed** (same Supabase Edge Functions pattern already used for ABDM, since this static-frontend app has no other place to put server-side code):
- `razorpay-create-token-order` — creates/reuses the Razorpay Customer, returns an order for Checkout to open against.
- `razorpay-save-payment-method` — verifies the returned token server-side, writes the safe fields to `clinic_payment_methods`.
- `razorpay-webhook` — the one public endpoint Razorpay actually calls; validates Razorpay's webhook signature, updates `clinic_payment_methods.autopay_enabled` / `clinics.subscription_status` accordingly.
- `razorpay-remove-payment-method` — cancels the mandate/token on Razorpay's side first, then deletes the local row — never delete-then-cancel, which would leave an orphaned live mandate still capable of charging the clinic.
- Razorpay's key pair lives in Supabase secrets (`RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET`), same as the ABDM bridge credentials — never a database table.

**New UI, per the user's own direction**: a new card on the Settings hub grid, styled with a gradient (like the login page's own gradient pill) rather than the plain white cards the other settings tiles use — "Subscription & Billing" stands out visually as the one settings item that's actually about money, matching how it's treated with more weight than "Appearance" or "Display screen." Opens a new settings sub-page with:
- The current plan/subscription status (reusing `clinics.subscription_status` — active/trialing/suspended, same states `account-suspended.html` already gates on).
- A payment-method card (the "card for payments" — a visual card UI showing the masked card/UPI info, network logo, "Default" badge) once one exists, or an empty state with "Add payment method" when none does.
- Remove — calls `razorpay-remove-payment-method`, cancels on Razorpay's side first.
- An Autopay toggle — enable/disable recurring auto-charge without removing the saved method entirely.

**Explicitly not scoped/started yet**: any actual Razorpay account setup (business KYC, live API keys), the Edge Functions themselves, the `clinic_payment_methods` migration, or the Settings UI build. This is a scope to build from, not a partial build.
