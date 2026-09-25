// Qlinic — staff-session authentication for abha-verify, the one
// function in this integration called from a browser rather than
// ABDM's Gateway (see gateway-auth.ts for the Gateway-facing check).
//
// abha-verify runs with the service-role client, bypassing RLS
// entirely, so it must enforce clinic scoping itself exactly the way
// every my_clinic_id()-gated RPC does at the database layer — without
// this, any caller who knows a patientId (sequential-feeling but
// really just a UUID reachable from other, legitimate API responses)
// could overwrite that patient's ABHA identity regardless of which
// clinic they belong to.

import { getServiceRoleClient } from './supabase-client.ts';

export interface StaffContext {
  userId: string;
  clinicId: string;
}

type AuthResult =
  | { ok: true; staff: StaffContext }
  | { ok: false; status: number; error: string };

export async function requireStaffSession(
  req: Request,
  supabase: ReturnType<typeof getServiceRoleClient>,
): Promise<AuthResult> {
  const auth = req.headers.get('Authorization') || '';
  const jwt = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!jwt) {
    return { ok: false, status: 401, error: 'Missing Authorization header.' };
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(jwt);
  if (userError || !userData?.user) {
    return { ok: false, status: 401, error: 'Invalid or expired session.' };
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('clinic_id, is_active')
    .eq('id', userData.user.id)
    .maybeSingle();

  if (!profile || !profile.is_active || !profile.clinic_id) {
    return { ok: false, status: 403, error: 'Account is not an active clinic staff member.' };
  }

  return { ok: true, staff: { userId: userData.user.id, clinicId: profile.clinic_id } };
}

/** Confirms `patientId` belongs to `clinicId` — the same boundary every my_clinic_id()-scoped RPC enforces. */
export async function patientBelongsToClinic(
  supabase: ReturnType<typeof getServiceRoleClient>,
  patientId: string,
  clinicId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('patients')
    .select('id')
    .eq('id', patientId)
    .eq('clinic_id', clinicId)
    .maybeSingle();
  return !!data;
}
