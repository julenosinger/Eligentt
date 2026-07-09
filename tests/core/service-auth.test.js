import { describe, it, expect } from 'vitest';
import { verifyAccess, signingString, hasHmacCredentials } from '../../functions/api/core/service-auth.mjs';
import { registerApplication, setApplicationSecret } from '../../functions/api/core/registry.mjs';
import { sealSecret, hmacSha256Hex } from '../../functions/api/core/application-secret.mjs';
import { applyRateLimit } from '../../functions/api/core/rate-limit.mjs';

const MASTER = '0x' + 'ab'.repeat(32);
const SECRET = 'execdaat-shared-secret-abc';

function mockKV() {
  const store = new Map();
  return {
    async get(k) { return store.get(k) ?? null; },
    async put(k, v) { store.set(k, v); },
    async list({ prefix = '', limit = 1000 } = {}) {
      return { keys: Array.from(store.keys()).filter(k => k.startsWith(prefix)).slice(0, limit).map(name => ({ name })) };
    },
  };
}

async function setupApp(env, id = 'EXECDAAT', secret = SECRET) {
  await registerApplication(env, { applicationId: id, status: 'active', authMode: 'hmac', allowedOrigins: [] });
  const sealed = await sealSecret(secret, env.CORE_SECRET_KEY);
  await setApplicationSecret(env, id, sealed);
}

async function signHeaders(method, url, bodyStr, { appId, secret, ts, nonce }) {
  const path = new URL(url).pathname;
  const t = ts != null ? ts : Date.now();
  const n = nonce || ('nonce-' + Math.random().toString(16).slice(2) + Date.now());
  const sig = await hmacSha256Hex(secret, signingString(method, path, t, n, bodyStr || ''));
  return { 'X-Application-Id': appId, 'X-Timestamp': String(t), 'X-Nonce': n, 'X-Signature': sig };
}

describe('Core hardening — HMAC service authentication', () => {
  it('detects HMAC credentials', () => {
    const req = new Request('https://x/y', { headers: { 'X-Signature': 's', 'X-Application-Id': 'A', 'X-Timestamp': '1', 'X-Nonce': 'n' } });
    expect(hasHmacCredentials(req)).toBe(true);
    expect(hasHmacCredentials(new Request('https://x/y'))).toBe(false);
  });

  it('accepts a valid signature', async () => {
    const env = { CORE_KV: mockKV(), CORE_SECRET_KEY: MASTER };
    await setupApp(env);
    const url = 'https://app/api/core/v1/quote';
    const body = JSON.stringify({ token: 'usdc', amount: 10 });
    const headers = await signHeaders('POST', url, body, { appId: 'EXECDAAT', secret: SECRET });
    const req = new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
    const res = await verifyAccess(req, env, { rawBody: body, body: JSON.parse(body) });
    expect(res.ok).toBe(true);
    expect(res.method).toBe('hmac');
    expect(res.application).toBe('EXECDAAT');
  });

  it('rejects an invalid signature', async () => {
    const env = { CORE_KV: mockKV(), CORE_SECRET_KEY: MASTER };
    await setupApp(env);
    const url = 'https://app/api/core/v1/quote';
    const body = JSON.stringify({ token: 'usdc', amount: 10 });
    const headers = await signHeaders('POST', url, body, { appId: 'EXECDAAT', secret: 'WRONG-SECRET' });
    const req = new Request(url, { method: 'POST', headers, body });
    const res = await verifyAccess(req, env, { rawBody: body, body: JSON.parse(body) });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('AUTH_SIGNATURE');
  });

  it('rejects a tampered body (signature no longer matches)', async () => {
    const env = { CORE_KV: mockKV(), CORE_SECRET_KEY: MASTER };
    await setupApp(env);
    const url = 'https://app/api/core/v1/quote';
    const signedBody = JSON.stringify({ token: 'usdc', amount: 10 });
    const headers = await signHeaders('POST', url, signedBody, { appId: 'EXECDAAT', secret: SECRET });
    const tampered = JSON.stringify({ token: 'usdc', amount: 999999 });
    const req = new Request(url, { method: 'POST', headers, body: tampered });
    const res = await verifyAccess(req, env, { rawBody: tampered, body: JSON.parse(tampered) });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('AUTH_SIGNATURE');
  });

  it('rejects an expired timestamp (outside 60s window)', async () => {
    const env = { CORE_KV: mockKV(), CORE_SECRET_KEY: MASTER };
    await setupApp(env);
    const url = 'https://app/api/core/v1/quote';
    const body = JSON.stringify({ token: 'usdc', amount: 10 });
    const headers = await signHeaders('POST', url, body, { appId: 'EXECDAAT', secret: SECRET, ts: Date.now() - 120000 });
    const req = new Request(url, { method: 'POST', headers, body });
    const res = await verifyAccess(req, env, { rawBody: body, body: JSON.parse(body) });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('AUTH_TIMESTAMP');
  });

  it('blocks replay (same nonce twice)', async () => {
    const env = { CORE_KV: mockKV(), CORE_SECRET_KEY: MASTER };
    await setupApp(env);
    const url = 'https://app/api/core/v1/quote';
    const body = JSON.stringify({ token: 'usdc', amount: 10 });
    const headers = await signHeaders('POST', url, body, { appId: 'EXECDAAT', secret: SECRET, nonce: 'fixed-nonce-123456' });
    const mk = () => new Request(url, { method: 'POST', headers, body });
    const r1 = await verifyAccess(mk(), env, { rawBody: body, body: JSON.parse(body) });
    expect(r1.ok).toBe(true);
    const r2 = await verifyAccess(mk(), env, { rawBody: body, body: JSON.parse(body) });
    expect(r2.ok).toBe(false);
    expect(r2.code).toBe('AUTH_REPLAY');
  });

  it('verifies against the previous secret during rotation grace', async () => {
    const env = { CORE_KV: mockKV(), CORE_SECRET_KEY: MASTER };
    await setupApp(env, 'EXECDAAT', 'secret-v1');
    // Rotate to v2 keeping v1 within grace.
    const { rotateServiceSecret } = await import('../../functions/api/core/application-secret.mjs');
    const cur = (await import('../../functions/api/core/registry.mjs'));
    const app = await cur.getApplication(env, 'EXECDAAT');
    const rotated = await rotateServiceSecret(app.secret, 'secret-v2', MASTER, { gracePeriodMs: 60000 });
    await setApplicationSecret(env, 'EXECDAAT', rotated);
    // Sign with the OLD secret — must still be accepted during grace.
    const url = 'https://app/api/core/v1/quote';
    const body = JSON.stringify({ token: 'usdc', amount: 1 });
    const headers = await signHeaders('POST', url, body, { appId: 'EXECDAAT', secret: 'secret-v1' });
    const req = new Request(url, { method: 'POST', headers, body });
    const res = await verifyAccess(req, env, { rawBody: body, body: JSON.parse(body) });
    expect(res.ok).toBe(true);
  });

  it('internal traffic still works by default (backward compatible)', async () => {
    const env = { CORE_KV: mockKV(), CORE_SECRET_KEY: MASTER };
    const req = new Request('https://app/api/core/v1/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const res = await verifyAccess(req, env, { rawBody: '{}', body: {} });
    expect(res.ok).toBe(true);
    expect(res.method).toBe('internal');
    expect(res.application).toBe('ELLIGENT');
  });

  it('strict mode requires a signature', async () => {
    const env = { CORE_KV: mockKV(), CORE_SECRET_KEY: MASTER, AUTH_MODE: 'strict' };
    const req = new Request('https://app/api/core/v1/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const res = await verifyAccess(req, env, { rawBody: '{}', body: {} });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('AUTH_SIGNATURE_REQUIRED');
  });
});

describe('Core hardening — effective rate limiting', () => {
  it('enforces limits and blocks over-limit (429 semantics)', async () => {
    const env = { CORE_KV: mockKV() };
    const appRecord = { rateLimits: { quotePerMin: 2 } };
    const opts = { application: 'EXECDAAT', client: 'c', ip: '1.2.3.4', kind: 'quote', appRecord, mode: 'enforce' };
    const a = await applyRateLimit(env, opts);
    const b = await applyRateLimit(env, opts);
    const c = await applyRateLimit(env, opts);
    expect(a.blocked).toBe(false);
    expect(b.blocked).toBe(false);
    expect(c.blocked).toBe(true);
    expect(c.retryAfter).toBeGreaterThan(0);
  });

  it('record mode never blocks', async () => {
    const env = { CORE_KV: mockKV() };
    const appRecord = { rateLimits: { quotePerMin: 1 } };
    const opts = { application: 'A', client: 'c', ip: '9.9.9.9', kind: 'quote', appRecord, mode: 'record' };
    await applyRateLimit(env, opts);
    const r = await applyRateLimit(env, opts);
    expect(r.exceeded).toBe(true);
    expect(r.blocked).toBe(false);
  });

  it('off mode skips entirely', async () => {
    const env = { CORE_KV: mockKV() };
    const r = await applyRateLimit(env, { application: 'A', client: 'c', kind: 'quote', mode: 'off' });
    expect(r.allowed).toBe(true);
    expect(r.blocked).toBe(false);
  });
});
