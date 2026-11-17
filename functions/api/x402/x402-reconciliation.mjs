/**
 * x402 — settlement reconciliation engine (read-only, PREPARATION ONLY)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Evaluates a persisted intent + settlement attempt against provider status and
 * on-chain evidence to recommend a reconciliation outcome. NEVER mutates state,
 * NEVER submits, NEVER broadcasts. A recommendation is applied only by a trusted
 * internal transition (settlement-transition) that re-validates evidence.
 *
 * Key principle: an on-chain `authorizationState(owner, nonce) == true` proves the
 * authorization was CONSUMED, but does NOT by itself prove the intended recipient
 * received the exact amount — so a provider-confirmed transaction reference is
 * required before recommending SETTLED.
 */
import {
  SETTLEMENT_STATES,
  classifySubmissionOutcome,
} from './x402-settlement.mjs';
import { getPaymentStatus } from './x402-facilitator.mjs';

// EIP-3009 authorizationState(address,bytes32) selector (confirmed in the
// corrective certification).
const AUTHORIZATION_STATE_SELECTOR = '0xe94a0102';

function padBytes32(hex) {
  const clean = String(hex).replace(/^0x/, '');
  return '0x' + clean.padStart(64, '0');
}

/**
 * Pure classification of a reconciliation recommendation given the attempt,
 * provider status, on-chain authorization-consumed flag and (optional) verified
 * transaction receipt.
 * Returns `{ state, evidence }`.
 */
export function evaluateReconciliation(attempt, providerStatus, onChainAuthorizationUsed, transactionReceipt) {
  if (!attempt) return { state: null, evidence: null };

  // Terminal states are not re-evaluated.
  if (attempt.state === SETTLEMENT_STATES.SETTLED || attempt.state === SETTLEMENT_STATES.FAILED) {
    return { state: attempt.state, evidence: null };
  }

  // A verified on-chain receipt is authoritative evidence.
  if (transactionReceipt && transactionReceipt.status === 1) {
    return {
      state: SETTLEMENT_STATES.SETTLED,
      evidence: {
        classification: 'confirmed',
        transactionHash: transactionReceipt.transactionHash || null,
        finality: transactionReceipt.confirmations >= 1 ? 'confirmed' : 'pending',
      },
    };
  }
  // A reverted transaction is a definitive failure.
  if (transactionReceipt && transactionReceipt.status === 0) {
    return {
      state: SETTLEMENT_STATES.FAILED,
      evidence: { classification: 'definitive_rejection', transactionHash: transactionReceipt.transactionHash || null, reverted: true },
    };
  }

  // Provider-confirmed settlement → SETTLED (authoritative transaction reference).
  if (providerStatus && providerStatus.status === 'completed' && providerStatus.transactionHash) {
    return {
      state: SETTLEMENT_STATES.SETTLED,
      evidence: {
        classification: 'confirmed',
        providerReference: providerStatus.reference || providerStatus.id || null,
        transactionHash: providerStatus.transactionHash,
        finality: 'confirmed',
      },
    };
  }

  // Provider-definitive failure → FAILED.
  if (providerStatus && providerStatus.status === 'failed') {
    return {
      state: SETTLEMENT_STATES.FAILED,
      evidence: { classification: 'definitive_rejection', providerReference: providerStatus.reference || providerStatus.id || null },
    };
  }

  // Pending provider / transaction status is not terminal.
  if (providerStatus && (providerStatus.status === 'pending' || providerStatus.status === 'submitted')) {
    return { state: SETTLEMENT_STATES.SETTLEMENT_UNKNOWN, evidence: { classification: 'ambiguous' } };
  }

  // Authorization consumed on-chain WITHOUT a provider-confirmed recipient is
  // INSUFFICIENT evidence: retain an unresolved state (do not fabricate success).
  if (onChainAuthorizationUsed) {
    return { state: SETTLEMENT_STATES.SETTLEMENT_UNKNOWN, evidence: { classification: 'ambiguous', onChainAuthorizationUsed: true } };
  }

  return { state: SETTLEMENT_STATES.SETTLEMENT_UNKNOWN, evidence: null };
}

/**
 * Read-only on-chain check: EIP-3009 `authorizationState(owner, nonce)` via
 * `eth_call`. Returns `{ ok, used }`. `rpc` is injected (mockable).
 */
export async function queryAuthorizationState(chainRpc, usdcAddress, owner, nonce, rpc) {
  const data = AUTHORIZATION_STATE_SELECTOR + padBytes32(owner).slice(2) + padBytes32(nonce).slice(2);
  let resp;
  try {
    const fetchFn = rpc || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!fetchFn) return { ok: false, error: 'no_rpc' };
    resp = await fetchFn(chainRpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: usdcAddress, data }, 'latest'] }),
    });
  } catch (_) {
    return { ok: false, error: 'rpc_unavailable' };
  }
  let body;
  try { body = await resp.json(); } catch (_) { return { ok: false, error: 'rpc_malformed' }; }
  if (!body || body.error) return { ok: false, error: 'rpc_error' };
  const result = body.result;
  if (typeof result !== 'string') return { ok: false, error: 'rpc_malformed' };
  // `true` is ABI-encoded as ...01; any non-zero return indicates consumed.
  const used = result !== '0x' + '0'.repeat(64);
  return { ok: true, used };
}

/**
 * Read-only reconciliation: fetch provider status (mockable) and on-chain
 * authorization state (mockable), then evaluate. Returns a recommendation that
 * a trusted internal process may apply via settlement-transition.
 */
export async function reconcileSettlement(env, { intent, attempt, providerTransport, rpc }) {
  if (!attempt) return { ok: false, error: 'attempt_not_found' };

  // Provider status (read-only) — best effort.
  let providerStatus = null;
  try {
    const ref = attempt.providerReference;
    if (ref) {
      const res = await getPaymentStatus(env, ref, providerTransport);
      if (res.ok) providerStatus = res.data || null;
    }
  } catch (_) { providerStatus = null; }

  // On-chain authorization state (read-only) — best effort.
  let onChainUsed = false;
  try {
    const chainRpc = (env && env.ARC_RPC_URL) || 'https://rpc.mainnet.arc.io';
    const q = await queryAuthorizationState(chainRpc, intent.assetAddress, intent.walletAddress, intent.authorizationNonce, rpc);
    if (q.ok) onChainUsed = q.used;
  } catch (_) { onChainUsed = false; }

  const rec = evaluateReconciliation(attempt, providerStatus, onChainUsed);
  return { ok: true, recommendation: rec.state, evidence: rec.evidence, providerStatus, onChainAuthorizationUsed: onChainUsed };
}

export { classifySubmissionOutcome };
