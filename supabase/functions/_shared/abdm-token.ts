// Qlinic — ABDM Gateway session-token helper, shared by every HIP
// callback function plus abha-verify.
//
// The bridge-level clientId/clientSecret (one pair for the whole
// Qlinic vendor bridge, not per-clinic - individual clinics attach
// via their HFR id, see migration 048) live in Edge Function secrets,
// set via:
//   supabase secrets set ABDM_CLIENT_ID=... ABDM_CLIENT_SECRET=... \
//     ABDM_BASE_URL=https://dev.abdm.gov.in/gateway ABDM_MOCK=true
// never a database table, even RLS-locked - a leaked bridge secret
// compromises every clinic on the bridge at once.
//
// The resulting session token is cached in-memory for this function
// instance's lifetime only (never persisted to Postgres) and
// refetched once its TTL passes. Edge Function instances are
// short-lived and don't share memory across cold starts, so this is a
// best-effort cache, not a guarantee against ever re-fetching - that's
// fine, ABDM's session endpoint is meant to be called this way.
//
// Under ABDM_MOCK=true (the default until real sandbox credentials
// exist - see plans/robust-questing-walrus.md, Milestone D), this
// returns a fixed placeholder token and never makes a real network
// call, so every other Edge Function's logic (DB writes, ACK shapes,
// FHIR bundling) is fully exercisable without a live ABDM Gateway.

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

let cached: CachedToken | null = null;

export function isAbdmMockMode(): boolean {
  return (Deno.env.get('ABDM_MOCK') ?? 'true').toLowerCase() !== 'false';
}

export function abdmBaseUrl(): string {
  return Deno.env.get('ABDM_BASE_URL') || 'https://dev.abdm.gov.in/gateway';
}

export async function getAbdmSessionToken(): Promise<string> {
  if (isAbdmMockMode()) {
    return 'MOCK-SESSION-TOKEN';
  }

  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.token;
  }

  const clientId = Deno.env.get('ABDM_CLIENT_ID');
  const clientSecret = Deno.env.get('ABDM_CLIENT_SECRET');
  if (!clientId || !clientSecret) {
    throw new Error('ABDM_CLIENT_ID/ABDM_CLIENT_SECRET not set - required once ABDM_MOCK=false.');
  }

  const res = await fetch(`${abdmBaseUrl()}/v0.5/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret, grantType: 'client_credentials' }),
  });
  if (!res.ok) {
    throw new Error(`ABDM session request failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  // Refresh a little early (60s buffer) rather than racing its exact
  // expiry against the next call that needs it.
  const expiresInSec = Number(data.expiresIn) || 300;
  cached = { token: data.accessToken, expiresAt: now + (expiresInSec - 60) * 1000 };
  return cached.token;
}
