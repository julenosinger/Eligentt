/**
 * x402-settlement-orchestrator.test.js — settlement orchestration (simulated)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Tests the settlement orchestrator against the real DO (mock storage) with a
 * MOCKED provider outcome. The live provider path is hard-disabled. No broadcast,
 * no transfer, no settlement.
 */
import { describe, it, expect } from 'vitest';
import { Wallet } from 'ethers';
import { X402IntentStore } from '../functions/api/x402/x402-intent.do.js';
import { buildTransferWithAuthorization, TRANSFER_WITH_AUTHORIZATION_TYPES } from '../functions/api/x402/x402-eip712.mjs';
import {
  liveSettlementEnabled,
  prepareSettlement,
  recordSettlementOutcome,
  orchestrateSettlement,
} from '../functions/api/x402/x402-settlement-orchestrator.mjs';

const TEST_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const SECRET = 'test-internal-secret-0123456789abcdef';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const signerAddress = () => new Wallet(TEST_PK).address.toLowerCase();

function makeMutex() { let t = Promise.resolve(); return (fn) => { const r = t.then(fn, fn); t = r.catch(() => {}); return r; }; }
function makeDOBinding() {
  const instances = new Map();
  return {
    idFromName(name) { return { __name: String(name) }; },
    get(id) {
      const name = id.__name;
      if (!instances.has(name)) {
        const store = new Map();
        const lock = makeMutex();
        const txn = { get: async (k) => store.has(k) ? store.get(k) : undefined, put: async (k, v) => store.set(k, v), delete: async (k) => store.delete(k) };
        const state = { storage: { get: async (k) => store.has(k) ? store.get(k) : undefined, put: async (k, v) => store.set(k, v), delete: async (k) => store.delete(k), setAlarm: async () => {}, deleteAlarm: async () => {}, getAlarm: async () => null, transaction: async (cb) => cb(txn) }, blockConcurrencyWhile: async (cb) => lock(cb) };
        instances.set(name, new X402IntentStore(state, { DO_INTERNAL_SECRET: SECRET }));
      }
      const doObj = instances.get(name);
      return { fetch: (url, opts) => doObj.fetch(new Request(url, opts)) };
    },
    _instances: instances,
  };
}

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

async function doFetch(stub, path, { method = 'GET', body } = {}) {
  return stub.fetch('https://do/' + path, { method, headers: { 'X-DO-Internal-Secret': SECRET, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
}
async function bodyOf(resp) { return resp.json(); }

// Drive an intent to AUTHORIZED + VERIFIED, returning the full record.
async function authorizedAndVerified(binding) {
  const intent = makeIntent();
  const stub = binding.get(binding.idFromName(intent.walletAddress));
  await doFetch(stub, 'create', { method: 'POST', body: { intent, requestDigest: 'c'.repeat(64) } });
  await doFetch(stub, 'transition', { method: 'POST', body: { intentId: intent.intentId, to: 'PREPARED', expectedVersion: 1 } });
  const nonce = '0x' + '11'.repeat(32);
  await doFetch(stub, 'reserve-nonce', { method: 'POST', body: { intentId: intent.intentId, nonce, expectedVersion: 2 } });
  const wallet = new Wallet(TEST_PK);
  const td = buildTransferWithAuthorization({ from: intent.walletAddress, to: intent.payTo, value: intent.amountAtomic, validAfter: '0', validBefore: '9999999999', nonce });
  const signature = await wallet.signTypedData(td.domain, TRANSFER_WITH_AUTHORIZATION_TYPES, td.value);
  await doFetch(stub, 'authorize', { method: 'POST', body: { intentId: intent.intentId, expectedVersion: 3, authorization: { from: intent.walletAddress, to: intent.payTo, value: intent.amountAtomic, validAfter: '0', validBefore: '9999999999', nonce, signature } } });
  await doFetch(stub, 'record-verification', { method: 'POST', body: { intentId: intent.intentId, expectedVersion: 4, verification: { status: 'verified', isValid: true, invalidReason: null, checkedAt: new Date().toISOString() } } });
  return { intent: { ...intent, authorizationNonce: nonce, authorizationSignature: signature, authorizationValidAfter: '0', authorizationValidBefore: '9999999999', facilitatorVerification: { status: 'verified', isValid: true }, state: 'AUTHORIZED', stateVersion: 4 }, stub };
}

function env(binding) {
  return { X402_INTENT_LOCK: binding, DO_INTERNAL_SECRET: SECRET };
}

describe('x402 settlement orchestrator — gate & preparation', () => {
  it('live settlement is hard-disabled regardless of flags', () => {
    expect(liveSettlementEnabled()).toBe(false);
    expect(liveSettlementEnabled({ X402_LIVE_SETTLEMENT_ENABLED: 'true' })).toBe(false);
  });

  it('prepares settlement: acquires claim and persists SUBMITTING', async () => {
    const binding = makeDOBinding();
    const { intent } = await authorizedAndVerified(binding);
    const e = env(binding);
    const res = await prepareSettlement(e, { intent, walletAddress: intent.walletAddress, userId: intent.userId, idempotencyKey: 'claim-prep-123', settlementAttemptId: crypto.randomUUID() });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('prepared');
    expect(res.attempt.state).toBe('SUBMITTING');
    // Provider request is prepared but never sent.
    expect(res.providerRequest.paymentRequirements.amount).toBe('1000000');
  });

  it('rejects preparation without a fresh verification', async () => {
    const binding = makeDOBinding();
    const { intent } = await authorizedAndVerified(binding);
    const unverified = { ...intent, facilitatorVerification: null };
    const res = await prepareSettlement(env(binding), { intent: unverified, walletAddress: intent.walletAddress, userId: intent.userId, idempotencyKey: 'claim-prep-123', settlementAttemptId: crypto.randomUUID() });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('verification_required');
  });

  it('rejects cross-user and cross-wallet settlement preparation', async () => {
    const binding = makeDOBinding();
    const { intent } = await authorizedAndVerified(binding);
    const e = env(binding);
    const a = await prepareSettlement(e, { intent, walletAddress: intent.walletAddress, userId: 'other-user', idempotencyKey: 'claim-prep-123', settlementAttemptId: crypto.randomUUID() });
    expect(a.reason).toBe('unauthorized');
    const b = await prepareSettlement(e, { intent, walletAddress: '0x' + 'ff'.repeat(20), userId: intent.userId, idempotencyKey: 'claim-prep-123', settlementAttemptId: crypto.randomUUID() });
    expect(b.reason).toBe('wallet_mismatch');
  });
});

describe('x402 settlement orchestrator — outcome classification (simulated)', () => {
  async function prepared(binding) {
    const { intent } = await authorizedAndVerified(binding);
    const res = await prepareSettlement(env(binding), { intent, walletAddress: intent.walletAddress, userId: intent.userId, idempotencyKey: 'claim-prep-123', settlementAttemptId: crypto.randomUUID() });
    return { intent, attempt: res.attempt };
  }

  it('classifies a timeout as SETTLEMENT_UNKNOWN (never FAILED)', async () => {
    const binding = makeDOBinding();
    const { intent, attempt } = await prepared(binding);
    const res = await recordSettlementOutcome(env(binding), { attempt, walletAddress: intent.walletAddress, userId: intent.userId, outcome: { timeout: true } });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('SETTLEMENT_UNKNOWN');
  });

  it('classifies a provider-confirmed reference as SETTLED', async () => {
    const binding = makeDOBinding();
    const { intent, attempt } = await prepared(binding);
    const res = await recordSettlementOutcome(env(binding), { attempt, walletAddress: intent.walletAddress, userId: intent.userId, outcome: { providerReference: 'p1', transactionHash: '0x' + 'aa'.repeat(32) } });
    expect(res.status).toBe('SETTLED');
    expect(res.attempt.transactionHash).toBe('0x' + 'aa'.repeat(32));
  });

  it('classifies a definitive rejection as FAILED', async () => {
    const binding = makeDOBinding();
    const { intent, attempt } = await prepared(binding);
    const res = await recordSettlementOutcome(env(binding), { attempt, walletAddress: intent.walletAddress, userId: intent.userId, outcome: { providerRejected: true, definitive: true } });
    expect(res.status).toBe('FAILED');
  });

  it('orchestrates the full simulated flow (ambiguous by default) and never calls the provider', async () => {
    const binding = makeDOBinding();
    const { intent } = await authorizedAndVerified(binding);
    const res = await orchestrateSettlement(env(binding), { intent, walletAddress: intent.walletAddress, userId: intent.userId, idempotencyKey: 'claim-full-123', settlementAttemptId: crypto.randomUUID() });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('SETTLEMENT_UNKNOWN');
  });
});
