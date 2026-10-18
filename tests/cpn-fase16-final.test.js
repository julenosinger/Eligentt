/**
 * cpn-fase16-final.test.js
 * ═══════════════════════════════════════════════════════════════════════
 * Fase 1.6 — final concurrency / recovery hardening.
 *
 * Exercises the REAL CpnLock DO (transactional storage + alarm semantics) and the
 * REAL handler (fail-safe when the DO binding is absent, and validation of DO
 * commit/markPending results).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { CpnLock } = await import('../functions/api/cpn-lock.do.js');
const { onRequest } = await import('../functions/api/cpn/[[route]].mjs');

const SESSION_TOKEN = '0'.repeat(40);
const USER_ID = 'user-1';
const PH = 'a'.repeat(64);

function makeDOState() {
  const store = new Map();
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
      async setAlarm() {},
      async deleteAlarm() {},
      async transaction(cb) { return cb(txn); },
    },
    async blockConcurrencyWhile(cb) { return cb(); },
    _store: store,
  };
}

function doRequest(action, extra = {}) {
  return new Request('https://do/lock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, payloadHash: PH, ...extra }),
  });
}

describe('CpnLock alarm — never silently releases a processing claim', () => {
  it('alarm transitions "processing" → "pending_reconciliation" (NOT delete)', async () => {
    const state = makeDOState();
    const lock = new CpnLock(state, {});
    await lock.fetch(doRequest('claim'));
    expect(state._store.get('claim').status).toBe('processing');

    // Alarm fires (abandoned/crashed fetch).
    await lock.alarm();
    const claim = state._store.get('claim');
    expect(claim).toBeTruthy(); // NOT deleted — still guarded
    expect(claim.status).toBe('pending_reconciliation');
  });

  it('alarm does NOT touch a committed claim', async () => {
    const state = makeDOState();
    const lock = new CpnLock(state, {});
    await lock.fetch(doRequest('claim'));
    await lock.fetch(doRequest('commit', { paymentId: 'pmt-1' }));
    await lock.alarm();
    expect(state._store.get('claim').status).toBe('committed');
  });

  it('alarm is a no-op when there is no claim', async () => {
    const state = makeDOState();
    const lock = new CpnLock(state, {});
    await lock.alarm();
    expect(state._store.get('claim')).toBeUndefined();
  });
});

// ── Handler helpers ────────────────────────────────────────────────────────────
function makeKV() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); return undefined; },
    async delete(k) { store.delete(k); return undefined; },
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

describe('onRequest — fail-safe when the atomic lock is not configured', () => {
  it('returns 503 CPN_LOCK_NOT_CONFIGURED when CPN_LOCK is absent (no silent KV fallback)', async () => {
    const kv = makeKV();
    await seedSession(kv);
    const env = { CPN_API_KEY: 'key', AUTH_KV: kv }; // no CPN_LOCK, no CPN_ALLOW_KV_FALLBACK
    globalThis.fetch = async () => new Response(JSON.stringify({ id: 'pmt-x' }), { status: 201 });
    const res = await onRequest({ env, request: makeRequest('POST', 'payments', paymentBody()) });
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.code).toBe('CPN_LOCK_NOT_CONFIGURED');
  });

  it('allows the KV fallback only when explicitly enabled (CPN_ALLOW_KV_FALLBACK=true)', async () => {
    const kv = makeKV();
    await seedSession(kv);
    const env = { CPN_API_KEY: 'key', AUTH_KV: kv, CPN_ALLOW_KV_FALLBACK: 'true' };
    globalThis.fetch = async () => new Response(JSON.stringify({ id: 'pmt-x' }), { status: 201 });
    const res = await onRequest({ env, request: makeRequest('POST', 'payments', paymentBody()) });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBe('pmt-x');
    expect(data.degraded).toBe(true); // explicit non-atomic mode
  });
});

// ── DO mock that can be told to fail specific actions ──────────────────────────
function makeFailingCpnLockDO({ failAction = null } = {}) {
  const store = new Map();
  return {
    idFromName(name) { return { name }; },
    get(id) {
      return {
        async fetch(url, init) {
          const body = JSON.parse(init.body);
          if (body.action === failAction) {
            return new Response(JSON.stringify({ error: 'DO action failed' }), { status: 500 });
          }
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
          if (body.action === 'commit') { store.set(id.name, { ...existing, status: 'committed', paymentId: body.paymentId }); return new Response(JSON.stringify({ ok: true })); }
          if (body.action === 'markPending') { store.set(id.name, { ...existing, status: 'pending_reconciliation' }); return new Response(JSON.stringify({ ok: true })); }
          if (body.action === 'release') { store.delete(id.name); return new Response(JSON.stringify({ ok: true })); }
          return new Response(JSON.stringify({ error: 'unknown' }), { status: 400 });
        },
      };
    },
    _store: store,
  };
}

describe('onRequest — validates DO commit/markPending results', () => {
  it('commit failure is surfaced via lockCommitFailed (not silent)', async () => {
    const kv = makeKV();
    await seedSession(kv);
    const cpnLock = makeFailingCpnLockDO({ failAction: 'commit' });
    const env = { CPN_API_KEY: 'key', AUTH_KV: kv, CPN_LOCK: cpnLock };
    globalThis.fetch = async () => new Response(JSON.stringify({ id: 'pmt-ok' }), { status: 201 });
    const res = await onRequest({ env, request: makeRequest('POST', 'payments', paymentBody()) });
    const data = await res.json();
    expect(data.id).toBe('pmt-ok');
    expect(data.lockCommitFailed).toBe(true);
  });

  it('markPending failure on NETWORK_UNKNOWN is surfaced via lockMarkPendingFailed', async () => {
    const kv = makeKV();
    await seedSession(kv);
    const cpnLock = makeFailingCpnLockDO({ failAction: 'markPending' });
    const env = { CPN_API_KEY: 'key', AUTH_KV: kv, CPN_LOCK: cpnLock };
    globalThis.fetch = async () => { throw new Error('network down'); };
    const res = await onRequest({ env, request: makeRequest('POST', 'payments', paymentBody()) });
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.code).toBe('NETWORK_UNKNOWN');
    expect(data.lockMarkPendingFailed).toBe(true);
  });
});
