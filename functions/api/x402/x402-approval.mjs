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

async function sha256Hex(data) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Canonical fingerprint (SHA-256) of a signed approval, for durable consumption
 * binding. Not the raw HMAC signature (avoid persisting the raw auth material).
 */
export async function approvalFingerprint(approval) {
  return sha256Hex(canonical(approval) + ':' + approval.signature);
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

/**
 * P0.2 — durable, atomic approval consumption. Validates the HMAC + scope +
 * expiry, then atomically consumes the approval through the Durable Object
 * (one-time-use, survives restart, exactly one winner under concurrency).
 */
export async function consumeApprovalDurable(env, { approval, request, walletAddress, userId, state }) {
  const secret = (env && env.X402_OPERATOR_APPROVAL_SECRET) || '';
  const v = await validateApproval(secret, approval, request, state);
  if (!v.ok) return { ok: false, reason: v.reason };

  const fp = await approvalFingerprint(approval);
  // Deferred import avoids a cycle at module load (intent-service imports _x402).
  const { doConsumeApproval } = await import('./intent-service.mjs');
  const res = await doConsumeApproval(env, walletAddress, userId, approval.id, fp, request.settlementAttemptId);
  if (!res.ok) {
    if (res.error === 'approval_revoked') return { ok: false, reason: 'approval_revoked' };
    if (res.error === 'approval_conflict') return { ok: false, reason: 'approval_conflict' };
    return { ok: false, reason: res.error };
  }
  return { ok: true, consumed: res.body.consumed, already: !!res.body.already };
}
