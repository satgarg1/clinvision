// Qlinic — shared-secret authentication gate for every ABDM Gateway
// callback (the six hip-* functions; never abha-verify, which is
// Qlinic's own browser-facing endpoint and uses staff-auth instead —
// see staff-auth.ts).
//
// Every one of these callbacks previously trusted its caller
// completely: whoever could reach the public Edge Function URL could
// forge consent, push a patient's real FHIR bundle to a server they
// control, or overwrite a patient's ABHA identity — see the
// codebase-review PDF's CRITICAL findings 1-3. Real ABDM Gateway
// callbacks are meant to be authenticated end-to-end via a JWT signed
// by ABDM's own Gateway, verifiable against ABDM's published signing
// certificate — that verification isn't wired up here (no live ABDM
// sandbox credentials exist yet, see plans/robust-questing-walrus.md's
// Milestone D, and the exact cert/JWKS endpoint is unverified against
// live ABDM V3 same as every other field name in this integration).
//
// Until that's built, every callback instead requires a shared secret
// bearer token — closing "anyone on the internet" down to "only
// whoever configured the Gateway integration with this secret," a
// real, immediately-effective control today, and one worth keeping
// even after JWT verification lands (defense in depth: two
// independent checks are strictly better than one).
//
// Set via: supabase secrets set ABDM_GATEWAY_AUTH_TOKEN=<long random value>
// Generate one with, e.g.: openssl rand -hex 32

export function verifyGatewayAuth(req: Request): Response | null {
  const expected = Deno.env.get('ABDM_GATEWAY_AUTH_TOKEN');
  if (!expected) {
    // Fail closed — an unset secret must never silently mean "allow
    // everyone," which is exactly the bug this function exists to fix.
    return new Response(
      JSON.stringify({ error: 'Gateway authentication is not configured on this server.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const auth = req.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token || !timingSafeEqual(token, expected)) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    );
  }

  return null; // authorized — caller proceeds
}

function timingSafeEqual(a: string, b: string): boolean {
  // Constant-time-ish comparison: always walks the longer string's
  // full length so an attacker can't learn the secret's length (or
  // narrow down correct prefix bytes) from response timing.
  const len = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}
