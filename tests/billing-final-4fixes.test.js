/**
 * billing-final-4fixes.test.js
 * Covers the 4 surgical fixes on top of commit 066dcc6:
 *   Fix 1 — userId/createdBy stripped from publicView
 *   Fix 2 — ownership on all admin CRUD (POST only — no extra GET/PATCH/DELETE endpoints exist)
 *   Fix 3 — idempotency: sequential write + re-read race guard
 *   Fix 4 — decimals from CHAIN_REGISTRY (USDC=6, EURC=6, CIRBTC=8)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RELAYER_CONFIG } from '../functions/api/shared-config.mjs';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeKV(initial = {}) {
  const store = { ...initial };
  return {
    async get(k) { return store[k] ?? null; },
    async put(k, v, _opts) { store[k] = v; },
    _store: store,
  };
}

function makeSession(overrides = {}) {
  return JSON.stringify({
    userId: overrides.userId ?? 'user-A',
    email:  overrides.email  ?? 'a@test.com',
    walletAddress: overrides.walletAddress ?? '0xAAAA0000000000000000000000000000000000AA',
    ...overrides,
  });
}

function makeAuthKV(sessionToken, sessionData) {
  return makeKV({ ['session:' + sessionToken]: sessionData ?? makeSession() });
}

function makeRequest(method, body, opts = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (opts.token) headers.set('Authorization', 'Bearer ' + opts.token);
  if (opts.origin) headers.set('Origin', opts.origin);
  return new Request('https://test.dev' + (opts.path || '/api/invoice'), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ── import handlers dynamically ───────────────────────────────────────────────

async function invoicePost(body, env) {
  const { onRequestPost } = await import('../functions/api/invoice.js?t=' + Date.now());
  const req = makeRequest('POST', body, { token: 'tok-user-A-000000000000000000000000000' });
  return onRequestPost({ request: req, env, params: {} });
}

async function paymentLinksPost(body, env) {
  const { onRequestPost } = await import('../functions/api/payment-links.js?t=' + Date.now());
  const req = makeRequest('POST', body, { token: 'tok-user-A-000000000000000000000000000' });
  return onRequestPost({ request: req, env, params: {} });
}

async function paymentPost(token, body, env) {
  const { onRequestPost } = await import('../functions/api/payment/[token].js?t=' + Date.now());
  const req = makeRequest('POST', body);
  return onRequestPost({ request: req, env, params: { token } });
}

// ── Fix 1: publicView strips userId, createdBy ────────────────────────────────

describe('Fix 1 — publicView strips server-only fields', () => {
  it('invoice response does not contain userId', async () => {
    const KV = makeKV();
    const AUTH_KV = makeAuthKV('tok-user-A-000000000000000000000000000');
    const env = { KV, PAYMENT_LINKS: KV, AUTH_KV, ALLOWED_ORIGINS: '*', RATE_LIMIT_KV: makeKV() };

    const res = await invoicePost({
      id: 'inv_test001fix1xx',
      recipient: '0xBBBB000000000000000000000000000000000BBB',
      amount: 10,
      chain: 'Arc Mainnet',
      token: 'USDC',
    }, env);

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.link).toBeDefined();
    expect(json.link.userId).toBeUndefined();
    expect(json.link.createdBy).toBeUndefined();
    expect(json.link.ownerEmail).toBeUndefined();
    expect(json.link.ownerWallet).toBeUndefined();
  });

  it('payment-link response does not contain userId', async () => {
    const KV = makeKV();
    const AUTH_KV = makeAuthKV('tok-user-A-000000000000000000000000000');
    const env = { KV, PAYMENT_LINKS: KV, AUTH_KV, ALLOWED_ORIGINS: '*', RATE_LIMIT_KV: makeKV() };

    const res = await paymentLinksPost({
      recipient: '0xBBBB000000000000000000000000000000000BBB',
      amount: 5,
      type: 'fixed',
      chain: 'Arc Mainnet',
      token: 'USDC',
    }, env);

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.link.userId).toBeUndefined();
    expect(json.link.createdBy).toBeUndefined();
    expect(json.link.ownerEmail).toBeUndefined();
    expect(json.link.ownerWallet).toBeUndefined();
  });

  it('invoice response still contains fields needed by UI', async () => {
    const KV = makeKV();
    const AUTH_KV = makeAuthKV('tok-user-A-000000000000000000000000000');
    const env = { KV, PAYMENT_LINKS: KV, AUTH_KV, ALLOWED_ORIGINS: '*', RATE_LIMIT_KV: makeKV() };

    const res = await invoicePost({
      id: 'inv_test002fix1ui',
      recipient: '0xBBBB000000000000000000000000000000000BBB',
      amount: 15,
      chain: 'Arc Mainnet',
      token: 'USDC',
      label: 'Test Invoice',
    }, env);

    const json = await res.json();
    const link = json.link;
    // Fields the UI actually uses
    expect(link.id).toBeDefined();
    expect(link.recipient).toBeDefined();
    expect(link.amount).toBeDefined();
    expect(link.chain).toBeDefined();
    expect(link.chainId).toBeDefined();
    expect(link.token).toBeDefined();
    expect(link.status).toBeDefined();
  });
});

// ── Fix 2: ownership — KV stores userId; conflict protection ─────────────────

describe('Fix 2 — ownership per user', () => {
  it('invoice KV record stores userId from session', async () => {
    const KV = makeKV();
    const AUTH_KV = makeAuthKV('tok-user-A-000000000000000000000000000');
    const env = { KV, PAYMENT_LINKS: KV, AUTH_KV, ALLOWED_ORIGINS: '*', RATE_LIMIT_KV: makeKV() };

    await invoicePost({
      id: 'inv_ownership001',
      recipient: '0xBBBB000000000000000000000000000000000BBB',
      amount: 5,
    }, env);

    const stored = JSON.parse(KV._store['inv_ownership001']);
    expect(stored.userId).toBe('user-A');
    expect(stored.ownerEmail).toBe('a@test.com');
  });

  it('invoice creation fails with 409 when ID already belongs to another user', async () => {
    const KV = makeKV();
    // Pre-populate with a record owned by user-B
    KV._store['inv_conflict001'] = JSON.stringify({
      id: 'inv_conflict001',
      userId: 'user-B',
      status: 'Active',
      amount: 5,
      recipient: '0xCCCC000000000000000000000000000000000CCC',
    });

    const AUTH_KV = makeAuthKV('tok-user-A-000000000000000000000000000'); // user-A session
    const env = { KV, PAYMENT_LINKS: KV, AUTH_KV, ALLOWED_ORIGINS: '*', RATE_LIMIT_KV: makeKV() };

    const res = await invoicePost({
      id: 'inv_conflict001',
      recipient: '0xAAAA000000000000000000000000000000000AAA',
      amount: 5,
    }, env);

    expect(res.status).toBe(409);
  });

  it('legacy record (no userId) is blocked — orphan cannot be silently claimed', async () => {
    const KV = makeKV();
    KV._store['inv_legacy001'] = JSON.stringify({
      id: 'inv_legacy001',
      userId: null, // legacy orphan
      status: 'Active',
      amount: 3,
      recipient: '0xDDDD000000000000000000000000000000000DDD',
    });

    const AUTH_KV = makeAuthKV('tok-user-A-000000000000000000000000000');
    const env = { KV, PAYMENT_LINKS: KV, AUTH_KV, ALLOWED_ORIGINS: '*', RATE_LIMIT_KV: makeKV() };

    // user-A re-posting with same ID — must be BLOCKED because the orphan record
    // has userId=null which != user-A's userId, preventing silent ownership takeover.
    const res = await invoicePost({
      id: 'inv_legacy001',
      recipient: '0xEEEE000000000000000000000000000000000EEE',
      amount: 3,
    }, env);

    // Must be 409 — legacy orphan protected from reassignment.
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/conflict/i);
  });

  it('fail-closed: 503 when AUTH_KV absent and no DEV_AUTH_BYPASS', async () => {
    const KV = makeKV();
    const env = { KV, PAYMENT_LINKS: KV, ALLOWED_ORIGINS: '*', RATE_LIMIT_KV: makeKV() };
    // AUTH_KV intentionally absent

    const res = await invoicePost({
      id: 'inv_noauth001',
      recipient: '0xBBBB000000000000000000000000000000000BBB',
      amount: 1,
    }, env);

    expect(res.status).toBe(503);
  });

  it('fail-closed: 401 when no session token provided', async () => {
    const KV = makeKV();
    const AUTH_KV = makeKV(); // empty
    const env = { KV, PAYMENT_LINKS: KV, AUTH_KV, ALLOWED_ORIGINS: '*', RATE_LIMIT_KV: makeKV() };

    // Make a request with NO auth token
    const { onRequestPost } = await import('../functions/api/invoice.js');
    const req = makeRequest('POST', {
      id: 'inv_notoken001',
      recipient: '0xBBBB000000000000000000000000000000000BBB',
      amount: 1,
    }); // no opts.token
    const res = await onRequestPost({ request: req, env, params: {} });

    expect(res.status).toBe(401);
  });
});

// ── Fix 3: idempotency — sequential write + race guard ────────────────────────

describe('Fix 3 — txHash idempotency (sequential write)', () => {
  const CHAIN_ID = 5042;
  const TX = '0xabc0000000000000000000000000000000000000000000000000000000000001';

  function makeVerifiedLink(tokenId) {
    return {
      id: tokenId,
      status: 'Active',
      recipient: '0xBBBB000000000000000000000000000000000BBB',
      amount: 1,
      feeAmount: 0,
      token: 'USDC',
      chainId: CHAIN_ID,
      userId: 'user-A',
    };
  }

  it('second identical txHash on same token returns current state (idempotent)', async () => {
    const tokenId = 'pl_idempotent001';
    const idKey = `txused:${CHAIN_ID}:${TX.toLowerCase()}`;

    const KV = makeKV({
      [tokenId]: JSON.stringify(makeVerifiedLink(tokenId)),
      // Pre-populate as if first request already claimed it
      [idKey]: tokenId,
    });

    // Also pre-mark as Paid so re-read returns Paid state
    KV._store[tokenId] = JSON.stringify({
      ...makeVerifiedLink(tokenId),
      status: 'Paid',
      paidTx: TX,
      paidAt: new Date().toISOString(),
    });

    const env = { PAYMENT_LINKS: KV, ALLOWED_ORIGINS: '*', RATE_LIMIT_KV: makeKV() };
    const res = await paymentPost(tokenId, { txHash: TX, paidBy: '0x123' }, env);

    // Should return 409 (already Paid) — not create a duplicate
    expect([200, 409]).toContain(res.status);
  });

  it('same txHash on different token returns 409 conflict', async () => {
    const tokenA = 'pl_txconflict_A';
    const tokenB = 'pl_txconflict_B';
    const idKey = `txused:${CHAIN_ID}:${TX.toLowerCase()}`;

    const KV = makeKV({
      [tokenA]: JSON.stringify(makeVerifiedLink(tokenA)),
      [tokenB]: JSON.stringify(makeVerifiedLink(tokenB)),
      [idKey]: tokenA, // already claimed by token A
    });

    const env = { PAYMENT_LINKS: KV, ALLOWED_ORIGINS: '*', RATE_LIMIT_KV: makeKV() };
    const res = await paymentPost(tokenB, { txHash: TX, paidBy: '0x456' }, env);

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toMatch(/already used/i);
  });

  it('duplicate payment on already-Paid link returns 409', async () => {
    const tokenId = 'pl_alreadypaid001';
    const KV = makeKV({
      [tokenId]: JSON.stringify({ ...makeVerifiedLink(tokenId), status: 'Paid', paidTx: TX }),
    });

    const env = { PAYMENT_LINKS: KV, ALLOWED_ORIGINS: '*', RATE_LIMIT_KV: makeKV() };
    const res = await paymentPost(tokenId, { txHash: TX }, env);

    expect(res.status).toBe(409);
  });
});

// ── Fix 4: decimals from CHAIN_REGISTRY ──────────────────────────────────────

describe('Fix 4 — decimals from CHAIN_REGISTRY', () => {
  it('USDC on Arc Mainnet → 6 decimals', () => {
    const chain = RELAYER_CONFIG.CHAIN_REGISTRY[5042];
    expect(chain).toBeDefined();
    expect(chain.tokens['USDC'].decimals).toBe(6);
  });

  it('EURC on Arc Mainnet → 6 decimals', () => {
    const chain = RELAYER_CONFIG.CHAIN_REGISTRY[5042];
    expect(chain.tokens['EURC'].decimals).toBe(6);
  });

  it('CIRBTC on Arc Mainnet → 8 decimals', () => {
    const chain = RELAYER_CONFIG.CHAIN_REGISTRY[5042];
    expect(chain.tokens['CIRBTC'].decimals).toBe(8);
  });

  it('USDC on Base → 6 decimals', () => {
    const chain = RELAYER_CONFIG.CHAIN_REGISTRY[8453];
    expect(chain).toBeDefined();
    expect(chain.tokens['USDC'].decimals).toBe(6);
  });

  it('invoice with CIRBTC uses 8 decimals in stored record', async () => {
    const KV = makeKV();
    const AUTH_KV = makeAuthKV('tok-user-A-000000000000000000000000000');
    const env = { KV, PAYMENT_LINKS: KV, AUTH_KV, ALLOWED_ORIGINS: '*', RATE_LIMIT_KV: makeKV() };

    const res = await invoicePost({
      id: 'inv_cirbtc001',
      recipient: '0xBBBB000000000000000000000000000000000BBB',
      amount: 0.001,
      chain: 'Arc Mainnet',
      token: 'CIRBTC',
    }, env);

    expect(res.status).toBe(201);
    const stored = JSON.parse(KV._store['inv_cirbtc001']);
    expect(stored.tokenDecimals).toBe(8);
    expect(stored.token).toBe('CIRBTC');
  });

  it('invoice with USDC uses 6 decimals in stored record', async () => {
    const KV = makeKV();
    const AUTH_KV = makeAuthKV('tok-user-A-000000000000000000000000000');
    const env = { KV, PAYMENT_LINKS: KV, AUTH_KV, ALLOWED_ORIGINS: '*', RATE_LIMIT_KV: makeKV() };

    const res = await invoicePost({
      id: 'inv_usdc001dec',
      recipient: '0xBBBB000000000000000000000000000000000BBB',
      amount: 5,
      chain: 'Arc Mainnet',
      token: 'USDC',
    }, env);

    expect(res.status).toBe(201);
    const stored = JSON.parse(KV._store['inv_usdc001dec']);
    expect(stored.tokenDecimals).toBe(6);
  });

  it('invoice with EURC uses 6 decimals in stored record', async () => {
    const KV = makeKV();
    const AUTH_KV = makeAuthKV('tok-user-A-000000000000000000000000000');
    const env = { KV, PAYMENT_LINKS: KV, AUTH_KV, ALLOWED_ORIGINS: '*', RATE_LIMIT_KV: makeKV() };

    const res = await invoicePost({
      id: 'inv_eurc001dec',
      recipient: '0xBBBB000000000000000000000000000000000BBB',
      amount: 5,
      chain: 'Arc Mainnet',
      token: 'EURC',
    }, env);

    expect(res.status).toBe(201);
    const stored = JSON.parse(KV._store['inv_eurc001dec']);
    expect(stored.tokenDecimals).toBe(6);
  });

  it('payment-link with CIRBTC uses 8 decimals in stored record', async () => {
    const KV = makeKV();
    const AUTH_KV = makeAuthKV('tok-user-A-000000000000000000000000000');
    const env = { KV, PAYMENT_LINKS: KV, AUTH_KV, ALLOWED_ORIGINS: '*', RATE_LIMIT_KV: makeKV() };

    const res = await paymentLinksPost({
      recipient: '0xBBBB000000000000000000000000000000000BBB',
      amount: 0.001,
      type: 'fixed',
      chain: 'Arc Mainnet',
      token: 'CIRBTC',
    }, env);

    expect(res.status).toBe(201);
    const json = await res.json();
    const id = json.link.id;
    const stored = JSON.parse(KV._store[id]);
    expect(stored.tokenDecimals).toBe(8);
    expect(stored.token).toBe('CIRBTC');
  });

  it('payment-link with USDC on Base uses 6 decimals', async () => {
    const KV = makeKV();
    const AUTH_KV = makeAuthKV('tok-user-A-000000000000000000000000000');
    const env = { KV, PAYMENT_LINKS: KV, AUTH_KV, ALLOWED_ORIGINS: '*', RATE_LIMIT_KV: makeKV() };

    const res = await paymentLinksPost({
      recipient: '0xBBBB000000000000000000000000000000000BBB',
      amount: 10,
      type: 'fixed',
      chain: 'Base',
      token: 'USDC',
    }, env);

    expect(res.status).toBe(201);
    const json = await res.json();
    const id = json.link.id;
    const stored = JSON.parse(KV._store[id]);
    expect(stored.tokenDecimals).toBe(6);
    expect(stored.chainId).toBe(8453);
  });
});
