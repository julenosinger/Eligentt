/**
 * x402 — operator settlement approval validation (mocked contexts only)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Explicit, cryptographically-authenticated operator authorization required before
 * any future controlled settlement. A feature flag is NEVER sufficient.
 *
 * An approval binds: unique id, operator identity, chain, token, sender,
 * recipient, max amount, fee ceiling, settlement attempt id, expiry, issue time —
 * and is HMAC-SHA256 signed with a server-side secret. It is one-time-use and
 * revocable.
 *
 * SECURITY:
 *   - Never accepts a client-generated approval as authoritative.
 *   - No general-purpose API key bypasses the approval requirement.
 *   - The HMAC secret never leaves the server; the signature never appears in
 *     browser responses.
 *
 * This module is the VALIDATION LAYER only. It does not create or activate any
 * live operator approval, and it never triggers financial execution.
 */

export const APPROVAL_FIELDS = Object.freeze([
  'id', 'operator', 'chainId', 'tokenAddress', 'sender', 'recipient',
  'maxAmountAtomic', 'feeCeiling', 'settlementAttemptId', 'expiresAt', 'issuedAt',
]);

function canonical(approval) {
  return JSON.stringify(APPROVAL_FIELDS.map((f) => String(approval[f] == null ? '' : approval[f])));
}

async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Build (sign) an operator approval. `opts.maxAmountAtomic` and `feeCeiling` are
 * canonical atomic decimal strings (exact, never Number).
 */
export async function buildApproval(opts, secret) {
  const approval = {
    id: opts.id,
    operator: opts.operator,
    chainId: Number(opts.chainId),
    tokenAddress: String(opts.tokenAddress).toLowerCase(),
    sender: String(opts.sender).toLowerCase(),
    recipient: String(opts.recipient).toLowerCase(),
    maxAmountAtomic: String(opts.maxAmountAtomic),
    feeCeiling: String(opts.feeCeiling || '0'),
    settlementAttemptId: opts.settlementAttemptId,
    expiresAt: Number(opts.expiresAt),
    issuedAt: Number(opts.issuedAt || Date.now()),
    signature: '',
  };
  approval.signature = await hmacHex(secret, canonical(approval));
  return approval;
}

/**
 * Validate an operator approval against a settlement request. Verifies the HMAC
 * signature, all bound fields, expiry, one-time-use and revocation.
 *
 * `request`: { chainId, tokenAddress, sender, recipient, amountAtomic, settlementAttemptId }
 * `state`:   { usedIds:Set, revokedIds:Set, now:number }
 */
export async function validateApproval(secret, approval, request, state) {
  const s = state || {};
  if (!approval || typeof approval !== 'object') return { ok: false, reason: 'approval_missing' };
  if (!secret) return { ok: false, reason: 'approval_secret_unconfigured' };

  // 1. Cryptographic authentication (HMAC).
  const expected = await hmacHex(secret, canonical({ ...approval, signature: '' }));
  if (expected !== approval.signature) return { ok: false, reason: 'approval_signature_invalid' };

  // 2. Expiry.
  const now = Number.isFinite(s.now) ? s.now : Date.now();
  if (now >= approval.expiresAt) return { ok: false, reason: 'approval_expired' };

  // 3. One-time-use + revocation.
  if (s.usedIds && s.usedIds.has(approval.id)) return { ok: false, reason: 'approval_already_used' };
  if (s.revokedIds && s.revokedIds.has(approval.id)) return { ok: false, reason: 'approval_revoked' };

  // 4. Exact field binding (all comparisons exact / lowercase).
  if (Number(approval.chainId) !== Number(request.chainId)) return { ok: false, reason: 'chain_mismatch' };
  if (String(approval.tokenAddress).toLowerCase() !== String(request.tokenAddress).toLowerCase()) return { ok: false, reason: 'token_mismatch' };
  if (String(approval.sender).toLowerCase() !== String(request.sender).toLowerCase()) return { ok: false, reason: 'sender_mismatch' };
  if (String(approval.recipient).toLowerCase() !== String(request.recipient).toLowerCase()) return { ok: false, reason: 'recipient_mismatch' };
  if (String(approval.settlementAttemptId) !== String(request.settlementAttemptId)) return { ok: false, reason: 'attempt_mismatch' };

  // 5. Amount bound (exact BigInt atomic comparison, never Number).
  let maxAmount, amount;
  try { maxAmount = BigInt(approval.maxAmountAtomic); amount = BigInt(request.amountAtomic); } catch (_) {
    return { ok: false, reason: 'invalid_amount' };
  }
  if (amount <= 0n) return { ok: false, reason: 'invalid_amount' };
  if (amount > maxAmount) return { ok: false, reason: 'amount_exceeds_approval' };

  return { ok: true, approvalId: approval.id };
}
