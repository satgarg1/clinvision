// Qlinic — ABDM callback: /hip/health-information/request
//
// The most complex flow in this integration. An HIU has a granted
// consent and now wants the actual data: ABDM's Gateway calls this
// with the consent id, a date range, the HIU's callback URL to push
// results to, and the HIU's ECDH public key + nonce. ABDM requires an
// ACK within 5 seconds - the real work (validate consent, assemble
// FHIR bundles, encrypt, push, report status) happens asynchronously
// after that ACK, via EdgeRuntime.waitUntil so the response is never
// blocked on it.
//
// EXACT REQUEST FIELD NAMES ARE UNVERIFIED AGAINST LIVE ABDM V3 - see
// hip-patient-discover's header comment for why.
//
// Under ABDM_MOCK=true (the default - see abdm-token.ts), the final
// "push to the HIU" step writes its output onto the
// health_information_requests row instead of making a real network
// call, so every step before it (consent validation, DB reads, FHIR
// bundling, the real Fidelius encryption) is fully exercisable without
// a live HIU to push to.

import { getServiceRoleClient } from '../_shared/supabase-client.ts';
import { jsonResponse } from '../_shared/http.ts';
import { isAbdmMockMode } from '../_shared/abdm-token.ts';
import { buildOpConsultationBundle } from '../_shared/fhir-bundle.ts';
import { encryptForHiu, generateKeyMaterial } from '../_shared/fidelius.ts';

interface HealthInfoRequest {
  transactionId: string;
  hiRequest: {
    consent: { id: string };
    dateRange: { from: string; to: string };
    dataPushUrl: string;
    keyMaterial: {
      dhPublicKey: { keyValue: string };
      nonce: string;
    };
  };
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body: HealthInfoRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const supabase = getServiceRoleClient();
  const { hiRequest, transactionId } = body;
  if (!hiRequest?.consent?.id || !hiRequest.dataPushUrl || !hiRequest.keyMaterial) {
    return jsonResponse({ error: 'hiRequest.consent.id, dataPushUrl, and keyMaterial are required' }, 400);
  }

  const { data: consentArtefact } = await supabase
    .from('consent_artefacts')
    .select('id, clinic_id, patient_id')
    .eq('consent_id', hiRequest.consent.id)
    .maybeSingle();

  if (!consentArtefact) {
    return jsonResponse({ error: `No consent artefact on file for consent id ${hiRequest.consent.id}` }, 404);
  }

  const { data: hiRow, error: insertError } = await supabase
    .from('health_information_requests')
    .insert({
      clinic_id: consentArtefact.clinic_id,
      consent_artefact_id: consentArtefact.id,
      transaction_id: transactionId,
      hiu_callback_url: hiRequest.dataPushUrl,
      status: 'received',
    })
    .select('id')
    .single();

  if (insertError) {
    return jsonResponse({ error: insertError.message }, 500);
  }

  // ACK first - everything below runs after the response is sent, per
  // ABDM's 5-second ACK requirement. EdgeRuntime.waitUntil keeps the
  // function instance alive long enough to finish this work even
  // though the HTTP response has already gone out.
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime?.waitUntil(
    processHealthInformationRequest(supabase, hiRow.id, consentArtefact, hiRequest),
  );

  return jsonResponse({ transactionId }, 202);
});

async function processHealthInformationRequest(
  supabase: ReturnType<typeof getServiceRoleClient>,
  hiRequestId: string,
  consentArtefact: { id: string; clinic_id: string; patient_id: string | null },
  hiRequest: HealthInfoRequest['hiRequest'],
): Promise<void> {
  try {
    if (!consentArtefact.patient_id) {
      throw new Error('Consent artefact has no linked patient - nothing to assemble.');
    }

    const { data: careContexts } = await supabase
      .from('care_contexts')
      .select('id, reference_number, display, invoice_id')
      .eq('patient_id', consentArtefact.patient_id);

    const { data: patientRow } = await supabase
      .from('patients')
      .select('id, name, gender, age, reason, abha_address, abha_number')
      .eq('id', consentArtefact.patient_id)
      .single();
    if (!patientRow) {
      throw new Error(`Patient ${consentArtefact.patient_id} not found - nothing to assemble.`);
    }

    const bundles = [];
    for (const cc of careContexts ?? []) {
      if (!cc.invoice_id) continue;
      const { data: invoiceRow } = await supabase
        .from('invoices')
        .select('id, invoice_date, fee_type, doctor_id')
        .eq('id', cc.invoice_id)
        .single();
      if (!invoiceRow) continue;
      if (invoiceRow.invoice_date < hiRequest.dateRange.from.slice(0, 10)
        || invoiceRow.invoice_date > hiRequest.dateRange.to.slice(0, 10)) continue;

      const { data: doctorRow } = await supabase
        .from('doctors')
        .select('id, name, specialty, hpr_id')
        .eq('id', invoiceRow.doctor_id)
        .single();
      if (!doctorRow) continue;

      bundles.push(buildOpConsultationBundle(
        { id: cc.id, referenceNumber: cc.reference_number, display: cc.display },
        { id: invoiceRow.id, invoiceDate: invoiceRow.invoice_date, feeType: invoiceRow.fee_type },
        {
          id: patientRow.id, name: patientRow.name, gender: patientRow.gender, age: patientRow.age,
          reason: patientRow.reason, abhaAddress: patientRow.abha_address, abhaNumber: patientRow.abha_number,
        },
        { id: doctorRow.id, name: doctorRow.name, specialty: doctorRow.specialty, hprId: doctorRow.hpr_id },
      ));
    }

    await supabase.from('health_information_requests').update({ status: 'bundled' }).eq('id', hiRequestId);

    const ours = await generateKeyMaterial();
    const encryptedEntries = [];
    for (const bundle of bundles) {
      const ciphertext = await encryptForHiu(
        JSON.stringify(bundle),
        ours,
        hiRequest.keyMaterial.dhPublicKey.keyValue,
        hiRequest.keyMaterial.nonce,
      );
      encryptedEntries.push({ content: ciphertext });
    }

    await supabase.from('health_information_requests').update({ status: 'encrypted' }).eq('id', hiRequestId);

    const pushPayload = {
      keyMaterial: { dhPublicKey: { keyValue: ours.publicKeyB64 }, nonce: ours.nonceB64 },
      entries: encryptedEntries,
    };

    if (isAbdmMockMode()) {
      // No live HIU to push to - record what WOULD have been sent so
      // the whole flow (consent check through encryption) is
      // inspectable without a real network hop.
      await supabase.from('health_information_requests').update({
        status: 'pushed',
        pushed_at: new Date().toISOString(),
        error_detail: `MOCK: would have pushed ${encryptedEntries.length} encrypted entr${encryptedEntries.length === 1 ? 'y' : 'ies'} to ${hiRequest.dataPushUrl}`,
      }).eq('id', hiRequestId);
      return;
    }

    const pushRes = await fetch(hiRequest.dataPushUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pushPayload),
    });
    if (!pushRes.ok) {
      throw new Error(`Push to HIU failed: ${pushRes.status} ${await pushRes.text()}`);
    }

    await supabase.from('health_information_requests').update({
      status: 'acknowledged',
      pushed_at: new Date().toISOString(),
    }).eq('id', hiRequestId);
  } catch (err) {
    await supabase.from('health_information_requests').update({
      status: 'failed',
      error_detail: err instanceof Error ? err.message : String(err),
    }).eq('id', hiRequestId);
  }
}
