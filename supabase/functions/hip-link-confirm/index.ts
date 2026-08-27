// Qlinic — ABDM callback: /hip/link/care-context/confirm
//
// ABDM's Gateway forwards the OTP the patient entered, referencing the
// linkRefNumber generated in hip-link-init. On success, this is the
// point where the previously-`pending` care_contexts rows for that
// patient become genuinely `linked` - the durable fact that this
// patient's ABHA now knows about this clinic's visit records.
//
// EXACT REQUEST/RESPONSE FIELD NAMES ARE UNVERIFIED AGAINST LIVE ABDM
// V3 - see hip-patient-discover's header comment for why.
//
// Real OTP validation depends on hip-link-init actually persisting
// which patient/care-contexts a given linkRefNumber refers to, which
// isn't built yet (see hip-link-init's own comment: it generates a
// linkRefNumber but doesn't store what it points to). Without that,
// this function has no honest way to know WHICH care_contexts rows a
// given confirm request means - a blanket "mark everything pending as
// linked" would be actively wrong (and dangerous: cross-clinic), not
// just incomplete. So this scaffold validates the request shape and
// ACKs correctly, but deliberately makes NO care_contexts write at
// all until the link-attempt persistence lands - a real gap, not
// silently glossed over as if it worked.

import { jsonResponse } from '../_shared/http.ts';

interface LinkConfirmRequest {
  confirmation: {
    linkRefNumber: string;
    token: string; // the OTP the patient entered
  };
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body: LinkConfirmRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.confirmation?.linkRefNumber) {
    return jsonResponse({ error: 'confirmation.linkRefNumber is required' }, 400);
  }

  // TODO (Milestone D, blocking): add a link_attempts table (or
  // equivalent) that hip-link-init writes linkRefNumber -> {patientId,
  // careContextIds, otp, expiresAt} into, so this function can look
  // that row up, validate body.confirmation.token against the stored
  // OTP, and update ONLY that specific patient's specific care_contexts
  // rows to status='linked'. Not implemented in Milestone C - there is
  // no persisted mapping to validate against yet, so this function
  // cannot honestly confirm anything real today. It returns a
  // not-yet-implemented error rather than a fake success, so nothing
  // downstream mistakes this scaffold for a working link confirmation.
  return jsonResponse({
    error: 'hip-link-confirm is scaffolded but not yet wired to a real link attempt store (Milestone D).',
  }, 501);
});
