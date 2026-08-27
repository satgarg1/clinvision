// Qlinic — abha-verify: browser-facing OTP init/confirm for M1 ABHA
// creation/verification. This is Qlinic's OWN API surface, not an
// ABDM-mandated callback path - it exists so a future intake form can
// drive Aadhaar/mobile OTP ABHA verification without the browser ever
// holding the bridge's clientId/clientSecret.
//
// SCAFFOLDED BUT NOT YET CALLED FROM ANY PAGE - per the plan
// (robust-questing-walrus.md), no ABHA capture UI exists in
// reception.html/billing-consultation.html this round, to avoid a
// half-working "type in an unverified ABHA" field creating false
// confidence before real OTP verification exists. This function is
// ready for that UI to call once Milestone D provides real sandbox
// credentials; until then ABDM_MOCK=true makes every step here
// exercisable (by hand, e.g. via `supabase functions invoke`) without
// one.
//
// EXACT ABDM ENDPOINT PATHS/PAYLOADS FOR ENROLLMENT-BY-OTP ARE
// UNVERIFIED AGAINST LIVE ABDM V3 - see hip-patient-discover's header
// comment for why this caveat applies across the integration.
//
// Only this function needs CORS (it's the one thing in this
// integration ever called from a browser, not from ABDM's Gateway).

import { getServiceRoleClient } from '../_shared/supabase-client.ts';
import { jsonResponse, CORS_HEADERS } from '../_shared/http.ts';
import { abdmBaseUrl, getAbdmSessionToken, isAbdmMockMode } from '../_shared/abdm-token.ts';

interface InitBody {
  step: 'init';
  method: 'mobile_otp' | 'aadhaar_otp';
  value: string; // mobile number or Aadhaar number
}

interface ConfirmBody {
  step: 'confirm';
  txnId: string;
  otp: string;
  patientId: string; // which Qlinic patient row this verification is for
  method: 'mobile_otp' | 'aadhaar_otp';
}

type Body = InitBody | ConfirmBody;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return jsonResponseWithCors({ error: 'Invalid JSON body' }, 400);
  }

  if (body.step === 'init') {
    return handleInit(body);
  }
  if (body.step === 'confirm') {
    return handleConfirm(body);
  }
  return jsonResponseWithCors({ error: 'step must be "init" or "confirm"' }, 400);
});

async function handleInit(body: InitBody): Promise<Response> {
  if (!body.value) {
    return jsonResponseWithCors({ error: 'value (mobile or Aadhaar number) is required' }, 400);
  }

  if (isAbdmMockMode()) {
    return jsonResponseWithCors({ txnId: crypto.randomUUID() });
  }

  const token = await getAbdmSessionToken();
  const path = body.method === 'aadhaar_otp'
    ? '/v3/enrollment/request/otp'
    : '/v3/profile/login/request/otp';
  const res = await fetch(`${abdmBaseUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ scope: [body.method], loginHint: body.method, value: body.value }),
  });
  if (!res.ok) {
    return jsonResponseWithCors({ error: `ABDM OTP request failed: ${res.status} ${await res.text()}` }, 502);
  }
  const data = await res.json();
  return jsonResponseWithCors({ txnId: data.txnId });
}

async function handleConfirm(body: ConfirmBody): Promise<Response> {
  if (!body.txnId || !body.otp || !body.patientId) {
    return jsonResponseWithCors({ error: 'txnId, otp, and patientId are required' }, 400);
  }

  let abhaNumber: string;
  let abhaAddress: string;

  if (isAbdmMockMode()) {
    abhaNumber = '91-0000-0000-0000';
    abhaAddress = 'mock-patient@sbx';
  } else {
    const token = await getAbdmSessionToken();
    const res = await fetch(`${abdmBaseUrl()}/v3/enrollment/enrol/byAadhaar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ txnId: body.txnId, otp: body.otp }),
    });
    if (!res.ok) {
      return jsonResponseWithCors({ error: `ABDM OTP verification failed: ${res.status} ${await res.text()}` }, 502);
    }
    const data = await res.json();
    abhaNumber = data.ABHANumber;
    abhaAddress = data.preferredAbhaAddress;
  }

  // The one place a client-facing call is allowed to write
  // abha_verified_at: only after this function itself has performed
  // (or, under mock mode, simulated) a real OTP verification - never
  // from an unauthenticated claim of "this is already verified."
  const supabase = getServiceRoleClient();
  const { error } = await supabase
    .from('patients')
    .update({
      abha_number: abhaNumber,
      abha_address: abhaAddress,
      abha_verified_at: new Date().toISOString(),
      abha_verification_method: body.method,
    })
    .eq('id', body.patientId);

  if (error) {
    return jsonResponseWithCors({ error: error.message }, 500);
  }

  return jsonResponseWithCors({ abhaNumber, abhaAddress, verified: true });
}

function jsonResponseWithCors(body: unknown, status = 200): Response {
  const res = jsonResponse(body, status);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.headers.set(key, value);
  }
  return res;
}
