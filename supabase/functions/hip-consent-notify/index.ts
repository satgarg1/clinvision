// Qlinic — ABDM callback: /consent/request/hip/notify
//
// ABDM's Gateway pushes a signed consent artefact here whenever a
// patient grants (or revokes) an HIU's access to records at this
// clinic. This is the one callback with a genuinely well-defined,
// fully-buildable-now write: consent_artefacts (migration 050) mirrors
// this payload closely on purpose, so this handler is a near-direct
// mapping rather than needing its own schema redesign.
//
// EXACT REQUEST FIELD NAMES ARE UNVERIFIED AGAINST LIVE ABDM V3 - see
// hip-patient-discover's header comment for why this caveat applies
// across every callback in this integration.

import { getServiceRoleClient } from '../_shared/supabase-client.ts';
import { jsonResponse } from '../_shared/http.ts';

interface ConsentNotifyRequest {
  notification: {
    consentId: string;
    status: 'GRANTED' | 'REVOKED' | 'EXPIRED';
    consentDetail: {
      patient: { id: string }; // ABHA address
      hip: { id: string }; // resolves to clinics.hfr_id
      hiu: { id: string };
      purpose: { code: string };
      hiTypes: string[];
      permission: {
        dateRange: { from: string; to: string };
        dataEraseAt: string; // expiry
      };
    };
  };
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body: ConsentNotifyRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const { notification } = body;
  if (!notification?.consentId || !notification.consentDetail) {
    return jsonResponse({ error: 'notification.consentId and notification.consentDetail are required' }, 400);
  }
  const detail = notification.consentDetail;

  const supabase = getServiceRoleClient();

  const { data: clinic } = await supabase
    .from('clinics')
    .select('id')
    .eq('hfr_id', detail.hip.id)
    .maybeSingle();
  if (!clinic) {
    return jsonResponse({ error: `No clinic registered with hfr_id ${detail.hip.id}` }, 404);
  }

  const { data: patient } = await supabase
    .from('patients')
    .select('id')
    .eq('clinic_id', clinic.id)
    .eq('abha_address', detail.patient.id)
    .maybeSingle();

  const statusMap: Record<ConsentNotifyRequest['notification']['status'], string> = {
    GRANTED: 'active',
    REVOKED: 'revoked',
    EXPIRED: 'expired',
  };

  const { error } = await supabase.from('consent_artefacts').upsert({
    clinic_id: clinic.id,
    patient_id: patient?.id ?? null,
    consent_id: notification.consentId,
    hiu_id: detail.hiu.id,
    purpose_code: detail.purpose.code,
    hi_types: detail.hiTypes,
    date_range_from: detail.permission.dateRange.from,
    date_range_to: detail.permission.dateRange.to,
    expiry_at: detail.permission.dataEraseAt,
    status: statusMap[notification.status] ?? 'active',
    raw_artefact: body,
  }, { onConflict: 'consent_id' });

  if (error) {
    return jsonResponse({ error: error.message }, 500);
  }

  return jsonResponse({ acknowledgement: { status: 'OK' } });
});
