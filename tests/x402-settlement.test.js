/**
 * x402-settlement.test.js — settlement-attempt ledger, atomic claim, ambiguity,
 * evidence integrity and read-only reconciliation.
 * ═══════════════════════════════════════════════════════════════════════════════
 * PREPARATION ONLY: exercises the real DO settlement actions against the mock
 * (serialized) storage, and the pure reconciliation logic. No provider submission,
 * no broadcast, no transfer.
 */
import { describe, it, expect } from 'vitest';
import { Wallet } from 'ethers';
import { X402IntentStore } from '../functions/api/x402/x402-intent.do.js';
import {
  buildTransferWithAuthorization,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
} from '../functions/api/x402/x402-eip712.mjs';
import {
  SETTLEMENT_STATES,
  classifySubmissionOutcome,
  validateSettlementTransition,
} from '../functions/api/x402/x402-settlement.mjs';
import {
  evaluateReconciliation,
  reconcileSettlement,
  queryAuthorizationState,
} from '../functions/api/x402/x402-reconciliation.mjs';

const TEST_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const SECRET = 'test-internal-secret-0123456789abcdef';
const signerAddress = () => new Wallet(TEST_PK).address.toLowerCase();
const ARC_USDC = '0x3600000000000000000000000000000000000000';

/* ── mock DO state (serialized) ──────────────────────────────────────── */
function makeMutex() { let t = Promise.resolve(); return (fn) => { const r = t.then(fn, fn); t = r.catch(() => {}); return r; }; }
function makeDO() {
  const store = new Map();
  const lock = makeMutex();
  const txn = { get: async (k) => store.has(k) ? store.get(k) : undefined, put: async (k, v) => store.set(k, v), delete: async (k) => store.delete(k) };
  const state = { storage: { get: async (k) => store.has(k) ? store.get(k) : undefined, put: async (k, v) => store.set(k, v), delete: async (k) => store.delete(k), setAlarm: async () => {}, deleteAlarm: async () => {}, getAlarm: async () => null, transaction: async (cb) => cb(txn) }, blockConcurrencyWhile: async (cb) => lock(cb), _store: store };
  return { doObj: new X402IntentStore(state, { DO_INTERNAL_SECRET: SECRET }), state };
}

function doFetch(doObj, path, { method = 'GET', body } = {}) {
  return doObj.fetch(new Request('https://do/' + path, { method, headers: { 'X-DO-Internal-Secret': SECRET, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }));
}
async function bodyOf(resp) { return resp.json(); }

function makeIntent(over = {}) {
  return {
    schemaVersion: 1, intentId: crypto.randomUUID(), userId: 'user-1', walletAddress: signerAddress(),
    walletProvider: 'circle', resourceUrl: 'https://api.example.com/x', resourceFingerprint: 'a'.repeat(64),
    requirementDigest: 'b'.repeat(64), scheme: 'exact', network: 'eip155:5042', chainId: 5042,
    assetAddress: ARC_USDC, tokenDecimals: 6, amountAtomic: '1000000', payTo: '0x' + 'cd'.repeat(20),
    maxTimeoutSeconds: 60, authorizationNonce: null, idempotencyKey: 'key-' + crypto.randomUUID().replace(/-/g, ''),
    state: 'CREATED', stateVersion: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), authorizedAt: null, authorizationSignature: null,
    authorizationValidAfter: null, authorizationValidBefore: null, facilitatorVerification: null,
    settlementAttemptId: null, settlementStatus: null, transactionHash: null, settlementEvidence: null, lastErrorCode: null,
    ...over,
  };
}

// Drive an intent to AUTHORIZED and return the AUTHORIZED record.
async function authorizeIntent(doObj, intent) {
  const nonce = '0x' + '11'.repeat(32);
  await doFetch(doObj, 'create', { method: 'POST', body: { intent: { ...intent, state: 'CREATED', stateVersion: 1, authorizationNonce: null }, requestDigest: 'c'.repeat(64) } });
  await doFetch(doObj, 'transition', { method: 'POST', body: { intentId: intent.intentId, to: 'PREPARED', expectedVersion: 1 } });
  await doFetch(doObj, 'reserve-nonce', { method: 'POST', body: { intentId: intent.intentId, nonce, expectedVersion: 2 } });
  const wallet = new Wallet(TEST_PK);
  const td = buildTransferWithAuthorization({ from: intent.walletAddress, to: intent.payTo, value: intent.amountAtomic, validAfter: '0', validBefore: '9999999999', nonce });
  const signature = await wallet.signTypedData(td.domain, TRANSFER_WITH_AUTHORIZATION_TYPES, td.value);
  const authRes = await doFetch(doObj, 'authorize', { method: 'POST', body: { intentId: intent.intentId, expectedVersion: 3, authorization: { from: intent.walletAddress, to: intent.payTo, value: intent.amountAtomic, validAfter: '0', validBefore: '9999999999', nonce, signature } } });
  return (await bodyOf(authRes)).intent;
}

describe('x402 settlement — atomic claim', () => {
  it('50 concurrent claims produce exactly ONE winner', async () => {
    const { doObj } = makeDO();
    const intent = await authorizeIntent(doObj, makeIntent());
    const claims = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        doFetch(doObj, 'claim-settlement', { method: 'POST', body: { intentId: intent.intentId, expectedVersion: 4, idempotencyKey: 'claim-key-' + i, settlementAttemptId: crypto.randomUUID() } })
      )
    );
    const bodies = await Promise.all(claims.map((r) => r.json()));
    const winners = bodies.filter((b) => b.claimed === true);
    const idem = bodies.filter((b) => b.claimed === false);
    expect(winners).toHaveLength(1);
    expect(idem).toHaveLength(49);
    const winnerId = winners[0].attempt.settlementAttemptId;
    for (const b of idem) expect(b.attempt.settlementAttemptId).toBe(winnerId);
  });

  it('duplicate claim with the same idempotency key is idempotent', async () => {
    const { doObj } = makeDO();
    const intent = await authorizeIntent(doObj, makeIntent());
    const attemptId = crypto.randomUUID();
    const a = await doFetch(doObj, 'claim-settlement', { method: 'POST', body: { intentId: intent.intentId, expectedVersion: 4, idempotencyKey: 'claim-same-123', settlementAttemptId: attemptId } });
    const b = await doFetch(doObj, 'claim-settlement', { method: 'POST', body: { intentId: intent.intentId, expectedVersion: 4, idempotencyKey: 'claim-same-123', settlementAttemptId: attemptId } });
    expect((await bodyOf(a)).claimed).toBe(true);
    const bb = await bodyOf(b);
    expect(bb.claimed).toBe(false);
    expect(bb.idempotent).toBe(true);
    expect(bb.attempt.settlementAttemptId).toBe(attemptId);
  });

  it('rejects a claim on a non-AUTHORIZED intent', async () => {
    const { doObj } = makeDO();
    const intent = makeIntent();
    await doFetch(doObj, 'create', { method: 'POST', body: { intent, requestDigest: 'c'.repeat(64) } });
    const res = await doFetch(doObj, 'claim-settlement', { method: 'POST', body: { intentId: intent.intentId, expectedVersion: 1, idempotencyKey: 'claim-key-123', settlementAttemptId: crypto.randomUUID() } });
    const body = await bodyOf(res);
    expect(res.status).toBe(409);
    expect(body.error).toBe('not_authorized');
  });
});

describe('x402 settlement — state machine & ambiguity', () => {
  async function claimedAttempt() {
    const { doObj } = makeDO();
    const intent = await authorizeIntent(doObj, makeIntent());
    const res = await doFetch(doObj, 'claim-settlement', { method: 'POST', body: { intentId: intent.intentId, expectedVersion: 4, idempotencyKey: 'claim-key-123', settlementAttemptId: crypto.randomUUID() } });
    const body = await bodyOf(res);
    return { doObj, attempt: body.attempt };
  }

  it('SETTLEMENT_READY → SUBMITTING → SETTLEMENT_UNKNOWN → SETTLED (with evidence)', async () => {
    const { doObj, attempt } = await claimedAttempt();
    const s1 = await bodyOf(await doFetch(doObj, 'settlement-transition', { method: 'POST', body: { attemptId: attempt.settlementAttemptId, to: 'SUBMITTING', expectedVersion: 1 } }));
    expect(s1.attempt.state).toBe('SUBMITTING');

    // Ambiguous timeout → SETTLEMENT_UNKNOWN.
    const s2 = await bodyOf(await doFetch(doObj, 'settlement-transition', { method: 'POST', body: { attemptId: attempt.settlementAttemptId, to: 'SETTLEMENT_UNKNOWN', expectedVersion: 2, evidence: { classification: 'ambiguous' } } }));
    expect(s2.attempt.state).toBe('SETTLEMENT_UNKNOWN');

    // Reconciled with authoritative evidence → SETTLED.
    const s3 = await bodyOf(await doFetch(doObj, 'settlement-transition', { method: 'POST', body: { attemptId: attempt.settlementAttemptId, to: 'SETTLED', expectedVersion: 3, evidence: { classification: 'confirmed', transactionHash: '0x' + 'aa'.repeat(32), finality: 'confirmed' } } }));
    expect(s3.attempt.state).toBe('SETTLED');
    expect(s3.attempt.transactionHash).toBe('0x' + 'aa'.repeat(32));
  });

  it('rejects READY → SETTLED (must pass through SUBMITTING); SUBMITTING → SUBMITTING is idempotent', async () => {
    const { doObj, attempt } = await claimedAttempt();
    const direct = await bodyOf(await doFetch(doObj, 'settlement-transition', { method: 'POST', body: { attemptId: attempt.settlementAttemptId, to: 'SETTLED', expectedVersion: 1, evidence: { transactionHash: '0x' + 'bb'.repeat(32) } } }));
    expect(direct.error).toBe('invalid_transition');
    await doFetch(doObj, 'settlement-transition', { method: 'POST', body: { attemptId: attempt.settlementAttemptId, to: 'SUBMITTING', expectedVersion: 1 } });
    // A retry of the SAME transition is idempotent (no new submission, no version bump).
    const retry = await bodyOf(await doFetch(doObj, 'settlement-transition', { method: 'POST', body: { attemptId: attempt.settlementAttemptId, to: 'SUBMITTING', expectedVersion: 2 } }));
    expect(retry.idempotent).toBe(true);
    expect(retry.attempt.stateVersion).toBe(2);
  });

  it('SETTLED requires evidence; FAILED requires a definitive rejection', async () => {
    const { doObj, attempt } = await claimedAttempt();
    await doFetch(doObj, 'settlement-transition', { method: 'POST', body: { attemptId: attempt.settlementAttemptId, to: 'SUBMITTING', expectedVersion: 1 } });
    const settledNoEv = await bodyOf(await doFetch(doObj, 'settlement-transition', { method: 'POST', body: { attemptId: attempt.settlementAttemptId, to: 'SETTLED', expectedVersion: 2, evidence: {} } }));
    expect(settledNoEv.error).toBe('settled_requires_evidence');
    const failedNoCls = await bodyOf(await doFetch(doObj, 'settlement-transition', { method: 'POST', body: { attemptId: attempt.settlementAttemptId, to: 'FAILED', expectedVersion: 2, evidence: { classification: 'ambiguous' } } }));
    expect(failedNoCls.error).toBe('failed_requires_definitive_rejection');
  });

  it('contradictory transaction hash is rejected (not silently overwritten)', async () => {
    const { doObj, attempt } = await claimedAttempt();
    await doFetch(doObj, 'settlement-transition', { method: 'POST', body: { attemptId: attempt.settlementAttemptId, to: 'SUBMITTING', expectedVersion: 1 } });
    await doFetch(doObj, 'settlement-transition', { method: 'POST', body: { attemptId: attempt.settlementAttemptId, to: 'SETTLED', expectedVersion: 2, evidence: { classification: 'confirmed', transactionHash: '0x' + 'aa'.repeat(32), finality: 'confirmed' } } });
    const contradictory = await bodyOf(await doFetch(doObj, 'settlement-evidence', { method: 'POST', body: { attemptId: attempt.settlementAttemptId, expectedVersion: 3, evidence: { transactionHash: '0x' + 'bb'.repeat(32) } } }));
    expect(contradictory.error).toBe('contradictory_evidence');
  });
});

describe('x402 settlement — pure model & reconciliation', () => {
  it('classifies timeouts/network errors as ambiguous (never terminal)', () => {
    expect(classifySubmissionOutcome({ timeout: true }).state).toBe(SETTLEMENT_STATES.SETTLEMENT_UNKNOWN);
    expect(classifySubmissionOutcome({ networkError: true }).state).toBe(SETTLEMENT_STATES.SETTLEMENT_UNKNOWN);
    expect(classifySubmissionOutcome({ providerRejected: true, definitive: true }).state).toBe(SETTLEMENT_STATES.FAILED);
    expect(classifySubmissionOutcome({ providerReference: 'p1' }).state).toBe(SETTLEMENT_STATES.SETTLED);
  });

  it('validateSettlementTransition enforces evidence invariants', () => {
    expect(validateSettlementTransition('SUBMITTING', 'SETTLED', {}).ok).toBe(false);
    expect(validateSettlementTransition('SUBMITTING', 'SETTLED', { transactionHash: '0x' + 'aa'.repeat(32) }).ok).toBe(true);
    expect(validateSettlementTransition('SUBMITTING', 'FAILED', { classification: 'ambiguous' }).ok).toBe(false);
    expect(validateSettlementTransition('SUBMITTING', 'FAILED', { classification: 'definitive_rejection' }).ok).toBe(true);
  });

  it('evaluateReconciliation recommends SETTLED on provider completion, FAILED on provider failure, UNKNOWN on on-chain-consumed-only', () => {
    const base = { state: 'SUBMITTING', providerReference: null };
    expect(evaluateReconciliation(base, { status: 'completed', transactionHash: '0x' + 'aa'.repeat(32), reference: 'r1' }, false).state).toBe(SETTLEMENT_STATES.SETTLED);
    expect(evaluateReconciliation(base, { status: 'failed', reference: 'r1' }, false).state).toBe(SETTLEMENT_STATES.FAILED);
    // On-chain consumed but no provider-confirmed recipient → remains UNKNOWN (no fabricated success).
    expect(evaluateReconciliation(base, null, true).state).toBe(SETTLEMENT_STATES.SETTLEMENT_UNKNOWN);
    expect(evaluateReconciliation({ state: 'SETTLED' }, null, false).state).toBe(SETTLEMENT_STATES.SETTLED);
  });

  it('queryAuthorizationState performs a read-only eth_call (mockable) and detects used', async () => {
    const rpc = async (_url, init) => {
      expect(JSON.parse(init.body).method).toBe('eth_call');
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + '0'.repeat(63) + '1' }), { status: 200 });
    };
    const res = await queryAuthorizationState('https://rpc', ARC_USDC, '0x' + 'ab'.repeat(20), '0x' + '11'.repeat(32), rpc);
    expect(res.ok).toBe(true);
    expect(res.used).toBe(true);
  });

  it('reconcileSettlement recommends from provider status without mutating state', async () => {
    const intent = { assetAddress: ARC_USDC, walletAddress: '0x' + 'ab'.repeat(20), authorizationNonce: '0x' + '11'.repeat(32) };
    const attempt = { state: 'SETTLEMENT_UNKNOWN', providerReference: 'p1' };
    const providerTransport = async () => new Response(JSON.stringify({ data: { status: 'completed', transactionHash: '0x' + 'aa'.repeat(32), reference: 'p1' } }), { status: 200 });
    const rpc = async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + '0'.repeat(64) }), { status: 200 });
    const res = await reconcileSettlement({ CIRCLE_API_KEY: 'k', ARC_RPC_URL: 'https://rpc' }, { intent, attempt, providerTransport, rpc });
    expect(res.ok).toBe(true);
    expect(res.recommendation).toBe(SETTLEMENT_STATES.SETTLED);
    expect(res.evidence.transactionHash).toBe('0x' + 'aa'.repeat(32));
  });
});
