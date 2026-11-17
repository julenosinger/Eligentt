/**
 * x402-verification.test.js — facilitator verification pipeline
 * ═══════════════════════════════════════════════════════════════════════════
 * Tests local signature revalidation, the verification gate, ownership, provider
 * (mocked) verify, evidence persistence, and signature confidentiality.
 * No live Circle calls; verification is never settlement.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Wallet } from 'ethers';
import { X402IntentStore } from '../functions/api/x402/x402-intent.do.js';
import {
  revalidateAuthorization,
  verifyIntent,
} from '../functions/api/x402/x402-verification.mjs';
import { buildTransferWithAuthorization, TRANSFER_WITH_AUTHORIZATION_TYPES } from '../functions/api/x402/x402-eip712.mjs';

const TEST_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const SECRET = 'test-internal-secret-0123456789abcdef';
const ARC_USDC = '0x3600000000000000000000000000000000000000';

const signerAddress = () => new Wallet(TEST_PK).address.toLowerCase();

function makeAuthorizedIntent(over = {}) {
  return {
    schemaVersion: 1,
    intentId: crypto.randomUUID(),
    userId: 'user-1',
    walletAddress: signerAddress(),
    walletProvider: 'circle',
    resourceUrl: 'https://api.example.com/premium',
    resourceFingerprint: 'a'.repeat(64),
    requirementDigest: 'b'.repeat(64),
    scheme: 'exact',
    network: 'eip155:5042',
    chainId: 5042,
    assetAddress: ARC_USDC,
    tokenDecimals: 6,
    amountAtomic: '1000000',
    payTo: '0x' + 'cd'.repeat(20),
    maxTimeoutSeconds: 60,
    authorizationNonce: '0x' + '11'.repeat(32),
    authorizationSignature: '0x' + '22'.repeat(65),
    authorizationValidAfter: '0',
    authorizationValidBefore: '9999999999',
    idempotencyKey: 'key-verif-1234',
    state: 'AUTHORIZED',
    stateVersion: 4,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    authorizedAt: new Date().toISOString(),
    facilitatorVerification: null,
    settlementAttemptId: null,
    settlementStatus: null,
    transactionHash: null,
    settlementEvidence: null,
    lastErrorCode: null,
    ...over,
  };
}

/** Sign an intent with the test key and return the signed intent + typed data. */
async function signIntent(intent) {
  const wallet = new Wallet(TEST_PK);
  const td = buildTransferWithAuthorization({
    from: intent.walletAddress,
    to: intent.payTo,
    value: intent.amountAtomic,
    validAfter: intent.authorizationValidAfter,
    validBefore: intent.authorizationValidBefore,
    nonce: intent.authorizationNonce,
  });
  const signature = await wallet.signTypedData(td.domain, TRANSFER_WITH_AUTHORIZATION_TYPES, td.value);
  return { ...intent, authorizationSignature: signature, td };
}

describe('x402 verification — local revalidation', () => {
  it('accepts a correctly-signed, valid-window intent', async () => {
    const intent = await signIntent(makeAuthorizedIntent());
    expect(revalidateAuthorization(intent).ok).toBe(true);
  });

  it('rejects a wrong signer (signature from a different key)', async () => {
    const intent = makeAuthorizedIntent();
    const other = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    const td = buildTransferWithAuthorization({
      from: intent.walletAddress, to: intent.payTo, value: intent.amountAtomic,
      validAfter: intent.authorizationValidAfter, validBefore: intent.authorizationValidBefore, nonce: intent.authorizationNonce,
    });
    intent.authorizationSignature = await other.signTypedData(td.domain, TRANSFER_WITH_AUTHORIZATION_TYPES, td.value);
    const res = revalidateAuthorization(intent);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('signer_mismatch');
  });

  it('rejects a modified amount / recipient / nonce (signature no longer matches)', async () => {
    const intent = await signIntent(makeAuthorizedIntent());
    expect(revalidateAuthorization({ ...intent, amountAtomic: '2000000' }).ok).toBe(false);
    expect(revalidateAuthorization({ ...intent, payTo: '0x' + 'ee'.repeat(20) }).ok).toBe(false);
    expect(revalidateAuthorization({ ...intent, authorizationNonce: '0x' + '33'.repeat(32) }).ok).toBe(false);
  });

  it('rejects an expired / not-yet-valid authorization', async () => {
    const intent = await signIntent(makeAuthorizedIntent());
    const past = await signIntent(makeAuthorizedIntent({ authorizationValidBefore: '1000000000' }));
    expect(revalidateAuthorization(past).reason).toBe('authorization_expired');
    const future = await signIntent(makeAuthorizedIntent({ authorizationValidAfter: '9999999999' }));
    expect(revalidateAuthorization(future).reason).toBe('authorization_not_yet_valid');
  });

  it('rejects non-AUTHORIZED state and missing signature', () => {
    expect(revalidateAuthorization(makeAuthorizedIntent({ state: 'PREPARED' })).reason).toBe('not_authorized');
    expect(revalidateAuthorization(makeAuthorizedIntent({ authorizationSignature: null })).reason).toBe('signature_missing');
  });
});

describe('x402 verification — verifyIntent gate & ownership', () => {
  it('reports unverified (never calls provider) when verification is disabled', async () => {
    const intent = await signIntent(makeAuthorizedIntent());
    const res = await verifyIntent({}, { intent, walletAddress: intent.walletAddress, userId: intent.userId });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('unverified');
    expect(res.reason).toBe('facilitator_verification_disabled');
    expect(res.localValid).toBe(true);
  });

  it('rejects cross-user and cross-wallet access before any provider call', async () => {
    const intent = await signIntent(makeAuthorizedIntent());
    const a = await verifyIntent({ X402_FACILITATOR_VERIFY: 'true', CIRCLE_API_KEY: 'k' }, { intent, walletAddress: intent.walletAddress, userId: 'user-OTHER' });
    expect(a.status).toBe('rejected');
    expect(a.reason).toBe('unauthorized');
    const b = await verifyIntent({ X402_FACILITATOR_VERIFY: 'true', CIRCLE_API_KEY: 'k' }, { intent, walletAddress: '0x' + 'ff'.repeat(20), userId: intent.userId });
    expect(b.status).toBe('rejected');
    expect(b.reason).toBe('wallet_mismatch');
  });

  it('rejects a tampered signature before any provider call', async () => {
    const intent = await signIntent(makeAuthorizedIntent());
    const tampered = { ...intent, amountAtomic: '999999' };
    const res = await verifyIntent({ X402_FACILITATOR_VERIFY: 'true', CIRCLE_API_KEY: 'k' }, { intent: tampered, walletAddress: tampered.walletAddress, userId: tampered.userId });
    expect(res.status).toBe('rejected');
  });
});

describe('x402 verification — provider flow (mocked) + persistence', () => {
  let realFetch;
  beforeEach(() => { realFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

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

  async function seedAuthorizedIntent(binding) {
    // Build a CREATED intent, then drive create → prepare → reserve → authorize.
    const created = makeAuthorizedIntent({
      state: 'CREATED',
      stateVersion: 1,
      authorizationNonce: null,
      authorizationSignature: null,
      authorizationValidAfter: null,
      authorizationValidBefore: null,
      authorizedAt: null,
    });
    const nonce = '0x' + '11'.repeat(32);
    const wallet = new Wallet(TEST_PK);
    const td = buildTransferWithAuthorization({
      from: created.walletAddress, to: created.payTo, value: created.amountAtomic,
      validAfter: '0', validBefore: '9999999999', nonce,
    });
    const signature = await wallet.signTypedData(td.domain, TRANSFER_WITH_AUTHORIZATION_TYPES, td.value);
    const stub = binding.get(binding.idFromName(created.walletAddress));
    const headers = { 'X-DO-Internal-Secret': SECRET, 'Content-Type': 'application/json' };
    await stub.fetch('https://do/create', { method: 'POST', headers, body: JSON.stringify({ intent: created, requestDigest: 'c'.repeat(64) }) });
    await stub.fetch('https://do/transition', { method: 'POST', headers, body: JSON.stringify({ intentId: created.intentId, to: 'PREPARED', expectedVersion: 1 }) });
    await stub.fetch('https://do/reserve-nonce', { method: 'POST', headers, body: JSON.stringify({ intentId: created.intentId, nonce, expectedVersion: 2 }) });
    const authResp = await stub.fetch('https://do/authorize', { method: 'POST', headers, body: JSON.stringify({ intentId: created.intentId, expectedVersion: 3, authorization: { from: created.walletAddress, to: created.payTo, value: created.amountAtomic, validAfter: '0', validBefore: '9999999999', nonce, signature } }) });
    const authorized = (await authResp.json()).intent;
    return { intent: authorized, signature };
  }

  function mockProvider(verifyBody) {
    globalThis.fetch = vi.fn().mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/supported')) {
        return new Response(JSON.stringify({ x402Version: 2, kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:5042', asset: ARC_USDC, decimals: 6, extra: { name: 'USDC', version: '2' } }], extensions: [], signers: {} }), { status: 200 });
      }
      if (u.includes('/verify')) {
        return new Response(JSON.stringify({ data: verifyBody }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
  }

  it('verifies a valid authorization and persists non-destructive evidence', async () => {
    const binding = makeDOBinding();
    const { intent, signature } = await seedAuthorizedIntent(binding);
    mockProvider({ isValid: true });

    const env = { X402_FACILITATOR_VERIFY: 'true', CIRCLE_API_KEY: 'k', DO_INTERNAL_SECRET: SECRET, X402_INTENT_LOCK: binding };
    const res = await verifyIntent(env, { intent, walletAddress: intent.walletAddress, userId: intent.userId });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('verified');
    expect(res.verification.status).toBe('verified');
    // Evidence persisted on the intent (non-destructive — still AUTHORIZED).
    const stored = binding._instances.get(intent.walletAddress);
    const raw = await stored.state.storage.get('intent:' + intent.intentId);
    expect(raw.state).toBe('AUTHORIZED');
    expect(raw.facilitatorVerification.status).toBe('verified');
    // The signature is never present in the returned status object.
    expect(JSON.stringify(res)).not.toContain(signature);
  });

  it('rejects when the provider reports an invalid authorization', async () => {
    const binding = makeDOBinding();
    const { intent, signature } = await seedAuthorizedIntent(binding);
    mockProvider({ isValid: false, invalidReason: 'invalid_exact_evm_payload_signature' });

    const env = { X402_FACILITATOR_VERIFY: 'true', CIRCLE_API_KEY: 'k', DO_INTERNAL_SECRET: SECRET, X402_INTENT_LOCK: binding };
    const res = await verifyIntent(env, { intent, walletAddress: intent.walletAddress, userId: intent.userId });
    expect(res.status).toBe('rejected');
    expect(res.verification.status).toBe('rejected');
    expect(res.verification.invalidReason).toBe('invalid_exact_evm_payload_signature');
  });

  it('reports unknown when the provider is unavailable', async () => {
    const binding = makeDOBinding();
    const { intent, signature } = await seedAuthorizedIntent(binding);
    globalThis.fetch = vi.fn().mockImplementation(async (url) => {
      if (String(url).includes('/supported')) {
        return new Response(JSON.stringify({ x402Version: 2, kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:5042', asset: ARC_USDC, decimals: 6, extra: {} }], extensions: [], signers: {} }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 500 });
    });
    const env = { X402_FACILITATOR_VERIFY: 'true', CIRCLE_API_KEY: 'k', DO_INTERNAL_SECRET: SECRET, X402_INTENT_LOCK: binding };
    const res = await verifyIntent(env, { intent, walletAddress: intent.walletAddress, userId: intent.userId });
    expect(res.status).toBe('unknown');
    expect(res.reason).toBe('temporarily_unavailable');
  });

  it('rejects when the facilitator does not support Arc exact/USDC', async () => {
    const binding = makeDOBinding();
    const { intent, signature } = await seedAuthorizedIntent(binding);
    // Capabilities advertise a DIFFERENT network.
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ x402Version: 2, kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453', asset: ARC_USDC, decimals: 6, extra: {} }], extensions: [], signers: {} }), { status: 200 }));
    const env = { X402_FACILITATOR_VERIFY: 'true', CIRCLE_API_KEY: 'k', DO_INTERNAL_SECRET: SECRET, X402_INTENT_LOCK: binding };
    const res = await verifyIntent(env, { intent, walletAddress: intent.walletAddress, userId: intent.userId });
    expect(res.status).toBe('rejected');
    expect(res.reason).toBe('capability_unsupported');
  });

  it('duplicate verification is idempotent (same result, no state change)', async () => {
    const binding = makeDOBinding();
    const { intent, signature } = await seedAuthorizedIntent(binding);
    mockProvider({ isValid: true });
    const env = { X402_FACILITATOR_VERIFY: 'true', CIRCLE_API_KEY: 'k', DO_INTERNAL_SECRET: SECRET, X402_INTENT_LOCK: binding };
    await verifyIntent(env, { intent, walletAddress: intent.walletAddress, userId: intent.userId });
    await verifyIntent(env, { intent, walletAddress: intent.walletAddress, userId: intent.userId });
    const stored = binding._instances.get(intent.walletAddress);
    const raw = await stored.state.storage.get('intent:' + intent.intentId);
    expect(raw.state).toBe('AUTHORIZED');
    expect(raw.stateVersion).toBe(4); // verification never bumps the core version
  });
});
