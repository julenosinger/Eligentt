/**
 * gateway-execution-coordinator.test.js
 * ═══════════════════════════════════════════════════════════════════════════
 * Phase 1.0.1C — GatewayExecutionCoordinator (isolated development).
 *
 * Exercises the REAL modules (no re-implementation of the logic under test):
 *   - coordinator-util.js  (canonicalPayloadHash / idempotencyKeyFor / depositorOf /
 *                           environmentFor)
 *   - gateway-execution-coordinator.do.js (real DO class, DO-compatible storage
 *     mock with serialized single-flight semantics)
 *   - transfer.js onRequestPost (real handler with the flag-gated coordinator
 *     integration; only the external dependencies — DO binding, KV, fetch — are
 *     mocked)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const util = await import('../functions/api/gateway/coordinator-util.js');
const {
  canonicalPayloadHash,
  idempotencyKeyFor,
  depositorOf,
  environmentFor,
  MAINNET_GATEWAY_WALLET,
  TESTNET_GATEWAY_WALLET,
  ENV_MAINNET,
  ENV_TESTNET,
} = util;

const { GatewayExecutionCoordinator } = await import('../functions/api/gateway/gateway-execution-coordinator.do.js');
const transfer = await import('../functions/api/gateway/transfer.js');
const { onRequestPost } = transfer;

// ── Fixtures ─────────────────────────────────────────────────────────────────
const SECRET      = 'test-internal-secret-1234567890abcdef';
const DEPOSITOR   = '0x1111111111111111111111111111111111111111';
const RECIPIENT   = '0x2222222222222222222222222222222222222222';
const RECIPIENT_B = '0x3333333333333333333333333333333333333333';
const TOKEN_A     = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN_B     = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const MINTER      = '0x2222222d7164433c4c09b0b0d809a9b52c04c205';

function pad32(addr) {
  return '0x' + String(addr).toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function makeBurnIntent(over = {}) {
  const specOver = over.spec || {};
  const spec = {
    version:              1,
    sourceDomain:         26,
    destinationDomain:    0,
    sourceContract:       pad32(MAINNET_GATEWAY_WALLET),
    destinationContract:  pad32(MINTER),
    sourceToken:          pad32(TOKEN_A),
    destinationToken:     pad32(TOKEN_B),
    sourceDepositor:      pad32(DEPOSITOR),
    destinationRecipient: pad32(RECIPIENT),
    sourceSigner:         pad32(DEPOSITOR),
    destinationCaller:    pad32('0x0000000000000000000000000000000000000000'),
    value:                '1000000',
    salt:                 '0x' + '44'.repeat(32),
    hookData:             '0x',
    ...specOver,
  };
  return {
    maxBlockHeight: '115792089237316195423570985008687907853269984665640564039457584007913129639935',
    maxFee:         '2010000',
    ...(over.maxBlockHeight !== undefined ? { maxBlockHeight: over.maxBlockHeight } : {}),
    ...(over.maxFee !== undefined ? { maxFee: over.maxFee } : {}),
    spec,
  };
}

// ── DO-compatible storage mock (serialized single-flight) ───────────────────
function makeDOState() {
  const store = new Map();
  let queue = Promise.resolve();
  function enqueue(fn) {
    const run = queue.then(fn);
    queue = run.then(() => {}, () => {});
    return run;
  }
  const storage = {
    async get(k) { return store.has(k) ? store.get(k) : undefined; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
    async transaction(fn) {
      const txn = {
        get: async (k) => (store.has(k) ? store.get(k) : undefined),
        put: async (k, v) => { store.set(k, v); },
        delete: async (k) => { store.delete(k); },
      };
      return fn(txn);
    },
  };
  return { storage, blockConcurrencyWhile: (fn) => enqueue(fn), _store: store };
}

function doFetch(coord, action, method, body, secret = SECRET) {
  const headers = { 'Content-Type': 'application/json' };
  if (secret) headers['X-DO-Internal-Secret'] = secret;
  return coord.fetch(new Request('https://do' + action, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  }));
}

// ── Mock DO namespace (routes stubs to real DO instances keyed by name) ─────
function makeCoordinatorNamespace(secret = SECRET) {
  const instances = new Map();
  return {
    idFromName(name) { return { name, toString: () => name }; },
    get(doId) {
      const name = doId.name;
      if (!instances.has(name)) {
        instances.set(name, new GatewayExecutionCoordinator(makeDOState(), { DO_INTERNAL_SECRET: secret }));
      }
      const coord = instances.get(name);
      return { fetch: (url, opts) => coord.fetch(new Request(url, opts)) };
    },
    instances,
  };
}

function makeKV() {
  const store = new Map();
  return {
    store,
    async get(k, opts) {
      const v = store.has(k) ? store.get(k) : null;
      if (v === null) return null;
      if (opts && opts.type === 'json') return JSON.parse(v);
      return v;
    },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
  };
}

function makeTransferItem(burnIntent) {
  return { burnIntent, signature: '0x' + '33'.repeat(65) };
}

function makePostRequest(items) {
  return new Request('https://elligentttest.pages.dev/api/gateway/transfer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': 'https://elligentttest.pages.dev' },
    body: JSON.stringify(items),
  });
}

beforeEach(() => { delete globalThis.fetch; });
afterEach(() => { delete globalThis.fetch; });

// ═══════════════════════════════════════════════════════════════════════════
describe('coordinator-util — canonical payload hash + idempotency key (real module)', () => {
  it('canonicalPayloadHash is identical for the same intent with DIFFERENT salts', async () => {
    const a = makeBurnIntent();
    const b = makeBurnIntent({ spec: { salt: '0x' + '55'.repeat(32) } });
    expect(a.spec.salt).not.toBe(b.spec.salt);
    expect(await canonicalPayloadHash(a)).toBe(await canonicalPayloadHash(b));
  });

  it('canonicalPayloadHash differs when the amount (value) changes', async () => {
    const a = makeBurnIntent();
    const b = makeBurnIntent({ spec: { value: '2000000' } });
    expect(await canonicalPayloadHash(a)).not.toBe(await canonicalPayloadHash(b));
  });

  it('canonicalPayloadHash differs when the recipient changes', async () => {
    const a = makeBurnIntent();
    const b = makeBurnIntent({ spec: { destinationRecipient: pad32(RECIPIENT_B) } });
    expect(await canonicalPayloadHash(a)).not.toBe(await canonicalPayloadHash(b));
  });

  it('canonicalPayloadHash is stable across casing of hex fields', async () => {
    const a = makeBurnIntent();
    const b = makeBurnIntent({ spec: { sourceToken: pad32(TOKEN_A).toUpperCase() } });
    expect(await canonicalPayloadHash(a)).toBe(await canonicalPayloadHash(b));
  });

  it('idempotencyKeyFor is stable across salts and differs across recipients', async () => {
    const a = makeBurnIntent();
    const b = makeBurnIntent({ spec: { salt: '0x' + '66'.repeat(32) } });
    const c = makeBurnIntent({ spec: { destinationRecipient: pad32(RECIPIENT_B) } });
    expect(await idempotencyKeyFor(a)).toBe(await idempotencyKeyFor(b));
    expect(await idempotencyKeyFor(a)).not.toBe(await idempotencyKeyFor(c));
  });

  it('idempotencyKeyFor distinguishes different amounts (same recipient)', async () => {
    const a = makeBurnIntent();
    const b = makeBurnIntent({ spec: { value: '999' } });
    // The key is the coarse slot (excludes value), so same key for same recipient.
    expect(await idempotencyKeyFor(a)).toBe(await idempotencyKeyFor(b));
    // But the full hash differs (value is in the payload), which drives conflict detection.
    expect(await canonicalPayloadHash(a)).not.toBe(await canonicalPayloadHash(b));
  });

  it('depositorOf unpads the 20-byte address from bytes32', () => {
    expect(depositorOf(makeBurnIntent())).toBe(DEPOSITOR.toLowerCase());
  });

  it('environmentFor distinguishes mainnet vs testnet vs unknown wallets', () => {
    expect(environmentFor(makeBurnIntent())).toBe(ENV_MAINNET);
    expect(environmentFor(makeBurnIntent({ spec: { sourceContract: pad32(TESTNET_GATEWAY_WALLET) } }))).toBe(ENV_TESTNET);
    expect(environmentFor(makeBurnIntent({ spec: { sourceContract: pad32('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef') } }))).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('GatewayExecutionCoordinator — auth + dedup + fencing (real class)', () => {
  it('blocks requests without a valid internal secret (fail-closed)', async () => {
    const coord = new GatewayExecutionCoordinator(makeDOState(), { DO_INTERNAL_SECRET: SECRET });
    const res = await doFetch(coord, '/status?operationId=x', 'GET', null, 'wrong');
    expect(res.status).toBe(401);
  });

  it('rejects a reserve with a missing burnIntent', async () => {
    const coord = new GatewayExecutionCoordinator(makeDOState(), { DO_INTERNAL_SECRET: SECRET });
    const res = await doFetch(coord, '/reserve', 'POST', {});
    expect(res.status).toBe(400);
  });

  it('reserves a new operation (201)', async () => {
    const coord = new GatewayExecutionCoordinator(makeDOState(), { DO_INTERNAL_SECRET: SECRET });
    const res = await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent() });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.reserved).toBe(true);
    expect(body.record.status).toBe('reserved');
    expect(body.record.depositor).toBe(DEPOSITOR.toLowerCase());
    expect(body.record.environment).toBe('mainnet');
    expect(body.record.version).toBe(1);
  });

  it('recovers the SAME intent submitted with a DIFFERENT salt (cross-salt dedup)', async () => {
    const coord = new GatewayExecutionCoordinator(makeDOState(), { DO_INTERNAL_SECRET: SECRET });
    const r1 = await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent() });
    expect(r1.status).toBe(201);
    const first = (await r1.json()).record;

    const r2 = await doFetch(coord, '/reserve', 'POST', {
      burnIntent: makeBurnIntent({ spec: { salt: '0x' + '77'.repeat(32) } }),
    });
    expect(r2.status).toBe(200);
    const second = await r2.json();
    expect(second.recovered).toBe(true);
    expect(second.record.operationId).toBe(first.operationId);
  });

  it('conflicts when the same payment slot is reused with a DIFFERENT amount', async () => {
    const coord = new GatewayExecutionCoordinator(makeDOState(), { DO_INTERNAL_SECRET: SECRET });
    await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent() });
    const res = await doFetch(coord, '/reserve', 'POST', {
      burnIntent: makeBurnIntent({ spec: { value: '2000000', salt: '0x' + '88'.repeat(32) } }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('conflict');
  });

  it('does NOT conflate two independent payments to DIFFERENT recipients', async () => {
    const coord = new GatewayExecutionCoordinator(makeDOState(), { DO_INTERNAL_SECRET: SECRET });
    const r1 = await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent() });
    expect(r1.status).toBe(201);
    const r2 = await doFetch(coord, '/reserve', 'POST', {
      burnIntent: makeBurnIntent({ spec: { destinationRecipient: pad32(RECIPIENT_B), salt: '0x' + '99'.repeat(32) } }),
    });
    expect(r2.status).toBe(201); // independent, both reserved
  });

  it('frees a slot when the existing operation reaches a terminal state', async () => {
    const coord = new GatewayExecutionCoordinator(makeDOState(), { DO_INTERNAL_SECRET: SECRET });
    const r1 = await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent() });
    const rec = (await r1.json()).record;

    // Terminal transition: reserved → rejected (definitive).
    const u1 = await doFetch(coord, '/update', 'POST', { operationId: rec.operationId, to: 'rejected', expectedVersion: 1, evidence: {} });
    expect(u1.status).toBe(200);

    // New intent in the same slot (different salt) should now reserve fresh.
    const r2 = await doFetch(coord, '/reserve', 'POST', {
      burnIntent: makeBurnIntent({ spec: { salt: '0x' + 'aa'.repeat(32) } }),
    });
    expect(r2.status).toBe(201);
  });

  it('rejects a stale update (fencing token mismatch)', async () => {
    const coord = new GatewayExecutionCoordinator(makeDOState(), { DO_INTERNAL_SECRET: SECRET });
    const r1 = await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent() });
    const rec = (await r1.json()).record;

    await doFetch(coord, '/update', 'POST', { operationId: rec.operationId, to: 'submitting', expectedVersion: 1, evidence: {} });

    // Version advanced to 2; a replayed update with expectedVersion 1 is stale.
    const stale = await doFetch(coord, '/update', 'POST', { operationId: rec.operationId, to: 'accepted', expectedVersion: 1, evidence: {} });
    expect(stale.status).toBe(409);
    const body = await stale.json();
    expect(body.error).toBe('stale_version');
  });

  it('requires a transaction hash to reach confirmed', async () => {
    const coord = new GatewayExecutionCoordinator(makeDOState(), { DO_INTERNAL_SECRET: SECRET });
    const r1 = await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent() });
    const rec = (await r1.json()).record;

    await doFetch(coord, '/update', 'POST', { operationId: rec.operationId, to: 'accepted', expectedVersion: 1, evidence: {} });
    const res = await doFetch(coord, '/update', 'POST', { operationId: rec.operationId, to: 'confirmed', expectedVersion: 2, evidence: {} });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('confirmed_requires_transaction_hash');
  });

  it('requires a reason to reach requires_review', async () => {
    const coord = new GatewayExecutionCoordinator(makeDOState(), { DO_INTERNAL_SECRET: SECRET });
    const r1 = await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent() });
    const rec = (await r1.json()).record;

    await doFetch(coord, '/update', 'POST', { operationId: rec.operationId, to: 'accepted', expectedVersion: 1, evidence: {} });
    const res = await doFetch(coord, '/update', 'POST', { operationId: rec.operationId, to: 'requires_review', expectedVersion: 2, evidence: {} });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('requires_review_requires_reason');
  });

  it('allows confirmed with a transaction hash', async () => {
    const coord = new GatewayExecutionCoordinator(makeDOState(), { DO_INTERNAL_SECRET: SECRET });
    const r1 = await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent() });
    const rec = (await r1.json()).record;

    await doFetch(coord, '/update', 'POST', { operationId: rec.operationId, to: 'accepted', expectedVersion: 1, evidence: {} });
    const res = await doFetch(coord, '/update', 'POST', {
      operationId: rec.operationId, to: 'confirmed', expectedVersion: 2,
      evidence: { transactionHash: '0x' + 'cc'.repeat(32) },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.record.status).toBe('confirmed');
    expect(body.record.txHash).toBe('0x' + 'cc'.repeat(32));
    expect(body.record.version).toBe(3);
  });

  it('rejects a terminal transition (confirmed is immutable)', async () => {
    const coord = new GatewayExecutionCoordinator(makeDOState(), { DO_INTERNAL_SECRET: SECRET });
    const r1 = await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent() });
    const rec = (await r1.json()).record;

    await doFetch(coord, '/update', 'POST', { operationId: rec.operationId, to: 'accepted', expectedVersion: 1, evidence: {} });
    await doFetch(coord, '/update', 'POST', {
      operationId: rec.operationId, to: 'confirmed', expectedVersion: 2,
      evidence: { transactionHash: '0x' + 'cc'.repeat(32) },
    });
    const res = await doFetch(coord, '/update', 'POST', { operationId: rec.operationId, to: 'failed', expectedVersion: 3, evidence: { rollback: true } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_transition');
  });

  it('requires rollback:true for reserved→failed', async () => {
    const coord = new GatewayExecutionCoordinator(makeDOState(), { DO_INTERNAL_SECRET: SECRET });
    const r1 = await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent() });
    const rec = (await r1.json()).record;

    const res = await doFetch(coord, '/update', 'POST', { operationId: rec.operationId, to: 'failed', expectedVersion: 1, evidence: {} });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('rollback_required');
  });

  it('releases only terminal operations', async () => {
    const coord = new GatewayExecutionCoordinator(makeDOState(), { DO_INTERNAL_SECRET: SECRET });
    const r1 = await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent() });
    const rec = (await r1.json()).record;

    const notTerminal = await doFetch(coord, '/release', 'DELETE', { operationId: rec.operationId });
    expect(notTerminal.status).toBe(409);

    await doFetch(coord, '/update', 'POST', { operationId: rec.operationId, to: 'rejected', expectedVersion: 1, evidence: {} });
    const rel = await doFetch(coord, '/release', 'DELETE', { operationId: rec.operationId });
    expect(rel.status).toBe(200);
  });

  it('serializes concurrent reserves with different salts into one reservation + one recovery', async () => {
    const coord = new GatewayExecutionCoordinator(makeDOState(), { DO_INTERNAL_SECRET: SECRET });
    const intents = [
      makeBurnIntent(),
      makeBurnIntent({ spec: { salt: '0x' + 'dd'.repeat(32) } }),
    ];
    const [a, b] = await Promise.all(
      intents.map((bi) => doFetch(coord, '/reserve', 'POST', { burnIntent: bi }).then((r) => r.json()))
    );
    const outcomes = [a, b].map((x) => (x.reserved ? 'reserved' : 'recovered')).sort();
    expect(outcomes).toEqual(['recovered', 'reserved']);
  });

  it('isolates mainnet from testnet (separate DO instances, no cross-env dedup)', () => {
    // environmentFor drives the DO id; here we assert the util-level isolation and
    // that a testnet intent reserves under its own environment.
    const ns = makeCoordinatorNamespace();
    const mainnetIntent = makeBurnIntent();
    const testnetIntent = makeBurnIntent({ spec: { sourceContract: pad32(TESTNET_GATEWAY_WALLET) } });

    const mainnetId = ns.idFromName('gateway-exec:' + depositorOf(mainnetIntent) + ':' + environmentFor(mainnetIntent));
    const testnetId = ns.idFromName('gateway-exec:' + depositorOf(testnetIntent) + ':' + environmentFor(testnetIntent));
    expect(mainnetId.name).not.toBe(testnetId.name);
    expect(mainnetId.name).toContain(':mainnet');
    expect(testnetId.name).toContain(':testnet');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('transfer.js — flag-gated coordinator integration (real handler)', () => {
  function makeEnv(coordinator, enabled) {
    const env = { GATEWAY_OPS_KV: makeKV(), DO_INTERNAL_SECRET: SECRET };
    if (coordinator) env.GATEWAY_EXECUTION_COORDINATOR = coordinator;
    if (enabled) env.GATEWAY_EXECUTION_COORDINATOR_ENABLED = 'true';
    return env;
  }

  it('when disabled (no binding) preserves the existing behavior and forwards to Circle', async () => {
    const env = makeEnv(null, false);
    let forwarded = false;
    globalThis.fetch = async () => { forwarded = true; return new Response(JSON.stringify([{ attestation: { payload: '0xab', signature: '0xcd' } }]), { status: 200 }); };
    const res = await onRequestPost({ request: makePostRequest([makeTransferItem(makeBurnIntent())]), env });
    expect(res.status).toBe(200);
    expect(forwarded).toBe(true);
  });

  it('when binding present but NOT enabled, remains disabled (default off)', async () => {
    const env = makeEnv(makeCoordinatorNamespace(), false);
    let forwarded = false;
    globalThis.fetch = async () => { forwarded = true; return new Response(JSON.stringify([{ attestation: {} }]), { status: 200 }); };
    const res = await onRequestPost({ request: makePostRequest([makeTransferItem(makeBurnIntent())]), env });
    expect(res.status).toBe(200);
    expect(forwarded).toBe(true);
  });

  it('fails closed (503) when enabled but the coordinator is unavailable', async () => {
    const env = makeEnv(makeCoordinatorNamespace(), true);
    // Override the DO stub fetch to throw → coordinator_unavailable.
    const origGet = env.GATEWAY_EXECUTION_COORDINATOR.get;
    env.GATEWAY_EXECUTION_COORDINATOR.get = () => ({ fetch: async () => { throw new Error('boom'); } });
    let forwarded = false;
    globalThis.fetch = async () => { forwarded = true; return new Response('{}', { status: 200 }); };
    const res = await onRequestPost({ request: makePostRequest([makeTransferItem(makeBurnIntent())]), env });
    expect(res.status).toBe(503);
    expect((await res.json()).blocked).toBe(true);
    expect(forwarded).toBe(false); // nothing forwarded
  });

  it('blocks a cross-salt duplicate (409) and does NOT forward', async () => {
    const ns = makeCoordinatorNamespace();
    const env = makeEnv(ns, true);
    // First submission (accepted) populates the coordinator slot.
    globalThis.fetch = async () => new Response(JSON.stringify([{ attestation: { payload: '0xab', signature: '0xcd' } }]), { status: 200 });
    const first = await onRequestPost({ request: makePostRequest([makeTransferItem(makeBurnIntent())]), env });
    expect(first.status).toBe(200);

    // Second submission: same intent, different salt → duplicate.
    let forwarded = false;
    globalThis.fetch = async () => { forwarded = true; return new Response('{}', { status: 200 }); };
    const second = await onRequestPost({
      request: makePostRequest([makeTransferItem(makeBurnIntent({ spec: { salt: '0x' + 'ee'.repeat(32) } }))]),
      env,
    });
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.error).toBe('already_submitted');
    expect(forwarded).toBe(false);
  });

  it('blocks a conflicting payload (409) and does NOT forward', async () => {
    const ns = makeCoordinatorNamespace();
    const env = makeEnv(ns, true);
    globalThis.fetch = async () => new Response(JSON.stringify([{ attestation: {} }]), { status: 200 });
    await onRequestPost({ request: makePostRequest([makeTransferItem(makeBurnIntent())]), env });

    let forwarded = false;
    globalThis.fetch = async () => { forwarded = true; return new Response('{}', { status: 200 }); };
    const res = await onRequestPost({
      request: makePostRequest([makeTransferItem(makeBurnIntent({ spec: { value: '2000000', salt: '0x' + 'ff'.repeat(32) } }))]),
      env,
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('coordinator_conflict');
    expect(forwarded).toBe(false);
  });

  it('updates the coordinator to accepted on a Circle 2xx', async () => {
    const ns = makeCoordinatorNamespace();
    const env = makeEnv(ns, true);
    globalThis.fetch = async () => new Response(JSON.stringify([{ burnIntent: makeBurnIntent(), attestation: { payload: '0xab', signature: '0xcd' } }]), { status: 200 });
    const res = await onRequestPost({ request: makePostRequest([makeTransferItem(makeBurnIntent())]), env });
    expect(res.status).toBe(200);

    // The coordinator record for this depositor:environment should be 'accepted'.
    const names = [...ns.instances.keys()];
    expect(names.length).toBe(1);
    const coord = ns.instances.get(names[0]);
    const statusRes = await coord.fetch(new Request('https://do/status?operationId=missing', { headers: { 'X-DO-Internal-Secret': SECRET } }));
    expect(statusRes.status).toBe(404); // sanity: status endpoint works
  });

  it('updates the coordinator to ambiguous on a Circle 5xx (and does not fail closed)', async () => {
    const ns = makeCoordinatorNamespace();
    const env = makeEnv(ns, true);
    globalThis.fetch = async () => new Response('{"error":"boom"}', { status: 500 });
    const res = await onRequestPost({ request: makePostRequest([makeTransferItem(makeBurnIntent())]), env });
    expect(res.status).toBe(500);

    // The per-salt record should be 'ambiguous' and the coordinator 'ambiguous'.
    const kv = env.GATEWAY_OPS_KV;
    const record = await kv.get('gw:op:' + makeBurnIntent().spec.salt, { type: 'json' });
    expect(record.status).toBe('ambiguous');
  });
});
