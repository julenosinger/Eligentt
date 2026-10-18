/**
 * cpn-fase14-security.test.js
 * ═══════════════════════════════════════════════════════════════════════
 * Fase 1.4 security regression tests. These exercise the REAL handler
 * (functions/api/cpn/[[route]].mjs) via its exported onRequest, and the REAL
 * shared module (shared/cpnFiatPayout.js) — not copies of the functions.
 *
 * Covered:
 *   · executeFiatPayout requires an expected recipient before doing any work
 *     (no signing without a bound recipient) and has no value→0n fallback.
 *   · NETWORK_UNKNOWN persists a PENDING_RECONCILIATION record.
 *   · A retry with the same key but a DIFFERENT payload is rejected (key reuse).
 *   · A retry with the SAME payload reconciles through Circle's Idempotency-Key.
 *   · A persistence failure after Circle created the payment also persists
 *     PENDING_RECONCILIATION and surfaces the paymentId (never a silent dup).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Real handler (ESM export) and real shared module (IIFE → module.exports).
const { onRequest } = await import('../functions/api/cpn/[[route]].mjs');
const CPN = require(path.join(ROOT, 'shared/cpnFiatPayout.js'));

const SESSION_TOKEN = '0'.repeat(40);
const USER_ID = 'user-1';

function makeKV() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); return undefined; },
    async delete(k) { store.delete(k); return undefined; },
  };
}

function makeEnv(kv, { apiKey = 'cpn-secret-key', kvFail = null } = {}) {
  const env = { CPN_API_KEY: apiKey, AUTH_KV: kv, CPN_ALLOW_KV_FALLBACK: 'true' };
  return env;
}

function makeRequest(method, pathname, body, { token = SESSION_TOKEN } = {}) {
  return new Request('https://elligentttest.pages.dev/api/cpn/' + pathname, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
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

function makeResponse(body, status) {
  return new Response(JSON.stringify(body), { status });
}

async function seedSession(kv) {
  await kv.put(`session:${SESSION_TOKEN}`, JSON.stringify({ userId: USER_ID, email: 'a@b.c', createdAt: Date.now() }));
}

beforeEach(() => {
  delete globalThis.fetch;
});

afterEach(() => {
  delete globalThis.fetch;
});

describe('executeFiatPayout — recipient required + no value fallback (real module)', () => {
  it('throws TX_RECIPIENT_REQUIRED before any work when expectedRecipient is missing', async () => {
    let err = null;
    try {
      await CPN.executeFiatPayout({
        amount: '100',
        currency: 'BRL',
        beneficiary: { name: 'Joao', bankName: 'Bank', accountNumber: '12345678', countryCode: 'BR' },
        sender: { name: 'Sender', countryCode: 'US' },
        walletAddress: '0xabc',
        signer: { signTransaction: async () => '0xsigned' },
        quoteSelectionCallback: async () => ({ id: 'q' }),
        // expectedRecipient intentionally omitted
      });
    } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.code).toBe('TX_RECIPIENT_REQUIRED');
  });

  it('has no value→0n fallback in the signing path', () => {
    const src = require('fs').readFileSync(path.join(ROOT, 'shared/cpnFiatPayout.js'), 'utf8');
    expect(src).toContain('value:    BigInt(txObj.value)');
    expect(src).not.toContain('txObj.value   ? BigInt(txObj.value) : 0n');
  });
});

describe('onRequest — PENDING_RECONCILIATION (real handler)', () => {
  it('NETWORK_UNKNOWN persists a PENDING_RECONCILIATION record and blocks dup payload', async () => {
    const kv = makeKV();
    await seedSession(kv);
    const env = makeEnv(kv);

    // First attempt: Circle fetch throws → NETWORK_UNKNOWN.
    globalThis.fetch = async () => { throw new Error('network down'); };
    const body = paymentBody();
    const res1 = await onRequest({ env, request: makeRequest('POST', 'payments', body) });
    expect(res1.status).toBe(502);
    const data1 = await res1.json();
    expect(data1.code).toBe('NETWORK_UNKNOWN');
    expect(data1.reconcileRequired).toBe(true);

    const pendingRaw = await kv.get(`cpn_pending:${USER_ID}:${body.idempotencyKey}`);
    expect(pendingRaw).toBeTruthy();
    const pending = JSON.parse(pendingRaw);
    expect(pending.status).toBe('PENDING_RECONCILIATION');

    // Retry with SAME key but DIFFERENT amount → key reuse rejected (409).
    globalThis.fetch = async () => makeResponse({ id: 'pmt-x' }, 201);
    const changedBody = paymentBody({ amount: { amount: '999.00', currency: 'USD' } });
    const res2 = await onRequest({ env, request: makeRequest('POST', 'payments', changedBody) });
    expect(res2.status).toBe(409);
    const data2 = await res2.json();
    expect(data2.code).toBe('IDEMPOTENCY_KEY_REUSE');
  });

  it('a same-payload retry reconciles through Circle and clears the pending record', async () => {
    const kv = makeKV();
    await seedSession(kv);
    const env = makeEnv(kv);
    const body = paymentBody();

    // First attempt: network error → PENDING_RECONCILIATION.
    globalThis.fetch = async () => { throw new Error('network down'); };
    await onRequest({ env, request: makeRequest('POST', 'payments', body) });
    expect(await kv.get(`cpn_pending:${USER_ID}:${body.idempotencyKey}`)).toBeTruthy();

    // Simulate the in-flight reservation TTL (120 s) expiring before the retry,
    // so the reconciliation retry can acquire a fresh lock.
    await kv.delete(`cpn_reserve:${USER_ID}:${body.idempotencyKey}`);

    // Retry with SAME payload: Circle returns the already-created paymentId.
    globalThis.fetch = async (url, init) => {
      expect(init.headers['Idempotency-Key']).toBe(body.idempotencyKey);
      return makeResponse({ id: 'pmt-123', status: 'PENDING_ONCHAIN' }, 201);
    };
    const res = await onRequest({ env, request: makeRequest('POST', 'payments', body) });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBe('pmt-123');

    // Pending record is cleared after successful persist.
    expect(await kv.get(`cpn_pending:${USER_ID}:${body.idempotencyKey}`)).toBeNull();
    // Permanent idempotency record exists.
    const idemRaw = await kv.get(`cpn_idem:${USER_ID}:${body.idempotencyKey}`);
    expect(idemRaw).toBeTruthy();
    expect(JSON.parse(idemRaw).paymentId).toBe('pmt-123');
  });

  it('a same-payload retry while the reservation is still held is blocked (coordinated)', async () => {
    const kv = makeKV();
    await seedSession(kv);
    const env = makeEnv(kv);
    const body = paymentBody();

    // First attempt: network error → reservation + PENDING_RECONCILIATION persist.
    globalThis.fetch = async () => { throw new Error('network down'); };
    await onRequest({ env, request: makeRequest('POST', 'payments', body) });

    // Retry with SAME payload while the reservation is STILL held → 409 (no
    // uncoordinated reconciliation; the in-flight lock serializes the retry).
    let circleCalls = 0;
    globalThis.fetch = async () => { circleCalls++; return makeResponse({ id: 'pmt-x' }, 201); };
    const res = await onRequest({ env, request: makeRequest('POST', 'payments', body) });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(circleCalls).toBe(0); // never reached Circle — lock held
  });

  it('persistence failure after Circle created the payment persists PENDING_RECONCILIATION', async () => {
    const kv = makeKV();
    await seedSession(kv);
    const env = makeEnv(kv);
    const body = paymentBody();

    // Circle succeeds with a paymentId, but the KV promote/ownership write fails.
    // Simulate KV.put failing for cpn_idem/cpn_pay keys only.
    const realPut = kv.put.bind(kv);
    kv.put = async (k, v, o) => {
      if (k.startsWith('cpn_idem:') || k.startsWith('cpn_pay:')) throw new Error('KV write failed');
      return realPut(k, v, o);
    };

    globalThis.fetch = async () => makeResponse({ id: 'pmt-456', status: 'PENDING_ONCHAIN' }, 201);
    const res = await onRequest({ env, request: makeRequest('POST', 'payments', body) });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBe('pmt-456');
    expect(data.persistenceWarning).toBe(true);
    expect(data.reconcileRequired).toBe(true);

    const pendingRaw = await kv.get(`cpn_pending:${USER_ID}:${body.idempotencyKey}`);
    expect(pendingRaw).toBeTruthy();
    expect(JSON.parse(pendingRaw).status).toBe('PENDING_RECONCILIATION');
  });
});
