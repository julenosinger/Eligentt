/**
 * x402 — settlement orchestrator (PREPARATION ONLY — no live submission)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Isolated orchestration that ties the durable intent → authorization validation
 * → atomic settlement claim → submission-intent persistence → (simulated) outcome
 * classification → evidence persistence into one auditable flow.
 *
 * The live provider submission path is HARD-DISABLED: `liveSettlementEnabled()`
 * is always false in this phase (a feature flag alone is insufficient; live
 * settlement additionally requires an explicit, separately-approved operator
 * context that does not exist yet). No browser may invoke settlement.
 */
import {
  doGetIntent,
  doClaimSettlement,
  doSettlementTransition,
} from './intent-service.mjs';
import { revalidateAuthorization } from './x402-verification.mjs';
import {
  buildPaymentPayload,
  buildVerificationRequest,
  verifyEnabled,
} from './x402-facilitator.mjs';
import { classifySubmissionOutcome, SETTLEMENT_STATES } from './x402-settlement.mjs';

/** Live settlement is NEVER enabled in this phase (feature flag is insufficient). */
export function liveSettlementEnabled() {
  return false;
}

/**
 * Prepare a settlement: revalidate the authorization, acquire the atomic claim,
 * persist SUBMITTING intent, and return the prepared provider request. This is
 * the pre-submission boundary — it never calls the provider.
 */
export async function prepareSettlement(env, { intent, walletAddress, userId, idempotencyKey, settlementAttemptId }) {
  if (!intent) return { ok: false, status: 'rejected', reason: 'intent_not_found' };
  if (String(intent.userId) !== String(userId)) return { ok: false, status: 'rejected', reason: 'unauthorized' };
  if (String(intent.walletAddress).toLowerCase() !== String(walletAddress).toLowerCase()) {
    return { ok: false, status: 'rejected', reason: 'wallet_mismatch' };
  }

  // Local authorization revalidation (signature + window + exact terms).
  const local = revalidateAuthorization(intent);
  if (!local.ok) return { ok: false, status: 'rejected', reason: local.reason };

  // Verification freshness: require a prior verified status before settlement.
  const v = intent.facilitatorVerification;
  if (!v || v.status !== 'verified') {
    return { ok: false, status: 'rejected', reason: 'verification_required' };
  }

  // Acquire the atomic settlement claim (one claim per authorization).
  const claim = await doClaimSettlement(env, walletAddress, userId, intent.intentId, intent.stateVersion, idempotencyKey, settlementAttemptId);
  if (!claim.ok) {
    if (claim.error === 'claim_conflict') return { ok: false, status: 'rejected', reason: 'claim_conflict' };
    return { ok: false, status: 'unknown', reason: claim.error };
  }
  const attempt = claim.body.attempt;

  // Persist SUBMITTING intent (transition from SETTLEMENT_READY).
  let current = attempt;
  if (attempt.state === SETTLEMENT_STATES.SETTLEMENT_READY) {
    const sub = await doSettlementTransition(env, walletAddress, userId, attempt.settlementAttemptId, 'SUBMITTING', attempt.stateVersion, { classification: 'prepared' });
    if (sub.ok) current = sub.body.attempt;
  }

  const providerRequest = buildVerificationRequest(buildPaymentPayload(intent));
  return { ok: true, status: 'prepared', attempt: current, providerRequest };
}

/**
 * Classify a (simulated) provider submission outcome and persist the
 * corresponding settlement transition. Timeouts/network errors are ambiguous
 * (SETTLEMENT_UNKNOWN), never terminal, never auto-retried.
 */
export async function recordSettlementOutcome(env, { attempt, walletAddress, userId, outcome }) {
  if (!attempt) return { ok: false, reason: 'attempt_not_found' };
  const classification = classifySubmissionOutcome(outcome);
  const to = classification.state;

  const evidence = {
    classification: classification.classification,
    providerReference: outcome && outcome.providerReference ? outcome.providerReference : null,
    transactionHash: outcome && outcome.transactionHash ? outcome.transactionHash : null,
    finality: outcome && outcome.transactionHash ? 'confirmed' : null,
  };

  const res = await doSettlementTransition(env, walletAddress, userId, attempt.settlementAttemptId, to, attempt.stateVersion, evidence);
  if (!res.ok) return { ok: false, reason: res.error };
  return { ok: true, status: to, attempt: res.body.attempt };
}

/**
 * Full (simulated) settlement orchestration: prepare → classify a MOCKED outcome
 * → persist. The live provider call is never performed. Returns a safe status.
 */
export async function orchestrateSettlement(env, { intent, walletAddress, userId, idempotencyKey, settlementAttemptId, mockOutcome }) {
  if (liveSettlementEnabled()) {
    return { ok: false, status: 'rejected', reason: 'live_settlement_not_permitted' };
  }
  const prepared = await prepareSettlement(env, { intent, walletAddress, userId, idempotencyKey, settlementAttemptId });
  if (!prepared.ok) return prepared;

  // Simulated outcome (no provider call). Defaults to ambiguous (unknown).
  const outcome = mockOutcome || { timeout: true };
  const recorded = await recordSettlementOutcome(env, { attempt: prepared.attempt, walletAddress, userId, outcome });
  return recorded;
}
