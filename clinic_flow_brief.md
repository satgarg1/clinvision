---
title: "Intelligent Clinic Flow Management Platform"
subtitle: "Strategic Product Brief — Critique, Workflows & Feature Roadmap"
author: "Prepared for Satyam Garg"
date: "August 2026"
---

*Revision note: This version reflects the MVP scope decision made after initial review — check-in is receptionist-mediated (name search, not QR/self-service) for v1, with automatic no-show marking added to the MVP. See Sections 1, 3, 4, and 8–9.*

\newpage

# 0. Reframing the Opportunity

The instinct to avoid building "another appointment booking app" is correct, and it should be sharpened further: booking is a commodity in India's clinic software market. Practo Ray, HealthPlix, Cliniqwise, MocDoc, Doccure and a dozen others already sell scheduling, EMR and billing. None of them are trusted for the thing that actually determines whether a Tier 2/3 clinic runs smoothly on a Tuesday afternoon: **who goes in next, how long everyone else waits, and who tells them so.**

The product this brief argues for is not a scheduling tool with a queue feature bolted on. It is a **flow-orchestration engine** — appointments and walk-ins are just two ways data enters it, and SMS/WhatsApp/screens are just two ways its output leaves it. Booking, EMR, and billing can be thin or even absent in v1; the queue engine and communication layer are the product.

# 1. Critique of the Business Idea

**What is right.** The diagnosis — patients want transparency, not zero wait — is accurate and matches decades of queueing-psychology research (perceived wait matters more than actual wait; uncertain waits feel longer than explained waits). Scoping the product around the full journey rather than a single feature is also right, because the pain points are inter-dependent: a receptionist who spends her day answering "how much longer" cannot also manage the queue well, and a doctor who has no visibility into the queue cannot communicate delays even if he wanted to.

**Where the thinking needs to be challenged, before a line of code is written:**

**Booking-app framing invites the wrong comparison.** If this is pitched or built as "online appointment booking for clinics," it will be evaluated against Practo, Justdial, and every EMR vendor's built-in scheduler — a category where price competition is brutal and switching costs for clinics are already sunk. It needs to be pitched and demoed as queue and delay intelligence, with booking as a side effect.

**"Live queue visibility" assumes uniform digital access that Tier 2/3 India does not have.** A meaningful share of patients in these markets are older, less smartphone-literate, on shared family phones, or simply prefer a phone call. A pure app/web queue view will under-serve exactly the population the brief says it wants to help. The system needs a **no-smartphone-required path** — SMS, a missed-call-to-check-status IVR, or a simple WhatsApp message — as a first-class channel, not an afterthought.

**Precise transparency can backfire worse than vague transparency.** Promising "you are 4th in line, ~25 minutes" and then missing it by 40 minutes because a consultation ran long generates more anger than never giving a number at all, because it reads as a broken promise rather than an unpredictable event. The product needs to manage a **confidence band**, not a false-precision countdown, and must communicate proactively when the estimate itself changes — silence after a promise is the actual trust-killer, not the wait itself.

**Doctors are the hardest user to onboard, and "transparency" sounds like surveillance to them.** A dashboard that shows an owner or a patient "Dr. Sharma is running 35 minutes behind" is, from the doctor's chair, a public scoreboard of his lateness. Doctors — especially senior ones who are often the clinic's core asset and sometimes a part-owner — will resist a tool that makes their pace visible unless it also visibly reduces their own friction (fewer interruptions, one-tap delay broadcast instead of a nurse knocking every ten minutes, a clean view of who's actually waiting versus who left). Doctor-side UX has to feel like it *serves* the doctor first; transparency to patients is a byproduct.

**The buyer, the configurator, and the beneficiary are three different people, and only one of them pays.** The clinic owner buys; the receptionist operates the system daily and will make or break adoption; the patient benefits but never opens a wallet. Anthropic's own analogy aside, this is a classic enterprise-software trap: teams that design for the end-beneficiary's delight (patient) while under-designing for the operator's daily friction (receptionist) end up with a product that patients like and receptionists quietly abandon within three months. The receptionist's daily task list has to get *shorter*, not just better-informed, or she will revert to the register and a shouted token number.

**The walk-in vs. appointment collision is the real unsolved problem — a queue display just makes today's chaos visible faster.** Most Indian clinics run a hybrid model: scheduled patients expect to be seen near their slot, walk-ins expect "first come first served," and both groups show up in the same waiting room. A digital token number does nothing by itself to resolve *whose* turn it actually is when a scheduled patient arrives 20 minutes into a walk-in-heavy morning. This sequencing logic — not the display screen — is the hardest and most valuable part of the build, and it deserves the most design attention, not the least. *(Update: an MVP-level rule for this is now defined in Sections 8–9 — appointment patients queue at their booked slot time adjusted for the day's accumulated delay, walk-ins queue by arrival order, interleaved by adjusted time. This still needs pressure-testing against a real clinic's Tuesday morning before it's trusted.)*

**There is no revenue-linked feature yet, which makes this a "nice to have," not a "must buy."** Reduced patient frustration is real value but is difficult for an owner to attach a rupee figure to when deciding whether to spend ₹3,000–₹8,000/month (current market range for small-clinic software in India). The pitch becomes far stronger once it includes features owners can size financially: fewer no-shows (deposit/confirmation nudges), more patients seen per day (less idle doctor time between patients), reduced receptionist headcount need, and government incentive capture (see Section 11 — ABDM/ABHA linkage pays clinics per registration).

**Data trust and compliance are not optional in 2026 India.** Health data is sensitive personal data under the Digital Personal Data Protection Act, 2023, and the government's Ayushman Bharat Digital Mission (ABDM) is moving from voluntary to effectively mandatory: over 2.5 lakh facilities were already using ABDM-enabled software as of March 2026, and full compliance is expected to be required industry-wide by 2027, with direct financial incentives (₹20 per ABHA-linked OPD registration, up to ₹4 lakh per facility under the Digital Health Incentive Scheme) for facilities that integrate. A platform that ignores ABHA/ABDM from the architecture stage will need a costly retrofit later, and misses a concrete near-term selling point now.

# 2. Hidden Problems Not Yet Considered

Several operational realities sit underneath the stated problem and will break a naive implementation if not designed for from day one.

**Consultation-time variance is the actual hard prediction problem.** A "10 minutes per patient" average is meaningless when a diabetic follow-up takes 4 minutes and a new complex case takes 25. Wait-time predictions built on a flat average will be wrong often enough to erode trust quickly. The estimator needs to learn per-doctor, per-visit-type patterns over time, and must be honest about its own uncertainty rather than presenting a single confident number.

**Multi-doctor, multi-room clinics fragment the queue.** Many Tier 2/3 clinics have two or three doctors, sometimes across specialties, sometimes sharing a single waiting area. A single linear queue does not model this — the system needs per-doctor sub-queues with a shared physical waiting-room display, and needs to handle a patient who is "waiting for whichever of two doctors is free first."

**Emergency and priority cases must jump the queue without breaking trust for everyone else.** A walk-in with chest pain or a child with a high fever cannot wait behind twelve scheduled tokens. The system needs an explicit, visible, justified priority-override mechanism — invisible overrides are the fastest way to make the rest of the queue believe the system is rigged or broken.

**Queue-jumping, proxy tokens, and "one token, whole family" are real behaviors, not edge cases.** Patients hand a token to a relative, book a slot and bring three family members who all expect to be seen, or leave the waiting room and return expecting their place held. The system needs rules (and receptionist override tools) for token transfer, multi-patient bookings, and "away from waiting room" grace periods.

**Connectivity and power are not guaranteed in Tier 2/3 locations.** A cloud-only architecture that goes blind during a power cut or a patchy mobile-data afternoon will lose exactly the trust it's trying to build. The reception-side application and waiting-room display need to degrade gracefully offline (local queue state cached, sync on reconnect) rather than freezing.

**Change management for receptionists is a bigger risk than the software itself.** Many receptionists in these clinics run the front desk on a paper register and instinct built over years. A system that requires significant retraining, or that is slower than the register for the first two weeks, will be rejected regardless of its long-run value. Onboarding design (not just product design) is a first-order requirement.

**Doctors go missing mid-day — late arrival, an emergency call, a lunch break, an early departure — and the system has to represent that honestly.** Without a "doctor status" concept (running late / on break / left for the day / in emergency), the queue will keep promising times against a doctor who isn't in the building.

**Downstream handoffs extend beyond the consultation room.** Many visits end with a trip to an in-house pharmacy, a lab, or a billing counter before the patient actually leaves. If the product's notion of "done" stops at the consultation, it undercounts the real bottleneck and the real total wait the patient experiences.

**Multi-location ambition changes the data model.** If the eventual customer is a small chain (2–5 branches, increasingly common in Tier 2/3 as successful solo clinics expand), owner-level reporting and cross-branch doctor scheduling need to be planned for structurally now, even if not built in v1.

**Language and literacy diversity is the norm, not the exception**, across Hindi, regional languages, and English, often within the same waiting room and sometimes within the same family. Every patient-facing message needs to work in at least the dominant regional language plus Hindi and English, and should assume some patients cannot read at all — audio/IVR fallback matters here too.

# 3. Patient Journey Map

| Stage | Current Experience | Pain Points | Platform Intervention |
|---|---|---|---|
| Discovery & Booking | Phone call to clinic, or walk in without any booking | No visibility into doctor's schedule or expected load that day | WhatsApp/web link booking with no app download; shows realistic same-day load ("Dr. Rao is running near normal today") |
| Pre-Visit | Patient guesses when to leave home; usually arrives far too early "to be safe" | Wasted time, unnecessary travel during peak hours | Predicted-turn window sent morning-of and updated once queue is live; "leave home by" nudge |
| Arrival & Check-in | Tells name to receptionist, asks "when will my number come," waits to be manually logged | Queue jumps if receptionist is distracted; no confirmation patient is "in" | Receptionist searches the patient's name (as she already does today), taps "arrived" — patient is instantly slotted into the queue at their booked-time-adjusted-for-delay position, with confirmation shown on screen |
| Waiting | Sits in waiting room, periodically asks "how much longer" | Anxiety from uncertainty; repeated interruptions to reception | Live position + confidence-band ETA on screen/phone; proactive delay alerts if estimate shifts >10 min |
| Consultation | Enters when called, sometimes after being told wrong number/name | Occasional mix-ups, especially with common names | Digital token + name + photo-less ID match at the door reduces call errors |
| Post-Consultation | Pays at counter, may need lab/pharmacy, unclear where to go next | Second queue with no visibility, same anxiety repeats | Guided next-step ticket (pharmacy/lab token issued automatically, own mini-queue) |
| Follow-up & Retention | No structured reminder for follow-up visits or chronic-care check-ins | Missed follow-ups hurt patient outcomes and clinic revenue | Automated WhatsApp/SMS recall for follow-ups, prescriptions due, chronic-care check-ins |

# 4. Receptionist Workflow Map

| Stage | Current Workflow | Pain Points | Platform Intervention |
|---|---|---|---|
| Day Start | Manually reviews appointment register/diary, preps token slips | Time-consuming, error-prone, no unified view of appointments + expected walk-ins | Single dashboard: today's appointments, historical walk-in pattern, doctor availability |
| Check-in Handling | Logs each patient by hand or basic software, juggles phone calls simultaneously | Constant context-switching; phone and desk queue compete for attention | Same behavior as today — patient states name, receptionist finds them — but it's a name/phone search plus a single "mark arrived" tap instead of a paper lookup, so it's faster than the register from day one and needs no patient-side app or QR |
| Merging Walk-ins + Appointments | Mentally interleaves both queues, often ad hoc | Perceived unfairness, arguments over "whose turn" | Rules-based unified queue (appointment-priority window + walk-in slots) visible to receptionist and adjustable manually |
| Answering Patient Queries | Repeatedly asked "how long," pulled away from other tasks | Major time sink, main source of daily frustration cited in the brief | Patients self-check status via phone/display; receptionist queries drop to near zero |
| Doctor Coordination | Walks to consultation room or calls doctor to check on progress/delays | Interrupts doctor, awkward for both parties | Doctor updates own status (one tap: "running late," "on break"); receptionist and patients see it instantly |
| Billing & Handoff | Manual billing, unclear referral to pharmacy/lab | Slower checkout, patient uncertainty on what's next | Integrated billing trigger + auto-generated next-step token |
| Day Close | Manually tallies patients seen, no-shows, revenue | No structured data for owner reporting | Auto-generated daily summary (footfall, no-shows, average wait, revenue) |

# 5. Doctor Workflow Map

| Stage | Current Workflow | Pain Points | Platform Intervention |
|---|---|---|---|
| Day Start | Arrives, has no visibility into total expected load or mix of walk-ins/appointments | Cannot plan pacing for the day | Simple pre-clinic summary: total booked, typical walk-in volume, any flagged priority cases |
| Between Patients | Buzzer/shout system or manual call for next patient | No visibility into who's actually next or waiting | One-tap "next patient" pulls the correct name per queue rules, no manual decision needed |
| Handling Delays | No way to communicate a delay without a staff member relaying it | Patient frustration is blamed on the doctor even when unavoidable (e.g., emergency case) | One-tap delay broadcast ("running ~20 min behind") sent to all waiting patients automatically |
| Emergencies / Breaks | Steps away with no system awareness | Queue keeps counting against an absent doctor, promises break | Doctor sets status (break/emergency/back-in-X-mins); queue and patient messages adjust automatically |
| End of Day | No structured record of pacing, delays, or patient load for reflection | No feedback loop to improve day-to-day operations | Simple end-of-day view: patients seen, average consult time, delay incidents — for the doctor's own reference, not a public scoreboard |

# 6. Consolidated Pain Point Inventory (Ranked by Impact)

| Rank | Pain Point | Who Feels It Most | Root Cause |
|---|---|---|---|
| 1 | Repeated "how much longer" questions | Receptionist (time), Patient (anxiety) | No self-serve visibility into queue status |
| 2 | Walk-in vs. appointment conflict | Receptionist, Patient | No agreed, visible sequencing rule |
| 3 | No delay communication path | Doctor, Patient | No lightweight way for doctor to broadcast status |
| 4 | Wasted patient time from early arrival | Patient | No pre-visit ETA before leaving home |
| 5 | Manual, error-prone check-in and logging | Receptionist | No digital check-in / unified register |
| 6 | No visibility into doctor's real-time status (break, emergency, running late) | Receptionist, Patient | Queue system has no concept of doctor state |
| 7 | Missed follow-ups and chronic-care check-ins | Clinic revenue, Patient outcomes | No automated recall system |
| 8 | No owner-level operational data (footfall, no-shows, wait trends) | Clinic Owner | No reporting layer over daily operations |
| 9 | Queue-jumping / proxy tokens / family-of-one-token | Receptionist, other waiting Patients | No token-transfer or multi-patient booking rules |
| 10 | No government-scheme (ABDM/ABHA) integration | Clinic Owner | Not architected in from the start |

# 7. Improvements at Every Stage

Each pain point above maps to a design response, not just a feature label. The unifying principle: **remove receptionist interruptions first, then doctor friction, then patient anxiety** — in that order, because the receptionist and doctor are the two people who can kill adoption in week one, while the patient benefit follows automatically once the operational core works.

For the receptionist, the single highest-leverage change is collapsing "check patient in," "answer status queries," and "log the register" into one name-search-and-tap flow that mirrors what she already does today, so her manual workload shrinks even before any dashboard is added — the win is in eliminating the status-query interruptions and the paper lookup, not in removing her from the process. For the doctor, the highest-leverage change is a private, one-tap way to broadcast status (late/break/emergency) that never requires a face-to-face interruption from staff. For the patient, the highest-leverage change is not a fancier prediction — it's *any* proactive communication when a previously given estimate changes, since silence-after-a-promise is what actually erodes trust. For the owner, the highest-leverage change is a weekly digest that turns "the clinic felt busy" into "Tuesday afternoons have 40% more walk-ins than any other slot, and average wait crossed 45 minutes twice this month" — because that's the evidence that justifies renewing (and eventually expanding) the subscription.

# 8. Feature Roadmap, In Order of Business Value

MVP scope is intentionally narrow: it should be sellable and demoable as "the queue and delay layer," fully working, before booking, EMR, or billing are anything more than thin wrappers around it.

## Phase 1 — MVP (prove the core wedge)

| Feature | Primary Beneficiary | Why It's MVP |
|---|---|---|
| Unified digital token queue (appointments + walk-ins, rules-based sequencing) | Receptionist, Patient | Solves the actual hard problem (Section 1); everything else is downstream of getting this right |
| Receptionist name/phone-search check-in ("mark arrived" in one tap) | Receptionist | Mirrors exactly what she already does today (patient states name, she looks them up) — faster than paper from day one, no patient app or QR needed |
| Booked-slot-plus-delay queue positioning | Receptionist, Patient | Concrete answer to the walk-in/appointment sequencing problem: appointment patients slot in at their booked time adjusted for the day's accumulated doctor delay; walk-ins slot in by arrival order, interleaved with adjusted appointment times |
| Automatic no-show handling (grace-window flag intraday, formal close-out end of day) | Receptionist, Owner | Anyone not marked "arrived" within a grace window of their adjusted slot is flagged as a likely no-show so the receptionist can offer that slot to a waiting walk-in; anyone still unmarked at day's end is closed out as a no-show for the daily summary and future no-show analytics |
| Waiting-room display screen | Patient | Immediate, cheap, visible proof of transparency inside the clinic itself |
| SMS/WhatsApp status + confidence-band ETA (no app required) | Patient | Reaches patients regardless of smartphone literacy; core of the "leave home now" promise |
| One-tap doctor status broadcast (late/break/back soon) | Doctor | Doctor's entire ask in one low-friction control; removes staff-relay interruptions |
| Receptionist dashboard (today's queue, doctor status, manual override) | Receptionist | Operational command center; must be faster than the paper register from day one |
| Basic daily owner summary (footfall, no-shows, avg. wait) | Owner | First taste of ROI-visible data, needed to justify renewal |

MVP's arrival-and-sequencing logic, concretely: each appointment carries a booked time; as the day's actual doctor delay becomes known (from consult durations and status updates), every not-yet-arrived appointment's *effective* queue position shifts with it. When a patient shows up and asks "when's my turn," the receptionist searches their name (exact behavior she uses today), taps arrived, and the system slots them at their adjusted position — no separate booking-time lookup or mental math required on her part. A patient who never arrives by some grace window past their adjusted time (e.g. 20–30 minutes, tunable per clinic) is flagged as a likely no-show mid-day so their slot can be offered to a waiting walk-in, and anyone still unmarked at closing is formally logged as a no-show in that day's record. Self-service check-in (QR/WhatsApp) is deliberately deferred — see Phase 3 — until real volume shows the receptionist's search-and-tap step, not the absence of self-check-in, is the actual bottleneck.

## Phase 2 — Differentiation & Retention

| Feature | Primary Beneficiary | Why It Matters |
|---|---|---|
| Predictive per-doctor, per-visit-type wait estimation (learns over time) | Patient, Owner | Moves from flat averages to real accuracy, the product's long-term moat |
| Multi-doctor / multi-room queue routing | Receptionist, Owner | Unlocks the majority of real Tier 2/3 clinics (2–3 doctor setups) |
| ABHA/ABDM integration (QR-based ABHA creation, FHIR record sharing) | Owner | Captures government incentives (₹20/registration, up to ₹4L/facility) and is heading toward mandatory by 2027 |
| No-show reduction (confirmation nudges, waitlist backfill) | Owner | Directly recoverable revenue — the strongest ROI argument in a sales pitch |
| Priority/emergency override with visible justification | Patient, Doctor | Prevents "the system is rigged" perception when urgent cases jump the queue |
| Owner analytics dashboard (peak-load heatmaps, per-doctor pacing trends) | Owner | Turns raw operations into decisions (staffing, slot design, pricing) |

## Phase 3 — Expansion

| Feature | Primary Beneficiary | Why It Matters |
|---|---|---|
| Automated follow-up / chronic-care recall campaigns | Owner, Patient | Converts one-time visits into repeat revenue and better outcomes |
| Multi-branch / chain management | Owner | Needed once a single clinic's success drives expansion — common growth path in Tier 2/3 |
| Self-service check-in (QR code / WhatsApp / kiosk) | Receptionist | Only worth building once a pilot clinic's volume makes the receptionist's search-and-tap step the visible bottleneck — premature in a clinic where she can still keep up |
| IVR / missed-call status check (zero-smartphone path) | Patient | Extends reach to the least digitally-served patients, a genuine differentiator vs. app-only competitors |
| Pharmacy/lab handoff queueing | Patient, Owner | Extends the "flow" promise past the consultation room to the patient's actual total time in the clinic |
| Payment collection & insurance/TPA integration | Owner | Rounds out the operational suite once the core flow engine has proven retention |

# 9. Ideal Workflow for a Modern Clinic

A patient books a same-day or advance slot through a phone call to the clinic, same as today — the receptionist enters it directly into the system, no app or patient-side booking flow required for v1. The night before or morning of, they receive a message with a realistic time window based on that doctor's typical pacing and the day's known booking load, plus a "leave home by" suggestion.

On arrival, nothing changes from the patient's point of view: they walk up and give their name, exactly as they do at every clinic today. The receptionist searches it, taps "arrived," and the system slots them into the queue at their booked time adjusted for however far behind (or ahead) the doctor is actually running that day — she doesn't calculate this herself, the system does it the instant she taps. The patient gets an immediate position and a confidence-band estimate, not a false-precision countdown. If someone's booked slot passes without them showing up, they're flagged as a likely no-show once a grace window elapses, freeing their slot for a waiting walk-in; anyone never marked arrived is formally closed out as a no-show at day's end, feeding the owner's daily summary. QR or WhatsApp self-check-in is intentionally left for later — it solves a problem this clinic doesn't have yet.

Inside, a shared queue engine — not a paper register, not a receptionist's memory — holds every doctor's sub-queue, blending scheduled and walk-in patients by the same transparent rule: appointments queue at their delay-adjusted slot time, walk-ins queue by arrival order, interleaved. If a true emergency arrives, the receptionist applies a visible override, and everyone else's display explains why their position moved rather than silently drifting.

The doctor works from an interface that shows only what's needed to call the next patient correctly, plus a single button to mark themselves late, on a break, or handling an emergency — the moment they tap it, every waiting patient's estimate and the waiting-room screen update automatically, with zero staff interruption required. The receptionist's day is now built around exceptions rather than repetition: she is not fielding "how long" every ten minutes, because patients can check that themselves; she is handling the walk-in who has no booking, the family that needs to be split into two tokens, the patient who stepped out and needs their place protected.

After the consultation, the same token concept follows the patient to billing and, if needed, to an in-house pharmacy or lab queue, so "done" means actually leaving the clinic, not just leaving the consultation room. That evening, the owner receives a short digest: how many patients were seen, how many no-shows, where the day's bottleneck was, and how today compared to the clinic's own historical pattern — turning a day that "felt busy" into a specific, actionable fact.

# 10. Why Clinics Will Pay for This Instead of What Already Exists

The current market gives clinics two unsatisfying choices. General practice-management suites — Practo Ray, Cliniqwise, MocDoc, HealthPlix, Doccure and similar — bundle scheduling, EMR, and billing but treat queueing as an afterthought: a list view, not an intelligence layer, and none of them solve the walk-in/appointment collision or give doctors a one-tap way to broadcast delays. Dedicated queue/token systems (increasingly common internationally, e.g. WaitWell) solve the display problem but are not built for the Indian clinic's specific hybrid of scheduled and walk-in flow, are not WhatsApp-native, and have no path into India's ABDM/ABHA ecosystem. Neither category is priced or positioned as an operations-ROI tool — most sit in the ₹2,000–₹8,000/month range and compete on feature checklists rather than measurable time or revenue saved.

This platform's case for a premium price rests on three things a clinic owner can actually verify. First, **measurable operational impact**: fewer receptionist interruptions, a clear reduction in average perceived wait, and a recoverable no-show rate — numbers the owner's own daily digest will show them within the first month, not a promise taken on faith. Second, **government incentive capture**: as ABDM/ABHA integration moves from optional to effectively mandatory by 2027, a platform that already creates ABHA-linked registrations and shares FHIR records earns the clinic direct payments (₹20 per linked OPD registration, up to ₹4 lakh per facility) — turning compliance from a cost center into a revenue line, and doing so earlier than slower-moving incumbents. Third, **adoption that survives past week one**: because the design is built around shrinking the receptionist's manual workload and giving the doctor a low-friction status control rather than a public scoreboard, it avoids the silent-abandonment failure mode that kills most clinic software regardless of its feature list.

The pitch to an owner, in one line: this is not software that makes patients feel better about waiting — it is software that makes the clinic see and fix the reason they're waiting, while collecting a government incentive for doing so.

# 11. Before Any Code Is Written

Validate the walk-in/appointment sequencing rule with two or three real clinics before building anything — this is the part most likely to be wrong on paper and right only after watching an actual Tuesday morning. Interview owners specifically on willingness to pay tied to the ROI claims above (no-show recovery, receptionist time, ABDM incentive), not on feature preference, since owners will say yes to nearly any feature in the abstract. Finally, lock the MVP scope to Section 8's Phase 1 only — the temptation to fold in EMR, billing, or predictive ML before the core queue engine is proven in one live clinic is the most common way projects like this stall before shipping anything.

---

*Sources consulted for competitive and regulatory context: [10 Best Clinic Management Software for Doctors in India (2026)](https://www.purshology.com/2026/03/10-best-clinic-management-software-for-doctors-in-india-2026/), [Best Clinic Management Software for Small Clinics in India (2026)](https://www.cufront.com/blog/best-clinic-management-software-small-clinics-india), [Best Queue Management Systems for Clinics in 2026](https://boringqms.com/blog/best-qms-clinics-2026/), [Practo Ray Pricing, Features and Reviews 2026](https://technologycounter.com/products/practo-ray), [Hospital ABDM Integration India 2026: Complete Setup Guide](https://www.adrine.in/blog/hospital-abdm-integration-complete-guide-india-2026), [Update on Ayushman Bharat Digital Mission — MoHFW](https://www.mohfw.gov.in/?q=en/pressrelease-147).*

---

# 12. Business Strategy Log — Licensing, Pricing, ABDM Reality, Hardware, Competitors

*Added 29 Aug 2026, once real code existed to sell. Status: pricing numbers are the owner's latest call, not yet locked; everything else in this section is settled reasoning that should hold unless new facts show up. Revisit this section rather than starting the conversation over next time.*

## 12.1 Licensing model — auth vs. entitlement

Two separate questions were being conflated: *can this person log in* (authentication) and *is this clinic's subscription active* (entitlement). Industry-standard SaaS practice keeps these apart, so that's what got built:

- `profiles.is_active` (pre-existing) — gates an individual staff member within an already-paying clinic (an owner suspending one receptionist's login without affecting the clinic's own status).
- `clinics.subscription_status` (new — `trialing` / `active` / `suspended`, plus `trial_ends_at`) — gates the whole clinic at once. Checked in one choke point, `Qlinic.requireLogin()`, so all 20 authenticated pages are covered without each page remembering to add its own check. A lapsed clinic's entire team (owner, reception, doctor) gets bounced to `account-suspended.html`, not just whoever would see a billing screen.

**Deliberately manual for now**: `subscription_status` is flipped by hand in the Supabase SQL Editor once a clinic actually pays — no payment processor is wired up yet, since there are no paying customers yet to justify that integration cost. This was an explicit MVP choice (confirmed via an in-session question to the owner: "manual gate now" over building payment automation first). Automating it later (e.g. a Razorpay webhook writing this same field) needs **no schema change and no page changes** — only who/what writes to the field changes. **Razorpay**, not Stripe, is the recommended processor when that day comes, for India/UPI/GST fit.

Every clinic that existed before this concept did is grandfathered straight to `'active'` — gating an existing user with no warning and no way to pay yet would be a self-inflicted lockout. Only clinics registered from now on start a real 14-day trial clock.

**Still outstanding**: [supabase/053_clinic_subscription_status.sql](supabase/053_clinic_subscription_status.sql) needs to be run once in the Supabase SQL Editor before any of this takes effect — confirm this has been done before relying on the gate.

## 12.2 Pricing — value-based, tiered, still a draft

Owner's stated philosophy, which overrides a cost-plus default: **price on the money saved for the clinic, not on Qlinic's own cost to deliver the feature.** Concretely, this means Billing Audit or the no-show/ABDM angle can justify a tier's price on their own if they save or make the clinic more than the subscription costs, independent of how cheap those features are to run.

Working patient-volume assumption (owner-specified, interpreted as *clinic-wide* daily patients per tier — not per-doctor; flagged as an interpretation, never corrected, so it stands): **Starter ~50/day, Growth ~100/day, Pro ~200/day.**

Price history this round (both revisions came from direct owner pushback, not a new analysis):
1. First draft, cost-plus-ish: Starter ₹999 / Growth ₹2,499 / Pro ₹4,999 — rejected for using an unrealistic (too low) patient-volume assumption.
2. Recomputed against the real volumes above, then revised a second time upward on the owner's explicit instruction ("prices can be increased for all, given the sheer amount of value we are providing"): **Starter ₹1,499 / Growth ₹3,499 / Pro ₹8,999 — current number, not yet locked in.**

Sanity-checked against real Indian competitor pricing (12.4): these numbers are *not* aggressive. A queue-only tool with no billing or analytics (Qwaiting) charges more than Growth. There is arguably room to hold firm here or push Pro higher still, once ABDM (12.3) gives Pro a genuine compliance differentiator most competitors lack.

**Not yet done**: an actual feature-by-tier scope document (what specifically is Starter- vs Growth- vs Pro-only). The conversation so far has priced tiers by volume and named a few tier-defining features in passing (Billing Audit as a differentiator; Growth replacing manual/Excel workflows; Pro's ABDM compliance) but never enumerated the full feature list per tier. That's the next real piece of pricing work, before these numbers can go on a marketing page.

## 12.3 ABDM — the incentive is real, but two catches change the pitch

Read directly from NHA's own policy PDF ([abdm.gov.in DHIS policy](https://abdm.gov.in/strapicms/uploads/Financial_Incentive_Policy_DHIS_e96a62fd28.pdf)), not a summary of it — so treat the mechanics below as authoritative, but see the caveat at the end.

- A single small clinic (no beds) gets **nothing directly** from this scheme. The policy's own worked example: a single-doctor clinic doing 300 transactions/month is *not eligible* for any incentive on its own.
- The money instead goes to the **Digital Solution Company (DSC)** — i.e. Qlinic — at **₹5 per ABHA-linked transaction**, once a *specific clinic* crosses **200 transactions/month** (then all of that clinic's transactions count that month, not just the excess).
- **Catch #1 — needs HIU, not just HIP.** The policy explicitly defines a DSC as an entity with software having *"ABDM certified Health Information Provider (HIP) **and** Health Information User (HIU) functionality."* Qlinic's existing ABDM plan (`robust-questing-walrus.md`, the Milestone A–D integration plan) deliberately scopes HIU (M3 — pulling other providers' records in) **out**, since it doesn't fit a queue/billing tool's job. Collecting this incentive is therefore not "free money on the plan we already have" — it requires expanding that plan's scope. This conflict has been raised with the owner but not yet resolved either way.
- **Catch #2 — needs scale first.** DSC eligibility itself requires a minimum of **10 facilities** transacting monthly, on top of each individual clinic needing 200+ transactions/month. Not available on day one of ABDM certification (Milestone D) even if HIU were built.
- **Caveat on the numbers themselves**: the PDF read is the original Dec-2022 policy; there is evidence of at least 6 corrigenda since, the latest dated Nov 2025 (not yet read). The ₹5/transaction rate, the 200-transaction threshold, and other figures should be **re-verified against the current corrigendum** before being quoted to anyone or used in a real financial model — they are "original policy terms, likely amended," not confirmed-current.
- **Honest sizing**: even a generous model (50 clinics × ~300 transactions/month) works out to roughly ₹75,000/month in incentive revenue — a real, welcome bonus (~4–5% on top of subscription revenue at that scale), not the "things go wild" scenario. The bigger payoff is probably what ABDM lets Qlinic *charge* for Pro (compliance-readiness as a premium feature) rather than the incentive cheques themselves — consistent with the owner's own instinct not to lead the pitch with ABDM.

## 12.4 Indian competitor pricing — what's actually out there

Real prices where publishable ones exist; secondary/aggregator estimates are marked as such.

| Vendor | Price | Notes |
|---|---|---|
| Practo Ray | Headline ~₹1,000–4,000/month, but marketplace/per-appointment fees add another 50–100% on top for a busy clinic | Real cost is opaque and rises with clinic success — the opposite of what a small clinic wants |
| MocDoc | ₹5,000–₹1,00,000/month depending on customization | Has ABDM/ABHA support; no self-serve price, sales-call required |
| Halemind | ₹1,500–₹15,000/month (dental/specialty-leaning) | Quote-based, wide band |
| ConnectAI | From ₹1,499/month self-serve, 1–5 doctors | The one real transparent, self-serve comparable found |
| Qwaiting (queue-only, no billing/EMR) | From $199/month (~₹16,600) | Just queue management, no billing/analytics, still costs more than Qlinic's proposed Pro tier |
| Enterprise/hospital-grade Indian HMS | ₹40,000–₹2,50,000+/month | Different market (hospitals) — not a real Qlinic competitor |

**Takeaways for positioning:**
- Almost nobody in this market publishes real pricing — "contact us" is the norm. Publishing clear self-serve pricing is a nearly-free trust advantage with a skeptical, time-poor small-clinic buyer.
- Practo's hidden marketplace fees are a direct, honest jab to make: "no marketplace tax, no per-appointment fee, the price you see is the price you pay."
- Qlinic's current draft pricing (12.2) is cheap relative to this market, not expensive — there's room to hold or push it, not a reason to cut it.

Sources: [Cufront: Practo Ray pricing](https://www.cufront.com/blog/practo-ray-pricing-india-worth-it-2026) · [Ichelon: clinic software cost comparison](https://ichelonconsulting.com/clinic-management-system-cost-india-2026) · [Techjockey: MocDoc pricing](https://www.techjockey.com/detail/mocdoc-clinic-management-system) · [Doccure: clinic software comparison 2026](https://doccure.io/best-clinic-management-software-in-india-2026-comprehensive-reviews-and-pricing-comparison/) · [ConnectAI pricing](https://www.connectai.care/learn/best-clinic-management-software-india) · [Qwaiting pricing](https://qwaiting.com/pricing)

## 12.5 Patient messaging — WhatsApp + SMS fallback, pooled across all clinics

Based on MSG91 pricing: SMS is flat ~₹0.17–0.18/message (~₹0.20–0.21 with 18% GST) across the 30K–450K/month range clinics would realistically generate; it only gets cheaper past ~9.6 lakh messages/month. WhatsApp Business API (MSG91 "Titan" plan) costs a ₹500/month platform fee (+GST) plus ~₹0.115/message for Utility-category messages (~₹0.136/message effective with GST).

**Breakeven where WhatsApp beats pure SMS: ~7,700 messages/month** — driven entirely by amortizing the fixed platform fee. Critically, this only clears if Qlinic pools messaging volume across **all** its clinic customers on **one** company-owned MSG91 account — a single clinic's own volume rarely clears 7,700/month alone, but as few as ~3 Growth-tier clinics combined would. Recommendation: WhatsApp primary with SMS fallback, on one pooled account; skip MSG91 Email entirely (Supabase's built-in auth email already covers the real need, and patients in this market are WhatsApp/SMS-first, not email-first).

**Compliance needed before any of this ships**: DLT registration (TRAI) for SMS; Meta Business verification + a WhatsApp Business Account (WABA) + template approval for WhatsApp (MSG91 acts as BSP/facilitator, but Meta's own approval still has lead time). Not started.

## 12.6 Waiting-room display — BYOD, not hardware sales

Confirmed with the owner as a real, common (not hypothetical) barrier: many Tier 2/3 clinics either have no screen, or have one that isn't "smart"/internet-connected. Recommendation stands: **don't sell or bundle display hardware** — `display.html` already works on any browser-capable screen, and turning Qlinic into a hardware/inventory/logistics business for the minority of clinics that lack a usable screen is the wrong trade. Instead: **BYOD by default**, with an optional low-cost recommended device (e.g. a Fire TV Stick, ~₹1,500) suggested via an affiliate link for clinics that need one.
