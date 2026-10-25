/**
 * gateway-fase18.test.js
 * ═══════════════════════════════════════════════════════════════════════
 * Fase 1.8 — Gateway Spend Service P0/P1 integrity fixes.
 *
 * Exercises the REAL transfer.js handler (classifyHttpStatus via onRequestPost,
 * persistence-failure handling, PATCH transition enforcement) and the REAL
 * GatewayOpLock Durable Object (auth + payload validation + rollback gating).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { GatewayOpLock } = await import('../functions/api/gateway/gateway-op-lock.do.js');
const transfer = await import('../functions/api/gateway/transfer.js');
const { onRequestPost, onRequestGet, onRequestPatch } = transfer;

// ── GatewayOpLock DO state mock ──────────────────────────────────────────────
function makeDOState() {
  const store = new Map();
  return {
    storage: {
      async get(k) { return store.has(k) ? store.get(k) : undefined; },
      async put(k, v) { store.set(k, v); },
      async delete(k) { store.delete(k); },
    },
    _store: store,
  };
}
const SECRET = 'test-internal-secret-1234567890abcdef';

function doFetch(lock, action, method, body, secret = SECRET) {
  const headers = { 'Content-Type': 'application/json' };
  if (secret) headers['X-DO-Internal-Secret'] = secret;
  return lock.fetch(new Request('https://do/' + action, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  }));
}

describe('GatewayOpLock — auth + payload validation + rollback gating (real class)', () => {
  it('blocks requests without a valid internal secret (fail-closed)', async () => {
    const state = makeDOState();
    const lock = new GatewayOpLock(state, { DO_INTERNAL_SECRET: SECRET });
    const res = await doFetch(lock, 'status', 'GET', null, 'wrong-secret');
    expect(res.status).toBe(401);
  });

  it('rejects a reserve with an invalid salt', async () => {
    const state = makeDOState();
    const lock = new GatewayOpLock(state, { DO_INTERNAL_SECRET: SECRET });
    const res = await doFetch(lock, 'reserve', 'POST', {
      salt: '0xzz', depositor: '0x' + '22'.repeat(20),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_salt');
  });

  it('rejects a reserve with an invalid depositor', async () => {
    const state = makeDOState();
    const lock = new GatewayOpLock(state, { DO_INTERNAL_SECRET: SECRET });
    const res = await doFetch(lock, 'reserve', 'POST', {
      salt: '0x' + '11'.repeat(32), depositor: '0xNOTANADDR',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_depositor');
  });

  it('rejects an update to an unknown status', async () => {
    const state = makeDOState();
    const lock = new GatewayOpLock(state, { DO_INTERNAL_SECRET: SECRET });
    await doFetch(lock, 'reserve', 'POST', { salt: '0x' + '11'.repeat(32), depositor: '0x' + '22'.repeat(20) });
    const res = await doFetch(lock, 'update', 'POST', { status: 'not_a_state' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('unknown_status');
  });

  it('rejects submitting→failed without the rollback flag', async () => {
    const state = makeDOState();
    const lock = new GatewayOpLock(state, { DO_INTERNAL_SECRET: SECRET });
    await doFetch(lock, 'reserve', 'POST', { salt: '0x' + '11'.repeat(32), depositor: '0x' + '22'.repeat(20) });
    const res = await doFetch(lock, 'update', 'POST', { status: 'failed' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('rollback_required');
  });

  it('allows submitting→failed only with rollback:true', async () => {
    const state = makeDOState();
    const lock = new GatewayOpLock(state, { DO_INTERNAL_SECRET: SECRET });
    await doFetch(lock, 'reserve', 'POST', { salt: '0x' + '11'.repeat(32), depositor: '0x' + '22'.repeat(20) });
    const res = await doFetch(lock, 'update', 'POST', { status: 'failed', rollback: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.record.status).toBe('failed');
  });
});

// ── transfer.js KV mock + helpers ────────────────────────────────────────────
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

function makeItem(over = {}) {
  const spec = Object.assign({
    salt: '0x' + '11'.repeat(32),
    sourceSigner: '0x' + '22'.repeat(32),
    sourceDomain: 26,
    destinationDomain: 0,
  }, over.spec || {});
  return {
    burnIntent: { spec },
    signature: '0x' + '33'.repeat(65),
  };
}

function makePostRequest(items) {
  return new Request('https://elligentttest.pages.dev/api/gateway/transfer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': 'https://elligentttest.pages.dev' },
    body: JSON.stringify(items),
  });
}

const DEPOSITOR = '0x' + '22'.repeat(20);

beforeEach(() => { delete globalThis.fetch; });
afterEach(() => { delete globalThis.fetch; });

describe('transfer.js onRequestPost — Circle response classification (real handler)', () => {
  async function runWithStatus(httpStatus) {
    const kv = makeKV();
    const env = { GATEWAY_OPS_KV: kv }; // non-production → KV fallback active
    globalThis.fetch = async () => new Response(JSON.stringify([{ attestation: {} }]), { status: httpStatus });
    const res = await onRequestPost({ request: makePostRequest([makeItem()]), env });
    const record = await kv.get('gw:op:0x' + '11'.repeat(32), { type: 'json' });
    return { res, record };
  }

  it('2xx → accepted', async () => {
    const { record } = await runWithStatus(200);
    expect(record.status).toBe('accepted');
  });

  it('400 (definitive client error) → rejected', async () => {
    const { record } = await runWithStatus(400);
    expect(record.status).toBe('rejected');
  });

  it('408 (request timeout) → ambiguous (NOT rejected)', async () => {
    const { record } = await runWithStatus(408);
    expect(record.status).toBe('ambiguous');
  });

  it('429 (rate limit) → ambiguous', async () => {
    const { record } = await runWithStatus(429);
    expect(record.status).toBe('ambiguous');
  });

  it('500 (server error) → ambiguous', async () => {
    const { record } = await runWithStatus(500);
    expect(record.status).toBe('ambiguous');
  });
});

describe('transfer.js onRequestPost — persistence failure after Circle responded', () => {
  it('returns 502 persistence_failed_after_response (not the Circle 2xx)', async () => {
    const kv = makeKV();
    // Reserve succeeds (first put), but the update put fails.
    let putCount = 0;
    kv.put = async (k, v) => {
      putCount++;
      if (putCount >= 2) throw new Error('KV write failed');
      kv.store.set(k, String(v));
    };
    const env = { GATEWAY_OPS_KV: kv };
    globalThis.fetch = async () => new Response(JSON.stringify([{ attestation: { payload: '0xab', signature: '0xcd' } }]), { status: 200 });
    const res = await onRequestPost({ request: makePostRequest([makeItem()]), env });
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.error).toBe('persistence_failed_after_response');
    expect(data.recoverable).toBe(true);
    expect(data.blocked).toBe(true);
    expect(data.httpStatus).toBe(200);
    expect(data.circleResponse).toBeTruthy(); // original response preserved
    expect(Array.isArray(data.failedSalts)).toBe(true);
  });
});

describe('transfer.js onRequestPatch — client cannot forge confirmed/failed', () => {
  function makePatchRequest(salt, depositor, body) {
    return new Request('https://elligentttest.pages.dev/api/gateway/transfer?salt=' + salt + '&depositor=' + depositor, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://elligentttest.pages.dev' },
      body: JSON.stringify(body || {}),
    });
  }

  async function seed(kv, status) {
    await kv.put('gw:op:0x' + '11'.repeat(32), JSON.stringify({
      salt: '0x' + '11'.repeat(32), depositor: DEPOSITOR, status, submittedAt: new Date().toISOString(),
    }));
  }

  // Fase 2.2: ambiguous→failed removed from client. ALL transitions require /confirm.
  it('ambiguous → failed via PATCH is BLOCKED (Fase 2.2: no client transitions)', async () => {
    const kv = makeKV();
    await seed(kv, 'ambiguous');
    const env = { GATEWAY_OPS_KV: kv };
    const res = await onRequestPatch({ request: makePatchRequest('0x' + '11'.repeat(32), DEPOSITOR, { status: 'failed' }), env });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('client_transition_not_allowed');
  });

  it('submitting → confirmed is forbidden', async () => {
    const kv = makeKV();
    await seed(kv, 'submitting');
    const env = { GATEWAY_OPS_KV: kv };
    const res = await onRequestPatch({ request: makePatchRequest('0x' + '11'.repeat(32), DEPOSITOR, { status: 'confirmed' }), env });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('client_transition_not_allowed');
  });

  // Fase 2.1 update: accepted→confirmed and accepted→failed are NO LONGER allowed
  // via client PATCH. These transitions require server-side RPC verification via
  // POST /api/gateway/transfer/confirm. The PATCH endpoint returns
  // client_transition_not_allowed for any attempted accepted→* transition.
  it('accepted → confirmed via PATCH → client_transition_not_allowed (Fase 2.1)', async () => {
    const kv = makeKV();
    await seed(kv, 'accepted');
    const env = { GATEWAY_OPS_KV: kv };
    const res = await onRequestPatch({ request: makePatchRequest('0x' + '11'.repeat(32), DEPOSITOR, { status: 'confirmed' }), env });
    expect(res.status).toBe(400);
    const data = await res.json();
    // Fase 2.1: all accepted→* transitions are now blocked at client level
    expect(data.error).toBe('client_transition_not_allowed');
  });

  it('accepted → failed via PATCH → client_transition_not_allowed (Fase 2.1)', async () => {
    const kv = makeKV();
    await seed(kv, 'accepted');
    const env = { GATEWAY_OPS_KV: kv };
    const res = await onRequestPatch({ request: makePatchRequest('0x' + '11'.repeat(32), DEPOSITOR, { status: 'failed' }), env });
    expect(res.status).toBe(400);
    const data = await res.json();
    // Fase 2.1: accepted→failed requires /confirm endpoint, not PATCH
    expect(data.error).toBe('client_transition_not_allowed');
  });

  it('accepted → confirmed with txHash via PATCH still blocked (Fase 2.1)', async () => {
    // Even with a valid txHash, the PATCH endpoint cannot set confirmed.
    // The client must use POST /api/gateway/transfer/confirm instead.
    const kv = makeKV();
    await seed(kv, 'accepted');
    const env = { GATEWAY_OPS_KV: kv };
    const txHash = '0x' + 'cc'.repeat(32);
    const res = await onRequestPatch({ request: makePatchRequest('0x' + '11'.repeat(32), DEPOSITOR, { status: 'confirmed', txHash }), env });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('client_transition_not_allowed');
  });

  it('accepted → failed with txHash via PATCH still blocked (Fase 2.1)', async () => {
    // Even with a valid txHash, PATCH cannot set failed for an accepted operation.
    // Use POST /api/gateway/transfer/confirm instead.
    const kv = makeKV();
    await seed(kv, 'accepted');
    const env = { GATEWAY_OPS_KV: kv };
    const txHash = '0x' + 'dd'.repeat(32);
    const res = await onRequestPatch({ request: makePatchRequest('0x' + '11'.repeat(32), DEPOSITOR, { status: 'failed', txHash }), env });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('client_transition_not_allowed');
  });
});

describe('transfer.js — production requires the Durable Object (fail-closed)', () => {
  it('POST is blocked in production without GATEWAY_OP_LOCK', async () => {
    const kv = makeKV();
    const env = { GATEWAY_OPS_KV: kv, GATEWAY_ENV: 'production' }; // prod + KV → KV disabled
    globalThis.fetch = async () => new Response('{}', { status: 200 });
    const res = await onRequestPost({ request: makePostRequest([makeItem()]), env });
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.error).toBe('do_required_in_production');
  });
});
