// Qlinic — ABDM callback: /hip/link/care-context/init
//
// ABDM's Gateway instructs the HIP: "start linking these discovered
// care contexts to this patient's ABHA - generate a link reference
// and get an OTP to the patient." A real implementation must actually
// deliver that OTP to the patient somehow; Qlinic has no SMS sending
// infrastructure today (the `notifications` table only logs message
// text, nothing sends it - a pre-existing, separate gap noted when
// this repo's queue-link date-gating work was scoped). That's a real
// blocker for Milestone D, not solved here - this scaffold generates
// a link reference and returns the ACK shape ABDM expects (see the
// TODO below for what's still missing - it doesn't persist the
// reference anywhere yet, so hip-link-confirm has nothing to validate
// against); actually notifying the patient is out of scope until
// Qlinic has real SMS delivery.
//
// EXACT REQUEST/RESPONSE FIELD NAMES ARE UNVERIFIED AGAINST LIVE ABDM
// V3 - see hip-patient-discover's header comment for why. Re-verify
// against ABDM's live API reference before Milestone D.

import { jsonResponse } from '../_shared/http.ts';

interface LinkInitRequest {
  transactionId: string;
  patient: { referenceNumber: string; careContexts: { referenceNumber: string }[] };
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body: LinkInitRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  // A real implementation persists this reference (e.g. in a new
  // link_attempts table, not scoped in Milestone A-C) so
  // hip-link-confirm can look it up by linkRefNumber and validate the
  // OTP against it. Not built yet - this scaffold only proves the ACK
  // shape and request parsing, per this milestone's scope.
  const linkRefNumber = crypto.randomUUID();

  return jsonResponse({
    transactionId: body.transactionId,
    link: {
      referenceNumber: linkRefNumber,
      authenticationType: 'DIRECT',
      meta: { communicationMedium: 'MOBILE', communicationHint: 'OTP sent to patient (not yet wired to real SMS delivery)' },
    },
  });
});
