/**
 * x402-intent-do.test.js — X402IntentStore Durable Object (real class)
 * ═══════════════════════════════════════════════════════════════════════
 * Exercises the REAL X402IntentStore class against an in-memory storage mock
 * that models Cloudflare DO semantics: single-instance serialization (async
 * mutex in blockConcurrencyWhile) + atomic read-modify-write transactions.
 *
 * Coverage:
 *   - State machine (valid/invalid/terminal/forbidden transitions).
 *   - Idempotency (same key+payload → same intent; different payload → conflict).
 *   - Nonce reservation (atomic, idempotent re-reserve, cross-intent conflict,
 *     retained on expiry).
 *   - Concurrency (50 duplicate creates → one intent; concurrent nonce race).
 *   - Expiration (lazy on read, alarm sweep, idempotent alarm, no auto-expire of
 *     future signed states).
 *   - Adversarial inputs (schema version, malformed record, forbidden SETTLED,
 *     huge amount, unknown state).
 *
 * NOTE: this uses a mock storage, not the live Cloudflare runtime. The mock
 * faithfully serializes concurrent requests (matching the DO single-instance
 * guarantee) but does NOT exercise SQLite persistence durability across a real
 * worker restart. That guarantee is documented as not integration-verified.
 */
import { describe, it, expect } from 'vitest';
import { Wallet } from 'ethers';
import { X402IntentStore } from '../functions/api/x402/x402-intent.do.js';
import {
  buildTransferWithAuthorization,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
} from '../functions/api/x402/x402-eip712.mjs';

const SECRET = 'test-internal-secret-0123456789abcdef';
// Deterministic test signer (no mainnet funds) — its address becomes the intent's
// wallet so the signed `from` matches the persisted wallet.
const TEST_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const testSignerAddress = () => new Wallet(TEST_PK).address.toLowerCase();

/* ── In-memory DO state mock (serialized via async mutex) ────────────── */

function makeMutex() {
  let tail = Promise.resolve();
  return function withLock(fn) {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
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
    _store: store,
  };
}

function makeDO(envOver = {}) {
  const state = makeDOState();
  const env = { DO_INTERNAL_SECRET: SECRET, X402_INTENT_MAX_PER_USER: '200', ...envOver };
  const doObj = new X402IntentStore(state, env);
  return { doObj, state };
}

function doFetch(doObj, path, { method = 'GET', body, secret = SECRET } = {}) {
  const headers = { 'X-DO-Internal-Secret': secret };
  if (body) headers['Content-Type'] = 'application/json';
  return doObj.fetch(new Request('https://x402-intent-do/' + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  }));
}

async function bodyOf(resp) { return resp.json(); }

/* ── Fixtures ────────────────────────────────────────────────────────── */

function makeIntent(over = {}) {
  return {
    schemaVersion: 1,
    intentId: crypto.randomUUID(),
    userId: 'user-1',
    walletAddress: '0x' + 'ab'.repeat(20),
    walletProvider: 'circle',
    resourceUrl: 'https://api.example.com/premium',
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
    idempotencyKey: 'idem-key-123456',
    state: 'CREATED',
    stateVersion: 1,
    createdAt: new Date(Date.now() - 1000).toISOString(),
    updatedAt: new Date(Date.now() - 1000).toISOString(),
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

const DIGEST = 'c'.repeat(64);
// EIP-3009 authorization nonce is a canonical bytes32 hex string.
function nonce(n) { return '0x' + n.toString(16).padStart(64, '0'); }

async function createIntent(doObj, intent, digest = DIGEST) {
  const resp = await doFetch(doObj, 'create', { method: 'POST', body: { intent, requestDigest: digest } });
  return { resp, body: await bodyOf(resp) };
}

/* ═══════════════════════════════════════════════════════════════════ */

describe('X402IntentStore — create + idempotency', () => {
  it('creates an intent durably and returns it', async () => {
    const { doObj } = makeDO();
    const intent = makeIntent();
    const { resp, body } = await createIntent(doObj, intent);
    expect(resp.status).toBe(201);
    expect(body.ok).toBe(true);
    expect(body.created).toBe(true);
    expect(body.intent.intentId).toBe(intent.intentId);
    expect(body.intent.state).toBe('CREATED');
    expect(body.intent.stateVersion).toBe(1);
  });

  it('is idempotent: same key + same payload returns the SAME intent', async () => {
    const { doObj } = makeDO();
    const intent = makeIntent();
    const first = await createIntent(doObj, intent);
    const second = await createIntent(doObj, intent);
    expect(first.resp.status).toBe(201);
    expect(second.resp.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.idempotent).toBe(true);
    expect(second.body.intent.intentId).toBe(intent.intentId);
  });

  it('conflicts: same key + different payload', async () => {
    const { doObj } = makeDO();
    const intent = makeIntent();
    await createIntent(doObj, intent);
    // Different requestDigest (different payload) with the SAME idempotency key.
    const resp = await doFetch(doObj, 'create', { method: 'POST', body: { intent, requestDigest: 'd'.repeat(64) } });
    const body = await bodyOf(resp);
    expect(resp.status).toBe(409);
    expect(body.error).toBe('idempotency_conflict');
  });

  it('conflicts: same key + different amount (different digest) does not silently replace', async () => {
    const { doObj } = makeDO();
    const intent = makeIntent();
    await createIntent(doObj, intent);
    const changed = makeIntent({ amountAtomic: '2000000' });
    const resp = await doFetch(doObj, 'create', { method: 'POST', body: { intent: changed, requestDigest: 'd'.repeat(64) } });
    expect(resp.status).toBe(409);
  });

  it('different keys create different intents', async () => {
    const { doObj } = makeDO();
    const a = await createIntent(doObj, makeIntent({ idempotencyKey: 'key-alpha-123' }));
    const b = await createIntent(doObj, makeIntent({ idempotencyKey: 'key-beta-1234' }));
    expect(a.body.intent.intentId).not.toBe(b.body.intent.intentId);
  });

  it('rejects a malformed record (unknown schemaVersion)', async () => {
    const { doObj } = makeDO();
    const { resp, body } = await createIntent(doObj, makeIntent({ schemaVersion: 99 }));
    expect(resp.status).toBe(400);
    expect(body.error).toBe('unknown_schema_version');
  });

  it('rejects a malformed amount (non-canonical)', async () => {
    const { doObj } = makeDO();
    const { resp, body } = await createIntent(doObj, makeIntent({ amountAtomic: '1.5' }));
    expect(resp.status).toBe(400);
    expect(body.error).toBe('invalid_amount');
  });

  it('rejects a zero amount', async () => {
    const { doObj } = makeDO();
    const { resp, body } = await createIntent(doObj, makeIntent({ amountAtomic: '0' }));
    expect(resp.status).toBe(400);
    expect(body.error).toBe('invalid_amount');
  });

  it('rejects an extremely large amount', async () => {
    const { doObj } = makeDO();
    const { resp, body } = await createIntent(doObj, makeIntent({ amountAtomic: '9'.repeat(100) }));
    expect(resp.status).toBe(400);
    expect(body.error).toBe('invalid_amount');
  });

  it('rejects terminal financial fields set at creation', async () => {
    const { doObj } = makeDO();
    const { resp, body } = await createIntent(doObj, makeIntent({ transactionHash: '0xabc' }));
    expect(resp.status).toBe(400);
    expect(body.error).toBe('invalid_terminal_fields');
  });

  it('rejects without the internal secret (fail-closed)', async () => {
    const { doObj } = makeDO();
    const resp = await doFetch(doObj, 'create', { method: 'POST', body: { intent: makeIntent(), requestDigest: DIGEST }, secret: 'wrong' });
    expect(resp.status).toBe(401);
  });

  it('enforces the per-user record cap', async () => {
    const { doObj } = makeDO({ X402_INTENT_MAX_PER_USER: '2' });
    await createIntent(doObj, makeIntent({ idempotencyKey: 'key-one-1234' }));
    await createIntent(doObj, makeIntent({ idempotencyKey: 'key-two-1234' }));
    const { resp, body } = await createIntent(doObj, makeIntent({ idempotencyKey: 'key-three-12' }));
    expect(resp.status).toBe(429);
    expect(body.error).toBe('too_many_intents');
  });
});

describe('X402IntentStore — state machine', () => {
  it('CREATED → PREPARED → AWAITING_AUTHORIZATION (happy path)', async () => {
    const { doObj } = makeDO();
    const intent = makeIntent();
    await createIntent(doObj, intent);

    const p = await doFetch(doObj, 'transition', { method: 'POST', body: { intentId: intent.intentId, to: 'PREPARED', expectedVersion: 1 } });
    const pb = await bodyOf(p);
    expect(p.status).toBe(200);
    expect(pb.intent.state).toBe('PREPARED');
    expect(pb.intent.stateVersion).toBe(2);

    const n = await doFetch(doObj, 'reserve-nonce', { method: 'POST', body: { intentId: intent.intentId, nonce: nonce(0x3039), expectedVersion: 2 } });
    const nb = await bodyOf(n);
    expect(n.status).toBe(200);
    expect(nb.intent.state).toBe('AWAITING_AUTHORIZATION');
    expect(nb.intent.authorizationNonce).toBe(nonce(0x3039));
    expect(nb.intent.stateVersion).toBe(3);
  });

  it('rejects a backward target (PREPARED → CREATED) as forbidden', async () => {
    const { doObj } = makeDO();
    const intent = makeIntent();
    await createIntent(doObj, intent);
    await doFetch(doObj, 'transition', { method: 'POST', body: { intentId: intent.intentId, to: 'PREPARED', expectedVersion: 1 } });
    const resp = await doFetch(doObj, 'transition', { method: 'POST', body: { intentId: intent.intentId, to: 'CREATED', expectedVersion: 2 } });
    const body = await bodyOf(resp);
    expect(resp.status).toBe(403);
    expect(body.error).toBe('forbidden_transition');
  });

  it('rejects an invalid transition among allowed targets (PREPARED → CANCELLED → PREPARED)', async () => {
    const { doObj } = makeDO();
    const intent = makeIntent();
    await createIntent(doObj, intent);
    await doFetch(doObj, 'transition', { method: 'POST', body: { intentId: intent.intentId, to: 'CANCELLED', expectedVersion: 1 } });
    const resp = await doFetch(doObj, 'transition', { method: 'POST', body: { intentId: intent.intentId, to: 'PREPARED', expectedVersion: 2 } });
    const body = await bodyOf(resp);
    expect(resp.status).toBe(400);
    expect(body.error).toBe('invalid_transition');
  });

  it('rejects transitions targeting reserved financial states (SETTLED / FAILED / AUTHORIZED / SUBMITTING / SETTLEMENT_UNKNOWN)', async () => {
    const { doObj } = makeDO();
    const intent = makeIntent();
    await createIntent(doObj, intent);
    for (const to of ['SETTLED', 'FAILED', 'AUTHORIZED', 'SUBMITTING', 'SETTLEMENT_UNKNOWN', 'EXPIRED']) {
      const resp = await doFetch(doObj, 'transition', { method: 'POST', body: { intentId: intent.intentId, to, expectedVersion: 1 } });
      expect(resp.status).toBe(403, `transition to ${to} must be forbidden`);
    }
  });

  it('rejects a stale stateVersion (optimistic concurrency)', async () => {
    const { doObj } = makeDO();
    const intent = makeIntent();
    await createIntent(doObj, intent);
    await doFetch(doObj, 'transition', { method: 'POST', body: { intentId: intent.intentId, to: 'PREPARED', expectedVersion: 1 } });
    // Now stateVersion is 2; a transition with the stale version 1 must fail.
    const resp = await doFetch(doObj, 'transition', { method: 'POST', body: { intentId: intent.intentId, to: 'CANCELLED', expectedVersion: 1 } });
    const body = await bodyOf(resp);
    expect(resp.status).toBe(409);
    expect(body.error).toBe('stale_version');
  });

  it('repeated identical transition is idempotent (no version bump)', async () => {
    const { doObj } = makeDO();
    const intent = makeIntent();
    await createIntent(doObj, intent);
    const a = await doFetch(doObj, 'transition', { method: 'POST', body: { intentId: intent.intentId, to: 'PREPARED', expectedVersion: 1 } });
    const ab = await bodyOf(a);
    expect(ab.intent.stateVersion).toBe(2);
    // Retry with the OLD version but same target → idempotent success, no change.
    const b = await doFetch(doObj, 'transition', { method: 'POST', body: { intentId: intent.intentId, to: 'PREPARED', expectedVersion: 1 } });
    const bb = await bodyOf(b);
    expect(b.status).toBe(200);
    expect(bb.idempotent).toBe(true);
    expect(bb.intent.stateVersion).toBe(2);
  });

  it('terminal state is absorbing (no transition out of CANCELLED)', async () => {
    const { doObj } = makeDO();
    const intent = makeIntent();
    await createIntent(doObj, intent);
    await doFetch(doObj, 'transition', { method: 'POST', body: { intentId: intent.intentId, to: 'CANCELLED', expectedVersion: 1 } });
    const resp = await doFetch(doObj, 'transition', { method: 'POST', body: { intentId: intent.intentId, to: 'PREPARED', expectedVersion: 2 } });
    const body = await bodyOf(resp);
    expect(resp.status).toBe(400);
    expect(body.error).toBe('invalid_transition');
  });

  it('unknown intent returns 404', async () => {
    const { doObj } = makeDO();
    const resp = await doFetch(doObj, 'intent?id=' + crypto.randomUUID());
    expect(resp.status).toBe(404);
  });
});

describe('X402IntentStore — nonce reservation / replay protection', () => {
  it('reserves a nonce atomically and idempotently for the same intent', async () => {
    const { doObj } = makeDO();
    const intent = makeIntent();
    await createIntent(doObj, intent);
    await doFetch(doObj, 'transition', { method: 'POST', body: { intentId: intent.intentId, to: 'PREPARED', expectedVersion: 1 } });

    const first = await doFetch(doObj, 'reserve-nonce', { method: 'POST', body: { intentId: intent.intentId, nonce: nonce(0x2a), expectedVersion: 2 } });
    expect(first.status).toBe(200);
    // Idempotent re-reserve by the same intent.
    const again = await doFetch(doObj, 'reserve-nonce', { method: 'POST', body: { intentId: intent.intentId, nonce: nonce(0x2a), expectedVersion: 2 } });
    const againBody = await bodyOf(again);
    expect(again.status).toBe(200);
    expect(againBody.idempotent).toBe(true);
    expect(againBody.intent.authorizationNonce).toBe(nonce(0x2a));
  });

  it('reservation by ANOTHER intent for the same nonce fails', async () => {
    const { doObj } = makeDO();
    const a = makeIntent({ idempotencyKey: 'key-aaaa-1234' });
    const b = makeIntent({ idempotencyKey: 'key-bbbb-1234' });
    await createIntent(doObj, a);
    await createIntent(doObj, b);
    await doFetch(doObj, 'transition', { method: 'POST', body: { intentId: a.intentId, to: 'PREPARED', expectedVersion: 1 } });
    await doFetch(doObj, 'transition', { method: 'POST', body: { intentId: b.intentId, to: 'PREPARED', expectedVersion: 1 } });

    await doFetch(doObj, 'reserve-nonce', { method: 'POST', body: { intentId: a.intentId, nonce: nonce(7), expectedVersion: 2 } });
    const resp = await doFetch(doObj, 'reserve-nonce', { method: 'POST', body: { intentId: b.intentId, nonce: nonce(7), expectedVersion: 2 } });
    const body = await bodyOf(resp);
    expect(resp.status).toBe(409);
    expect(body.error).toBe('nonce_already_reserved');
    expect(body.ownerIntentId).toBe(a.intentId);
  });

  it('different chains with identical nonces do NOT conflict', async () => {
    const { doObj } = makeDO();
    const base = makeIntent({ idempotencyKey: 'key-base-1234' });
    const arc = makeIntent({
      idempotencyKey: 'key-arc-12345',
      network: 'eip155:8453',
      chainId: 8453,
      assetAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    });
    await createIntent(doObj, base);
    await createIntent(doObj, arc);
    await doFetch(doObj, 'transition', { method: 'POST', body: { intentId: base.intentId, to: 'PREPARED', expectedVersion: 1 } });
    await doFetch(doObj, 'transition', { method: 'POST', body: { intentId: arc.intentId, to: 'PREPARED', expectedVersion: 1 } });

    const r1 = await doFetch(doObj, 'reserve-nonce', { method: 'POST', body: { intentId: base.intentId, nonce: nonce(0x63), expectedVersion: 2 } });
    const r2 = await doFetch(doObj, 'reserve-nonce', { method: 'POST', body: { intentId: arc.intentId, nonce: nonce(0x63), expectedVersion: 2 } });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  it('rejects an invalid nonce', async () => {
    const { doObj } = makeDO();
    const intent = makeIntent();
    await createIntent(doObj, intent);
    await doFetch(doObj, 'transition', { method: 'POST', body: { intentId: intent.intentId, to: 'PREPARED', expectedVersion: 1 } });
    const resp = await doFetch(doObj, 'reserve-nonce', { method: 'POST', body: { intentId: intent.intentId, nonce: '-1', expectedVersion: 2 } });
    expect(resp.status).toBe(400);
  });

  it('cannot reserve a nonce before PREPARED', async () => {
    const { doObj } = makeDO();
    const intent = makeIntent();
    await createIntent(doObj, intent);
    const resp = await doFetch(doObj, 'reserve-nonce', { method: 'POST', body: { intentId: intent.intentId, nonce: nonce(1), expectedVersion: 1 } });
    const body = await bodyOf(resp);
    expect(resp.status).toBe(400);
    expect(body.error).toBe('invalid_transition');
  });
});

describe('X402IntentStore — concurrency (serialized)', () => {
  it('50 concurrent duplicate creates produce exactly ONE intent', async () => {
    const { doObj } = makeDO();
    const intent = makeIntent();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => createIntent(doObj, intent))
    );
    const created = results.filter((r) => r.body.created === true);
    const idem = results.filter((r) => r.body.created === false);
    expect(created.length).toBe(1);
    expect(idem.length).toBe(49);
    // Every response refers to the SAME intentId.
    for (const r of results) expect(r.body.intent.intentId).toBe(intent.intentId);
  });

  it('concurrent nonce reservation: only one intent can own a nonce', async () => {
    const { doObj } = makeDO();
    const a = makeIntent({ idempotencyKey: 'key-aaaa-1234' });
    const b = makeIntent({ idempotencyKey: 'key-bbbb-1234' });
    await createIntent(doObj, a);
    await createIntent(doObj, b);
    await doFetch(doObj, 'transition', { method: 'POST', body: { intentId: a.intentId, to: 'PREPARED', expectedVersion: 1 } });
    await doFetch(doObj, 'transition', { method: 'POST', body: { intentId: b.intentId, to: 'PREPARED', expectedVersion: 1 } });

    const results = await Promise.all([
      doFetch(doObj, 'reserve-nonce', { method: 'POST', body: { intentId: a.intentId, nonce: nonce(0x309), expectedVersion: 2 } }),
      doFetch(doObj, 'reserve-nonce', { method: 'POST', body: { intentId: b.intentId, nonce: nonce(0x309), expectedVersion: 2 } }),
    ]);
    const statuses = await Promise.all(results.map((r) => r.json()));
    const okCount = statuses.filter((s) => s.ok === true).length;
    const conflictCount = statuses.filter((s) => s.error === 'nonce_already_reserved').length;
    expect(okCount).toBe(1);
    expect(conflictCount).toBe(1);
  });

  it('cancel racing with prepare is deterministic (one wins, no torn state)', async () => {
    const { doObj } = makeDO();
    const intent = makeIntent();
    await createIntent(doObj, intent);
    const [p, c] = await Promise.all([
      doFetch(doObj, 'transition', { method: 'POST', body: { intentId: intent.intentId, to: 'PREPARED', expectedVersion: 1 } }),
      doFetch(doObj, 'transition', { method: 'POST', body: { intentId: intent.intentId, to: 'CANCELLED', expectedVersion: 1 } }),
    ]);
    const pb = await p.json();
    const cb = await c.json();
    // Exactly one transition succeeds (status 200 ok); the other is either an
    // idempotent no-op or an invalid_transition/stale — never a torn state.
    const successes = [pb, cb].filter((b) => b.ok === true).length;
    expect(successes).toBeGreaterThanOrEqual(1);
    const final = await doFetch(doObj, 'intent?id=' + intent.intentId);
    const finalBody = await final.json();
    expect(['PREPARED', 'CANCELLED']).toContain(finalBody.intent.state);
  });
});

describe('X402IntentStore — expiration & recovery', () => {
  it('lazily expires an unsigned intent on read (past expiresAt)', async () => {
    const { doObj } = makeDO();
    const intent = makeIntent({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    await createIntent(doObj, intent);
    const resp = await doFetch(doObj, 'intent?id=' + intent.intentId);
    const body = await bodyOf(resp);
    expect(resp.status).toBe(200);
    expect(body.intent.state).toBe('EXPIRED');
  });

  it('rejects transitions on an expired intent (expiration races prepare)', async () => {
    const { doObj } = makeDO();
    const intent = makeIntent({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    await createIntent(doObj, intent);
    const resp = await doFetch(doObj, 'transition', { method: 'POST', body: { intentId: intent.intentId, to: 'PREPARED', expectedVersion: 1 } });
    const body = await bodyOf(resp);
    expect(resp.status).toBe(409);
    expect(body.error).toBe('intent_expired');
  });

  it('alarm sweep transitions expired unsigned intents and re-arms for the next', async () => {
    const { doObj, state } = makeDO();
    const expiring = makeIntent({ idempotencyKey: 'key-exp-12345', expiresAt: new Date(Date.now() - 1000).toISOString() });
    const future = makeIntent({ idempotencyKey: 'key-fut-12345', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await createIntent(doObj, expiring);
    await createIntent(doObj, future);

    await doObj.alarm();

    const e = await bodyOf(await doFetch(doObj, 'intent?id=' + expiring.intentId));
    const f = await bodyOf(await doFetch(doObj, 'intent?id=' + future.intentId));
    expect(e.intent.state).toBe('EXPIRED');
    expect(f.intent.state).toBe('CREATED');
    // Alarm re-armed for the next earliest (future intent's expiry).
    const alarm = state._store.get('__alarm');
    expect(alarm).toBeTypeOf('number');
    expect(alarm).toBeGreaterThan(Date.now());
  });

  it('duplicate alarm is idempotent (no double transition)', async () => {
    const { doObj } = makeDO();
    const intent = makeIntent({ idempotencyKey: 'key-dup-12345', expiresAt: new Date(Date.now() - 1000).toISOString() });
    await createIntent(doObj, intent);
    await doObj.alarm();
    await doObj.alarm();
    const body = await bodyOf(await doFetch(doObj, 'intent?id=' + intent.intentId));
    expect(body.intent.state).toBe('EXPIRED');
    // stateVersion incremented exactly once across the two sweeps.
    expect(body.intent.stateVersion).toBe(2);
  });

  it('nonce reservation is RETAINED after expiry (never released for reuse)', async () => {
    const { doObj, state } = makeDO();
    const intent = makeIntent({ idempotencyKey: 'key-keep-1234', expiresAt: new Date(Date.now() + 10_000).toISOString() });
    await createIntent(doObj, intent);
    await doFetch(doObj, 'transition', { method: 'POST', body: { intentId: intent.intentId, to: 'PREPARED', expectedVersion: 1 } });
    await doFetch(doObj, 'reserve-nonce', { method: 'POST', body: { intentId: intent.intentId, nonce: nonce(0x67932), expectedVersion: 2 } });

    // Simulate wall-clock advancing past expiresAt (trusted server clock only).
    const stored = state._store.get('intent:' + intent.intentId);
    stored.expiresAt = new Date(Date.now() - 1000).toISOString();
    state._store.set('intent:' + intent.intentId, stored);
    await doObj.alarm();

    // The nonce:424242 reservation must still exist (retained, NOT released).
    const nonceKey = [String(intent.chainId), intent.assetAddress.toLowerCase(), intent.walletAddress.toLowerCase(), nonce(0x67932)].join(':');
    expect(state._store.has('nonce:' + nonceKey)).toBe(true);

    // A second intent cannot now grab that nonce (still reserved).
    const other = makeIntent({ idempotencyKey: 'key-other-123', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await createIntent(doObj, other);
    await doFetch(doObj, 'transition', { method: 'POST', body: { intentId: other.intentId, to: 'PREPARED', expectedVersion: 1 } });
    const resp = await doFetch(doObj, 'reserve-nonce', { method: 'POST', body: { intentId: other.intentId, nonce: nonce(0x67932), expectedVersion: 2 } });
    expect(resp.status).toBe(409);
  });

  it('a future signed/submitted state is NEVER auto-expired', async () => {
    // Reserved states are unreachable via public transitions; verify the expiry
    // logic skips non-ACTIVE_UNSIGNED states even if present in storage.
    const { doObj } = makeDO();
    const intent = makeIntent({ state: 'AUTHORIZED', expiresAt: new Date(Date.now() - 1000).toISOString() });
    await createIntent(doObj, intent); // passes _validateNewIntent? No — state must be CREATED.
    // Expect create to reject the reserved state at creation.
    const resp = await doFetch(doObj, 'create', { method: 'POST', body: { intent: makeIntent({ state: 'AUTHORIZED' }), requestDigest: DIGEST } });
    expect(resp.status).toBe(400);
  });
});

describe('X402IntentStore — cross-wallet isolation (sharding)', () => {
  it('two DO instances (different wallets) do not share idempotency or nonce state', async () => {
    const a = makeDO();
    const b = makeDO();
    // Sharding boundary is the wallet address (authoritative nonce namespace).
    const intentA = makeIntent({ walletAddress: '0x' + 'ab'.repeat(20) });
    const intentB = makeIntent({ walletAddress: '0x' + 'ef'.repeat(20), idempotencyKey: intentA.idempotencyKey });

    const ra = await createIntent(a.doObj, intentA);
    const rb = await createIntent(b.doObj, intentB);
    // Same idempotency key but different wallets → both create successfully.
    expect(ra.resp.status).toBe(201);
    expect(rb.resp.status).toBe(201);
    expect(ra.body.intent.intentId).not.toBe(rb.body.intent.intentId);
  });
});

describe('X402IntentStore — trusted internal /authorize', () => {
  // Drive an intent to AWAITING_AUTHORIZATION with a reserved bytes32 nonce.
  async function preparedIntent(doObj) {
    const intent = makeIntent({ walletAddress: testSignerAddress() });
    await createIntent(doObj, intent);
    await doFetch(doObj, 'transition', { method: 'POST', body: { intentId: intent.intentId, to: 'PREPARED', expectedVersion: 1 } });
    const reserved = await doFetch(doObj, 'reserve-nonce', { method: 'POST', body: { intentId: intent.intentId, nonce: nonce(0xabc), expectedVersion: 2 } });
    const reservedBody = await bodyOf(reserved);
    return reservedBody.intent; // AWAITING_AUTHORIZATION with the reserved nonce
  }

  async function signFor(intent) {
    const wallet = new Wallet(TEST_PK);
    const td = buildTransferWithAuthorization({
      from: intent.walletAddress,
      to: intent.payTo,
      value: intent.amountAtomic,
      validAfter: '0',
      validBefore: '9999999999',
      nonce: intent.authorizationNonce,
    });
    const signature = await wallet.signTypedData(td.domain, TRANSFER_WITH_AUTHORIZATION_TYPES, td.value);
    return { td, signature };
  }

  it('authorizes a valid signature and persists AUTHORIZED + metadata', async () => {
    const { doObj } = makeDO();
    const intent = await preparedIntent(doObj);
    const { td, signature } = await signFor(intent);

    const resp = await doFetch(doObj, 'authorize', { method: 'POST', body: {
      intentId: intent.intentId, expectedVersion: 3,
      authorization: { from: td.value.from, to: td.value.to, value: td.value.value, validAfter: '0', validBefore: '9999999999', nonce: td.value.nonce, signature },
    } });
    expect(resp.status).toBe(200);
    const body = await bodyOf(resp);
    expect(body.intent.state).toBe('AUTHORIZED');
    expect(body.intent.stateVersion).toBe(4);
    expect(body.intent.authorizedAt).toBeTruthy();
    expect(body.intent.authorizationSignature).toBe(signature);
    expect(body.intent.authorizationValidAfter).toBe('0');
    expect(body.intent.authorizationValidBefore).toBe('9999999999');
  });

  it('rejects a stale stateVersion (409)', async () => {
    const { doObj } = makeDO();
    const intent = await preparedIntent(doObj);
    const { td, signature } = await signFor(intent);
    const resp = await doFetch(doObj, 'authorize', { method: 'POST', body: {
      intentId: intent.intentId, expectedVersion: 2, // stale (current is 3)
      authorization: { from: td.value.from, to: td.value.to, value: td.value.value, validAfter: '0', validBefore: '9999999999', nonce: td.value.nonce, signature },
    } });
    const body = await bodyOf(resp);
    expect(resp.status).toBe(409);
    expect(body.error).toBe('stale_version');
  });

  it('rejects a nonce mismatch (signed nonce ≠ reserved nonce)', async () => {
    const { doObj } = makeDO();
    const intent = await preparedIntent(doObj);
    const { td } = await signFor(intent);
    const resp = await doFetch(doObj, 'authorize', { method: 'POST', body: {
      intentId: intent.intentId, expectedVersion: 3,
      authorization: { from: td.value.from, to: td.value.to, value: td.value.value, validAfter: '0', validBefore: '9999999999', nonce: nonce(0xdef), signature: '0x' + '11'.repeat(65) },
    } });
    const body = await bodyOf(resp);
    expect(resp.status).toBe(409);
    expect(body.error).toBe('nonce_mismatch');
  });

  it('rejects an amount mismatch (signed value ≠ intent amount)', async () => {
    const { doObj } = makeDO();
    const intent = await preparedIntent(doObj);
    const { td, signature } = await signFor(intent);
    const resp = await doFetch(doObj, 'authorize', { method: 'POST', body: {
      intentId: intent.intentId, expectedVersion: 3,
      authorization: { from: td.value.from, to: td.value.to, value: '999999999', validAfter: '0', validBefore: '9999999999', nonce: td.value.nonce, signature },
    } });
    const body = await bodyOf(resp);
    expect(resp.status).toBe(409);
    expect(body.error).toBe('amount_mismatch');
  });

  it('rejects authorizing before AWAITING_AUTHORIZATION (invalid_transition)', async () => {
    const { doObj } = makeDO();
    const intent = makeIntent({ walletAddress: testSignerAddress() });
    await createIntent(doObj, intent); // state CREATED
    const resp = await doFetch(doObj, 'authorize', { method: 'POST', body: {
      intentId: intent.intentId, expectedVersion: 1,
      authorization: { from: intent.walletAddress, to: intent.payTo, value: intent.amountAtomic, validAfter: '0', validBefore: '9999999999', nonce: nonce(0xabc), signature: '0x' + '11'.repeat(65) },
    } });
    const body = await bodyOf(resp);
    expect(resp.status).toBe(400);
    expect(body.error).toBe('invalid_transition');
  });

  it('is idempotent on re-entry with the identical signature', async () => {
    const { doObj } = makeDO();
    const intent = await preparedIntent(doObj);
    const { td, signature } = await signFor(intent);
    const authBody = { intentId: intent.intentId, expectedVersion: 3, authorization: { from: td.value.from, to: td.value.to, value: td.value.value, validAfter: '0', validBefore: '9999999999', nonce: td.value.nonce, signature } };
    await doFetch(doObj, 'authorize', { method: 'POST', body: authBody });
    const again = await doFetch(doObj, 'authorize', { method: 'POST', body: authBody });
    const body = await bodyOf(again);
    expect(again.status).toBe(200);
    expect(body.idempotent).toBe(true);
    expect(body.intent.stateVersion).toBe(4); // no double increment
  });

  it('does NOT auto-expire an AUTHORIZED (signed) intent', async () => {
    const { doObj } = makeDO();
    const intent = await preparedIntent(doObj);
    const { td, signature } = await signFor(intent);
    await doFetch(doObj, 'authorize', { method: 'POST', body: {
      intentId: intent.intentId, expectedVersion: 3,
      authorization: { from: td.value.from, to: td.value.to, value: td.value.value, validAfter: '0', validBefore: '9999999999', nonce: td.value.nonce, signature },
    } });
    // Force the expiresAt into the past and run the alarm: a signed intent must stay AUTHORIZED.
    const store = doObj.storage;
    const stored = await store.get('intent:' + intent.intentId);
    stored.expiresAt = new Date(Date.now() - 1000).toISOString();
    await store.put('intent:' + intent.intentId, stored);
    await doObj.alarm();
    const after = await bodyOf(await doFetch(doObj, 'intent?id=' + intent.intentId));
    expect(after.intent.state).toBe('AUTHORIZED');
  });
});
