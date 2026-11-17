/**
 * x402 — settlement-attempt ledger model (pure; PREPARATION ONLY)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Durable settlement lifecycle, kept SEPARATE from the intent state machine so
 * the signed intent (AUTHORIZED) is never mutated by settlement tracking.
 *
 *   SETTLEMENT_READY → SUBMITTING → SETTLEMENT_UNKNOWN → SETTLED | FAILED
 *                                    ↘ SETTLED | FAILED
 *
 * Invariants:
 *   - No direct READY → SETTLED (must pass through SUBMITTING).
 *   - No SUBMITTING → SUBMITTING (no automatic retry after ambiguity).
 *   - SETTLED requires authoritative evidence (transaction hash / provider ref).
 *   - FAILED requires a definitive rejection (never a timeout).
 *   - SETTLEMENT_UNKNOWN is a resting state, reconciled via evidence only.
 *
 * No transition here performs a real provider submission or broadcast; all
 * provider interactions are gated behind disabled execution flags.
 */

export const SETTLEMENT_STATES = Object.freeze({
  SETTLEMENT_READY:    'SETTLEMENT_READY',
  SUBMITTING:          'SUBMITTING',
  SETTLEMENT_UNKNOWN:  'SETTLEMENT_UNKNOWN',
  SETTLED:             'SETTLED',
  FAILED:              'FAILED',
});

export const SETTLEMENT_TERMINAL = new Set(['SETTLED', 'FAILED']);

export const SETTLEMENT_TRANSITIONS = Object.freeze({
  SETTLEMENT_READY:   ['SUBMITTING'],
  SUBMITTING:         ['SETTLEMENT_UNKNOWN', 'SETTLED', 'FAILED'],
  SETTLEMENT_UNKNOWN: ['SETTLED', 'FAILED'],
  SETTLED:            [],
  FAILED:             [],
});

/**
 * Canonical, immutable authorization fingerprint: SHA-256 of the exact signed
 * terms + signature. Binds a settlement claim to one specific authorization.
 */
export async function authorizationFingerprintOf(intent) {
  const canon = JSON.stringify([
    String(intent.chainId),
    String(intent.assetAddress).toLowerCase(),
    String(intent.walletAddress).toLowerCase(),
    String(intent.amountAtomic),
    String(intent.payTo).toLowerCase(),
    String(intent.authorizationValidAfter),
    String(intent.authorizationValidBefore),
    String(intent.authorizationNonce).toLowerCase(),
    String(intent.authorizationSignature),
  ]);
  const data = new TextEncoder().encode(canon);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Nonce namespace key (chainId, token, authorizer, nonce). */
export function authorizationNonceKey(intent) {
  return [
    String(intent.chainId),
    String(intent.assetAddress).toLowerCase(),
    String(intent.walletAddress).toLowerCase(),
    String(intent.authorizationNonce).toLowerCase(),
  ].join(':');
}

/** Build a new settlement attempt record (pure). */
export function buildSettlementAttempt(opts) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    settlementAttemptId: opts.settlementAttemptId,
    intentId: opts.intent.intentId,
    userId: opts.intent.userId,
    walletAddress: opts.intent.walletAddress,
    authorizationFingerprint: opts.authorizationFingerprint,
    nonceKey: opts.nonceKey,
    chainId: opts.intent.chainId,
    tokenAddress: opts.intent.assetAddress,
    amountAtomic: opts.intent.amountAtomic,
    payTo: opts.intent.payTo,
    state: SETTLEMENT_STATES.SETTLEMENT_READY,
    stateVersion: 1,
    idempotencyKey: opts.idempotencyKey,
    providerReference: null,
    transactionHash: null,
    createdAt: now,
    updatedAt: now,
    evidence: [],
  };
}

/**
 * Validate a settlement transition. Returns `{ ok, reason? }`. Enforces:
 * allowlisted source→target, SETTLED requires evidence, FAILED requires a
 * definitive classification (not 'unknown').
 */
export function validateSettlementTransition(from, to, evidence) {
  if (!SETTLEMENT_STATES[to]) return { ok: false, reason: 'unknown_state' };
  const allowed = SETTLEMENT_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) return { ok: false, reason: 'invalid_transition', from, to, allowed };

  if (to === SETTLEMENT_STATES.SETTLED) {
    const hasTx = !!(evidence && evidence.transactionHash);
    const hasProviderRef = !!(evidence && evidence.providerReference && evidence.finality === 'confirmed');
    if (!hasTx && !hasProviderRef) {
      return { ok: false, reason: 'settled_requires_evidence' };
    }
  }
  if (to === SETTLEMENT_STATES.FAILED) {
    const definitive = !!(evidence && evidence.classification === 'definitive_rejection');
    if (!definitive) {
      return { ok: false, reason: 'failed_requires_definitive_rejection' };
    }
  }
  return { ok: true };
}

/**
 * Classify a submission outcome. `timeout`/`network_error`/`lost_response` are
 * ambiguous (SETTLEMENT_UNKNOWN), never terminal. Definitive 4xx rejections are
 * terminal failures. Provider success with a reference is SETTLED.
 */
export function classifySubmissionOutcome(outcome) {
  if (!outcome) return { classification: 'ambiguous', state: SETTLEMENT_STATES.SETTLEMENT_UNKNOWN };
  if (outcome.timeout || outcome.networkError || outcome.lostResponse) {
    return { classification: 'ambiguous', state: SETTLEMENT_STATES.SETTLEMENT_UNKNOWN };
  }
  if (outcome.providerRejected && outcome.definitive) {
    return { classification: 'definitive_rejection', state: SETTLEMENT_STATES.FAILED };
  }
  if (outcome.providerReference || outcome.transactionHash) {
    return { classification: 'confirmed', state: SETTLEMENT_STATES.SETTLED };
  }
  return { classification: 'ambiguous', state: SETTLEMENT_STATES.SETTLEMENT_UNKNOWN };
}
