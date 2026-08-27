// Qlinic — ABDM callback: /hip/patient/share (QR scan-and-share)
//
// The patient scans this clinic's ABDM QR code (or shares their
// profile via the ABDM app), and ABDM pushes their full demographics +
// ABHA identifiers directly here, along with a linking token that -
// per ABDM V3 - establishes the care-context link immediately, no
// separate OTP round-trip needed (V3 simplified this versus the
// older link-init/confirm flow used for HIP-initiated linking).
//
// EXACT REQUEST FIELD NAMES ARE UNVERIFIED AGAINST LIVE ABDM V3 - see
// hip-patient-discover's header comment for why.
//
// Matching this pushed profile to an existing Qlinic patient record is
// the real open question here: phone number is the only field Qlinic
// reliably collects that ABDM's profile share is also likely to carry,
// but a phone match can be ambiguous (multiple patients sharing a
// household line) or simply absent (no patient registered yet under
// that phone today). This scaffold does the phone-based lookup and
// writes the ABHA identifiers onto an unambiguous single match; an
// ambiguous or absent match is reported back rather than guessed at -
// deciding what Qlinic should do in that case (prompt reception to
// pick/create a patient?) is a real product question for Milestone D,
// not resolved here.

import { getServiceRoleClient } from '../_shared/supabase-client.ts';
import { jsonResponse } from '../_shared/http.ts';

interface PatientShareRequest {
  transactionId: string;
  profile: {
    patient: {
      abhaAddress: string;
      abhaNumber?: string;
      name?: string;
      phone?: string;
    };
  };
  hipId: string; // resolves to clinics.hfr_id
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body: PatientShareRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const phone = body.profile?.patient?.phone;
  if (!phone) {
    return jsonResponse({ transactionId: body.transactionId, status: 'NO_MATCH', reason: 'No phone number in the shared profile to match against.' });
  }

  const supabase = getServiceRoleClient();

  const { data: clinic } = await supabase
    .from('clinics')
    .select('id')
    .eq('hfr_id', body.hipId)
    .maybeSingle();
  if (!clinic) {
    return jsonResponse({ transactionId: body.transactionId, status: 'NO_MATCH', reason: `No clinic registered with hfr_id ${body.hipId}` });
  }

  const { data: candidates } = await supabase
    .from('patients')
    .select('id')
    .eq('clinic_id', clinic.id)
    .eq('phone', phone);

  if (!candidates || candidates.length === 0) {
    return jsonResponse({ transactionId: body.transactionId, status: 'NO_MATCH', reason: 'No patient registered under this phone number at this clinic.' });
  }
  if (candidates.length > 1) {
    return jsonResponse({ transactionId: body.transactionId, status: 'AMBIGUOUS', reason: `${candidates.length} patients share this phone number - cannot pick one automatically.` });
  }

  const { error } = await supabase
    .from('patients')
    .update({
      abha_address: body.profile.patient.abhaAddress,
      abha_number: body.profile.patient.abhaNumber ?? null,
      abha_verified_at: new Date().toISOString(),
      abha_verification_method: 'qr_scan',
    })
    .eq('id', candidates[0].id);

  if (error) {
    return jsonResponse({ error: error.message }, 500);
  }

  return jsonResponse({ transactionId: body.transactionId, status: 'LINKED', patientId: candidates[0].id });
});
