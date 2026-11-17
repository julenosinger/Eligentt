/**
 * x402 — facilitator verification pipeline (verification-only, non-settling)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Ties together: durable intent loading → ownership/state checks → LOCAL EIP-712
 * signature revalidation → facilitator capability check → (gated) /verify →
 * verification-evidence persistence → safe status.
 *
 * SECURITY:
 *   - Verification is NOT settlement. A `verified` result never transitions the
 *     intent to SETTLED and never submits a transfer.
 *   - Signed terms are revalidated locally against the persisted intent — never
 *     rebuilt from browser input.
 *   - Provider verification is gated (`X402_FACILITATOR_VERIFY`); when off, the
 *     pipeline reports `unverified` and never calls the provider. Tests inject a
 *     mock transport for the /supported + /verify calls.
 *   - The executable signature never appears in the returned status.
 */
import {
  buildTransferWithAuthorization,
  verifyTransferWithAuthorization,
} from './x402-eip712.mjs';
import {
  fetchSupported,
  parseSupported,
  verifySupportedCapability,
  buildPaymentPayload,
  buildVerificationRequest,
  verifyPayment,
  verifyEnabled,
} from './x402-facilitator.mjs';
import { doRecordVerification } from './intent-service.mjs';

/**
 * Revalidate a persisted AUTHORIZED intent's signature and validity window
 * locally (offline, authoritative). Returns `{ ok, reason? }`.
 */
export function revalidateAuthorization(intent) {
  if (!intent) return { ok: false, reason: 'intent_not_found' };
  if (intent.state !== 'AUTHORIZED') return { ok: false, reason: 'not_authorized' };
  if (typeof intent.authorizationSignature !== 'string') return { ok: false, reason: 'signature_missing' };

  const td = buildTransferWithAuthorization({
    from: intent.walletAddress,
    to: intent.payTo,
    value: intent.amountAtomic,
    validAfter: intent.authorizationValidAfter,
    validBefore: intent.authorizationValidBefore,
    nonce: intent.authorizationNonce,
  });
  const verified = verifyTransferWithAuthorization(td, intent.authorizationSignature, intent.walletAddress);
  if (!verified.ok) return { ok: false, reason: verified.reason };

  // Validity window (trusted server clock; BigInt, no rounding).
  let va, vb, nowSec;
  try {
    va = BigInt(intent.authorizationValidAfter);
    vb = BigInt(intent.authorizationValidBefore);
    nowSec = BigInt(Math.floor(Date.now() / 1000));
  } catch (_) {
    return { ok: false, reason: 'invalid_validity_window' };
  }
  if (nowSec > vb) return { ok: false, reason: 'authorization_expired' };
  if (nowSec < va) return { ok: false, reason: 'authorization_not_yet_valid' };

  return { ok: true };
}

/**
 * Full verification pipeline. `intent` is the authoritative persisted record
 * (already ownership-checked by the caller through the service layer).
 *
 * Returns a SAFE status: `{ ok, status: verified|rejected|unverified|unknown,
 * reason?, verification? }` — never the signature.
 */
export async function verifyIntent(env, { intent, walletAddress, userId }) {
  if (!intent) return { ok: false, status: 'rejected', reason: 'intent_not_found' };
  if (String(intent.userId) !== String(userId)) return { ok: false, status: 'rejected', reason: 'unauthorized' };
  if (String(intent.walletAddress).toLowerCase() !== String(walletAddress).toLowerCase()) {
    return { ok: false, status: 'rejected', reason: 'wallet_mismatch' };
  }

  // 1. Local revalidation (authoritative, offline).
  const local = revalidateAuthorization(intent);
  if (!local.ok) return { ok: false, status: 'rejected', reason: local.reason };

  // 2. Provider verification is gated: when disabled, never call the provider.
  if (!verifyEnabled(env)) {
    return { ok: false, status: 'unverified', reason: 'facilitator_verification_disabled', localValid: true };
  }

  // 3. Capability check (read-only).
  const supported = await fetchSupported(env);
  if (!supported.ok) return { ok: false, status: 'unknown', reason: supported.error };
  const parsed = parseSupported(supported.data);
  if (!parsed.ok) return { ok: false, status: 'unknown', reason: parsed.error };
  const cap = verifySupportedCapability(parsed.capabilities, {
    network: intent.network,
    scheme: 'exact',
    asset: intent.assetAddress,
    decimals: intent.tokenDecimals,
  });
  if (!cap.ok) return { ok: false, status: 'rejected', reason: cap.reason };

  // 4. Provider /verify (non-settling).
  const payload = buildPaymentPayload(intent);
  const req = buildVerificationRequest(payload);
  const res = await verifyPayment(env, req);

  const status = !res.ok ? 'unknown' : (res.isValid ? 'verified' : 'rejected');
  const verification = {
    status,
    isValid: res.ok ? res.isValid : false,
    invalidReason: res.ok ? (res.invalidReason || null) : res.error,
    checkedAt: new Date().toISOString(),
  };

  // 5. Persist evidence (best-effort; never blocks the safe status).
  let persisted = null;
  try {
    const recordRes = await doRecordVerification(env, walletAddress, userId, intent.intentId, intent.stateVersion, verification);
    if (recordRes.ok) persisted = recordRes.body.intent.facilitatorVerification;
  } catch (_) { /* persistence is non-authoritative for the verification result */ }

  return {
    ok: status === 'verified',
    status,
    reason: verification.invalidReason || (res.ok ? null : res.error),
    verification: persisted || verification,
  };
}
