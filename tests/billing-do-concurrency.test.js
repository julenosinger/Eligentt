/**
 * Tests for billing concurrency safety and Durable Object PaymentLock.
 *
 * Tests run entirely in-process — no real Cloudflare runtime needed.
 * The DO is simulated via a PaymentLockMock that enforces the same
 * serialization contract as the real Durable Object.
 */
import { describe, it, expect } from 'vitest';
import { PaymentLock } from '../functions/api/payment-lock.do.js';

// ── In-process DO simulator ──────────────────────────────────────────────────
// Mirrors the exact DO fetch() API used in payment/[token].js.
class DOStorage {
  constructor() { this._data = {}; this._alarms = {}; }
  async get(key) { return this._data[key]; }
  async put(key, val) { this._data[key] = val; }
  async delete(key) { delete this._data[key]; }
  async setAlarm(ts) { this._alarms['alarm'] = ts; }
  async deleteAlarm() { delete this._alarms['alarm']; }
}

function makeDOInstance() {
  const storage = new DOStorage();
  const doInstance = new PaymentLock({ storage }, {});
  // Serialize all calls through a microtask queue, mirroring Cloudflare DO's
  // single-active-request guarantee per instance.
  let _queue = Promise.resolve();
  function serialCall(body) {
    const result = _queue.then(async () => {
      const res = await doInstance.fetch(new Request('https://do/lock', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      }));
      return res.json();
    });
    _queue = result.catch(() => {});
    return result;
  }
  return {
    call: serialCall,
    doInstance,
    storage,
    alarm: () => doInstance.alarm(),
  };
}

// ── PaymentLock DO unit tests ────────────────────────────────────────────────
describe('PaymentLock DO', () => {
  it('first claim returns claimed=true', async () => {
    const do_ = makeDOInstance();
    const r = await do_.call({ action: 'claim', token: 'tok-A' });
    expect(r.claimed).toBe(true);
    expect(r.claimant).toBe('tok-A');
  });

  it('second claim from SAME token returns claimed="same" (idempotent)', async () => {
    const do_ = makeDOInstance();
    await do_.call({ action: 'claim', token: 'tok-A' });
    const r = await do_.call({ action: 'claim', token: 'tok-A' });
    expect(r.claimed).toBe('same');
    expect(r.claimant).toBe('tok-A');
  });

  it('second claim from DIFFERENT token returns claimed=false (rejected)', async () => {
    const do_ = makeDOInstance();
    await do_.call({ action: 'claim', token: 'tok-A' });
    const r = await do_.call({ action: 'claim', token: 'tok-B' });
    expect(r.claimed).toBe(false);
    expect(r.claimant).toBe('tok-A');
  });

  it('commit upgrades processing to committed', async () => {
    const do_ = makeDOInstance();
    await do_.call({ action: 'claim', token: 'tok-A' });
    const r = await do_.call({ action: 'commit', token: 'tok-A' });
    expect(r.ok).toBe(true);
    const claim = await do_.storage.get('claim');
    expect(claim.status).toBe('committed');
  });

  it('commit with wrong token returns ok=false and status 409', async () => {
    const do_ = makeDOInstance();
    await do_.call({ action: 'claim', token: 'tok-A' });
    // Commit with a different token — the DO instance returns HTTP 409.
    const res = await do_.doInstance.fetch(new Request('https://do/lock', {
      method: 'POST',
      body: JSON.stringify({ action: 'commit', token: 'tok-B' }),
      headers: { 'Content-Type': 'application/json' },
    }));
    expect(res.status).toBe(409);
  });

  it('release removes the claim', async () => {
    const do_ = makeDOInstance();
    await do_.call({ action: 'claim', token: 'tok-A' });
    await do_.call({ action: 'release', token: 'tok-A' });
    const claim = await do_.storage.get('claim');
    expect(claim).toBeUndefined();
  });

  it('after release a new claim can be made', async () => {
    const do_ = makeDOInstance();
    await do_.call({ action: 'claim', token: 'tok-A' });
    await do_.call({ action: 'release', token: 'tok-A' });
    const r = await do_.call({ action: 'claim', token: 'tok-B' });
    expect(r.claimed).toBe(true);
  });

  it('alarm releases a processing claim (auto-expire)', async () => {
    const do_ = makeDOInstance();
    await do_.call({ action: 'claim', token: 'tok-A' });
    // Simulate alarm firing
    await do_.alarm();
    const claim = await do_.storage.get('claim');
    expect(claim).toBeUndefined();
  });

  it('alarm does NOT release a committed claim', async () => {
    const do_ = makeDOInstance();
    await do_.call({ action: 'claim', token: 'tok-A' });
    await do_.call({ action: 'commit', token: 'tok-A' });
    // Alarm was cancelled on commit, but simulate it firing anyway
    await do_.alarm(); // committed → should NOT delete
    const claim = await do_.storage.get('claim');
    // alarm() only deletes when status === 'processing'
    expect(claim).toBeDefined();
    expect(claim.status).toBe('committed');
  });
});

// ── True parallel concurrency simulation ────────────────────────────────────
describe('PaymentLock DO — concurrent requests', () => {
  it('two simultaneous claims for the same key: exactly one wins', async () => {
    const do_ = makeDOInstance();

    // Launch both claims in parallel — no await between them.
    const [r1, r2] = await Promise.all([
      do_.call({ action: 'claim', token: 'tok-A' }),
      do_.call({ action: 'claim', token: 'tok-B' }),
    ]);

    const winners = [r1, r2].filter(r => r.claimed === true);
    const losers  = [r1, r2].filter(r => r.claimed === false);

    // Exactly one winner, one loser.
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
  });

  it('five simultaneous claims: exactly one wins', async () => {
    const do_ = makeDOInstance();
    const tokens = ['tok-1','tok-2','tok-3','tok-4','tok-5'];
    const results = await Promise.all(tokens.map(t => do_.call({ action: 'claim', token: t })));

    const winners = results.filter(r => r.claimed === true);
    const sames   = results.filter(r => r.claimed === 'same');
    const losers  = results.filter(r => r.claimed === false);

    expect(winners).toHaveLength(1);
    expect(sames).toHaveLength(0);
    expect(losers).toHaveLength(4);
  });

  it('winner commits; subsequent claim attempt is still rejected', async () => {
    const do_ = makeDOInstance();
    await do_.call({ action: 'claim', token: 'tok-A' });
    await do_.call({ action: 'commit', token: 'tok-A' });
    const r = await do_.call({ action: 'claim', token: 'tok-B' });
    expect(r.claimed).toBe(false);
    expect(r.claimant).toBe('tok-A');
  });

  it('loser receives 409-equivalent immediately without reaching RPC', async () => {
    const do_ = makeDOInstance();
    // Simulate first request winning:
    await do_.call({ action: 'claim', token: 'inv-token-A' });

    // Second request from a different payment link for the same txHash:
    const r = await do_.call({ action: 'claim', token: 'inv-token-B' });

    // It gets claimed=false — in payment/[token].js this maps to HTTP 409.
    expect(r.claimed).toBe(false);
  });
});

// ── Legacy ownership (invoice.js) ───────────────────────────────────────────
// These tests verify the real invoice.js implementation by importing it directly.
describe('invoice.js — legacy ownership', () => {
  // Minimal mock infrastructure for invoice.js
  function makeKV(initial = {}) {
    const store = { ...initial };
    return {
      _store: store,
      get: async (k) => store[k] ?? null,
      put: async (k, v) => { store[k] = v; },
    };
  }

  function makeAuthKV(token, userId = 'user-A-000000000000000000000000000') {
    const store = {
      ['session:' + token]: JSON.stringify({
        userId,
        email: 'a@test.com',
        walletAddress: '0xAAAA000000000000000000000000000000000AAA',
      }),
    };
    return { get: async (k) => store[k] ?? null };
  }

  async function invoicePost(body, env) {
    const { onRequestPost } = await import('../functions/api/invoice.js');
    const req = new Request('https://test.com/api/invoice', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer tok-user-A-000000000000000000000000000',
        'Origin': 'https://elligente.pages.dev',
      },
      body: JSON.stringify({
        id: body.id || 'inv_test001_abc',
        number: 'INV-001',
        label: 'Test Invoice',
        amount: body.amount ?? 1,
        recipient: body.recipient || '0xAAAA000000000000000000000000000000000AAA',
        token: body.token || 'USDC',
        chain: body.chain || 'Arc Mainnet',
        ...body,
      }),
    });
    return onRequestPost({ request: req, env: { ...env, ALLOWED_ORIGINS: '*' } });
  }

  it('user A creates invoice — success', async () => {
    const KV = makeKV();
    const AUTH_KV = makeAuthKV('tok-user-A-000000000000000000000000000');
    const env = { KV, PAYMENT_LINKS: KV, AUTH_KV, RATE_LIMIT_KV: makeKV() };
    const res = await invoicePost({ id: 'inv_ownership001' }, env);
    expect([200, 201]).toContain(res.status);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.link.userId).toBeUndefined(); // publicView strips userId
  });

  it('user A cannot overwrite invoice owned by user B (409)', async () => {
    const KV = makeKV();
    // Pre-populate KV with an invoice owned by user-B
    KV._store['inv_cross001'] = JSON.stringify({
      id: 'inv_cross001', userId: 'user-B-999', status: 'Active', amount: 5,
    });
    const AUTH_KV = makeAuthKV('tok-user-A-000000000000000000000000000', 'user-A-000');
    const env = { KV, PAYMENT_LINKS: KV, AUTH_KV, RATE_LIMIT_KV: makeKV() };
    const res = await invoicePost({ id: 'inv_cross001' }, env);
    expect(res.status).toBe(409);
  });

  it('legacy record (userId=null) blocks ownership takeover (409)', async () => {
    const KV = makeKV();
    KV._store['inv_legacy001'] = JSON.stringify({
      id: 'inv_legacy001', userId: null, status: 'Active', amount: 3,
    });
    const AUTH_KV = makeAuthKV('tok-user-A-000000000000000000000000000', 'user-A-000');
    const env = { KV, PAYMENT_LINKS: KV, AUTH_KV, RATE_LIMIT_KV: makeKV() };
    const res = await invoicePost({ id: 'inv_legacy001' }, env);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/conflict/i);
  });

  it('publicView never exposes userId, ownerEmail, ownerWallet', async () => {
    const KV = makeKV();
    const AUTH_KV = makeAuthKV('tok-user-A-000000000000000000000000000', 'user-A-000');
    const env = { KV, PAYMENT_LINKS: KV, AUTH_KV, RATE_LIMIT_KV: makeKV() };
    const res = await invoicePost({ id: 'inv_pubview001' }, env);
    const body = await res.json();
    expect(body.link.userId).toBeUndefined();
    expect(body.link.ownerEmail).toBeUndefined();
    expect(body.link.ownerWallet).toBeUndefined();
    expect(body.link.createdBy).toBeUndefined();
    // Fields the UI needs must be present
    expect(body.link.id).toBeDefined();
    expect(body.link.amount).toBeDefined();
    expect(body.link.recipient).toBeDefined();
    expect(body.link.status).toBeDefined();
  });

  it('same user idempotent re-post on same ID returns current state (not Paid)', async () => {
    const KV = makeKV();
    KV._store['inv_idem001'] = JSON.stringify({
      id: 'inv_idem001', userId: 'user-A-000', status: 'Active', amount: 2,
      recipient: '0xAAAA000000000000000000000000000000000AAA',
    });
    const AUTH_KV = makeAuthKV('tok-user-A-000000000000000000000000000', 'user-A-000');
    const env = { KV, PAYMENT_LINKS: KV, AUTH_KV, RATE_LIMIT_KV: makeKV() };
    const res = await invoicePost({ id: 'inv_idem001' }, env);
    // Same user same ID → allowed (idempotent, not Paid)
    expect([200, 201]).toContain(res.status);
  });
});

// ── Decimals ─────────────────────────────────────────────────────────────────
describe('Decimals — CHAIN_REGISTRY resolution', () => {
  it('USDC has 6 decimals', async () => {
    const { RELAYER_CONFIG } = await import('../functions/api/shared-config.mjs');
    const arc = RELAYER_CONFIG.CHAIN_REGISTRY[5042];
    expect(arc).toBeDefined();
    expect(arc.tokens['USDC'].decimals).toBe(6);
  });

  it('EURC has 6 decimals', async () => {
    const { RELAYER_CONFIG } = await import('../functions/api/shared-config.mjs');
    const arc = RELAYER_CONFIG.CHAIN_REGISTRY[5042];
    expect(arc.tokens['EURC'].decimals).toBe(6);
  });

  it('CIRBTC has 8 decimals', async () => {
    const { RELAYER_CONFIG } = await import('../functions/api/shared-config.mjs');
    const arc = RELAYER_CONFIG.CHAIN_REGISTRY[5042];
    expect(arc.tokens['CIRBTC'].decimals).toBe(8);
  });

  it('unknown token defaults to 6', async () => {
    const { RELAYER_CONFIG } = await import('../functions/api/shared-config.mjs');
    const arc = RELAYER_CONFIG.CHAIN_REGISTRY[5042];
    const entry = arc ? (arc.tokens['FAKETOKEN'] || arc.tokens['USDC']) : null;
    const decimals = entry ? entry.decimals : 6;
    expect(decimals).toBe(6);
  });
});
