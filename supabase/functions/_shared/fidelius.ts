// Qlinic — ABDM/Fidelius-spec ECDH + HKDF + AES-256-GCM encryption,
// used only by hip-health-info-request to encrypt a FHIR bundle for
// the requesting HIU.
//
// Algorithm, sourced from NHA's own "Encryption and Decryption
// Implementation Guidelines for FHIR data in ABDM" (the Fidelius
// spec), not hand-derived from a general description:
//   https://github.com/mgrmtech/fidelius-cli/blob/main/abdm/Encryption%20and%20Decryption%20Implementation%20Guidelines%20for%20FHIR%20data%20in%20ABDM.md
// - Curve: Curve25519 (X25519) for ECDH key exchange.
// - Each party generates a fresh ephemeral X25519 key pair AND a
//   fresh 32-byte random nonce PER TRANSACTION - never reused. That's
//   what gives this forward secrecy: compromising one transaction's
//   keys never exposes any other transaction's data.
// - salt = first 20 bytes of (ourNonce XOR theirNonce)
// - iv   = last 12 bytes of (ourNonce XOR theirNonce)
//   (20 + 12 = 32 - the same 32-byte XOR result split into two
//   non-overlapping pieces, nothing left over)
// - sharedSecret = X25519(ourPrivateKey, theirPublicKey)
// - aesKey = HKDF-SHA256(ikm=sharedSecret, salt=salt, info=<empty>, length=256 bits)
// - ciphertext = AES-256-GCM(aesKey, iv, plaintext=FHIR bundle JSON)
//
// THIS IS THE HIGHEST-RISK MODULE IN THE ABDM INTEGRATION (see
// plans/robust-questing-walrus.md's Risk callout) - it handles real
// patient health data. Before Milestone D ever calls this against a
// live HIU:
//   1. Validate against NHA's own published Fidelius test vectors, if
//      any can be obtained, rather than trusting this module on the
//      strength of these comments alone - they describe the intended
//      algorithm accurately as sourced, but have not been validated
//      against a real HIU round-trip.
//   2. Get an independent security review of this file specifically -
//      a mistake in salt/IV construction or a nonce-reuse bug is a
//      real data-exposure bug, not a cosmetic one.
//   3. Confirm the deployed Supabase Edge Functions Deno runtime's
//      crypto.subtle actually implements the "X25519" algorithm name
//      (a newer Web Crypto API addition) before relying on it - do
//      not assume from this code alone.

export interface GeneratedKeyMaterial {
  privateKey: CryptoKey;
  /** Raw 32-byte X25519 public key, base64-encoded - send this to the HIU. */
  publicKeyB64: string;
  /** Raw 32-byte random nonce, base64-encoded - send this to the HIU. */
  nonceB64: string;
  nonce: Uint8Array;
}

/**
 * Generates this side's ephemeral X25519 key pair + fresh nonce for
 * one transaction. Never reuse the result across transactions - a
 * fresh call per health-information/request is required.
 */
export async function generateKeyMaterial(): Promise<GeneratedKeyMaterial> {
  const keyPair = await crypto.subtle.generateKey(
    // deno-lint-ignore no-explicit-any
    { name: 'X25519' } as any,
    true,
    ['deriveBits'],
  ) as CryptoKeyPair;
  const rawPublicKey = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  return {
    privateKey: keyPair.privateKey,
    publicKeyB64: toBase64(new Uint8Array(rawPublicKey)),
    nonceB64: toBase64(nonce),
    nonce,
  };
}

/**
 * Encrypts `plaintext` (the FHIR bundle, as a UTF-8 JSON string) for
 * the HIU, given our own generated key material (from
 * generateKeyMaterial()) and the HIU's public key + nonce, both
 * base64, exactly as received in the health-information/request
 * callback's `hiRequest.keyMaterial` field. Returns the ciphertext,
 * base64-encoded - send it alongside our own publicKeyB64/nonceB64
 * (the HIU needs both to derive the same key and decrypt).
 */
export async function encryptForHiu(
  plaintext: string,
  ours: GeneratedKeyMaterial,
  theirPublicKeyB64: string,
  theirNonceB64: string,
): Promise<string> {
  const theirPublicKeyRaw = fromBase64(theirPublicKeyB64);
  const theirPublicKey = await crypto.subtle.importKey(
    'raw',
    theirPublicKeyRaw,
    // deno-lint-ignore no-explicit-any
    { name: 'X25519' } as any,
    false,
    [],
  );

  const sharedSecretBits = await crypto.subtle.deriveBits(
    // deno-lint-ignore no-explicit-any
    { name: 'X25519', public: theirPublicKey } as any,
    ours.privateKey,
    256,
  );

  const theirNonce = fromBase64(theirNonceB64);
  const xored = xorBytes(ours.nonce, theirNonce);
  const salt = xored.slice(0, 20);
  const iv = xored.slice(xored.length - 12);

  const hkdfKey = await crypto.subtle.importKey('raw', sharedSecretBits, 'HKDF', false, ['deriveKey']);
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new Uint8Array(0) },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );

  const plaintextBytes = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plaintextBytes);
  return toBase64(new Uint8Array(ciphertext));
}

function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const len = Math.min(a.length, b.length);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = a[i] ^ b[i];
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
