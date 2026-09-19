import { describe, it, expect } from 'vitest';
import { onRequestPost as quote } from '../../functions/api/core/v1/quote.js';
import { onRequestGet as health } from '../../functions/api/core/v1/health.js';
import { onRequestGet as applications } from '../../functions/api/core/v1/applications.js';
import { hmacSha256Hex } from '../../functions/api/core/application-secret.mjs';
import { signingString } from '../../functions/api/core/service-auth.mjs';
import { vi, afterEach } from 'vitest';

const EXEC_SECRET = 'golive-execdaat-secret-256bit-test-value';

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

// Production-like env: strict HMAC + ExecDaat secret provided ONLY as a Cloudflare
// Secret env var (never in KV / git / bundle).
function prodEnv() {
  return {
    CORE_KV: mockKV(),
    AUTH_MODE: 'strict',
    RATE_LIMIT_MODE: 'enforce',
    CORE_ALLOWED_ORIGINS: 'https://execdaat.xyz,https://elligentt.xyz',
    EXECDAAT_APP_SECRET: EXEC_SECRET,
  };
}

async function execSignedQuote(env, bodyObj, { nonce } = {}) {
  const url = 'https://api/api/core/v1/quote';
  const body = JSON.stringify(bodyObj);
  const ts = Date.now();
  const n = nonce || ('n-' + Math.random().toString(16).slice(2) + Date.now());
  const sig = await hmacSha256Hex(EXEC_SECRET, signingString('POST', '/api/core/v1/quote', ts, n, body));
  const req = new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Application-Id': 'EXECDAAT', 'X-Timestamp': String(ts), 'X-Nonce': n, 'X-Signature': sig },
    body,
  });
  return quote({ request: req, env });
}

afterEach(() => vi.unstubAllGlobals());

describe('GO-LIVE — ExecDaat consumes the Treasury Core (strict HMAC, Cloudflare Secret)', () => {
  it('EXECDAAT is registered ACTIVE (secret masked in responses)', async () => {
    const res = await applications({ request: new Request('https://api/api/core/v1/applications', { headers: { 'X-Application-Id': 'ELLIGENT' } }), env: { ...prodEnv(), AUTH_MODE: 'internal' } });
    const body = await res.json();
    const exec = body.data.applications.find(a => a.applicationId === 'EXECDAAT');
    expect(exec.status).toBe('active');
    expect(exec.authMode).toBe('hmac');
    expect(exec.permissions).toContain('execute:write');
    // The secret projection is deep-masked in API responses (never leaks a value).
    expect(exec.secret).toBe('***REDACTED***');
  });

  it('accepts a correctly signed ExecDaat request (200)', async () => {
    const res = await execSignedQuote(prodEnv(), { token: 'usdc', amount: 1000 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.bridge).toBe('Turbo');
  });

  it('rejects an UNSIGNED request under strict mode (401)', async () => {
    const req = new Request('https://api/api/core/v1/quote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'usdc', amount: 10 }),
    });
    const res = await quote({ request: req, env: prodEnv() });
    expect(res.status).toBe(401);
    expect((await res.json()).errors[0].code).toBe('AUTH_SIGNATURE_REQUIRED');
  });

  it('rejects a wrong signature (401 AUTH_SIGNATURE)', async () => {
    const env = prodEnv();
    const url = 'https://api/api/core/v1/quote';
    const body = JSON.stringify({ token: 'usdc', amount: 10 });
    const ts = Date.now();
    const n = 'nonce-wrong-1234567';
    const sig = await hmacSha256Hex('not-the-secret', signingString('POST', '/api/core/v1/quote', ts, n, body));
    const req = new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Application-Id': 'EXECDAAT', 'X-Timestamp': String(ts), 'X-Nonce': n, 'X-Signature': sig }, body });
    const res = await quote({ request: req, env });
    expect(res.status).toBe(401);
    expect((await res.json()).errors[0].code).toBe('AUTH_SIGNATURE');
  });

  it('blocks replay of a signed ExecDaat request', async () => {
    const env = prodEnv();
    const nonce = 'golive-replay-nonce-1';
    const r1 = await execSignedQuote(env, { token: 'usdc', amount: 5 }, { nonce });
    expect(r1.status).toBe(200);
    const r2 = await execSignedQuote(env, { token: 'usdc', amount: 5 }, { nonce });
    expect(r2.status).toBe(401);
    expect((await r2.json()).errors[0].code).toBe('AUTH_REPLAY');
  });

  it('health stays PUBLIC even under strict auth', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ result: '0x2a' }), { status: 200 }));
    const res = await health({ request: new Request('https://api/api/core/v1/health'), env: prodEnv() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.components.rpc.status).toBe('ok');
  });
});
