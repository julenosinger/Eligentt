/**
 * cpn-fase15-concurrency.test.js
 * ═══════════════════════════════════════════════════════════════════════
 * Fase 1.5 — concurrency / reconciliation / persistence tests.
 *
 * Exercises the REAL CpnLock Durable Object class and the REAL handler's DO +
 * KV-fallback branches. Covers: atomic claim semantics, coordinated concurrent
 * reconciliation, key reuse, and persistence failure for every idempotency record.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { CpnLock } = await import('../functions/api/cpn-lock.do.js');
const { onRequest } = await import('../functions/api/cpn/[[route]].mjs');

const SESSION_TOKEN = '0'.repeat(40);
const USER_ID = 'user-1';
const PAYLOAD_HASH = 'a'.repeat(64);

// ── DO state mock ──────────────────────────────────────────────────────────────
function makeDOState() {
  const store = new Map();
  return {
    storage: {
      async get(k) { return store.has(k) ? store.get(k) : undefined; },
      async put(k, v) { store.set(k, v); },
      async delete(k) { store.delete(k); },
      async setAlarm() {},
      async deleteAlarm() {},
    },
    _store: store,
  };
}

function doRequest(action, extra = {}) {
  return new Request('https://do/lock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, payloadHash: PAYLOAD_HASH, ...extra }),
  });
}

describe('CpnLock Durable Object — atomic claim semantics (real class)', () => {
  it('claim: first request wins (claimed: true)', async () => {
    const state = makeDOState();
    const lock = new CpnLock(state, {});
    const res = await lock.fetch(doRequest('claim'));
    const body = await res.json();
    expect(body.claimed).toBe(true);
    expect(state._store.get('claim').status).toBe('processing');
  });

  it('claim: same payload while processing → claimed "same" (blocked)', async () => {
    const state = makeDOState();
    const lock = new CpnLock(state, {});
    await lock.fetch(doRequest('claim'));
    const res = await lock.fetch(doRequest('claim'));
    const body = await res.json();
    expect(body.claimed).toBe('same');
  });

  it('claim: different payload → claimed false (key reuse)', async () => {
    const state = makeDOState();
    const lock = new CpnLock(state, {});
    await lock.fetch(doRequest('claim'));
    const res = await lock.fetch(doRequest('claim', { payloadHash: 'b'.repeat(64) }));
    const body = await res.json();
    expect(body.claimed).toBe(false);
  });

  it('commit → subsequent claim returns "committed" with paymentId', async () => {
    const state = makeDOState();
    const lock = new CpnLock(state, {});
    await lock.fetch(doRequest('claim'));
    await lock.fetch(doRequest('commit', { paymentId: 'pmt-1' }));
    const res = await lock.fetch(doRequest('claim'));
    const body = await res.json();
    expect(body.claimed).toBe('committed');
    expect(body.paymentId).toBe('pmt-1');
  });

  it('markPending → claim re-claims (claimed: true) for reconciliation, not committed', async () => {
    const state = makeDOState();
    const lock = new CpnLock(state, {});
    await lock.fetch(doRequest('claim'));
    await lock.fetch(doRequest('markPending'));
    expect(state._store.get('claim').status).toBe('pending_reconciliation');
    const res = await lock.fetch(doRequest('claim'));
    const body = await res.json();
    expect(body.claimed).toBe(true); // atomically re-claimed for reconciliation
    expect(state._store.get('claim').status).toBe('processing');
  });

  it('release deletes the claim (retryable)', async () => {
    const state = makeDOState();
    const lock = new CpnLock(state, {});
    await lock.fetch(doRequest('claim'));
    await lock.fetch(doRequest('release'));
    const res = await lock.fetch(doRequest('claim'));
    const body = await res.json();
    expect(body.claimed).toBe(true); // fresh claim after release
  });
});

// ── Handler DO branch + persistence helpers ───────────────────────────────────
function makeKV() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); return undefined; },
    async delete(k) { store.delete(k); return undefined; },
  };
}

function makeCpnLockDO() {
  const store = new Map();
  return {
    idFromName(name) { return { name }; },
    get(id) {
      return {
        async fetch(url, init) {
          const body = JSON.parse(init.body);
          const existing = store.get(id.name);
          if (body.action === 'claim') {
            if (!existing) { store.set(id.name, { payloadHash: body.payloadHash, status: 'processing' }); return new Response(JSON.stringify({ ok: true, claimed: true })); }
            if (existing.payloadHash === body.payloadHash) {
              if (existing.status === 'committed') return new Response(JSON.stringify({ ok: true, claimed: 'committed', paymentId: existing.paymentId }));
              if (existing.status === 'pending_reconciliation') { store.set(id.name, { payloadHash: body.payloadHash, status: 'processing' }); return new Response(JSON.stringify({ ok: true, claimed: true })); }
              return new Response(JSON.stringify({ ok: true, claimed: 'same' }));
            }
            return new Response(JSON.stringify({ ok: true, claimed: false }));
          }
          if (body.action === 'commit') {
            store.set(id.name, { ...existing, status: 'committed', paymentId: body.paymentId });
            return new Response(JSON.stringify({ ok: true }));
          }
          if (body.action === 'markPending') {
            store.set(id.name, { ...existing, status: 'pending_reconciliation' });
            return new Response(JSON.stringify({ ok: true }));
          }
          if (body.action === 'release') { store.delete(id.name); return new Response(JSON.stringify({ ok: true })); }
          return new Response(JSON.stringify({ error: 'unknown' }), { status: 400 });
        },
      };
    },
    _store: store,
  };
}

function paymentBody(over = {}) {
  return Object.assign({
    idempotencyKey: '11111111-2222-4333-8444-555555555555',
    quoteId: 'q-1',
    amount: { amount: '100.00', currency: 'USD' },
    destinationCurrency: 'BRL',
    beneficiaryDetails: { name: 'Joao', bankName: 'Bank', accountNumber: '12345678', countryCode: 'BR' },
    senderDetails: { name: 'Sender', countryCode: 'US' },
  }, over);
}

function makeRequest(method, pathname, body, token = SESSION_TOKEN) {
  return new Request('https://elligentttest.pages.dev/api/cpn/' + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function seedSession(kv) {
  await kv.put(`session:${SESSION_TOKEN}`, JSON.stringify({ userId: USER_ID, email: 'a@b.c', createdAt: Date.now() }));
}

beforeEach(() => { delete globalThis.fetch; });
afterEach(() => { delete globalThis.fetch; });

describe('onRequest — Durable Object branch (coordinated reconciliation)', () => {
  it('NETWORK_UNKNOWN marks pending; a retry atomically re-claims and reconciles', async () => {
    const kv = makeKV();
    await seedSession(kv);
    const cpnLock = makeCpnLockDO();
    const env = { CPN_API_KEY: 'key', AUTH_KV: kv, CPN_LOCK: cpnLock };
    const body = paymentBody();
    const key = `${USER_ID}:${body.idempotencyKey}`;

    // First request claims the DO lock, then a network error → markPending.
    globalThis.fetch = async () => { throw new Error('network down'); };
    await onRequest({ env, request: makeRequest('POST', 'payments', body) });
    expect(cpnLock._store.get(key).status).toBe('pending_reconciliation');

    // Retry with SAME payload: claim re-claims (processing) → proceeds to Circle.
    globalThis.fetch = async () => new Response(JSON.stringify({ id: 'pmt-x' }), { status: 201 });
    const res = await onRequest({ env, request: makeRequest('POST', 'payments', body) });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBe('pmt-x');
    // After success, the DO is committed.
    expect(cpnLock._store.get(key).status).toBe('committed');
  });

  it('DO claim "same" → 409 IDEMPOTENCY_CONFLICT (blocked, not duplicated)', async () => {
    const kv = makeKV();
    await seedSession(kv);
    const cpnLock = makeCpnLockDO();
    // Override claim to return "same" (simulating a same-payload in-flight claim).
    const originalGet = cpnLock.get.bind(cpnLock);
    cpnLock.get = (id) => {
      const stub = originalGet(id);
      const origFetch = stub.fetch.bind(stub);
      stub.fetch = async (url, init) => {
        const b = JSON.parse(init.body);
        if (b.action === 'claim') return new Response(JSON.stringify({ ok: true, claimed: 'same' }));
        return origFetch(url, init);
      };
      return stub;
    };
    const env = { CPN_API_KEY: 'key', AUTH_KV: kv, CPN_LOCK: cpnLock };
    globalThis.fetch = async () => new Response(JSON.stringify({ id: 'pmt-x' }), { status: 201 });
    const res = await onRequest({ env, request: makeRequest('POST', 'payments', paymentBody()) });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.code).toBe('IDEMPOTENCY_CONFLICT');
  });
});

describe('onRequest — persistence failure for every idempotency record', () => {
  it('cpn_pending write failure sets reconciliationPersistFailed (still indeterminate)', async () => {
    const kv = makeKV();
    await seedSession(kv);
    const env = { CPN_API_KEY: 'key', AUTH_KV: kv };

    // Circle succeeds, but cpn_idem + cpn_pay + cpn_pending writes all fail.
    kv.put = async (k, v) => {
      if (k.startsWith('cpn_idem:') || k.startsWith('cpn_pay:') || k.startsWith('cpn_pending:')) throw new Error('KV write failed');
      kv.store.set(k, v);
    };

    globalThis.fetch = async () => new Response(JSON.stringify({ id: 'pmt-789' }), { status: 201 });
    const res = await onRequest({ env, request: makeRequest('POST', 'payments', paymentBody()) });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBe('pmt-789');
    expect(data.persistenceWarning).toBe(true);
    expect(data.code).toBe('INDETERMINATE_OUTCOME');
    expect(data.reconciliationPersistFailed).toBe(true);
  });

  it('cpn_pay failure alone → INDETERMINATE_OUTCOME (never definitive success)', async () => {
    const kv = makeKV();
    await seedSession(kv);
    const env = { CPN_API_KEY: 'key', AUTH_KV: kv };

    kv.put = async (k, v) => {
      if (k.startsWith('cpn_pay:')) throw new Error('KV write failed');
      kv.store.set(k, v);
    };

    globalThis.fetch = async () => new Response(JSON.stringify({ id: 'pmt-abc' }), { status: 201 });
    const res = await onRequest({ env, request: makeRequest('POST', 'payments', paymentBody()) });
    const data = await res.json();
    expect(data.id).toBe('pmt-abc');
    expect(data.persistenceWarning).toBe(true);
    expect(data.code).toBe('INDETERMINATE_OUTCOME');
  });
});
