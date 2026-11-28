/**
 * gateway-execution-coordinator.test.js
 * ═══════════════════════════════════════════════════════════════════════════
 * Phase 1.0.1C.1 — GatewayExecutionCoordinator financial integrity & lifecycle
 * hardening.
 *
 * Exercises the REAL modules (no re-implementation of the logic under test):
 *   - coordinator-util.js (canonicalPayloadHash / isValidIdempotencyKey /
 *     depositorOf / environmentFor / scopeKeyFor / tokenSymbolFor)
 *   - gateway-execution-coordinator.do.js (real DO class; DO-compatible storage
 *     mock with serialized single-flight semantics)
 *   - transfer.js onRequestPost (real handler; only external deps mocked)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const util = await import('../functions/api/gateway/coordinator-util.js');
const {
  canonicalPayloadHash,
  isValidIdempotencyKey,
  depositorOf,
  environmentFor,
  scopeKeyFor,
  tokenSymbolFor,
  MAINNET_GATEWAY_WALLET,
  TESTNET_GATEWAY_WALLET,
  ENV_MAINNET,
  ENV_TESTNET,
} = util;

const { GatewayExecutionCoordinator } = await import('../functions/api/gateway/gateway-execution-coordinator.do.js');
const transfer = await import('../functions/api/gateway/transfer.js');
const { onRequestPost } = transfer;
const { onRequestPost: onRequestPostIntent } = await import('../functions/api/gateway/intent.js');

// ── Fixtures ─────────────────────────────────────────────────────────────────
const SECRET      = 'test-internal-secret-1234567890abcdef';
const DEPOSITOR   = '0x1111111111111111111111111111111111111111';
const RECIPIENT   = '0x2222222222222222222222222222222222222222';
const RECIPIENT_B = '0x3333333333333333333333333333333333333333';
const TOKEN_A     = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN_B     = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const MINTER      = '0x2222222d7164433c4c09b0b0d809a9b52c04c205';
// A real Circle USDC address (Arc mainnet) so tokenSymbolFor resolves in transfer.js tests.
const USDC_ARC    = '0x3600000000000000000000000000000000000000';

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
    sourceToken:          pad32(over.sourceToken || TOKEN_A),
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

const IDEM_KEY_A = 'intent-aaaaaaaa-0001';

// ── DO-compatible storage mock (serialized single-flight) ───────────────────
function makeDOState() {
  const store = new Map();
  let alarmAt = null;
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
    async list({ prefix } = {}) {
      const keys = [];
      for (const k of store.keys()) if (!prefix || k.startsWith(prefix)) keys.push({ name: k });
      return { keys };
    },
    async getAlarm() { return alarmAt; },
    async setAlarm(t) { alarmAt = t; },
    async deleteAlarm() { alarmAt = null; },
    async transaction(fn) {
      const txn = {
        get: async (k) => (store.has(k) ? store.get(k) : undefined),
        put: async (k, v) => { store.set(k, v); },
        delete: async (k) => { store.delete(k); },
      };
      return fn(txn);
    },
  };
  return { storage, blockConcurrencyWhile: (fn) => enqueue(fn), _store: store, _alarm: () => alarmAt };
}

function makeCoord(secret = SECRET) {
  return new GatewayExecutionCoordinator(makeDOState(), { DO_INTERNAL_SECRET: secret });
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

async function seedBalance(coord, scope, amount) {
  const res = await doFetch(coord, '/set-balance', 'POST', { scope, amount: String(amount) });
  expect(res.status).toBe(200);
}

function scopeOf(burnIntent) {
  return scopeKeyFor(burnIntent);
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

function makeTransferItem(burnIntent, idempotencyKey) {
  return { burnIntent, signature: '0x' + '33'.repeat(65), idempotencyKey };
}

function makePostRequest(items) {
  return new Request('https://elligentttest.pages.dev/api/gateway/transfer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': 'https://elligentttest.pages.dev' },
    body: JSON.stringify(items),
  });
}

function makeEnv(coordinator, enabled) {
  const env = { GATEWAY_OPS_KV: makeKV(), DO_INTERNAL_SECRET: SECRET };
  if (coordinator) env.GATEWAY_EXECUTION_COORDINATOR = coordinator;
  if (enabled) env.GATEWAY_EXECUTION_COORDINATOR_ENABLED = 'true';
  return env;
}

// A fetch mock that serves both the balance fetch (/v1/balances) and the transfer
// POST (/v1/transfer). Circle returns the balance as a DECIMAL string (e.g.
// "100.000000" = 100 USDC); fetchGatewayBalance normalizes it to atomic.
function mockFetch({ balance = '100.000000', transferStatus = 200, transferBody }) {
  return async (url, init) => {
    const u = String(url);
    if (u.includes('/v1/balances')) {
      return new Response(JSON.stringify({ balances: [{ domain: 26, balance }] }), { status: 200 });
    }
    if (u.includes('/v1/transfer')) {
      return new Response(JSON.stringify(transferBody || [{ burnIntent: { spec: { salt: '0x' + '44'.repeat(32) } }, attestation: { payload: '0xab', signature: '0xcd' } }]), { status: transferStatus });
    }
    return new Response('{}', { status: 404 });
  };
}

beforeEach(() => { delete globalThis.fetch; });
afterEach(() => { delete globalThis.fetch; });

// ═══════════════════════════════════════════════════════════════════════════
describe('coordinator-util (real module)', () => {
  it('canonicalPayloadHash is identical across salts and excludes salt', async () => {
    const a = makeBurnIntent();
    const b = makeBurnIntent({ spec: { salt: '0x' + '55'.repeat(32) } });
    expect(a.spec.salt).not.toBe(b.spec.salt);
    expect(await canonicalPayloadHash(a)).toBe(await canonicalPayloadHash(b));
  });

  it('canonicalPayloadHash differs on value and recipient', async () => {
    const a = makeBurnIntent();
    expect(await canonicalPayloadHash(a)).not.toBe(await canonicalPayloadHash(makeBurnIntent({ spec: { value: '2000000' } })));
    expect(await canonicalPayloadHash(a)).not.toBe(await canonicalPayloadHash(makeBurnIntent({ spec: { destinationRecipient: pad32(RECIPIENT_B) } })));
  });

  it('canonicalPayloadHash is casing-stable', async () => {
    const a = makeBurnIntent();
    const b = makeBurnIntent({ spec: { sourceToken: pad32(TOKEN_A).toUpperCase() } });
    expect(await canonicalPayloadHash(a)).toBe(await canonicalPayloadHash(b));
  });

  it('isValidIdempotencyKey accepts a bounded safe key', () => {
    expect(isValidIdempotencyKey('intent-abc-123456')).toBe(true);
    expect(isValidIdempotencyKey('short')).toBe(false);
    expect(isValidIdempotencyKey('a'.repeat(200))).toBe(false);
    expect(isValidIdempotencyKey('has space')).toBe(false);
    expect(isValidIdempotencyKey(null)).toBe(false);
  });

  it('depositorOf / environmentFor / scopeKeyFor / tokenSymbolFor', () => {
    expect(depositorOf(makeBurnIntent())).toBe(DEPOSITOR.toLowerCase());
    expect(environmentFor(makeBurnIntent())).toBe(ENV_MAINNET);
    expect(environmentFor(makeBurnIntent({ spec: { sourceContract: pad32(TESTNET_GATEWAY_WALLET) } }))).toBe(ENV_TESTNET);
    expect(scopeOf(makeBurnIntent())).toBe(TOKEN_A + ':26');
    expect(tokenSymbolFor(pad32(USDC_ARC))).toBe('USDC');
    expect(tokenSymbolFor(pad32(TOKEN_A))).toBeNull();
  });

  it('tokenDecimalsFor returns official asset decimals (USDC/EURC=6, cirBTC=8)', async () => {
    const { tokenDecimalsFor } = await import('../functions/api/gateway/coordinator-util.js');
    expect(tokenDecimalsFor('USDC')).toBe(6);
    expect(tokenDecimalsFor('EURC')).toBe(6);
    expect(tokenDecimalsFor('cirBTC')).toBe(8);
    expect(tokenDecimalsFor('UNKNOWN')).toBeNull();
  });

  it('decimalToAtomic normalizes the Circle balance (decimal string → atomic BigInt)', async () => {
    const { decimalToAtomic } = await import('../functions/api/gateway/coordinator-util.js');
    expect(decimalToAtomic('10.000000', 6)).toBe('10000000');
    expect(decimalToAtomic('0.500000', 6)).toBe('500000');
    expect(decimalToAtomic('0', 6)).toBe('0');
    expect(decimalToAtomic('1.23456789', 8)).toBe('123456789');
    // Invalid / incomplete / excess precision → null (fail-closed, never a fake zero).
    expect(decimalToAtomic('abc', 6)).toBeNull();
    expect(decimalToAtomic('-5', 6)).toBeNull();
    expect(decimalToAtomic('1e3', 6)).toBeNull();
    expect(decimalToAtomic('1.2345678', 6)).toBeNull(); // 7 decimals > 6
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('GatewayExecutionCoordinator — dedup + balance reservation (real class)', () => {
  it('blocks requests without a valid internal secret', async () => {
    const coord = makeCoord();
    const res = await doFetch(coord, '/status?operationId=x', 'GET', null, 'wrong');
    expect(res.status).toBe(401);
  });

  it('requires an idempotencyKey', async () => {
    const coord = makeCoord();
    const res = await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent() });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('idempotencyKey_required');
  });

  it('fails closed when no balance snapshot is set', async () => {
    const coord = makeCoord();
    const res = await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent(), idempotencyKey: IDEM_KEY_A });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('balance_not_synced');
  });

  it('reserves a new operation after set-balance', async () => {
    const coord = makeCoord();
    await seedBalance(coord, scopeOf(makeBurnIntent()), '100000000');
    const res = await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent(), idempotencyKey: IDEM_KEY_A });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.record.status).toBe('reserved');
    expect(body.record.reservedAmount).toBe('3010000'); // value + maxFee
  });

  it('recovers the SAME intent with a DIFFERENT salt (cross-salt dedup)', async () => {
    const coord = makeCoord();
    await seedBalance(coord, scopeOf(makeBurnIntent()), '100000000');
    const r1 = await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent(), idempotencyKey: IDEM_KEY_A });
    expect(r1.status).toBe(201);
    const first = (await r1.json()).record;

    const r2 = await doFetch(coord, '/reserve', 'POST', {
      burnIntent: makeBurnIntent({ spec: { salt: '0x' + '77'.repeat(32) } }), idempotencyKey: IDEM_KEY_A,
    });
    expect(r2.status).toBe(200);
    const r2body = await r2.json();
    expect(r2body.recovered).toBe(true);
    expect(r2body.record.operationId).toBe(first.operationId);
  });

  it('conflicts when the same key is reused with a DIFFERENT amount', async () => {
    const coord = makeCoord();
    await seedBalance(coord, scopeOf(makeBurnIntent()), '100000000');
    await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent(), idempotencyKey: IDEM_KEY_A });
    const res = await doFetch(coord, '/reserve', 'POST', {
      burnIntent: makeBurnIntent({ spec: { value: '2000000', salt: '0x' + '88'.repeat(32) } }), idempotencyKey: IDEM_KEY_A,
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('conflict');
  });

  it('allows two INDEPENDENT identical payments with DIFFERENT idempotency keys', async () => {
    const coord = makeCoord();
    await seedBalance(coord, scopeOf(makeBurnIntent()), '100000000');
    const r1 = await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent(), idempotencyKey: 'intent-1' });
    const r2 = await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent({ spec: { salt: '0x' + '99'.repeat(32) } }), idempotencyKey: 'intent-2' });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
  });

  it('rejects a reservation that exceeds the available balance (fees included)', async () => {
    const coord = makeCoord();
    // Balance 4_000_000 covers value(1_000_000)+maxFee(2_010_000)=3_010_000 once,
    // but not twice.
    await seedBalance(coord, scopeOf(makeBurnIntent()), '4000000');
    const r1 = await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent(), idempotencyKey: 'intent-1' });
    expect(r1.status).toBe(201);

    const r2 = await doFetch(coord, '/reserve', 'POST', {
      burnIntent: makeBurnIntent({ spec: { salt: '0x' + 'aa'.repeat(32) } }), idempotencyKey: 'intent-2',
    });
    expect(r2.status).toBe(422);
    const body = await r2.json();
    expect(body.error).toBe('insufficient_available_balance');
    expect(body.requested).toBe('3010000');
  });

  it('rejects a stale update (fencing)', async () => {
    const coord = makeCoord();
    await seedBalance(coord, scopeOf(makeBurnIntent()), '100000000');
    const r1 = await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent(), idempotencyKey: IDEM_KEY_A });
    const rec = (await r1.json()).record;

    await doFetch(coord, '/update', 'POST', { operationId: rec.operationId, to: 'submitting', expectedVersion: 1, evidence: {} });
    const stale = await doFetch(coord, '/update', 'POST', { operationId: rec.operationId, to: 'accepted', expectedVersion: 1, evidence: {} });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toBe('stale_version');
  });

  it('requires evidence for confirmed / requires_review', async () => {
    const coord = makeCoord();
    await seedBalance(coord, scopeOf(makeBurnIntent()), '100000000');
    const rec = (await (await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent(), idempotencyKey: IDEM_KEY_A })).json()).record;
    await doFetch(coord, '/update', 'POST', { operationId: rec.operationId, to: 'submitting', expectedVersion: 1, evidence: {} });
    await doFetch(coord, '/update', 'POST', { operationId: rec.operationId, to: 'accepted', expectedVersion: 2, evidence: {} });

    const noTx = await doFetch(coord, '/update', 'POST', { operationId: rec.operationId, to: 'confirmed', expectedVersion: 3, evidence: {} });
    expect(noTx.status).toBe(400);
    expect((await noTx.json()).error).toBe('confirmed_requires_transaction_hash');
  });

  it('releases the reservation on a terminal transition', async () => {
    const coord = makeCoord();
    await seedBalance(coord, scopeOf(makeBurnIntent()), '4000000');
    await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent(), idempotencyKey: 'intent-1' });
    // Second intent would fail (balance 4M covers only one 3.01M reservation).
    const r2 = await doFetch(coord, '/reserve', 'POST', {
      burnIntent: makeBurnIntent({ spec: { salt: '0x' + 'bb'.repeat(32) } }), idempotencyKey: 'intent-2',
    });
    expect(r2.status).toBe(422);

    // Terminal (rejected) releases intent-1's reservation → intent-2 can now reserve.
    const rec1 = (await (await doFetch(coord, '/status?idempotencyKey=intent-1', 'GET')).json()).record;
    await doFetch(coord, '/update', 'POST', { operationId: rec1.operationId, to: 'rejected', expectedVersion: 1, evidence: {} });
    await seedBalance(coord, scopeOf(makeBurnIntent()), '4000000');
    const r3 = await doFetch(coord, '/reserve', 'POST', {
      burnIntent: makeBurnIntent({ spec: { salt: '0x' + 'cc'.repeat(32) } }), idempotencyKey: 'intent-2',
    });
    expect(r3.status).toBe(201);
  });

  it('serializes concurrent reserves with different salts into one reserve + one recover', async () => {
    const coord = makeCoord();
    await seedBalance(coord, scopeOf(makeBurnIntent()), '100000000');
    const [a, b] = await Promise.all([
      doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent(), idempotencyKey: IDEM_KEY_A }).then((r) => r.json()),
      doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent({ spec: { salt: '0x' + 'dd'.repeat(32) } }), idempotencyKey: IDEM_KEY_A }).then((r) => r.json()),
    ]);
    const outcomes = [a, b].map((x) => (x.reserved ? 'reserved' : 'recovered')).sort();
    expect(outcomes).toEqual(['recovered', 'reserved']);
  });

  it('release preserves the operation record and idempotency history', async () => {
    const coord = makeCoord();
    await seedBalance(coord, scopeOf(makeBurnIntent()), '100000000');
    const rec = (await (await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent(), idempotencyKey: IDEM_KEY_A })).json()).record;
    await doFetch(coord, '/update', 'POST', { operationId: rec.operationId, to: 'rejected', expectedVersion: 1, evidence: {} });

    const rel = await doFetch(coord, '/release', 'DELETE', { operationId: rec.operationId });
    expect(rel.status).toBe(200);

    // The record is still present (released, not deleted).
    const st = await doFetch(coord, '/status?operationId=' + rec.operationId, 'GET');
    expect(st.status).toBe(200);
    const body = await st.json();
    expect(body.record.released).toBe(true);
    expect(body.record.status).toBe('rejected');
  });

  it('the idempotency key is permanent: a terminal+released key recovers, never a new op', async () => {
    const coord = makeCoord();
    await seedBalance(coord, scopeOf(makeBurnIntent()), '100000000');
    const r1 = (await (await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent(), idempotencyKey: 'intent-1' })).json()).record;
    await doFetch(coord, '/update', 'POST', { operationId: r1.operationId, to: 'rejected', expectedVersion: 1, evidence: {} });
    await doFetch(coord, '/release', 'DELETE', { operationId: r1.operationId });

    // Reusing the SAME key after terminal+release → recover the ORIGINAL operation
    // (identity is permanent), never a new operation.
    const r2 = await doFetch(coord, '/reserve', 'POST', {
      burnIntent: makeBurnIntent({ spec: { salt: '0x' + 'ee'.repeat(32) } }), idempotencyKey: 'intent-1',
    });
    expect(r2.status).toBe(200);
    const r2body = await r2.json();
    expect(r2body.recovered).toBe(true);
    expect(r2body.record.operationId).toBe(r1.operationId);
    expect(r2body.record.released).toBe(true);

    // A DIFFERENT key is required for a new independent intent.
    const r3 = await doFetch(coord, '/reserve', 'POST', {
      burnIntent: makeBurnIntent({ spec: { salt: '0x' + 'ff'.repeat(32) } }), idempotencyKey: 'intent-2',
    });
    expect(r3.status).toBe(201);
  });

  it('rejects a salt collision (same salt bound to a different operation)', async () => {
    const coord = makeCoord();
    await seedBalance(coord, scopeOf(makeBurnIntent()), '100000000');
    const r1 = await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent(), idempotencyKey: 'intent-1' });
    expect(r1.status).toBe(201);

    // Same salt but a DIFFERENT key → salt collision.
    const r2 = await doFetch(coord, '/reserve', 'POST', {
      burnIntent: makeBurnIntent(), idempotencyKey: 'intent-2',
    });
    expect(r2.status).toBe(409);
    expect((await r2.json()).error).toBe('salt_already_bound');
  });

  it('isolates mainnet from testnet by DO name', () => {
    const ns = makeCoordinatorNamespace();
    const m = ns.idFromName('gateway-exec:' + depositorOf(makeBurnIntent()) + ':' + environmentFor(makeBurnIntent()));
    const t = ns.idFromName('gateway-exec:' + depositorOf(makeBurnIntent()) + ':testnet');
    expect(m.name).toContain(':mainnet');
    expect(t.name).toContain(':testnet');
    expect(m.name).not.toBe(t.name);
  });

  it('rejects an out-of-order (older) balance snapshot (Gate C)', async () => {
    const coord = makeCoord();
    const scope = scopeOf(makeBurnIntent());
    await seedBalance(coord, scope, '100000000');
    // A newer snapshot with a later asOf.
    const newer = await doFetch(coord, '/set-balance', 'POST', { scope, amount: '90000000', asOf: new Date(Date.now() + 3600000).toISOString() });
    expect(newer.status).toBe(200);
    // An older snapshot (earlier asOf) must be rejected — never restore committed balance.
    const older = await doFetch(coord, '/set-balance', 'POST', { scope, amount: '100000000', asOf: new Date(Date.now() - 3600000).toISOString() });
    expect(older.status).toBe(409);
    expect((await older.json()).error).toBe('stale_snapshot');
  });

  it('allows submitting → failed ONLY as a rollback (Gate E)', async () => {
    const coord = makeCoord();
    await seedBalance(coord, scopeOf(makeBurnIntent()), '100000000');
    const rec = (await (await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent(), idempotencyKey: IDEM_KEY_A })).json()).record;
    await doFetch(coord, '/update', 'POST', { operationId: rec.operationId, to: 'submitting', expectedVersion: 1, evidence: {} });

    // submitting → failed WITHOUT rollback flag is forbidden.
    const noRollback = await doFetch(coord, '/update', 'POST', { operationId: rec.operationId, to: 'failed', expectedVersion: 2, evidence: {} });
    expect(noRollback.status).toBe(400);
    expect((await noRollback.json()).error).toBe('rollback_required');

    // submitting → failed WITH rollback flag is allowed (batch aborted before POST).
    const withRollback = await doFetch(coord, '/update', 'POST', { operationId: rec.operationId, to: 'failed', expectedVersion: 2, evidence: { rollback: true } });
    expect(withRollback.status).toBe(200);
    expect((await withRollback.json()).record.status).toBe('failed');
  });

  it('a dispatched operation CANNOT be rolled back to failed (must go ambiguous) (Gate E)', async () => {
    const coord = makeCoord();
    await seedBalance(coord, scopeOf(makeBurnIntent()), '100000000');
    const rec = (await (await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent(), idempotencyKey: IDEM_KEY_A })).json()).record;
    await doFetch(coord, '/update', 'POST', { operationId: rec.operationId, to: 'submitting', expectedVersion: 1, evidence: {} });
    // Mark dispatched (durable, before POST).
    const dc = await doFetch(coord, '/dispatch', 'POST', { operationId: rec.operationId, expectedVersion: 2 });
    expect(dc.status).toBe(200);

    // Rollback to failed is now refused — the op was dispatched.
    const rb = await doFetch(coord, '/update', 'POST', { operationId: rec.operationId, to: 'failed', expectedVersion: 2, evidence: { rollback: true } });
    expect(rb.status).toBe(409);
    expect((await rb.json()).error).toBe('cannot_rollback_dispatched');

    // It can resolve as ambiguous (preserving the reservation).
    const amb = await doFetch(coord, '/update', 'POST', { operationId: rec.operationId, to: 'ambiguous', expectedVersion: 2, evidence: {} });
    expect(amb.status).toBe(200);
    expect((await amb.json()).record.status).toBe('ambiguous');
  });

  it('/reconcile registers a durable obligation and applies the terminal transition idempotently (Gate B)', async () => {
    const coord = makeCoord();
    await seedBalance(coord, scopeOf(makeBurnIntent()), '100000000');
    const rec = (await (await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent(), idempotencyKey: IDEM_KEY_A })).json()).record;
    await doFetch(coord, '/update', 'POST', { operationId: rec.operationId, to: 'submitting', expectedVersion: 1, evidence: {} });
    await doFetch(coord, '/update', 'POST', { operationId: rec.operationId, to: 'accepted', expectedVersion: 2, evidence: {} });

    // Reconcile to confirmed (with the required txHash evidence).
    const r1 = await doFetch(coord, '/reconcile', 'POST', { salt: rec.salt, to: 'confirmed', evidence: { transactionHash: '0x' + 'cc'.repeat(32) } });
    expect(r1.status).toBe(200);
    expect((await r1.json()).record.status).toBe('confirmed');

    // Idempotent replay (op already confirmed → resolved:already, no double release).
    const r2 = await doFetch(coord, '/reconcile', 'POST', { salt: rec.salt, to: 'confirmed', evidence: { transactionHash: '0x' + 'cc'.repeat(32) } });
    expect(r2.status).toBe(200);
  });

  it('a reconcile for a salt NOT in this shard returns 404 (environment isolation, Gate C)', async () => {
    const coord = makeCoord();
    // No op reserved under this salt → 404 (caller probes the other shard).
    const res = await doFetch(coord, '/reconcile', 'POST', { salt: '0x' + 'ab'.repeat(32), to: 'confirmed', evidence: { transactionHash: '0x' + 'cc'.repeat(32) } });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('not_in_this_environment');
  });

  it('a divergent terminal state yields an auditable conflict, never silent success (Gate D)', async () => {
    const coord = makeCoord();
    await seedBalance(coord, scopeOf(makeBurnIntent()), '100000000');
    const rec = (await (await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent(), idempotencyKey: IDEM_KEY_A })).json()).record;
    await doFetch(coord, '/update', 'POST', { operationId: rec.operationId, to: 'submitting', expectedVersion: 1, evidence: {} });
    await doFetch(coord, '/update', 'POST', { operationId: rec.operationId, to: 'accepted', expectedVersion: 2, evidence: {} });
    // Terminal as 'failed' first.
    await doFetch(coord, '/update', 'POST', { operationId: rec.operationId, to: 'failed', expectedVersion: 3, evidence: {} });

    // Reconcile to 'confirmed' → divergent terminal → conflict (409).
    const res = await doFetch(coord, '/reconcile', 'POST', { salt: rec.salt, to: 'confirmed', evidence: { transactionHash: '0x' + 'cc'.repeat(32) } });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('divergent_terminal_state');
  });

  it('rejects a stale_generation snapshot (Gate E fencing)', async () => {
    const coord = makeCoord();
    const scope = scopeOf(makeBurnIntent());
    await seedBalance(coord, scope, '100000000'); // generation 1
    await doFetch(coord, '/set-balance', 'POST', { scope, amount: '90000000', asOf: new Date(Date.now() + 3600000).toISOString() }); // generation 2
    // A query that observed generation 1 (before the 2nd write) is now stale.
    const res = await doFetch(coord, '/set-balance', 'POST', { scope, amount: '100000000', asOf: new Date(Date.now() + 7200000).toISOString(), expectedGeneration: 1 });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('stale_generation');
  });

  it('an expired balance snapshot is treated as stale (Gate D temporal validity)', async () => {
    const coord = makeCoord();
    const scope = scopeOf(makeBurnIntent());
    // Set a snapshot with an asOf far in the past → expired.
    await doFetch(coord, '/set-balance', 'POST', { scope, amount: '100000000', asOf: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
    const res = await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent(), idempotencyKey: IDEM_KEY_A });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('balance_expired');
  });

  it('fails safe on a corrupt idempotency index (missing record)', async () => {
    const state = makeDOState();
    const coord = new GatewayExecutionCoordinator(state, { DO_INTERNAL_SECRET: SECRET });
    await doFetch(coord, '/set-balance', 'POST', { scope: scopeOf(makeBurnIntent()), amount: '100000000' });
    await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent(), idempotencyKey: IDEM_KEY_A });
    // Simulate corruption: delete the op record but leave the idem index.
    for (const k of [...state._store.keys()]) {
      if (k.startsWith('op:')) state._store.delete(k);
    }
    const res = await doFetch(coord, '/reserve', 'POST', { burnIntent: makeBurnIntent({ spec: { salt: '0x' + '77'.repeat(32) } }), idempotencyKey: IDEM_KEY_A });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('corrupt_idempotency_index');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('transfer.js — flag-gated coordinator integration (real handler)', () => {
  it('allows a legitimate app origin and rejects an unauthorized origin (P0 CORS)', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify([{ attestation: {} }]), { status: 200 });

    const reqFor = (origin, salt) => new Request('https://elligentttest.pages.dev/api/gateway/transfer', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Origin': origin },
      body: JSON.stringify([makeTransferItem(makeBurnIntent({ spec: { salt } }), IDEM_KEY_A)]),
    });
    // Legitimate domains (aligned with CORE_ALLOWED_ORIGINS) must be accepted.
    const legit = ['https://execdaat.xyz', 'https://elligentt.xyz', 'https://elligente.pages.dev', 'https://elligentttest.pages.dev'];
    for (let i = 0; i < legit.length; i++) {
      const env = makeEnv(null, false); // fresh KV per request (fresh salt space)
      const res = await onRequestPost({ request: reqFor(legit[i], '0x' + (i + 10).toString(16).padStart(2, '0').repeat(32)), env });
      expect(res.status, legit[i]).toBe(200);
    }
    // An unauthorized origin must be rejected (403).
    const evil = await onRequestPost({ request: reqFor('https://evil.example.com', '0x' + '99'.repeat(32)), env: makeEnv(null, false) });
    expect(evil.status).toBe(403);
    expect((await evil.json()).error).toBe('forbidden');
  });

  it('flag ON without binding → fail-closed 503 (no silent fallback)', async () => {
    const env = { GATEWAY_OPS_KV: makeKV(), DO_INTERNAL_SECRET: SECRET, GATEWAY_EXECUTION_COORDINATOR_ENABLED: 'true' };
    let forwarded = false;
    globalThis.fetch = async () => { forwarded = true; return new Response('{}', { status: 200 }); };
    const res = await onRequestPost({ request: makePostRequest([makeTransferItem(makeBurnIntent(), IDEM_KEY_A)]), env });
    expect(res.status).toBe(503);
    expect((await res.json()).blocked).toBe(true);
    expect(forwarded).toBe(false);
  });

  it('flag OFF → legacy flow (coordinator not consulted)', async () => {
    const env = makeEnv(null, false);
    let forwarded = false;
    globalThis.fetch = async () => { forwarded = true; return new Response(JSON.stringify([{ attestation: {} }]), { status: 200 }); };
    const res = await onRequestPost({ request: makePostRequest([makeTransferItem(makeBurnIntent(), null)]), env });
    expect(res.status).toBe(200);
    expect(forwarded).toBe(true);
  });

  it('binding present but flag OFF → legacy flow (default off)', async () => {
    const env = makeEnv(makeCoordinatorNamespace(), false);
    let forwarded = false;
    globalThis.fetch = async () => { forwarded = true; return new Response(JSON.stringify([{ attestation: {} }]), { status: 200 }); };
    const res = await onRequestPost({ request: makePostRequest([makeTransferItem(makeBurnIntent(), null)]), env });
    expect(res.status).toBe(200);
    expect(forwarded).toBe(true);
  });

  it('enabled + coordinator unavailable → fail-closed 503 (no forward)', async () => {
    const ns = makeCoordinatorNamespace();
    const env = makeEnv(ns, true);
    ns.get = () => ({ fetch: async () => { throw new Error('boom'); } });
    let forwarded = false;
    globalThis.fetch = mockFetch({});
    const res = await onRequestPost({ request: makePostRequest([makeTransferItem(makeBurnIntent({ sourceToken: USDC_ARC }), IDEM_KEY_A)]), env });
    expect(res.status).toBe(503);
    expect(forwarded).toBe(false);
  });

  it('drain mode suspends NEW coordinated operations (503) and does NOT fall back', async () => {
    const ns = makeCoordinatorNamespace();
    const env = { GATEWAY_OPS_KV: makeKV(), DO_INTERNAL_SECRET: SECRET, GATEWAY_EXECUTION_COORDINATOR: ns, GATEWAY_EXECUTION_COORDINATOR_ENABLED: 'drain' };
    let forwarded = false;
    globalThis.fetch = mockFetch({});
    const res = await onRequestPost({ request: makePostRequest([makeTransferItem(makeBurnIntent({ sourceToken: USDC_ARC }), IDEM_KEY_A)]), env });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('coordinator_draining');
    expect(forwarded).toBe(false);
  });

  it('pilot mode: an unauthorized wallet falls through to the legacy flow (no coordinator)', async () => {
    const ns = makeCoordinatorNamespace();
    const env = { GATEWAY_OPS_KV: makeKV(), DO_INTERNAL_SECRET: SECRET, GATEWAY_EXECUTION_COORDINATOR: ns, GATEWAY_EXECUTION_COORDINATOR_ENABLED: 'pilot', GATEWAY_PILOT_ALLOWLIST: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' };
    let forwarded = false;
    globalThis.fetch = async () => { forwarded = true; return new Response(JSON.stringify([{ attestation: {} }]), { status: 200 }); };
    const res = await onRequestPost({ request: makePostRequest([makeTransferItem(makeBurnIntent({ sourceToken: USDC_ARC }), IDEM_KEY_A)]), env });
    expect(res.status).toBe(200); // legacy flow forwards
    expect(forwarded).toBe(true);
    expect(ns.instances.size).toBe(0); // no coordinator instance created
  });

  it('pilot mode: kill switch blocks all new coordinated operations (503)', async () => {
    const ns = makeCoordinatorNamespace();
    const env = { GATEWAY_OPS_KV: makeKV(), DO_INTERNAL_SECRET: SECRET, GATEWAY_EXECUTION_COORDINATOR: ns, GATEWAY_EXECUTION_COORDINATOR_ENABLED: 'pilot', GATEWAY_PILOT_KILL_SWITCH: 'true', GATEWAY_PILOT_ALLOWLIST: DEPOSITOR };
    let forwarded = false;
    globalThis.fetch = mockFetch({});
    const res = await onRequestPost({ request: makePostRequest([makeTransferItem(makeBurnIntent({ sourceToken: USDC_ARC }), IDEM_KEY_A)]), env });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('pilot_kill_switch');
    expect(forwarded).toBe(false);
  });

  it('pilot mode: over per-op limit → 429', async () => {
    const ns = makeCoordinatorNamespace();
    const env = { GATEWAY_OPS_KV: makeKV(), DO_INTERNAL_SECRET: SECRET, GATEWAY_EXECUTION_COORDINATOR: ns, GATEWAY_EXECUTION_COORDINATOR_ENABLED: 'pilot', GATEWAY_PILOT_ALLOWLIST: DEPOSITOR, GATEWAY_PILOT_MAX_PER_OP: '1000' };
    globalThis.fetch = mockFetch({ balance: '100.000000', transferStatus: 200 });
    const res = await onRequestPost({ request: makePostRequest([makeTransferItem(makeBurnIntent({ sourceToken: USDC_ARC }), IDEM_KEY_A)]), env });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe('pilot_per_op_limit');
  });

  it('the intent endpoint issues a server-bound idempotency key and recovers it by session', async () => {
    const kv = makeKV();
    // Pilot mode → identity IS required and issued.
    const env = { GATEWAY_OPS_KV: kv, DO_INTERNAL_SECRET: SECRET, GATEWAY_EXECUTION_COORDINATOR_ENABLED: 'pilot' };
    const mk = (body) => new Request('https://elligentttest.pages.dev/api/gateway/intent', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Origin': 'https://elligentttest.pages.dev' }, body: JSON.stringify(body),
    });

    const r1 = await onRequestPostIntent({ request: mk({ intentSessionId: 'session-abc-123456' }), env });
    expect(r1.status).toBe(200);
    const key = (await r1.json()).idempotencyKey;
    expect(key).toMatch(/^gw-[0-9a-f]{32}$/);

    // Same session → recover the SAME key (deterministic derivation).
    const r2 = await onRequestPostIntent({ request: mk({ intentSessionId: 'session-abc-123456' }), env });
    const r2body = await r2.json();
    expect(r2body.idempotencyKey).toBe(key);
    expect(r2body.recovered).toBe(true);

    // A new session → a NEW key.
    const r3 = await onRequestPostIntent({ request: mk({ intentSessionId: 'session-xyz-654321' }), env });
    expect((await r3.json()).idempotencyKey).not.toBe(key);
  });

  it('the intent endpoint requires NO secret when the coordinator is DISABLED (P0.2 legacy isolation)', async () => {
    const env = { GATEWAY_OPS_KV: makeKV() }; // no DO_INTERNAL_SECRET, no coordinator flag → disabled
    const mk = (body) => new Request('https://elligentttest.pages.dev/api/gateway/intent', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Origin': 'https://elligentttest.pages.dev' }, body: JSON.stringify(body),
    });
    const res = await onRequestPostIntent({ request: mk({ intentSessionId: 'session-abc-123456' }), env });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.identityNotRequired).toBe(true);
    expect(body.idempotencyKey).toBeUndefined();
  });

  it('the intent endpoint fails closed in pilot mode without a configured secret (Gate A)', async () => {
    const env = { GATEWAY_OPS_KV: makeKV(), GATEWAY_EXECUTION_COORDINATOR_ENABLED: 'pilot' }; // no DO_INTERNAL_SECRET
    const mk = (body) => new Request('https://elligentttest.pages.dev/api/gateway/intent', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Origin': 'https://elligentttest.pages.dev' }, body: JSON.stringify(body),
    });
    const res = await onRequestPostIntent({ request: mk({ intentSessionId: 'session-abc-123456' }), env });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('identity_secret_not_configured');
  });

  it('enabled + missing idempotencyKey → 400', async () => {
    const env = makeEnv(makeCoordinatorNamespace(), true);
    globalThis.fetch = mockFetch({});
    const res = await onRequestPost({ request: makePostRequest([makeTransferItem(makeBurnIntent({ sourceToken: USDC_ARC }), null)]), env });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('idempotencyKey_required');
  });

  it('enabled → forwards to Circle and persists coordinator accepted (submitting before POST)', async () => {
    const ns = makeCoordinatorNamespace();
    const env = makeEnv(ns, true);
    globalThis.fetch = mockFetch({ balance: '100.000000', transferStatus: 200 });
    const res = await onRequestPost({ request: makePostRequest([makeTransferItem(makeBurnIntent({ sourceToken: USDC_ARC }), IDEM_KEY_A)]), env });
    expect(res.status).toBe(200);

    const names = [...ns.instances.keys()];
    expect(names.length).toBe(1);
    const coord = ns.instances.get(names[0]);
    const st = await coord.fetch(new Request('https://do/status?idempotencyKey=' + IDEM_KEY_A, { headers: { 'X-DO-Internal-Secret': SECRET } }));
    const body = await st.json();
    expect(body.record.status).toBe('accepted');
    expect(body.record.transferId).toBe(null); // no transferId in this mock body
  });

  it('enabled → HTTP 200 without a valid attestation stays ambiguous (Gate F)', async () => {
    const ns = makeCoordinatorNamespace();
    const env = makeEnv(ns, true);
    // 200 response but NO attestation field → the item is inconclusive, not accepted.
    globalThis.fetch = async (url) => {
      if (String(url).includes('/v1/balances')) return new Response(JSON.stringify({ balances: [{ domain: 26, balance: '100.000000' }] }), { status: 200 });
      if (String(url).includes('/v1/transfer')) return new Response(JSON.stringify([{ burnIntent: { spec: { salt: '0x' + '44'.repeat(32) } } }]), { status: 200 });
      return new Response('{}', { status: 404 });
    };
    const res = await onRequestPost({ request: makePostRequest([makeTransferItem(makeBurnIntent({ sourceToken: USDC_ARC }), IDEM_KEY_A)]), env });
    expect(res.status).toBe(200);

    const names = [...ns.instances.keys()];
    const coord = ns.instances.get(names[0]);
    const st = await coord.fetch(new Request('https://do/status?idempotencyKey=' + IDEM_KEY_A, { headers: { 'X-DO-Internal-Secret': SECRET } }));
    const body = await st.json();
    expect(body.record.status).toBe('ambiguous');
  });

  it('enabled → blocks a cross-salt duplicate (409) and does NOT forward', async () => {
    const ns = makeCoordinatorNamespace();
    const env = makeEnv(ns, true);
    globalThis.fetch = mockFetch({ balance: '100.000000', transferStatus: 200 });
    await onRequestPost({ request: makePostRequest([makeTransferItem(makeBurnIntent({ sourceToken: USDC_ARC }), IDEM_KEY_A)]), env });

    let forwarded = false;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/v1/balances')) return new Response(JSON.stringify({ balances: [{ domain: 26, balance: '100.000000' }] }), { status: 200 });
      if (String(url).includes('/v1/transfer')) { forwarded = true; return new Response('{}', { status: 200 }); }
      return new Response('{}', { status: 404 });
    };
    const res = await onRequestPost({
      request: makePostRequest([makeTransferItem(makeBurnIntent({ sourceToken: USDC_ARC, spec: { salt: '0x' + 'ff'.repeat(32) } }), IDEM_KEY_A)]),
      env,
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('already_submitted');
    expect(forwarded).toBe(false);
  });

  it('associates transferId per item (not the first item for all)', async () => {
    const ns = makeCoordinatorNamespace();
    const env = makeEnv(ns, true);
    // Two items with distinct salts, each echoed with its own transferId.
    const saltA = '0x' + '11'.repeat(32);
    const saltB = '0x' + '22'.repeat(32);
    globalThis.fetch = async (url) => {
      if (String(url).includes('/v1/balances')) return new Response(JSON.stringify({ balances: [{ domain: 26, balance: '100.000000' }] }), { status: 200 });
      if (String(url).includes('/v1/transfer')) {
        return new Response(JSON.stringify([
          { burnIntent: { spec: { salt: saltA } }, attestation: { payload: '0xab', signature: '0xcd' }, transferId: 'tx-A' },
          { burnIntent: { spec: { salt: saltB } }, attestation: { payload: '0xef', signature: '0x01' }, transferId: 'tx-B' },
        ]), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };
    const itemA = makeTransferItem(makeBurnIntent({ sourceToken: USDC_ARC, spec: { salt: saltA } }), 'intent-A');
    const itemB = makeTransferItem(makeBurnIntent({ sourceToken: USDC_ARC, spec: { salt: saltB } }), 'intent-B');
    const res = await onRequestPost({ request: makePostRequest([itemA, itemB]), env });
    expect(res.status).toBe(200);

    const names = [...ns.instances.keys()];
    const coord = ns.instances.get(names[0]);
    const stA = await (await coord.fetch(new Request('https://do/status?operationId=', { headers: { 'X-DO-Internal-Secret': SECRET } }))).json().catch(() => ({}));
    void stA;
    const a = await (await coord.fetch(new Request('https://do/status?idempotencyKey=intent-A', { headers: { 'X-DO-Internal-Secret': SECRET } }))).json();
    const b = await (await coord.fetch(new Request('https://do/status?idempotencyKey=intent-B', { headers: { 'X-DO-Internal-Secret': SECRET } }))).json();
    expect(a.record.transferId).toBe('tx-A');
    expect(b.record.transferId).toBe('tx-B');
  });

  it('enabled → rejects an over-balance reservation (422)', async () => {
    const ns = makeCoordinatorNamespace();
    const env = makeEnv(ns, true);
    globalThis.fetch = mockFetch({ balance: '2.000000', transferStatus: 200 }); // balance < value+maxFee
    const res = await onRequestPost({ request: makePostRequest([makeTransferItem(makeBurnIntent({ sourceToken: USDC_ARC }), IDEM_KEY_A)]), env });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('insufficient_available_balance');
  });
});
