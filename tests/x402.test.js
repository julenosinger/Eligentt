/**
 * x402 integration tests (Phase 1 — infrastructure, discovery, validation,
 * authorization gating). Proves:
 *   1. PAYMENT-REQUIRED parsing (base64 JSON header, raw JSON, body fallback).
 *   2. Requirement normalisation (v2 + legacy v1 field fallback, CAIP-2).
 *   3. Requirement validation (scheme, network, EIP-3009, asset, payTo,
 *      amount, max-price, timeout) — including Arc Mainnet being blocked
 *      because its native USDC EIP-3009 compatibility is unconfirmed.
 *   4. SSRF guard (private IP / localhost blocked, public https allowed).
 *   5. /api/x402/status reports `disabled` by default (no fake activation).
 *   6. /api/x402/discover detects 402 and returns normalised requirements.
 *   7. /api/x402/prepare blocks payments (disabled flag, wallet, network).
 *   8. /api/x402/pay is fail-closed (503) — no simulated settlement.
 *   9. requirementId is deterministic (dedup / replay protection basis).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  parsePaymentRequired,
  normalizePaymentRequired,
  validateRequirement,
  normalizeNetwork,
  requirementId,
  assertSafeTarget,
  X402_NETWORKS,
  HEADER_PAYMENT_REQUIRED,
} from '../functions/api/x402/_x402.mjs';
import { onRequest } from '../functions/api/x402/index.js';

/* ── helpers ─────────────────────────────────────────────────────────── */

function b64(obj) { return btoa(JSON.stringify(obj)); }

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // Base USDC
const PAYER = '0x' + 'ab'.repeat(20);
const PAYTO = '0x' + 'cd'.repeat(20);
const TOKEN = 'abc123'.repeat(6); // 36 chars
const EMAIL = 'alice@example.com';
const USER_ID = 'user-1111';

function paymentRequired(over = {}) {
  return {
    x402Version: 2,
    error: 'PAYMENT-SIGNATURE header is required',
    resource: { url: 'https://api.example.com/premium', description: 'Premium data', serviceName: 'Example' },
    accepts: [{
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '10000',
      asset: USDC_BASE,
      payTo: PAYTO,
      maxTimeoutSeconds: 60,
      extra: { name: 'USDC', version: '2' },
    }],
    ...over,
  };
}

function makeKV(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    async get(k) { return map.has(k) ? map.get(k) : null; },
    async put(k, v) { map.set(k, v); return true; },
    async delete(k) { map.delete(k); return true; },
    _map: map,
  };
}

function makeEnv(over = {}) {
  return {
    AUTH_KV: makeKV({
      ['session:' + TOKEN]: JSON.stringify({ userId: USER_ID, email: EMAIL }),
      ['user:' + EMAIL]: JSON.stringify({ id: USER_ID, circleWalletId: 'w1', circleWalletAddress: PAYER }),
    }),
    CIRCLE_API_KEY: '',
    CIRCLE_ENTITY_SECRET: '',
    ...over,
  };
}

function req(path, { method = 'GET', body, token = TOKEN } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  return new Request('https://app.local' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

async function jsonOf(response) {
  return response.json();
}

/* ── pure helpers ────────────────────────────────────────────────────── */

describe('x402 _x402.mjs helpers', () => {
  it('normalizeNetwork accepts CAIP-2 and legacy slugs', () => {
    expect(normalizeNetwork('eip155:8453')).toBe('eip155:8453');
    expect(normalizeNetwork('base')).toBe('eip155:8453');
    expect(normalizeNetwork('base-sepolia')).toBe('eip155:84532');
    expect(normalizeNetwork('arc')).toBe('eip155:5042');
    expect(normalizeNetwork('polygon-pos')).toBe('eip155:137');
    expect(normalizeNetwork('nope:1')).toBeNull();
  });

  it('parses base64 JSON PAYMENT-REQUIRED header', () => {
    const pr = paymentRequired();
    const res = parsePaymentRequired(b64(pr), null);
    expect(res.ok).toBe(true);
    expect(res.paymentRequired.accepts[0].network).toBe('eip155:8453');
  });

  it('parses raw JSON header and JSON body fallback', () => {
    const pr = paymentRequired();
    expect(parsePaymentRequired(JSON.stringify(pr), null).ok).toBe(true);
    expect(parsePaymentRequired(null, JSON.stringify(pr)).ok).toBe(true);
  });

  it('fails closed on garbage', () => {
    expect(parsePaymentRequired('!!!not-json!!!', 'also not json').ok).toBe(false);
    expect(parsePaymentRequired(null, null).ok).toBe(false);
  });

  it('normalises v2 PaymentRequired', () => {
    const norm = normalizePaymentRequired(paymentRequired());
    expect(norm.ok).toBe(true);
    expect(norm.resource.serviceName).toBe('Example');
    expect(norm.requirements[0].amount).toBe('10000');
    expect(norm.requirements[0].network).toBe('eip155:8453');
  });

  it('normalises legacy v1 field names (maxAmountRequired + slug) within v2', () => {
    const legacy = {
      scheme: 'exact', network: 'base', maxAmountRequired: '5000', payTo: PAYTO,
      asset: USDC_BASE, maxTimeoutSeconds: 30, extra: { name: 'USDC', version: '2' },
    };
    const norm = normalizePaymentRequired({ x402Version: 2, accepts: [legacy] });
    expect(norm.ok).toBe(true);
    expect(norm.requirements[0].amount).toBe('5000');
    expect(norm.requirements[0].network).toBe('eip155:8453');
  });

  it('rejects a missing x402 version', () => {
    const legacy = { scheme: 'exact', network: 'base', amount: '5000', payTo: PAYTO, asset: USDC_BASE, extra: { name: 'USDC', version: '2' } };
    expect(normalizePaymentRequired({ accepts: [legacy] }).ok).toBe(false);
  });

  it('rejects unsupported x402 version', () => {
    expect(normalizePaymentRequired(paymentRequired({ x402Version: 3 })).ok).toBe(false);
  });

  it('validates a Base USDC requirement as fully passable (except payment gate)', () => {
    const req0 = normalizePaymentRequired(paymentRequired()).requirements[0];
    const v = validateRequirement(req0);
    const names = v.checks.map((c) => c.name);
    // Everything structural passes; only the "payments_enabled"/"settlement" flags are external.
    expect(names).toEqual(expect.arrayContaining(['scheme', 'network_supported', 'network_eip3009', 'asset_known', 'asset_domain_name', 'asset_domain_version', 'asset_transfer_method', 'payto_valid', 'amount_valid', 'amount_within_max', 'timeout_valid']));
    expect(v.ok).toBe(true);
    expect(v.amountUsd).toBeCloseTo(0.01, 5);
    expect(v.asset).toBe('USDC');
    expect(v.decimals).toBe(6);
  });

  it('rejects a token falsely named "USDC" with an untrusted contract address', () => {
    const fake = {
      scheme: 'exact', network: 'eip155:8453', amount: '10000',
      asset: '0x' + '99'.repeat(20), payTo: PAYTO, maxTimeoutSeconds: 60,
      extra: { name: 'USDC', version: '2' },
    };
    const v = validateRequirement(fake);
    expect(v.ok).toBe(false);
    expect(v.checks.find((c) => c.name === 'asset_known').passed).toBe(false);
  });

  it('rejects a USDC named token on the wrong network (address/network mismatch)', () => {
    // Base USDC address but claimed on Polygon PoS → asset_known must fail.
    const wrongNet = {
      scheme: 'exact', network: 'eip155:137', amount: '10000',
      asset: USDC_BASE, payTo: PAYTO, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' },
    };
    const v = validateRequirement(wrongNet);
    expect(v.checks.find((c) => c.name === 'asset_known').passed).toBe(false);
  });

  it('blocks Arc Mainnet (EIP-3009 unconfirmed)', () => {
    const arcReq = {
      scheme: 'exact', network: 'eip155:5042', amount: '10000', asset: '0x3600000000000000000000000000000000000000',
      payTo: PAYTO, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' },
    };
    const v = validateRequirement(arcReq);
    expect(v.ok).toBe(false);
    const eip = v.checks.find((c) => c.name === 'network_eip3009');
    expect(eip.passed).toBe(false);
  });

  it('blocks unsupported network, non-USDC asset, bad payTo, zero amount, over-max amount', () => {
    const base = { scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: USDC_BASE, payTo: PAYTO, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' } };
    expect(validateRequirement({ ...base, network: 'eip155:1' }).ok).toBe(false);
    expect(validateRequirement({ ...base, extra: { name: 'EURC', version: '2' } }).ok).toBe(false);
    expect(validateRequirement({ ...base, payTo: '0x1234' }).ok).toBe(false);
    expect(validateRequirement({ ...base, amount: '0' }).ok).toBe(false);
    expect(validateRequirement({ ...base, amount: String(100 * 1e6) }).ok).toBe(false); // $100 > $25 max
  });

  it('produces a deterministic requirementId', () => {
    const req0 = normalizePaymentRequired(paymentRequired()).requirements[0];
    expect(requirementId('https://api.example.com/premium', req0)).toBe(requirementId('https://api.example.com/premium', req0));
  });

  it('SSRF guard blocks private/loopback and allows public https', () => {
    expect(assertSafeTarget('https://api.example.com/x').ok).toBe(true);
    expect(assertSafeTarget('http://127.0.0.1/x').ok).toBe(false);
    expect(assertSafeTarget('http://169.254.169.254/latest/meta-data').ok).toBe(false);
    expect(assertSafeTarget('http://localhost:3000/x').ok).toBe(false);
    expect(assertSafeTarget('http://192.168.1.1/x').ok).toBe(false);
    expect(assertSafeTarget('ftp://example.com').ok).toBe(false);
    expect(assertSafeTarget('https://api.example.com/x', ['api.example.com']).ok).toBe(true);
    expect(assertSafeTarget('https://evil.com/x', ['api.example.com']).ok).toBe(false);
  });
});

/* ── HTTP endpoints ──────────────────────────────────────────────────── */

describe('x402 /api/x402 endpoints', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => { globalThis.fetch = vi.fn(); });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('GET /status reports disabled by default (no fake activation)', async () => {
    const res = await onRequest({ request: req('/api/x402/status', { token: null }), env: makeEnv() });
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.state).toBe('disabled');
    expect(data.enabled).toBe(false);
    expect(data.networks).toEqual(expect.arrayContaining([
      expect.objectContaining({ caip: 'eip155:5042', eip3009Compatible: false }),
    ]));
  });

  it('GET /status never claims settlement available even when X402_ENABLED=true', async () => {
    const res = await onRequest({ request: req('/api/x402/status', { token: null }), env: makeEnv({ X402_ENABLED: 'true', CIRCLE_API_KEY: 'k', CIRCLE_ENTITY_SECRET: 's' }) });
    const data = await res.json();
    expect(data.enabled).toBe(true);
    expect(data.state).toBe('settlement_unavailable');
    expect(data.settlement.available).toBe(false);
    expect(data.discovery.available).toBe(true);
  });

  it('POST /discover detects 402 and returns normalised requirements', async () => {
    const pr = paymentRequired();
    globalThis.fetch.mockResolvedValueOnce(new Response('{}', {
      status: 402,
      headers: { 'Content-Type': 'application/json', [HEADER_PAYMENT_REQUIRED]: b64(pr) },
    }));
    const res = await onRequest({ request: req('/api/x402/discover', { method: 'POST', body: { url: 'https://api.example.com/premium' } }), env: makeEnv() });
    const data = await jsonOf(res);
    expect(data.ok).toBe(true);
    expect(data.status).toBe(402);
    expect(data.x402).toBe(true);
    expect(data.requirements.length).toBe(1);
    expect(data.requirements[0].amountUsd).toBeCloseTo(0.01, 5);
  });

  it('POST /discover returns no requirements on 200', async () => {
    globalThis.fetch.mockResolvedValueOnce(new Response('ok', { status: 200, headers: {} }));
    const res = await onRequest({ request: req('/api/x402/discover', { method: 'POST', body: { url: 'https://api.example.com/free' } }), env: makeEnv() });
    const data = await jsonOf(res);
    expect(data.ok).toBe(true);
    expect(data.x402).toBe(false);
    expect(data.requirements).toEqual([]);
  });

  it('POST /discover blocks private targets (SSRF)', async () => {
    const res = await onRequest({ request: req('/api/x402/discover', { method: 'POST', body: { url: 'http://169.254.169.254/latest' } }), env: makeEnv() });
    const data = await jsonOf(res);
    expect(res.status).toBe(400);
    expect(data.error).toMatch(/blocked/i);
  });

  it('POST /discover blocks redirects to private destinations (SSRF re-validation)', async () => {
    globalThis.fetch.mockResolvedValueOnce(new Response('', { status: 302, headers: { Location: 'http://169.254.169.254/latest' } }));
    const res = await onRequest({ request: req('/api/x402/discover', { method: 'POST', body: { url: 'https://api.example.com/redirect' } }), env: makeEnv() });
    const data = await jsonOf(res);
    expect(res.status).toBe(502);
    expect(data.error).toMatch(/blocked/i);
  });

  it('POST /discover follows a safe redirect and still detects 402', async () => {
    const pr = paymentRequired();
    globalThis.fetch
      .mockResolvedValueOnce(new Response('', { status: 302, headers: { Location: 'https://api.example.com/final' } }))
      .mockResolvedValueOnce(new Response('{}', { status: 402, headers: { 'Content-Type': 'application/json', [HEADER_PAYMENT_REQUIRED]: b64(pr) } }));
    const res = await onRequest({ request: req('/api/x402/discover', { method: 'POST', body: { url: 'https://api.example.com/start' } }), env: makeEnv() });
    const data = await jsonOf(res);
    expect(data.ok).toBe(true);
    expect(data.status).toBe(402);
    expect(data.x402).toBe(true);
  });

  it('POST /discover requires a session', async () => {
    const res = await onRequest({ request: req('/api/x402/discover', { method: 'POST', token: null, body: { url: 'https://api.example.com/x' } }), env: makeEnv() });
    expect(res.status).toBe(401);
  });

  it('POST /prepare blocks payment because x402 is disabled (Phase 1)', async () => {
    const req0 = normalizePaymentRequired(paymentRequired()).requirements[0];
    const res = await onRequest({
      request: req('/api/x402/prepare', { method: 'POST', body: { resourceUrl: 'https://api.example.com/premium', requirement: req0 } }),
      env: makeEnv(),
    });
    const data = await jsonOf(res);
    expect(data.ok).toBe(true);
    expect(data.enabled).toBe(false);
    expect(data.intent.status).toBe('blocked');
    expect(data.intent.blockedCheck).toBe('payments_enabled');
  });

  it('POST /prepare blocks Arc network even if the flag were on', async () => {
    const arcReq = {
      scheme: 'exact', network: 'eip155:5042', amount: '10000', asset: '0x3600000000000000000000000000000000000000',
      payTo: PAYTO, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' },
    };
    const res = await onRequest({
      request: req('/api/x402/prepare', { method: 'POST', body: { resourceUrl: 'https://api.example.com/x', requirement: arcReq } }),
      env: makeEnv({ X402_ENABLED: 'true', CIRCLE_API_KEY: 'k', CIRCLE_ENTITY_SECRET: 's' }),
    });
    const data = await jsonOf(res);
    expect(data.intent.status).toBe('blocked');
    expect(data.intent.checks.find((c) => c.name === 'network_eip3009').passed).toBe(false);
  });

  it('POST /prepare blocks settlement even when the flag is on (settlement not implemented)', async () => {
    const req0 = normalizePaymentRequired(paymentRequired()).requirements[0];
    const res = await onRequest({
      request: req('/api/x402/prepare', { method: 'POST', body: { resourceUrl: 'https://api.example.com/premium', requirement: req0 } }),
      env: makeEnv({ X402_ENABLED: 'true', CIRCLE_API_KEY: 'k', CIRCLE_ENTITY_SECRET: 's' }),
    });
    const data = await jsonOf(res);
    expect(data.intent.status).toBe('blocked');
    expect(data.intent.checks.find((c) => c.name === 'settlement_implemented').passed).toBe(false);
  });

  it('POST /prepare rejects an invalid requirement (bad recipient)', async () => {
    const req0 = normalizePaymentRequired(paymentRequired()).requirements[0];
    const bad = { ...req0, payTo: '0x1234' };
    const res = await onRequest({
      request: req('/api/x402/prepare', { method: 'POST', body: { resourceUrl: 'https://api.example.com/premium', requirement: bad } }),
      env: makeEnv(),
    });
    const data = await jsonOf(res);
    expect(data.intent.status).toBe('blocked');
    expect(data.intent.checks.find((c) => c.name === 'payto_valid').passed).toBe(false);
  });

  it('POST /pay is fail-closed (503) with no simulated settlement', async () => {
    const res = await onRequest({ request: req('/api/x402/pay', { method: 'POST', body: { intentId: 'x402_x' } }), env: makeEnv() });
    expect(res.status).toBe(503);
    const data = await jsonOf(res);
    expect(data.code).toBe('x402_not_enabled');
  });

  it('requires session for prepare', async () => {
    const req0 = normalizePaymentRequired(paymentRequired()).requirements[0];
    const res = await onRequest({
      request: req('/api/x402/prepare', { method: 'POST', token: null, body: { resourceUrl: 'https://x', requirement: req0 } }),
      env: makeEnv(),
    });
    expect(res.status).toBe(401);
  });

  it('rejects an expired session (discover + prepare → 401)', async () => {
    const expiredEnv = makeEnv({
      AUTH_KV: makeKV({
        ['session:' + TOKEN]: JSON.stringify({ userId: USER_ID, email: EMAIL, expiresAt: Date.now() - 1000 }),
        ['user:' + EMAIL]: JSON.stringify({ id: USER_ID, circleWalletId: 'w1', circleWalletAddress: PAYER }),
      }),
    });
    const d = await onRequest({ request: req('/api/x402/discover', { method: 'POST', body: { url: 'https://api.example.com/x' } }), env: expiredEnv });
    expect(d.status).toBe(401);

    const req0 = normalizePaymentRequired(paymentRequired()).requirements[0];
    const p = await onRequest({ request: req('/api/x402/prepare', { method: 'POST', body: { resourceUrl: 'https://api.example.com/x', requirement: req0 } }), env: expiredEnv });
    expect(p.status).toBe(401);
  });

  it('blocks prepare when the wallet is missing (no per-user Circle wallet)', async () => {
    const noWalletEnv = makeEnv({
      AUTH_KV: makeKV({
        ['session:' + TOKEN]: JSON.stringify({ userId: USER_ID, email: EMAIL }),
        ['user:' + EMAIL]: JSON.stringify({ id: USER_ID }), // no circleWalletId
      }),
    });
    const req0 = normalizePaymentRequired(paymentRequired()).requirements[0];
    const res = await onRequest({
      request: req('/api/x402/prepare', { method: 'POST', body: { resourceUrl: 'https://api.example.com/x', requirement: req0 } }),
      env: noWalletEnv,
    });
    const data = await jsonOf(res);
    expect(data.intent.status).toBe('blocked');
    expect(data.intent.checks.find((c) => c.name === 'wallet').passed).toBe(false);
  });

  it('POST /discover blocks redirects to internal hostnames (localhost / metadata)', async () => {
    globalThis.fetch.mockResolvedValueOnce(new Response('', { status: 302, headers: { Location: 'http://localhost:3000/x' } }));
    const res1 = await onRequest({ request: req('/api/x402/discover', { method: 'POST', body: { url: 'https://api.example.com/r' } }), env: makeEnv() });
    expect(res1.status).toBe(502);
    expect((await jsonOf(res1)).error).toMatch(/blocked/i);

    globalThis.fetch.mockResolvedValueOnce(new Response('', { status: 302, headers: { Location: 'http://metadata.google.internal/latest' } }));
    const res2 = await onRequest({ request: req('/api/x402/discover', { method: 'POST', body: { url: 'https://api.example.com/r' } }), env: makeEnv() });
    expect(res2.status).toBe(502);
  });

  it('POST /discover does not accept the wallet-connect/global fallback header', async () => {
    // A request authenticated ONLY via X-Agent-Wallet (matching CIRCLE_WALLET_ADDRESS)
    // must NOT be treated as a valid x402 session — only email sessions count.
    const env = makeEnv({ CIRCLE_WALLET_ADDRESS: PAYER });
    const headers = { 'Content-Type': 'application/json', 'X-Agent-Wallet': PAYER };
    const request = new Request('https://app.local/api/x402/discover', {
      method: 'POST', headers, body: JSON.stringify({ url: 'https://api.example.com/x' }),
    });
    const res = await onRequest({ request, env });
    expect(res.status).toBe(401);
  });
});
