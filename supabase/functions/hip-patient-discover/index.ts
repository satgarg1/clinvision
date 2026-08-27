// Qlinic — ABDM callback: /hip/patient/care-context/discover
//
// ABDM (on behalf of a requesting HIU, via the Gateway) asks: "does a
// patient matching this ABHA/these demographics exist at this
// facility, and if so, what care contexts do they have?" This is the
// first step before any consent/linking can happen - a patient can't
// be asked to consent to sharing something Qlinic never confirmed it
// has.
//
// EXACT REQUEST/RESPONSE FIELD NAMES ARE UNVERIFIED AGAINST LIVE ABDM
// V3 - the Gateway's discover API changed shape between V2 (async,
// separate on-discover callback) and V3 (synchronous, response
// returned directly in the HTTP body) during this integration's
// research phase. The lookup logic below (matching by abha_address,
// scoping to a clinic via its hfr_id) is the real, durable part -
// re-verify field names against ABDM's live V3 API reference before
// Milestone D's first real call.
//
// This handler never calls out to ABDM itself (it only responds to an
// inbound call), so ABDM_MOCK doesn't apply here the way it does in
// hip-health-info-request - the DB lookup below is real and
// exercisable today, with no dependency on live credentials.

import { getServiceRoleClient } from '../_shared/supabase-client.ts';
import { jsonResponse } from '../_shared/http.ts';

interface DiscoverRequest {
  transactionId: string;
  patient: {
    id: string; // ABHA address or number, as sent by the HIU
  };
  hipId: string; // resolves to clinics.hfr_id
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body: DiscoverRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const supabase = getServiceRoleClient();

  const { data: clinic } = await supabase
    .from('clinics')
    .select('id')
    .eq('hfr_id', body.hipId)
    .maybeSingle();

  if (!clinic) {
    return jsonResponse({ transactionId: body.transactionId, matchedCount: 0, careContexts: null });
  }

  const { data: patient } = await supabase
    .from('patients')
    .select('id, name')
    .eq('clinic_id', clinic.id)
    .eq('abha_address', body.patient.id)
    .maybeSingle();

  if (!patient) {
    return jsonResponse({ transactionId: body.transactionId, matchedCount: 0, careContexts: null });
  }

  const { data: careContexts } = await supabase
    .from('care_contexts')
    .select('reference_number, display')
    .eq('patient_id', patient.id);

  return jsonResponse({
    transactionId: body.transactionId,
    matchedCount: 1,
    patient: { referenceNumber: patient.id, display: patient.name },
    careContexts: (careContexts ?? []).map((cc) => ({
      referenceNumber: cc.reference_number,
      display: cc.display,
    })),
  });
});
