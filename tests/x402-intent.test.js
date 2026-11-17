/**
 * x402-intent.test.js — service layer + /api/x402/intent HTTP routes
 * ═══════════════════════════════════════════════════════════════════════
 * Unit-tests the intent-service (canonicalization, SHA-256 fingerprints/digests,
 * record building, gates) and integration-tests the /api/x402/intent* routes
 * against the REAL X402IntentStore Durable Object class via a mock namespace
 * binding (idFromName → get → fetch), reusing the real AUTH_KV session resolver.
 */
import { describe, it, expect } from 'vitest';
import { X402IntentStore } from '../functions/api/x402/x402-intent.do.js';
import {
  intentPersistenceEnabled,
  intentTtlSeconds,
  intentMaxPerUser,
  canonicalizeRequirement,
  resourceFingerprintOf,
  requirementDigestOf,
  createRequestDigestOf,
  buildIntentRecord,
} from '../functions/api/x402/intent-service.mjs';
import { onRequest as onIntentRequest } from '../functions/api/x402/intent.js';

const SECRET = 'test-internal-secret-0123456789abcdef';
const TOKEN = '0'.repeat(40);
const USER_ID = 'user-1111';
const EMAIL = 'alice@example.com';
const PAYER = '0x' + 'ab'.repeat(20);
const PAYTO = '0x' + 'cd'.repeat(20);
const USDC_ARC = '0x3600000000000000000000000000000000000000';

/* ── Mock DO namespace (routes to real DO class, per-user instance) ──── */
function makeMutex() {
  let tail = Promise.resolve();
  return (fn) => { const run = tail.then(fn, fn); tail = run.catch(() => {}); return run; };
}

function makeDOState() {
  const store = new Map();
  const lock = makeMutex();
  const txn = {
    async get(k) { return store.has(k) ? store.get(k) : undefined; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
  return {
    storage: {
      async get(k) { return store.has(k) ? store.get(k) : undefined; },
      async put(k, v) { store.set(k, v); },
      async delete(k) { store.delete(k); },
      async setAlarm(ms) { store.set('__alarm', ms); },
      async deleteAlarm() { store.delete('__alarm'); },
      async getAlarm() { return store.has('__alarm') ? store.get('__alarm') : null; },
      async transaction(cb) { return cb(txn); },
    },
    async blockConcurrencyWhile(cb) { return lock(cb); },
  };
}

function makeDOBinding() {
  const instances = new Map();
  return {
    idFromName(name) { return { __name: String(name) }; },
    get(id) {
      const name = id.__name;
      if (!instances.has(name)) {
        instances.set(name, new X402IntentStore(makeDOState(), { DO_INTERNAL_SECRET: SECRET, X402_INTENT_MAX_PER_USER: '200' }));
      }
      const doObj = instances.get(name);
      return { fetch: (url, opts) => doObj.fetch(new Request(url, opts)) };
    },
    _instances: instances,
  };
}

/* ── Auth KV + env ───────────────────────────────────────────────────── */
function makeKV(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    async get(k) { return map.has(k) ? map.get(k) : null; },
    async put(k, v) { map.set(k, v); return true; },
    async delete(k) { map.delete(k); return true; },
  };
}

function makeEnv(over = {}) {
  return {
    AUTH_KV: makeKV({
      ['session:' + TOKEN]: JSON.stringify({ userId: USER_ID, email: EMAIL }),
      ['user:' + EMAIL]: JSON.stringify({ id: USER_ID, circleWalletId: 'w1', circleWalletAddress: PAYER }),
    }),
    DO_INTERNAL_SECRET: SECRET,
    X402_INTENT_PERSISTENCE: 'true',
    X402_INTENT_LOCK: makeDOBinding(),
    ...over,
  };
}

function req(path, { method = 'GET', body, token = TOKEN } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  return new Request('https://app.local' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

async function jsonOf(resp) { return resp.json(); }

const ARC_REQ = {
  scheme: 'exact',
  network: 'eip155:5042',
  amount: '1000000',
  asset: USDC_ARC,
  payTo: PAYTO,
  maxTimeoutSeconds: 60,
  extra: { name: 'USDC', version: '2', assetTransferMethod: 'eip3009' },
};

/* ═══════════════════════════════════════════════════════════════════ */

describe('x402 intent-service — canonicalization & digests', () => {
  it('canonicalizes a valid Arc USDC requirement to exact canonical fields', () => {
    const r = canonicalizeRequirement(ARC_REQ, {});
    expect(r.ok).toBe(true);
    expect(r.canonical.amountAtomic).toBe('1000000');
    expect(r.canonical.assetAddress).toBe(USDC_ARC.toLowerCase());
    expect(r.canonical.network).toBe('eip155:5042');
    expect(r.canonical.maxTimeoutSeconds).toBe(60);
    expect(r.chainId).toBe(5042);
    expect(r.tokenDecimals).toBe(6);
  });

  it('rejects an invalid requirement (wrong asset address)', () => {
    const r = canonicalizeRequirement({ ...ARC_REQ, asset: '0x' + '99'.repeat(20) }, {});
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_requirement');
  });

  it('rejects an invalid requirement (wrong chain)', () => {
    const r = canonicalizeRequirement({ ...ARC_REQ, network: 'eip155:999' }, {});
    expect(r.ok).toBe(false);
  });

  it('rejects a negative / scientific / excess-precision amount', () => {
    expect(canonicalizeRequirement({ ...ARC_REQ, amount: '-1' }, {}).ok).toBe(false);
    expect(canonicalizeRequirement({ ...ARC_REQ, amount: '1e6' }, {}).ok).toBe(false);
    expect(canonicalizeRequirement({ ...ARC_REQ, amount: '0.0000001' }, {}).ok).toBe(false);
    expect(canonicalizeRequirement({ ...ARC_REQ, amount: '1.5' }, {}).ok).toBe(false);
  });

  it('rejects an amount above the max cap', () => {
    const r = canonicalizeRequirement({ ...ARC_REQ, amount: String(100 * 1e6) }, {});
    expect(r.ok).toBe(false);
  });

  it('rejects an invalid timeout', () => {
    const r = canonicalizeRequirement({ ...ARC_REQ, maxTimeoutSeconds: 'abc' }, {});
    expect(r.ok).toBe(false);
  });

  it('produces deterministic, domain-separated SHA-256 digests (64 hex chars)', async () => {
    const fp1 = await resourceFingerprintOf('https://api.example.com/premium', 'Premium');
    const fp2 = await resourceFingerprintOf('https://api.example.com/premium', 'Premium');
    const fp3 = await resourceFingerprintOf('https://api.example.com/other', 'Premium');
    expect(fp1).toBe(fp2);
    expect(fp1).not.toBe(fp3);
    expect(fp1).toMatch(/^[0-9a-f]{64}$/);

    const canon = canonicalizeRequirement(ARC_REQ, {}).canonical;
    canon.resourceUrl = 'https://api.example.com/premium';
    const d1 = await requirementDigestOf(canon);
    const d2 = await requirementDigestOf({ ...canon });
    const d3 = await requirementDigestOf({ ...canon, amountAtomic: '2000000' });
    expect(d1).toBe(d2);
    expect(d1).not.toBe(d3);
    expect(d1).toMatch(/^[0-9a-f]{64}$/);

    const rd1 = await createRequestDigestOf(d1, fp1, PAYER);
    const rd2 = await createRequestDigestOf(d1, fp1, PAYER);
    const rd3 = await createRequestDigestOf(d1, fp1, '0x' + 'ef'.repeat(20));
    expect(rd1).toBe(rd2);
    expect(rd1).not.toBe(rd3);
  });

  it('gates and config defaults are fail-closed', () => {
    expect(intentPersistenceEnabled({})).toBe(false);
    expect(intentPersistenceEnabled({ X402_INTENT_PERSISTENCE: 'true' })).toBe(true);
    expect(intentPersistenceEnabled({ X402_INTENT_PERSISTENCE: '1' })).toBe(false);
    expect(intentTtlSeconds({})).toBe(3600);
    expect(intentTtlSeconds({ X402_INTENT_TTL_SECONDS: '60' })).toBe(60);
    expect(intentTtlSeconds({ X402_INTENT_TTL_SECONDS: '-5' })).toBe(3600);
    expect(intentMaxPerUser({})).toBe(200);
  });

  it('builds a complete intent record with exact string amount and null future fields', () => {
    const canon = canonicalizeRequirement(ARC_REQ, {}).canonical;
    canon.resourceUrl = 'https://api.example.com/premium';
    const rec = buildIntentRecord({
      intentId: crypto.randomUUID(),
      userId: USER_ID,
      walletAddress: PAYER,
      resourceUrl: canon.resourceUrl,
      resourceFingerprint: 'a'.repeat(64),
      requirementDigest: 'b'.repeat(64),
      canonical: canon,
      chainId: 5042,
      tokenDecimals: 6,
      idempotencyKey: 'key-test-1234',
      ttlSeconds: 3600,
    });
    expect(rec.schemaVersion).toBe(1);
    expect(rec.amountAtomic).toBe('1000000');
    expect(typeof rec.amountAtomic).toBe('string');
    expect(rec.state).toBe('CREATED');
    expect(rec.stateVersion).toBe(1);
    expect(rec.authorizationNonce).toBeNull();
    expect(rec.transactionHash).toBeNull();
    expect(rec.settlementStatus).toBeNull();
    expect(rec.settlementEvidence).toBeNull();
    expect(rec.lastErrorCode).toBeNull();
    expect(Date.parse(rec.expiresAt)).toBeGreaterThan(Date.parse(rec.createdAt));
  });
});

/* ═══════════════════════════════════════════════════════════════════ */

describe('/api/x402/intent — HTTP routes (gated, real DO)', () => {
  it('fails closed (503) when persistence is disabled', async () => {
    const env = makeEnv({ X402_INTENT_PERSISTENCE: 'false' });
    const res = await onIntentRequest({ request: req('/api/x402/intent', { method: 'POST', body: { resourceUrl: 'https://api.example.com/x', requirement: ARC_REQ, idempotencyKey: 'key-http-1234' } }), env });
    expect(res.status).toBe(503);
    const d = await jsonOf(res);
    expect(d.code).toBe('x402_intent_persistence_disabled');
  });

  it('fails closed (503) when the DO binding is absent', async () => {
    const env = makeEnv({ X402_INTENT_LOCK: undefined });
    const res = await onIntentRequest({ request: req('/api/x402/intent', { method: 'POST', body: { resourceUrl: 'https://api.example.com/x', requirement: ARC_REQ, idempotencyKey: 'key-http-1234' } }), env });
    expect(res.status).toBe(503);
  });

  it('rejects unauthenticated requests (401)', async () => {
    const env = makeEnv();
    const res = await onIntentRequest({ request: req('/api/x402/intent', { method: 'POST', body: { resourceUrl: 'https://api.example.com/x', requirement: ARC_REQ, idempotencyKey: 'key-http-1234' }, token: null }), env });
    expect(res.status).toBe(401);
  });

  it('creates an intent and returns the durable record', async () => {
    const env = makeEnv();
    const res = await onIntentRequest({ request: req('/api/x402/intent', { method: 'POST', body: { resourceUrl: 'https://api.example.com/x', requirement: ARC_REQ, idempotencyKey: 'key-http-1234' } }), env });
    expect(res.status).toBe(200);
    const d = await jsonOf(res);
    expect(d.ok).toBe(true);
    expect(d.idempotent).toBe(false);
    expect(d.intent.intentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(d.intent.state).toBe('CREATED');
    expect(d.intent.amountAtomic).toBe('1000000');
    expect(d.intent.chainId).toBe(5042);
  });

  it('is idempotent across a retry (same key + payload → same intentId)', async () => {
    const env = makeEnv();
    const body = { resourceUrl: 'https://api.example.com/x', requirement: ARC_REQ, idempotencyKey: 'key-http-1234' };
    const a = await jsonOf(await onIntentRequest({ request: req('/api/x402/intent', { method: 'POST', body }), env }));
    const b = await jsonOf(await onIntentRequest({ request: req('/api/x402/intent', { method: 'POST', body }), env }));
    expect(a.intent.intentId).toBe(b.intent.intentId);
    expect(b.idempotent).toBe(true);
  });

  it('conflicts on idempotency-key reuse with a different amount', async () => {
    const env = makeEnv();
    const bodyA = { resourceUrl: 'https://api.example.com/x', requirement: ARC_REQ, idempotencyKey: 'key-http-1234' };
    await onIntentRequest({ request: req('/api/x402/intent', { method: 'POST', body: bodyA }), env });
    const bodyB = { resourceUrl: 'https://api.example.com/x', requirement: { ...ARC_REQ, amount: '2000000' }, idempotencyKey: 'key-http-1234' };
    const res = await onIntentRequest({ request: req('/api/x402/intent', { method: 'POST', body: bodyB }), env });
    expect(res.status).toBe(409);
  });

  it('rejects an invalid idempotency key (400)', async () => {
    const env = makeEnv();
    const res = await onIntentRequest({ request: req('/api/x402/intent', { method: 'POST', body: { resourceUrl: 'https://api.example.com/x', requirement: ARC_REQ, idempotencyKey: 'short' } }), env });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid requirement (400)', async () => {
    const env = makeEnv();
    const res = await onIntentRequest({ request: req('/api/x402/intent', { method: 'POST', body: { resourceUrl: 'https://api.example.com/x', requirement: { ...ARC_REQ, amount: '-1' }, idempotencyKey: 'key-http-1234' } }), env });
    expect(res.status).toBe(400);
  });

  it('gets an intent by id', async () => {
    const env = makeEnv();
    const created = await jsonOf(await onIntentRequest({ request: req('/api/x402/intent', { method: 'POST', body: { resourceUrl: 'https://api.example.com/x', requirement: ARC_REQ, idempotencyKey: 'key-http-1234' } }), env }));
    const got = await jsonOf(await onIntentRequest({ request: req('/api/x402/intent/' + created.intent.intentId), env }));
    expect(got.ok).toBe(true);
    expect(got.intent.intentId).toBe(created.intent.intentId);
  });

  it('returns 404 for an unknown intent', async () => {
    const env = makeEnv();
    const res = await onIntentRequest({ request: req('/api/x402/intent/' + crypto.randomUUID()), env });
    expect(res.status).toBe(404);
  });

  it('prepares an intent (CREATED → PREPARED) with the correct stateVersion', async () => {
    const env = makeEnv();
    const created = await jsonOf(await onIntentRequest({ request: req('/api/x402/intent', { method: 'POST', body: { resourceUrl: 'https://api.example.com/x', requirement: ARC_REQ, idempotencyKey: 'key-http-1234' } }), env }));
    const res = await onIntentRequest({ request: req('/api/x402/intent/' + created.intent.intentId + '/prepare', { method: 'POST', body: { expectedVersion: 1 } }), env });
    expect(res.status).toBe(200);
    const d = await jsonOf(res);
    expect(d.intent.state).toBe('PREPARED');
    expect(d.intent.stateVersion).toBe(2);
  });

  it('rejects a stale prepare (409 stale_version)', async () => {
    const env = makeEnv();
    const created = await jsonOf(await onIntentRequest({ request: req('/api/x402/intent', { method: 'POST', body: { resourceUrl: 'https://api.example.com/x', requirement: ARC_REQ, idempotencyKey: 'key-http-1234' } }), env }));
    await onIntentRequest({ request: req('/api/x402/intent/' + created.intent.intentId + '/prepare', { method: 'POST', body: { expectedVersion: 1 } }), env });
    const res = await onIntentRequest({ request: req('/api/x402/intent/' + created.intent.intentId + '/cancel', { method: 'POST', body: { expectedVersion: 1 } }), env });
    expect(res.status).toBe(409);
    const d = await jsonOf(res);
    expect(d.code).toBe('stale_version');
  });

  it('cancels an intent (→ CANCELLED)', async () => {
    const env = makeEnv();
    const created = await jsonOf(await onIntentRequest({ request: req('/api/x402/intent', { method: 'POST', body: { resourceUrl: 'https://api.example.com/x', requirement: ARC_REQ, idempotencyKey: 'key-http-1234' } }), env }));
    const res = await onIntentRequest({ request: req('/api/x402/intent/' + created.intent.intentId + '/cancel', { method: 'POST', body: { expectedVersion: 1 } }), env });
    expect(res.status).toBe(200);
    const d = await jsonOf(res);
    expect(d.intent.state).toBe('CANCELLED');
  });

  it('isolates users: user B cannot read user A\'s intent', async () => {
    const env = makeEnv();
    const created = await jsonOf(await onIntentRequest({ request: req('/api/x402/intent', { method: 'POST', body: { resourceUrl: 'https://api.example.com/x', requirement: ARC_REQ, idempotencyKey: 'key-http-1234' } }), env }));

    // Different session token → different user.
    const tokenB = '1'.repeat(40);
    const envB = makeEnv();
    envB.AUTH_KV = makeKV({
      ['session:' + tokenB]: JSON.stringify({ userId: 'user-2222', email: 'bob@example.com' }),
      ['user:bob@example.com']: JSON.stringify({ id: 'user-2222', circleWalletId: 'w2', circleWalletAddress: '0x' + 'ef'.repeat(20) }),
    });
    const res = await onIntentRequest({ request: req('/api/x402/intent/' + created.intent.intentId, { token: tokenB }), env: envB });
    expect(res.status).toBe(404);
  });

  it('defends cross-user access even if two users reference the SAME wallet', async () => {
    const env = makeEnv();
    const created = await jsonOf(await onIntentRequest({ request: req('/api/x402/intent', { method: 'POST', body: { resourceUrl: 'https://api.example.com/x', requirement: ARC_REQ, idempotencyKey: 'key-http-1234' } }), env }));

    // A different user whose session resolves to the SAME wallet address as user A
    // (edge case: wallet→user uniqueness is not assumed). Ownership is re-checked
    // against the intent's userId, so the read must still be denied.
    const tokenC = '2'.repeat(40);
    const envC = makeEnv();
    envC.AUTH_KV = makeKV({
      ['session:' + tokenC]: JSON.stringify({ userId: 'user-3333', email: 'carol@example.com' }),
      ['user:carol@example.com']: JSON.stringify({ id: 'user-3333', circleWalletId: 'w1', circleWalletAddress: PAYER }), // same wallet as user A
    });
    const res = await onIntentRequest({ request: req('/api/x402/intent/' + created.intent.intentId, { token: tokenC }), env: envC });
    expect(res.status).toBe(404);
  });

  it('rejects when wallet is not provisioned (400 wallet_not_provisioned)', async () => {
    const env = makeEnv();
    // Session exists but user record has no wallet.
    env.AUTH_KV = makeKV({
      ['session:' + TOKEN]: JSON.stringify({ userId: USER_ID, email: EMAIL }),
      ['user:' + EMAIL]: JSON.stringify({ id: USER_ID }),
    });
    const res = await onIntentRequest({ request: req('/api/x402/intent', { method: 'POST', body: { resourceUrl: 'https://api.example.com/x', requirement: ARC_REQ, idempotencyKey: 'key-http-1234' } }), env });
    expect(res.status).toBe(400);
    const d = await jsonOf(res);
    expect(d.code).toBe('wallet_not_provisioned');
  });

  it('rejects a client attempt to settle/fail an intent (no such route / forbidden)', async () => {
    const env = makeEnv();
    const created = await jsonOf(await onIntentRequest({ request: req('/api/x402/intent', { method: 'POST', body: { resourceUrl: 'https://api.example.com/x', requirement: ARC_REQ, idempotencyKey: 'key-http-1234' } }), env }));
    // There is no public route to set SETTLED; the transition endpoint is not
    // reachable via /settle. Assert a settle-like POST is not found.
    const res = await onIntentRequest({ request: req('/api/x402/intent/' + created.intent.intentId + '/settle', { method: 'POST', body: { expectedVersion: 1 } }), env });
    expect(res.status).toBe(404);
  });
});
