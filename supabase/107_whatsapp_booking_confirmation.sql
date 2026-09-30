-- ============================================================
-- Clinic Settings, Patient messages: a per clinic switch for sending the
-- booking confirmation over the clinic's own WhatsApp.
--
-- Off by default, so no clinic's behaviour changes until an admin turns it
-- on. When on, reception gets a "Send on WhatsApp" button after every
-- appointment and walk in, and the booking no longer queues a pending row
-- in public.notifications (that queue is for a text message provider and
-- would otherwise double up once one is connected).
--
-- Changed through the existing clinics update policy, so only a clinic admin
-- can flip it. Nothing else to grant.
-- ============================================================

alter table public.clinics
  add column if not exists whatsapp_confirm_enabled boolean not null default false;
