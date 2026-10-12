/**
 * exec-otp → authorize flow regression tests.
 * ═══════════════════════════════════════════════════════════════════════
 * Proves:
 *   1. The email OTP verify path generates a VALID execToken (no `Buffer` crash,
 *      consistent JSON) and consumes the OTP single-use.
 *   2. Wrong / expired / reused / session-expired / KV-failure / server-error
 *      cases return consistent JSON (never a non-JSON 500) with a correlation id.
 *   3. The execToken is re-verified server-side by /api/agent-signer/authorize
 *      (signature, expiry, user, wallet, operation, amount, asset, destination)
 *      and any tampering is rejected.
 *   4. A valid OTP confirmation proceeds to authorization (proof issued).
 */
import { describe, it, expect } from 'vitest';
import { onRequestPost as execOtpPost } from '../functions/api/agent/exec-otp.js';
import { onRequestPost as authorizePost } from '../functions/api/agent-signer/authorize.js';
import { hmacSha256Hex } from '../functions/api/core/application-secret.mjs';

const AUTH_SECRET = 'test-auth-secret-0123456789';
const PROOF_SECRET = 'agent-signer-proof-secret-0123456789';
const USER_ID = 'user-1111-2222-3333-4444';
const EMAIL = 'alice@example.com';
const WALLET_ID = 'user_wallet_123';
const WALLET_ADDR = '0x' + '22'.repeat(20);
const RCPT = '0x' + '11'.repeat(20);
const USDC = '0x3600000000000000000000000000000000000000';
const SESSION_TOKEN = 'abcdef'.repeat(6); // 36 chars
const INTENT = 'intent_abc123';

function makeKV({ failGet = false, failDelete = false, failPut = false } = {}) {
  const map = new Map();
  return {
    async get(k) { if (failGet) throw new Error('KV get failed'); return map.has(k) ? map.get(k) : null; },
    async put(k, v) { if (failPut) throw new Error('KV put failed'); map.set(k, v); return true; },
    async delete(k) { if (failDelete) throw new Error('KV delete failed'); map.delete(k); return true; },
    async list() { return { keys: [] }; },
    _map: map,
  };
}

async function hashOTP(code, salt) {
  const enc = new TextEncoder();
  const mat = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' }, mat, 256);
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function makeExecToken(secret, claim) {
  const payload = [
    claim.userId, claim.intentId, claim.circleWalletId || '', claim.operation,
    String(claim.amount), claim.asset, claim.destination || '', String(claim.expiresAt),
  ].join(':');
  const sig = await hmacSha256Hex(secret, payload);
  return btoa(JSON.stringify({ payload, sig }));
}

function execOtpReq(body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  return new Request('https://example.com/api/agent/exec-otp', { method: 'POST', headers, body: JSON.stringify(body) });
}

function authorizeReq(body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  return new Request('https://example.com/api/agent-signer/authorize', { method: 'POST', headers, body: JSON.stringify(body) });
}

// Seed a valid session + per-user Circle wallet + an un-consumed OTP for a known code.
async function seedOtp(kv, code = '123456', over = {}) {
  const salt = 'a1b2c3d4e5f60718';
  const hash = await hashOTP(code, salt);
  await kv.put('session:' + SESSION_TOKEN, JSON.stringify({
    email: EMAIL,
    userId: USER_ID,
    walletAddress: null,
    circleWalletId: WALLET_ID,
    circleWalletAddress: WALLET_ADDR,
    createdAt: Date.now(),
  }));
  await kv.put('user:' + EMAIL, JSON.stringify({
    id: USER_ID,
    email: EMAIL,
    circleWalletId: WALLET_ID,
    circleWalletAddress: WALLET_ADDR,
  }));
  await kv.put('execotp:' + USER_ID + ':' + INTENT, JSON.stringify(Object.assign({
    hash, salt, attempts: 0,
    operation: 'payment', amount: 100, asset: 'USDC',
    destination: RCPT, createdAt: Date.now(),
  }, over)));
}

function makeOtpEnv(kv, over = {}) {
  return { AUTH_KV: kv, AUTH_SECRET, ...over };
}

describe('exec-otp OTP verify flow', () => {
  it('correct OTP → ok:true + valid execToken (base64, no Buffer crash)', async () => {
    const kv = makeKV();
    await seedOtp(kv);
    const res = await execOtpPost({ request: execOtpReq({ action: 'verify', intentId: INTENT, code: '123456' }, SESSION_TOKEN), env: makeOtpEnv(kv) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(typeof data.execToken).toBe('string');
    expect(data.execToken.length).toBeGreaterThan(20);
    expect(data.operation).toBe('payment');
    expect(data.amount).toBe(100);
    expect(data.asset).toBe('USDC');
    expect(data.destination).toBe(RCPT);
    expect(data.correlationId).toBeTruthy();
    // Token must decode to { payload, sig } — not a mangled Buffer artifact.
    const decoded = JSON.parse(atob(data.execToken));
    expect(typeof decoded.payload).toBe('string');
    expect(typeof decoded.sig).toBe('string');
    expect(decoded.sig).toMatch(/^[0-9a-f]{64}$/);
    // OTP consumed (single-use)
    expect(await kv.get('execotp:' + USER_ID + ':' + INTENT)).toBeNull();
  });

  it('incorrect OTP → 401 JSON with remaining attempts', async () => {
    const kv = makeKV();
    await seedOtp(kv);
    const res = await execOtpPost({ request: execOtpReq({ action: 'verify', intentId: INTENT, code: '000000' }, SESSION_TOKEN), env: makeOtpEnv(kv) });
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.ok).toBeUndefined();
    expect(data.error).toMatch(/Invalid code/);
  });

  it('reused OTP → 400 (already consumed)', async () => {
    const kv = makeKV();
    await seedOtp(kv);
    await execOtpPost({ request: execOtpReq({ action: 'verify', intentId: INTENT, code: '123456' }, SESSION_TOKEN), env: makeOtpEnv(kv) });
    const res = await execOtpPost({ request: execOtpReq({ action: 'verify', intentId: INTENT, code: '123456' }, SESSION_TOKEN), env: makeOtpEnv(kv) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/expired or not found/i);
  });

  it('expired / missing OTP → 400', async () => {
    const kv = makeKV();
    await kv.put('session:' + SESSION_TOKEN, JSON.stringify({ email: EMAIL, userId: USER_ID, circleWalletId: WALLET_ID, circleWalletAddress: WALLET_ADDR }));
    // No OTP record — equivalent to TTL expiry.
    const res = await execOtpPost({ request: execOtpReq({ action: 'verify', intentId: INTENT, code: '123456' }, SESSION_TOKEN), env: makeOtpEnv(kv) });
    expect(res.status).toBe(400);
  });

  it('expired session → 401', async () => {
    const kv = makeKV();
    await kv.put('session:' + SESSION_TOKEN, JSON.stringify({ email: EMAIL, userId: USER_ID, expiresAt: Date.now() - 1000 }));
    const res = await execOtpPost({ request: execOtpReq({ action: 'verify', intentId: INTENT, code: '123456' }, SESSION_TOKEN), env: makeOtpEnv(kv) });
    expect(res.status).toBe(401);
  });

  it('missing session → 401', async () => {
    const kv = makeKV();
    const res = await execOtpPost({ request: execOtpReq({ action: 'verify', intentId: INTENT, code: '123456' }, 'no-such-token-xxxxxxxxxxxxxxxx'), env: makeOtpEnv(kv) });
    expect(res.status).toBe(401);
  });

  it('KV failure → 500 JSON with correlationId (not a raw error page)', async () => {
    const kv = makeKV();
    await seedOtp(kv);
    // Session lookup succeeds; the OTP record lookup throws (unwrapped) → 500 JSON.
    const failingKv = {
      ...kv,
      async get(k) { if (String(k).indexOf('execotp:') === 0) throw new Error('KV get failed'); return kv.get(k); },
    };
    const res = await execOtpPost({ request: execOtpReq({ action: 'verify', intentId: INTENT, code: '123456' }, SESSION_TOKEN), env: makeOtpEnv(failingKv) });
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    const data = await res.json();
    expect(data.correlationId).toBeTruthy();
    expect(typeof data.error).toBe('string');
  });

  it('unhandled server error → 500 JSON with correlationId', async () => {
    const kv = makeKV();
    await seedOtp(kv);
    // delete throws after hash match → exercises the top-level try/catch.
    const throwingKv = {
      ...kv,
      async delete() { throw new Error('boom'); },
    };
    const res = await execOtpPost({ request: execOtpReq({ action: 'verify', intentId: INTENT, code: '123456' }, SESSION_TOKEN), env: makeOtpEnv(throwingKv) });
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    const data = await res.json();
    expect(data.correlationId).toBeTruthy();
    expect(data.error).toContain('boom');
  });

  it('invalid action → 400', async () => {
    const kv = makeKV();
    await kv.put('session:' + SESSION_TOKEN, JSON.stringify({ email: EMAIL, userId: USER_ID }));
    const res = await execOtpPost({ request: execOtpReq({ action: 'nope', intentId: INTENT }, SESSION_TOKEN), env: makeOtpEnv(kv) });
    expect(res.status).toBe(400);
  });
});

describe('authorize execToken re-validation', () => {
  const EXEC = 'exec_test_123456';
  const baseClaim = () => ({
    userId: USER_ID,
    intentId: INTENT,
    circleWalletId: WALLET_ID,
    operation: 'payment',
    amount: 100,
    asset: 'USDC',
    destination: RCPT,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });

  function authorizeEnv(kv, over = {}) {
    return {
      CIRCLE_API_KEY: 'test-api-key',
      CIRCLE_ENTITY_SECRET: 'ab'.repeat(32),
      CIRCLE_WALLET_ID: 'platform_wallet',
      CIRCLE_WALLET_ADDRESS: '0x' + '33'.repeat(20),
      AGENT_SIGNER_PROOF_SECRET: PROOF_SECRET,
      AUTH_SECRET,
      AUTH_KV: kv,
      RATE_LIMIT_KV: kv,
      ...over,
    };
  }

  function authorizeBody(over = {}) {
    return Object.assign({
      executionId: EXEC,
      chainId: 5042,
      operation: 'payment',
      amount: 100,
      destination: RCPT,
      request: { type: 'transfer', tokenAddress: USDC, to: RCPT, amount: '100000000' },
    }, over);
  }

  async function seedSession(kv) {
    await kv.put('session:' + SESSION_TOKEN, JSON.stringify({ email: EMAIL, userId: USER_ID, circleWalletId: WALLET_ID, circleWalletAddress: WALLET_ADDR }));
    await kv.put('user:' + EMAIL, JSON.stringify({ id: USER_ID, email: EMAIL, circleWalletId: WALLET_ID, circleWalletAddress: WALLET_ADDR }));
  }

  it('valid execToken → issues proof (confirmation proceeds to authorization)', async () => {
    const kv = makeKV();
    await seedSession(kv);
    const token = await makeExecToken(AUTH_SECRET, baseClaim());
    const res = await authorizePost({ request: authorizeReq(authorizeBody({ execToken: token }), SESSION_TOKEN), env: authorizeEnv(kv) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.authorizationProof).toBeTruthy();
    expect(data.walletId).toBe(WALLET_ID);
  });

  it('invalid signature → 403', async () => {
    const kv = makeKV();
    await seedSession(kv);
    const token = await makeExecToken('wrong-secret-xxxxxxxxx', baseClaim());
    const res = await authorizePost({ request: authorizeReq(authorizeBody({ execToken: token }), SESSION_TOKEN), env: authorizeEnv(kv) });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/signature/i);
  });

  it('expired execToken → 403', async () => {
    const kv = makeKV();
    await seedSession(kv);
    const token = await makeExecToken(AUTH_SECRET, { ...baseClaim(), expiresAt: Date.now() - 1000 });
    const res = await authorizePost({ request: authorizeReq(authorizeBody({ execToken: token }), SESSION_TOKEN), env: authorizeEnv(kv) });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/expired/i);
  });

  it('recipient change → 403', async () => {
    const kv = makeKV();
    await seedSession(kv);
    const token = await makeExecToken(AUTH_SECRET, baseClaim());
    const body = authorizeBody({ execToken: token, destination: '0x' + '99'.repeat(20), request: { type: 'transfer', tokenAddress: USDC, to: '0x' + '99'.repeat(20), amount: '100000000' } });
    const res = await authorizePost({ request: authorizeReq(body, SESSION_TOKEN), env: authorizeEnv(kv) });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/destination/i);
  });

  it('amount change → 403', async () => {
    const kv = makeKV();
    await seedSession(kv);
    const token = await makeExecToken(AUTH_SECRET, baseClaim());
    const body = authorizeBody({ execToken: token, amount: 999 });
    const res = await authorizePost({ request: authorizeReq(body, SESSION_TOKEN), env: authorizeEnv(kv) });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/amount/i);
  });

  it('operation change → 403', async () => {
    const kv = makeKV();
    await seedSession(kv);
    const token = await makeExecToken(AUTH_SECRET, baseClaim());
    const body = authorizeBody({ execToken: token, operation: 'bridge' });
    const res = await authorizePost({ request: authorizeReq(body, SESSION_TOKEN), env: authorizeEnv(kv) });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/operation/i);
  });

  it('user mismatch → 403', async () => {
    const kv = makeKV();
    await seedSession(kv);
    const token = await makeExecToken(AUTH_SECRET, { ...baseClaim(), userId: 'user-other-9999-0000-1111' });
    const res = await authorizePost({ request: authorizeReq(authorizeBody({ execToken: token }), SESSION_TOKEN), env: authorizeEnv(kv) });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/user/i);
  });

  it('wallet mismatch → 403', async () => {
    const kv = makeKV();
    await seedSession(kv);
    const token = await makeExecToken(AUTH_SECRET, { ...baseClaim(), circleWalletId: 'other_wallet_999' });
    const res = await authorizePost({ request: authorizeReq(authorizeBody({ execToken: token }), SESSION_TOKEN), env: authorizeEnv(kv) });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/wallet/i);
  });

  it('no execToken → still allowed (session-only, non-OTP flows unaffected)', async () => {
    const kv = makeKV();
    await seedSession(kv);
    const res = await authorizePost({ request: authorizeReq(authorizeBody(), SESSION_TOKEN), env: authorizeEnv(kv) });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('end-to-end: OTP verify execToken is accepted by authorize', async () => {
    const kv = makeKV();
    await seedOtp(kv);
    await kv.put('session:' + SESSION_TOKEN, JSON.stringify({ email: EMAIL, userId: USER_ID, circleWalletId: WALLET_ID, circleWalletAddress: WALLET_ADDR }));
    const vres = await execOtpPost({ request: execOtpReq({ action: 'verify', intentId: INTENT, code: '123456' }, SESSION_TOKEN), env: makeOtpEnv(kv) });
    const vdata = await vres.json();
    expect(vdata.ok).toBe(true);

    const ares = await authorizePost({ request: authorizeReq(authorizeBody({ execToken: vdata.execToken }), SESSION_TOKEN), env: authorizeEnv(kv) });
    expect(ares.status).toBe(200);
    expect((await ares.json()).ok).toBe(true);
  });
});
