/**
 * x402-signing.test.js — Circle Wallet EIP-712 signing adapter (Level 2)
 * ═══════════════════════════════════════════════════════════════════════════
 * Provider-backed tests using Circle API mocks (no live credentials, no real
 * signing, no broadcast). Level 3 (authorized live signing) is NOT performed.
 *
 * Covers: the gate, typed-data construction from an intent, Circle request
 * serialization, authentication/failure/retry-shaped responses, malformed
 * signatures, and the full authorizeIntent flow (mocked Circle → real DO).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Wallet } from 'ethers';
import { X402IntentStore } from '../functions/api/x402/x402-intent.do.js';
import {
  signingEnabled,
  maxAuthWindowSeconds,
  buildAuthorizationFromIntent,
  serializeTypedDataForCircle,
  signTransferWithAuthorizationViaCircle,
  authorizeIntent,
} from '../functions/api/x402/x402-signing.mjs';
import { generateAuthorizationNonce } from '../functions/api/x402/intent-service.mjs';
import { buildTransferWithAuthorization, TRANSFER_WITH_AUTHORIZATION_TYPES, verifyTransferWithAuthorization } from '../functions/api/x402/x402-eip712.mjs';

// Mock the Circle crypto helper (avoid real RSA/entity-public-key fetch) and
// credentials resolution. The adapter is tested against documented API shapes.
vi.mock('../functions/api/agent-signer/_circle.js', () => ({
  encryptEntitySecret: async () => 'mock-ciphertext',
  getCredentials: (env) => ({
    apiKey: (env && env.CIRCLE_API_KEY) || '',
    entitySecret: (env && env.CIRCLE_ENTITY_SECRET) || '',
    walletId: (env && env.CIRCLE_WALLET_ID) || '',
    walletAddress: (env && env.CIRCLE_WALLET_ADDRESS) || '',
  }),
}));

const TEST_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const SECRET = 'test-internal-secret-0123456789abcdef';

const walletAddress = () => new Wallet(TEST_PK).address.toLowerCase();
const walletId = 'wallet-0001';

function env(over = {}) {
  return {
    CIRCLE_API_KEY: 'api-key',
    CIRCLE_ENTITY_SECRET: 'entity-secret',
    X402_SIGNING_ENABLED: 'true',
    DO_INTERNAL_SECRET: SECRET,
    ...over,
  };
}

/* ── mock DO binding (real DO class, per-wallet) ─────────────────────── */
function makeMutex() {
  let tail = Promise.resolve();
  return (fn) => { const run = tail.then(fn, fn); tail = run.catch(() => {}); return run; };
}
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

function buildIntent(over = {}) {
  return {
    schemaVersion: 1,
    intentId: crypto.randomUUID(),
    userId: 'user-1',
    walletAddress: walletAddress(),
    walletProvider: 'circle',
    resourceUrl: 'https://api.example.com/x',
    resourceFingerprint: 'a'.repeat(64),
    requirementDigest: 'b'.repeat(64),
    scheme: 'exact',
    network: 'eip155:5042',
    chainId: 5042,
    assetAddress: '0x3600000000000000000000000000000000000000',
    tokenDecimals: 6,
    amountAtomic: '1000000',
    payTo: '0x' + 'cd'.repeat(20),
    maxTimeoutSeconds: 60,
    authorizationNonce: null,
    idempotencyKey: 'key-sign-1234',
    state: 'CREATED',
    stateVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    authorizedAt: null,
    authorizationSignature: null,
    authorizationValidAfter: null,
    authorizationValidBefore: null,
    settlementAttemptId: null,
    settlementStatus: null,
    transactionHash: null,
    settlementEvidence: null,
    lastErrorCode: null,
    ...over,
  };
}

describe('x402 signing — gate & typed-data construction', () => {
  it('is disabled by default and requires both flag and credentials', () => {
    expect(signingEnabled({})).toBe(false);
    expect(signingEnabled({ X402_SIGNING_ENABLED: 'true' })).toBe(false); // no creds
    expect(signingEnabled(env({ X402_SIGNING_ENABLED: 'false' }))).toBe(false);
    expect(signingEnabled(env())).toBe(true);
  });

  it('builds exact typed data from an intent (amount never through Number)', () => {
    const intent = buildIntent({ authorizationNonce: generateAuthorizationNonce() });
    const td = buildAuthorizationFromIntent(intent, 1700000000, 3600);
    expect(td.value.from).toBe(intent.walletAddress);
    expect(td.value.to).toBe(intent.payTo);
    expect(td.value.value).toBe('1000000'); // exact decimal string
    expect(td.value.validAfter).toBe('1700000000');
    expect(td.value.validBefore).toBe('1700003600');
    expect(td.value.nonce).toBe(intent.authorizationNonce);
  });

  it('serializes the Circle data string with EIP712Domain + primaryType', () => {
    const intent = buildIntent({ authorizationNonce: generateAuthorizationNonce() });
    const td = buildAuthorizationFromIntent(intent, 1700000000, 3600);
    const data = JSON.parse(serializeTypedDataForCircle(td));
    expect(data.primaryType).toBe('TransferWithAuthorization');
    expect(data.types.EIP712Domain.map((f) => f.name)).toEqual(['name', 'version', 'chainId', 'verifyingContract']);
    expect(data.domain.name).toBe('USDC');
    expect(data.message.value).toBe('1000000');
  });

  it('caps the authorization window to the configured policy', () => {
    expect(maxAuthWindowSeconds({})).toBe(3600);
    expect(maxAuthWindowSeconds({ X402_AUTH_WINDOW_SECONDS: '120' })).toBe(120);
    expect(maxAuthWindowSeconds({ X402_AUTH_WINDOW_SECONDS: '0' })).toBe(3600);
  });
});

describe('x402 signing — Circle provider adapter (mocked fetch)', () => {
  let realFetch;
  beforeEach(() => { realFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  function mockSignResponse(status, body) {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  }

  it('returns the signature on 200', async () => {
    mockSignResponse(200, { data: { signature: '0x' + 'ab'.repeat(65) } });
    const intent = buildIntent({ authorizationNonce: generateAuthorizationNonce() });
    const td = buildAuthorizationFromIntent(intent, 1700000000, 3600);
    const res = await signTransferWithAuthorizationViaCircle(env(), walletId, td);
    expect(res.ok).toBe(true);
    expect(res.signature).toBe('0x' + 'ab'.repeat(65));
  });

  it('fails closed on Circle auth/forbidden/rate-limit/5xx/missing-signature', async () => {
    const intent = buildIntent({ authorizationNonce: generateAuthorizationNonce() });
    const td = buildAuthorizationFromIntent(intent, 1700000000, 3600);

    mockSignResponse(401, { message: 'unauthorized' });
    expect((await signTransferWithAuthorizationViaCircle(env(), walletId, td)).error).toBe('circle_auth_failed');

    mockSignResponse(403, {});
    expect((await signTransferWithAuthorizationViaCircle(env(), walletId, td)).error).toBe('circle_forbidden');

    mockSignResponse(429, {});
    expect((await signTransferWithAuthorizationViaCircle(env(), walletId, td)).error).toBe('circle_rate_limited');

    mockSignResponse(500, {});
    expect((await signTransferWithAuthorizationViaCircle(env(), walletId, td)).error).toBe('circle_5xx');

    mockSignResponse(200, { data: {} });
    expect((await signTransferWithAuthorizationViaCircle(env(), walletId, td)).error).toBe('circle_signature_missing');
  });

  it('fails closed when Circle credentials are missing', async () => {
    const intent = buildIntent({ authorizationNonce: generateAuthorizationNonce() });
    const td = buildAuthorizationFromIntent(intent, 1700000000, 3600);
    const res = await signTransferWithAuthorizationViaCircle({}, walletId, td);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('circle_not_configured');
  });
});

describe('x402 signing — authorizeIntent (mocked Circle → real DO)', () => {
  let realFetch;
  beforeEach(() => { realFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  async function driveToAwaitingAuthorization(binding, intent) {
    const doId = binding.idFromName(intent.walletAddress);
    const stub = binding.get(doId);
    await stub.fetch('https://x402-intent-do/create', { method: 'POST', headers: { 'X-DO-Internal-Secret': SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify({ intent, requestDigest: 'c'.repeat(64) }) });
    await stub.fetch('https://x402-intent-do/transition', { method: 'POST', headers: { 'X-DO-Internal-Secret': SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify({ intentId: intent.intentId, to: 'PREPARED', expectedVersion: 1 }) });
    const nonce = generateAuthorizationNonce();
    await stub.fetch('https://x402-intent-do/reserve-nonce', { method: 'POST', headers: { 'X-DO-Internal-Secret': SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify({ intentId: intent.intentId, nonce, expectedVersion: 2 }) });
    return nonce;
  }

  it('refuses to sign when signing is disabled (fail-closed)', async () => {
    const binding = makeDOBinding();
    const intent = buildIntent();
    const nonce = await driveToAwaitingAuthorization(binding, intent);
    intent.authorizationNonce = nonce;
    intent.state = 'AWAITING_AUTHORIZATION';
    intent.stateVersion = 3;
    const res = await authorizeIntent(env({ X402_SIGNING_ENABLED: 'false' }), { intent, walletId, walletAddress: intent.walletAddress, userId: intent.userId });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('signing_disabled');
  });

  it('authorizes a valid (mocked) signature end-to-end into the DO', async () => {
    const binding = makeDOBinding();
    const e = env({ X402_INTENT_LOCK: binding });
    const intent = buildIntent();
    const nonce = await driveToAwaitingAuthorization(binding, intent);
    intent.authorizationNonce = nonce;
    intent.state = 'AWAITING_AUTHORIZATION';
    intent.stateVersion = 3;

    // Mock Circle to return a REAL signature from the test signer.
    const wallet = new Wallet(TEST_PK);
    const td = buildAuthorizationFromIntent(intent, Math.floor(Date.now() / 1000), 3600);
    const signature = await wallet.signTypedData(td.domain, TRANSFER_WITH_AUTHORIZATION_TYPES, td.value);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { signature } }), { status: 200 }));

    const res = await authorizeIntent(e, { intent, walletId, walletAddress: intent.walletAddress, userId: intent.userId });
    expect(res.ok).toBe(true);
    expect(res.intent.state).toBe('AUTHORIZED');
    // The signature is NOT exposed in the returned intent (redacted by the service wrapper).
    // (authorizeIntent returns the DO record; the HTTP layer redacts it.)
    const stored = binding._instances.get(intent.walletAddress);
    const raw = await stored.state.storage.get('intent:' + intent.intentId);
    expect(raw.authorizationSignature).toBe(signature);
    expect(raw.state).toBe('AUTHORIZED');
  });

  it('rejects a signature from the wrong signer (never persists)', async () => {
    const binding = makeDOBinding();
    const e = env({ X402_INTENT_LOCK: binding });
    const intent = buildIntent();
    const nonce = await driveToAwaitingAuthorization(binding, intent);
    intent.authorizationNonce = nonce;
    intent.state = 'AWAITING_AUTHORIZATION';
    intent.stateVersion = 3;

    const other = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    const td = buildAuthorizationFromIntent(intent, Math.floor(Date.now() / 1000), 3600);
    const wrongSig = await other.signTypedData(td.domain, TRANSFER_WITH_AUTHORIZATION_TYPES, td.value);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { signature: wrongSig } }), { status: 200 }));

    const res = await authorizeIntent(e, { intent, walletId, walletAddress: intent.walletAddress, userId: intent.userId });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('signer_mismatch');
    // Intent was NOT authorized.
    const stored = binding._instances.get(intent.walletAddress);
    const raw = await stored.state.storage.get('intent:' + intent.intentId);
    expect(raw.state).toBe('AWAITING_AUTHORIZATION');
  });
});
