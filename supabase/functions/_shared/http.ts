// Qlinic — tiny shared HTTP response helpers for ABDM Edge Functions.

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Only abha-verify is ever called from a browser (the six ABDM
// callback paths are server-to-server, called by ABDM's Gateway, and
// never need CORS) - kept here anyway so every function has it
// available without duplicating the header list by hand.
export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
