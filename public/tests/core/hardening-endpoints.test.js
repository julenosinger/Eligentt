import { describe, it, expect, vi, afterEach } from 'vitest';
import { onRequestPost as quote } from '../../functions/api/core/v1/quote.js';
import { onRequestPost as createIntent } from '../../functions/api/core/v1/intents.js';
import { onRequestGet as health } from '../../functions/api/core/v1/health.js';
import { registerApplication, setApplicationSecret } from '../../functions/api/core/registry.mjs';
import { sealSecret, hmacSha256Hex } from '../../functions/api/core/application-secret.mjs';
import { signingString } from '../../functions/api/core/service-auth.mjs';
import * as breaker from '../../functions/api/core/circuit-breaker.mjs';

const MASTER = '0x' + 'ab'.repeat(32);

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
function makeEnv(extra) { return { CORE_KV: mockKV(), CORE_SECRET_KEY: MASTER, ALLOWED_ORIGINS: 'https://elligente.pages.dev', ...(extra || {}) }; }

async function signedRequest(url, bodyObj, { appId, secret, nonce, ts }) {
  const body = JSON.stringify(bodyObj);
  const path = new URL(url).pathname;
  const t = ts != null ? ts : Date.now();
  const n = nonce || ('n-' + Math.random().toString(16).slice(2) + Date.now());
  const sig = await hmacSha256Hex(secret, signingString('POST', path, t, n, body));
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Application-Id': appId, 'X-Timestamp': String(t), 'X-Nonce': n, 'X-Signature': sig },
    body,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('Core hardening — pipeline (end-to-end)', () => {
  it('internal traffic remains backward compatible (201 + non-wildcard CORS)', async () => {
    const env = makeEnv();
    const req = new Request('https://app/api/core/v1/intents', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://elligente.pages.dev' },
      body: JSON.stringify({ asset: 'usdc', amount: 100, wallet: '0x' + '1'.repeat(40) }),
    });
    const res = await createIntent({ request: req, env });
    expect(res.status).toBe(201);
    const acao = res.headers.get('Access-Control-Allow-Origin');
    expect(acao).toBe('https://elligente.pages.dev');
    expect(acao).not.toBe('*');
  });

  it('authenticates a signed EXECDAAT request end-to-end', async () => {
    const env = makeEnv();
    await registerApplication(env, { applicationId: 'EXECDAAT', status: 'active', authMode: 'hmac', allowedOrigins: [] });
    await setApplicationSecret(env, 'EXECDAAT', await sealSecret('execdaat-e2e-secret', MASTER));

    const req = await signedRequest('https://app/api/core/v1/quote', { token: 'usdc', amount: 250 }, { appId: 'EXECDAAT', secret: 'execdaat-e2e-secret' });
    const res = await quote({ request: req, env });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.bridge).toBe('Turbo');
  });

  it('rejects a signed request with a bad signature (401)', async () => {
    const env = makeEnv();
    await registerApplication(env, { applicationId: 'EXECDAAT', status: 'active', authMode: 'hmac', allowedOrigins: [] });
    await setApplicationSecret(env, 'EXECDAAT', await sealSecret('execdaat-e2e-secret', MASTER));

    const req = await signedRequest('https://app/api/core/v1/quote', { token: 'usdc', amount: 250 }, { appId: 'EXECDAAT', secret: 'WRONG' });
    const res = await quote({ request: req, env });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.errors[0].code).toBe('AUTH_SIGNATURE');
  });

  it('blocks replay end-to-end (same nonce → 401 AUTH_REPLAY)', async () => {
    const env = makeEnv();
    await registerApplication(env, { applicationId: 'EXECDAAT', status: 'active', authMode: 'hmac', allowedOrigins: [] });
    await setApplicationSecret(env, 'EXECDAAT', await sealSecret('execdaat-e2e-secret', MASTER));

    const nonce = 'replay-nonce-abcdef';
    const build = async () => signedRequest('https://app/api/core/v1/quote', { token: 'usdc', amount: 5 }, { appId: 'EXECDAAT', secret: 'execdaat-e2e-secret', nonce });
    const r1 = await quote({ request: await build(), env });
    expect(r1.status).toBe(200);
    const r2 = await quote({ request: await build(), env });
    expect(r2.status).toBe(401);
    expect((await r2.json()).errors[0].code).toBe('AUTH_REPLAY');
  });

  it('enforces rate limits (429 with standardized envelope)', async () => {
    const env = makeEnv();
    await registerApplication(env, { applicationId: 'RLTEST', status: 'active', authMode: 'internal', rateLimits: { quotePerMin: 2 } });
    const call = () => quote({
      request: new Request('https://app/api/core/v1/quote', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '5.5.5.5' },
        body: JSON.stringify({ token: 'usdc', amount: 1, applicationId: 'RLTEST' }),
      }), env,
    });
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    const third = await call();
    expect(third.status).toBe(429);
    const body = await third.json();
    expect(body.success).toBe(false);
    expect(body.errors[0].code).toBe('RATE_LIMITED');
    expect(third.headers.get('Retry-After')).toBeTruthy();
  });

  it('health reports circuit-open dependency and degraded status', async () => {
    const env = makeEnv();
    for (let i = 0; i < 5; i++) await breaker.recordFailure(env, 'rpc', 'boom');
    // fetch should not even be called when the rpc breaker is open.
    vi.stubGlobal('fetch', async () => { throw new Error('should not be called'); });
    const res = await health({ request: new Request('https://app/api/core/v1/health'), env });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.components.rpc.status).toBe('circuit_open');
    expect(body.data.status).toBe('degraded');
    expect(body.data.circuitBreaker.rpc.state).toBe('open');
  });

  it('health returns expanded observability fields', async () => {
    const env = makeEnv();
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ result: '0x10' }), { status: 200 }));
    const res = await health({ request: new Request('https://app/api/core/v1/health'), env });
    const body = await res.json();
    expect(body.data).toHaveProperty('averageLatency');
    expect(body.data).toHaveProperty('errorRate');
    expect(body.data).toHaveProperty('p95');
    expect(body.data).toHaveProperty('applicationCount');
    expect(body.data.components).toHaveProperty('storage');
    expect(body.data.components).toHaveProperty('ledger');
  });
});
