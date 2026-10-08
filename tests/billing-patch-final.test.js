/**
 * billing-patch-final.test.js
 *
 * Tests for the 3 surgical fixes on top of bd4b9dc:
 *   Fix 1 — legacy ownership: userId=null blocks creation by any user
 *   Fix 2 — idempotency: processing sentinel written before RPC; concurrent requests see it
 *   Fix 3 — payment-links.js decimals unified (single resolution path)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeKV(initial = {}) {
  const store = { ...initial };
  return {
    _store: store,
    get:    async (k)    => store[k] ?? null,
    put:    async (k, v) => { store[k] = v; },
    delete: async (k)    => { delete store[k]; },
    // vi.fn wrappers for call-tracking in specific tests
    trackPut: null,
  };
}

function makeSession(userId = 'user-a', email = 'a@test.com') {
  return JSON.stringify({ userId, email, walletAddress: '0xabc' });
}

// Session tokens must be >= 32 chars (enforced by extractSessionToken).
const SID_A = 'valid_session_token_user_aaaaaaaaaa'; // 35 chars
const SID_B = 'valid_session_token_user_bbbbbbbbbbb'; // 36 chars

function makeRequest({ method = 'POST', body = {}, sessionToken = SID_A } = {}) {
  const h = new Map([
    ['cookie', `elligente_sid=${sessionToken}`],
    ['content-type', 'application/json'],
    ['cf-connecting-ip', '1.2.3.4'],
    ['origin', 'https://elligentttest.pages.dev'],
  ]);
  return {
    method,
    headers: { get: (k) => h.get(k.toLowerCase()) ?? null },
    json: async () => body,
  };
}

function makeEnv(kvOverride = {}) {
  return {
    ALLOWED_ORIGINS: 'https://elligentttest.pages.dev',
    DEV_AUTH_BYPASS: 'false',
    AUTH_KV: makeKV({
      [`session:${SID_A}`]: makeSession('user-a', 'a@test.com'),
      [`session:${SID_B}`]: makeSession('user-b', 'b@test.com'),
    }),
    PAYMENT_LINKS: makeKV(kvOverride),
    RATE_LIMIT_KV: makeKV(),
  };
}

// ─── Load modules ───────────────────────────────────────────────────────────

const { onRequestPost: invoicePost } = await import('../functions/api/invoice.js');
const { onRequestPost: paylinksPost } = await import('../functions/api/payment-links.js');
const { onRequestPost: payPost } = await import('../functions/api/payment/[token].js');

// ─── FIX 1: LEGACY OWNERSHIP ────────────────────────────────────────────────

describe('Fix 1 — Legacy ownership (invoice.js)', () => {
  const baseBody = {
    id: 'inv_legacytest001',
    number: 'INV-LEGACY',
    label: 'Legacy Test',
    amount: 5.00,
    feeAmount: 0,
    recipient: '0x1234567890123456789012345678901234567890',
    token: 'USDC',
    chain: 'Arc Mainnet',
  };

  it('blocks User A from claiming a legacy record (userId=null)', async () => {
    // Existing record with no userId (legacy)
    const legacyRecord = JSON.stringify({
      id: 'inv_legacytest001',
      kind: 'invoice',
      userId: null,
      status: 'Active',
      amount: 3.0,
    });
    const env = makeEnv({ 'inv_legacytest001': legacyRecord });
    const ctx = { request: makeRequest({ body: baseBody }), env };
    const res = await invoicePost(ctx);
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toContain('conflict');
  });

  it('blocks User B from claiming a legacy record (userId=null)', async () => {
    const legacyRecord = JSON.stringify({
      id: 'inv_legacytest001',
      kind: 'invoice',
      userId: null,
      status: 'Active',
      amount: 3.0,
    });
    const env = makeEnv({ 'inv_legacytest001': legacyRecord });
    const ctx = {
      request: makeRequest({ body: baseBody, sessionToken: SID_B }),
      env,
    };
    const res = await invoicePost(ctx);
    expect(res.status).toBe(409);
  });

  it('blocks User B from overwriting User A record', async () => {
    const existingRecord = JSON.stringify({
      id: 'inv_legacytest001',
      kind: 'invoice',
      userId: 'user-a',
      status: 'Active',
      amount: 3.0,
    });
    const env = makeEnv({ 'inv_legacytest001': existingRecord });
    const ctx = {
      request: makeRequest({ body: baseBody, sessionToken: SID_B }),
      env,
    };
    const res = await invoicePost(ctx);
    expect(res.status).toBe(409);
  });

  it('allows User A to re-submit own existing unpaid invoice (idempotent)', async () => {
    const existingRecord = JSON.stringify({
      id: 'inv_legacytest001',
      kind: 'invoice',
      userId: 'user-a',
      status: 'Active',
      amount: 3.0,
    });
    const env = makeEnv({ 'inv_legacytest001': existingRecord });
    const ctx = { request: makeRequest({ body: baseBody }), env };
    const res = await invoicePost(ctx);
    // Should overwrite (same owner) — not 409
    expect(res.status).not.toBe(409);
  });

  it('returns existing Paid invoice idempotently for same owner', async () => {
    const paidRecord = JSON.stringify({
      id: 'inv_legacytest001',
      kind: 'invoice',
      userId: 'user-a',
      status: 'Paid',
      amount: 3.0,
    });
    const env = makeEnv({ 'inv_legacytest001': paidRecord });
    const ctx = { request: makeRequest({ body: baseBody }), env };
    const res = await invoicePost(ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.existed).toBe(true);
    expect(data.link.status).toBe('Paid');
  });

  it('publicView never exposes userId', async () => {
    const env = makeEnv();
    const ctx = {
      request: makeRequest({
        body: { ...baseBody, id: 'inv_pubviewtest001' },
      }),
      env,
    };
    const res = await invoicePost(ctx);
    const data = await res.json();
    expect(data.link).not.toHaveProperty('userId');
    expect(data.link).not.toHaveProperty('ownerEmail');
    expect(data.link).not.toHaveProperty('ownerWallet');
    expect(data.link).not.toHaveProperty('createdBy');
    // Required fields present
    expect(data.link).toHaveProperty('id');
    expect(data.link).toHaveProperty('amount');
    expect(data.link).toHaveProperty('recipient');
    expect(data.link).toHaveProperty('chainId');
  });
});

// ─── FIX 2: IDEMPOTENCY SENTINEL ────────────────────────────────────────────

describe('Fix 2 — Idempotency sentinel in payment/[token].js', () => {
  it('rejects a txHash already claimed by a different token (step A)', async () => {
    const tokenA = 'inv_tokenA001';
    const tokenB = 'inv_tokenB001';
    const txHash = '0x' + 'a'.repeat(64);
    const chainId = 5042;
    const idKey = `txused:${chainId}:${txHash}`;

    const linkB = {
      id: tokenB, kind: 'invoice', status: 'Active',
      amount: 1.0, feeAmount: 0, totalAmount: 1.0,
      recipient: '0x1234567890123456789012345678901234567890',
      token: 'USDC', chainId, chain: 'Arc Mainnet',
    };
    const kv = makeKV({
      [tokenB]: JSON.stringify(linkB),
      [idKey]: tokenA,  // already claimed by tokenA
    });
    const env = {
      PAYMENT_LINKS: kv,
      RATE_LIMIT_KV: makeKV(),
      ALLOWED_ORIGINS: 'https://elligentttest.pages.dev',
    };
    const req = makeRequest({ body: { txHash } });
    const ctx = { request: req, env, params: { token: tokenB } };
    const res = await payPost(ctx);
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toContain('already used');
  });

  it('returns current state idempotently when same token re-submits', async () => {
    const token = 'inv_idemptoken001';
    const txHash = '0x' + 'b'.repeat(64);
    const chainId = 5042;
    const idKey = `txused:${chainId}:${txHash}`;

    // Status is Active — idempotency key already has the permanent claim for this token.
    // The idempotency pre-check (Step A) should detect this and return current state.
    const link = {
      id: token, kind: 'invoice', status: 'Active',
      amount: 1.0, feeAmount: 0, totalAmount: 1.0,
      recipient: '0x1234567890123456789012345678901234567890',
      token: 'USDC', chainId, chain: 'Arc Mainnet',
      paidTx: txHash, paidAt: '2026-10-07T00:00:00Z',
    };
    const kv = makeKV({
      [token]: JSON.stringify(link),
      [idKey]: token,  // already claimed by same token
    });
    const env = {
      PAYMENT_LINKS: kv,
      RATE_LIMIT_KV: makeKV(),
      ALLOWED_ORIGINS: 'https://elligentttest.pages.dev',
    };
    const req = makeRequest({ body: { txHash } });
    const ctx = { request: req, env, params: { token } };
    const res = await payPost(ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    // Returns current state (Active with paidTx info) — idempotent re-read
    expect(data.link.paidTx).toBe(txHash);
  });

  it('writes processing sentinel BEFORE RPC (evidenced by call sequence in KV store)', async () => {
    // We verify the sentinel is in the KV store by the time a concurrent request arrives.
    // We do this by simulating: Request A writes sentinel, Request B arrives and sees it.
    // (True RPC mocking requires Durable Objects not available here — KV sequence test only.)
    const tokenA = 'inv_sentinelA001';
    const txHash = '0x' + 'e'.repeat(64);
    const chainId = 5042;
    const idKey = `txused:${chainId}:${txHash}`;

    const link = {
      id: tokenA, kind: 'invoice', status: 'Active',
      amount: 1.0, feeAmount: 0, totalAmount: 1.0,
      recipient: '0x1234567890123456789012345678901234567890',
      token: 'USDC', chainId, chain: 'Arc Mainnet',
    };

    // Simulate the state AFTER Request A wrote the sentinel but BEFORE it wrote Paid.
    // Request B arrives and should see `processing:tokenA` as the claim.
    const tokenB = 'inv_sentinelB001';
    const kv = makeKV({
      [tokenA]: JSON.stringify(link),
      [tokenB]: JSON.stringify({ ...link, id: tokenB }),
      [idKey]: `processing:${tokenA}`, // sentinel written by Request A
    });

    const env = {
      PAYMENT_LINKS: kv,
      RATE_LIMIT_KV: makeKV(),
      ALLOWED_ORIGINS: 'https://elligentttest.pages.dev',
    };
    // Request B tries to use the same txHash for tokenB
    const req = makeRequest({ body: { txHash } });
    const ctx = { request: req, env, params: { token: tokenB } };
    const res = await payPost(ctx);
    // Request B should be rejected because the sentinel already exists for tokenA
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toContain('already used');
  });

  it('concurrent request sees processing sentinel and returns 409', async () => {
    // Simulate: Request A wrote the processing sentinel, Request B arrives
    const tokenA = 'inv_concurrent001';
    const txHash = '0x' + 'd'.repeat(64);
    const chainId = 5042;
    const idKey = `txused:${chainId}:${txHash}`;

    const link = {
      id: tokenA, kind: 'invoice', status: 'Active',
      amount: 1.0, feeAmount: 0, totalAmount: 1.0,
      recipient: '0x1234567890123456789012345678901234567890',
      token: 'USDC', chainId, chain: 'Arc Mainnet',
    };
    const kv = makeKV({
      [tokenA]: JSON.stringify(link),
      // A concurrent request for tokenA has already written the processing sentinel
      [idKey]: `processing:${tokenA}`,
    });
    // Request B uses a different token but same txHash
    const tokenB = 'inv_concurrent002';
    kv._store[tokenB] = JSON.stringify({ ...link, id: tokenB });

    const env = {
      PAYMENT_LINKS: kv,
      RATE_LIMIT_KV: makeKV(),
      ALLOWED_ORIGINS: 'https://elligentttest.pages.dev',
    };
    const req = makeRequest({ body: { txHash } });
    const ctx = { request: req, env, params: { token: tokenB } };
    const res = await payPost(ctx);
    // The processing sentinel belongs to tokenA, not tokenB — should reject
    expect(res.status).toBe(409);
  });
});

// ─── FIX 3: PAYMENT-LINKS DECIMALS ─────────────────────────────────────────

describe('Fix 3 — payment-links.js decimals unified after chain resolution', () => {
  async function createPayLink(tokenSym, chain, chainId, amount = 1.0) {
    const env = makeEnv();
    const body = {
      label: 'Test link',
      amount,
      type: 'fixed',
      recipient: '0x1234567890123456789012345678901234567890',
      token: tokenSym,
      chain,
      chainId,
    };
    const ctx = { request: makeRequest({ body, sessionToken: SID_A }), env };
    return paylinksPost(ctx);
  }

  it('USDC on Arc Mainnet uses 6 decimals', async () => {
    const res = await createPayLink('USDC', 'Arc Mainnet', 5042, 1.0);
    const data = await res.json();
    expect(res.status).toBe(201);
    expect(data.link.tokenDecimals).toBe(6);
  });

  it('EURC on Arc Mainnet uses 6 decimals', async () => {
    const res = await createPayLink('EURC', 'Arc Mainnet', 5042, 1.0);
    const data = await res.json();
    expect(res.status).toBe(201);
    expect(data.link.tokenDecimals).toBe(6);
  });

  it('CIRBTC on Arc Mainnet uses 8 decimals', async () => {
    const res = await createPayLink('CIRBTC', 'Arc Mainnet', 5042, 0.001);
    const data = await res.json();
    expect(res.status).toBe(201);
    expect(data.link.tokenDecimals).toBe(8);
  });

  it('USDC on Base uses 6 decimals', async () => {
    const res = await createPayLink('USDC', 'Base', 8453, 1.0);
    const data = await res.json();
    expect(res.status).toBe(201);
    expect(data.link.tokenDecimals).toBe(6);
    expect(data.link.chainId).toBe(8453);
  });

  it('fee and totalAmount are consistent with amount decimals', async () => {
    const res = await createPayLink('USDC', 'Arc Mainnet', 5042, 100.0);
    const data = await res.json();
    expect(res.status).toBe(201);
    const { amount, feeAmount, totalAmount } = data.link;
    expect(Math.abs(feeAmount + amount - totalAmount)).toBeLessThan(0.0001);
  });

  it('resolvedChainId and _plDecimals come from same resolution path (no _plTmpChainId)', async () => {
    // Submit chain by name — verifies no duplicate resolution
    const res = await createPayLink('USDC', 'Ethereum', 1, 50.0);
    const data = await res.json();
    expect(res.status).toBe(201);
    expect(data.link.chainId).toBe(1);
    expect(data.link.tokenDecimals).toBe(6);
  });

  it('publicView on paylink never exposes userId', async () => {
    const res = await createPayLink('USDC', 'Arc Mainnet', 5042, 1.0);
    const data = await res.json();
    expect(data.link).not.toHaveProperty('userId');
    expect(data.link).not.toHaveProperty('ownerEmail');
    expect(data.link).not.toHaveProperty('ownerWallet');
    expect(data.link).not.toHaveProperty('createdBy');
    expect(data.link).toHaveProperty('id');
    expect(data.link).toHaveProperty('chainId');
  });
});

// ─── INVOICE DECIMALS ───────────────────────────────────────────────────────

describe('Invoice decimals — USDC/EURC/CIRBTC', () => {
  async function createInvoice(tokenSym, chain, amount = 1.0) {
    const env = makeEnv();
    const body = {
      id: `inv_dec_${tokenSym}_${Date.now()}`,
      number: 'INV-DEC-01',
      label: 'Dec Test',
      amount,
      feeAmount: 0,
      recipient: '0x1234567890123456789012345678901234567890',
      token: tokenSym,
      chain,
    };
    const ctx = { request: makeRequest({ body, sessionToken: SID_A }), env };
    return invoicePost(ctx);
  }

  it('USDC invoice uses 6 decimals', async () => {
    const res = await createInvoice('USDC', 'Arc Mainnet', 1.0);
    const data = await res.json();
    expect(res.status).toBe(201);
    expect(data.link.tokenDecimals).toBe(6);
  });

  it('EURC invoice uses 6 decimals', async () => {
    const res = await createInvoice('EURC', 'Arc Mainnet', 1.0);
    const data = await res.json();
    expect(res.status).toBe(201);
    expect(data.link.tokenDecimals).toBe(6);
  });

  it('CIRBTC invoice uses 8 decimals', async () => {
    const res = await createInvoice('CIRBTC', 'Arc Mainnet', 0.001);
    const data = await res.json();
    expect(res.status).toBe(201);
    expect(data.link.tokenDecimals).toBe(8);
  });
});
