-- ============================================================
-- ClinVision — reference query: activate a clinic after payment
--
-- Not a migration. This is the manual gate described in migration
-- 053's own comment: there's no Razorpay/payment-processor integration
-- wired up yet (scoped in BACKLOG.md, "Qlinic subscription billing
-- (Razorpay)"), so "authenticating a paying clinic" today just means
-- you personally confirm payment happened OUTSIDE the app (bank
-- transfer, UPI, whatever you actually collect it through), then flip
-- this one field by hand.
--
-- clinics.subscription_status has exactly three values:
--   'trialing'  — new signups land here automatically, gated open
--                 only until trial_ends_at (14 days from signup).
--   'active'    — paid and confirmed by you — full access, no
--                 trial-expiry check.
--   'suspended' — blocked immediately regardless of dates (payment
--                 lapsed, chargeback, abuse, etc.).
-- Enforced everywhere by Qlinic.requireLogin() -> isSubscriptionActive()
-- in clinic-data.js, which redirects to account-suspended.html the
-- moment a clinic is neither 'active' nor still inside its trial.
-- ============================================================

-- 1. Find the clinic first — confirm you've got the right one before
--    running the update below.
select id, name, admin_email, subscription_status, trial_ends_at
from clinics
where name ilike '%CLINIC NAME HERE%';  -- or filter by admin_email instead

-- 2. Once you've confirmed payment and found the right clinic id,
--    activate it. This is the actual "gate lifted" moment — the very
--    next requireLogin() check on that clinic's account (next page
--    load, no logout/login needed) sees 'active' and lets them in.
update clinics
set subscription_status = 'active'
where id = 'PASTE-THE-CLINIC-UUID-HERE';

-- 3. If a clinic stops paying / needs to be cut off, the same pattern
--    in reverse — this takes effect just as immediately.
-- update clinics
-- set subscription_status = 'suspended'
-- where id = 'PASTE-THE-CLINIC-UUID-HERE';
