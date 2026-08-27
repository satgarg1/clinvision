// Qlinic — shared Supabase service-role client for ABDM Edge Functions.
//
// Every ABDM Edge Function needs to write to tables with no
// client-facing insert/update/delete policy (care_contexts,
// consent_artefacts, health_information_requests, and the ABHA columns
// on patients) - the service-role key is what lets it, bypassing RLS
// entirely, the same way this repo's Postgres `security definer`
// functions already do inside the database itself.
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected
// automatically into every Edge Function's environment by the
// Supabase platform - never set by hand via `supabase secrets set`,
// unlike the ABDM-specific secrets in abdm-token.ts.

import { createClient } from 'npm:@supabase/supabase-js@2';

export function getServiceRoleClient() {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceRoleKey) {
    throw new Error('SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not available in this environment.');
  }
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
