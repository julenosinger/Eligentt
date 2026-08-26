/**
 * AUTONOMA-6C — /api/agent-signer/broadcast security tests.
 * ═══════════════════════════════════════════════════════════════════════
 * Proves the Circle broadcast endpoint is NOT a public API that can turn any
 * HTTP request into a Circle wallet operation. It requires a server-issued,
 * single-use, request-bound authorization proof, and enforces nonce lock,
 * idempotency, circuit breaker, emergency pause and rate limiting.
 *
 * Also re-asserts the client-side invariants (no secrets, single broadcast
 * authority, browser mode unchanged, circle mode fail-closed).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { onRequestPost as broadcastPost } from '../functions/api/agent-signer/broadcast.js';
import { onRequestPost as authorizePost } from '../functions/api/agent-signer/authorize.js';
import { onRequestGet as configGet } from '../functions/api/agent-signer/config.js';
import { issueProof, signToken } from '../functions/api/agent-signer/_proof.mjs';
import { mapStructuredRequest } from '../functions/api/agent-signer/_circle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const SECRET = 'agent-signer-proof-secret-0123456789';
const WALLET_ADDRESS = '0x' + '66'.repeat(20);
const WALLET_ID = 'wallet_test';
const USDC = '0x3600000000000000000000000000000000000000';
const RCPT = '0x' + '11'.repeat(20);
const EXEC = 'exec_test_123456';
const SESSION_TOKEN = 'abcdef'.repeat(6); // 36 chars

function makeKV() {
  const map = new Map();
  return {
    async get(k) { return map.has(k) ? map.get(k) : null; },
    async put(k, v) { map.set(k, v); return true; },
    async delete(k) { map.delete(k); return true; },
    async list() { return { keys: [] }; },
    _map: map,
  };
}

function makeEnv(over = {}) {
  const kv = makeKV();
  const env = {
    CIRCLE_API_KEY: 'test-api-key',
    CIRCLE_ENTITY_SECRET: 'ab'.repeat(32),
    CIRCLE_WALLET_ID: WALLET_ID,
    CIRCLE_WALLET_ADDRESS: WALLET_ADDRESS,
    AGENT_SIGNER_PROOF_SECRET: SECRET,
    AUTH_KV: kv,
    RATE_LIMIT_KV: kv,
    RATE_LIMIT_MODE: 'off',
    CIRCUIT_BREAKER: 'on',
    ...over,
  };
  return { env, kv };
}

function req(body, cookie) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = 'elligente_sid=' + cookie;
  return new Request('https://example.com/api/agent-signer/broadcast', { method: 'POST', headers, body: JSON.stringify(body) });
}

function baseBody(over = {}) {
  return Object.assign({
    executionId: EXEC,
    chainId: 5042002,
    operation: 'payment',
    request: { type: 'transfer', tokenAddress: USDC, to: RCPT, amount: '1000000' },
  }, over);
}

function descriptorFor(request) {
  return mapStructuredRequest(request);
}

async function proofFor(env, over = {}) {
  const b = baseBody();
  const desc = descriptorFor(b.request);
  const payload = Object.assign({
    executionId: b.executionId,
    userId: 'USR-1',
    chainId: b.chainId,
    operation: b.operation,
    walletId: WALLET_ID,
    walletAddress: WALLET_ADDRESS.toLowerCase(),
    contractAddress: desc.contractAddress,
    abiFunctionSignature: desc.abiFunctionSignature,
    abiParameters: desc.abiParameters,
    destination: RCPT.toLowerCase(),
    amount: '1000000',
  }, over);
  return issueProof(env, payload);
}

async function postBroadcast(env, body) {
  const resp = await broadcastPost({ request: req(body), env });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

describe('AUTONOMA-6C — /broadcast authorization proof', () => {
  beforeEach(() => { delete globalThis.fetch; });
  afterEach(() => { delete globalThis.fetch; });

  it('1. broadcast WITHOUT authorizationProof → 401', async () => {
    const { env } = makeEnv();
    const r = await postBroadcast(env, baseBody());
    expect(r.status).toBe(401);
    expect(r.data.ok).toBe(false);
  });

  it('2. invalid proof (bad signature) → 401', async () => {
    const { env } = makeEnv();
    const r = await postBroadcast(env, baseBody({ authorizationProof: 'deadbeef.deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }));
    expect(r.status).toBe(401);
    expect(r.data.ok).toBe(false);
  });

  it('3. expired proof → 401', async () => {
    const { env } = makeEnv();
    const now = Date.now();
    const desc = descriptorFor(baseBody().request);
    const token = (await signToken(env, {
      v: 1, proofId: 'f'.repeat(32),
      executionId: EXEC, userId: 'USR-1', chainId: 5042002, operation: 'payment',
      walletId: WALLET_ID, walletAddress: WALLET_ADDRESS.toLowerCase(),
      contractAddress: desc.contractAddress, abiFunctionSignature: desc.abiFunctionSignature, abiParameters: desc.abiParameters,
      issuedAt: now - 200000, expiresAt: now - 1000,
    })).token;
    const r = await postBroadcast(env, baseBody({ authorizationProof: token }));
    expect(r.status).toBe(401);
  });

  it('4. executionId not matching the proof → 403', async () => {
    const { env } = makeEnv();
    const proof = await proofFor(env); // bound to EXEC
    const r = await postBroadcast(env, baseBody({ authorizationProof: proof.token, executionId: 'other_exec_999999' }));
    expect(r.status).toBe(403);
  });

  it('5. already-executed executionId → idempotent response (no second tx)', async () => {
    const { env, kv } = makeEnv();
    await kv.put('agent:exec:' + EXEC, JSON.stringify({ executionId: EXEC, status: 'submitted', txHash: '0x' + 'ab'.repeat(32) }));
    const proof = await proofFor(env);
    const r = await postBroadcast(env, baseBody({ authorizationProof: proof.token }));
    expect(r.status).toBe(200);
    expect(r.data.idempotent).toBe(true);
    expect(r.data.txHash).toBe('0x' + 'ab'.repeat(32));
  });

  it('6. chainId different from the proof → 403', async () => {
    const { env } = makeEnv();
    const proof = await proofFor(env);
    const r = await postBroadcast(env, baseBody({ authorizationProof: proof.token, chainId: 11155111 }));
    expect(r.status).toBe(403);
  });

  it('7. wallet different from the authorized wallet → 403', async () => {
    const { env } = makeEnv();
    const proof = await proofFor(env, { walletAddress: '0x' + '77'.repeat(20) });
    const r = await postBroadcast(env, baseBody({ authorizationProof: proof.token }));
    expect(r.status).toBe(403);
  });

  it('8. operation different from the proof → 403', async () => {
    const { env } = makeEnv();
    const proof = await proofFor(env);
    const r = await postBroadcast(env, baseBody({ authorizationProof: proof.token, operation: 'bridge' }));
    expect(r.status).toBe(403);
  });

  it('9. contractAddress different from the proof → 403', async () => {
    const { env } = makeEnv();
    const proof = await proofFor(env);
    const r = await postBroadcast(env, baseBody({
      authorizationProof: proof.token,
      request: { type: 'transfer', tokenAddress: '0x89b50855aa3be2f677cd6303cec089b5f319d72a', to: RCPT, amount: '1000000' },
    }));
    expect(r.status).toBe(403);
  });

  it('10. abiFunctionSignature altered → 403', async () => {
    const { env } = makeEnv();
    const proof = await proofFor(env, { abiFunctionSignature: 'transfer(address,uint256)' });
    const r = await postBroadcast(env, baseBody({
      authorizationProof: proof.token,
      request: { type: 'contractExecution', contractAddress: USDC, abiFunctionSignature: 'approve(address,uint256)', abiParameters: [RCPT, '1000000'] },
    }));
    expect(r.status).toBe(403);
  });

  it('11. abiParameters altered → 403', async () => {
    const { env } = makeEnv();
    const proof = await proofFor(env);
    const r = await postBroadcast(env, baseBody({
      authorizationProof: proof.token,
      request: { type: 'transfer', tokenAddress: USDC, to: RCPT, amount: '999999999' },
    }));
    expect(r.status).toBe(403);
  });

  it('12. duplicate nonce (locked by another execution) → 409', async () => {
    const { env, kv } = makeEnv();
    const proof = await proofFor(env);
    await kv.put('agent:nonce:' + WALLET_ADDRESS.toLowerCase() + ':5042002:5', JSON.stringify({ executionId: 'other_exec' }));
    globalThis.fetch = async (url) => {
      if (String(url).includes('arc-testnet') || String(url).includes('drpc')) {
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x5' }) };
      }
      throw new Error('unexpected fetch ' + url);
    };
    const r = await postBroadcast(env, baseBody({ authorizationProof: proof.token }));
    expect(r.status).toBe(409);
  });

  it('13. circuit breaker open → 503 (fail-closed)', async () => {
    const { env, kv } = makeEnv();
    const proof = await proofFor(env);
    await kv.put('core:cb:circle', JSON.stringify({ state: 'open', failures: 5, windowStart: Date.now(), openedAt: Date.now(), lastError: 'boom' }));
    const r = await postBroadcast(env, baseBody({ authorizationProof: proof.token }));
    expect(r.status).toBe(503);
  });

  it('14. emergency pause → 503 (no execution)', async () => {
    const { env } = makeEnv({ AGENT_SIGNER_PAUSED: 'true' });
    const proof = await proofFor(env);
    const r = await postBroadcast(env, baseBody({ authorizationProof: proof.token }));
    expect(r.status).toBe(503);
  });

  it('15. rate limit exceeded → 429', async () => {
    const { env, kv } = makeEnv({ RATE_LIMIT_MODE: 'enforce' });
    const proof = await proofFor(env);
    const minute = Math.floor(Date.now() / 60000);
    await kv.put('core:rate:app:ELLIGENT:execute:' + minute, '999');
    const r = await postBroadcast(env, baseBody({ authorizationProof: proof.token }));
    expect(r.status).toBe(429);
  });
});

describe('AUTONOMA-6C — /authorize session + happy path', () => {
  beforeEach(() => { delete globalThis.fetch; });
  afterEach(() => { delete globalThis.fetch; });

  it('authorize WITHOUT a valid session → 401', async () => {
    const { env } = makeEnv();
    const resp = await authorizePost({ request: req(baseBody()), env });
    expect(resp.status).toBe(401);
  });

  it('authorize WITH a valid session issues a bound proof', async () => {
    const { env, kv } = makeEnv();
    await kv.put('session:' + SESSION_TOKEN, JSON.stringify({ userId: 'USR-1', email: 'a@b.c', walletAddress: WALLET_ADDRESS }));
    const resp = await authorizePost({ request: req(baseBody(), SESSION_TOKEN), env });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.ok).toBe(true);
    expect(data.authorizationProof).toBeTruthy();
    expect(data.walletAddress).toBe(WALLET_ADDRESS.toLowerCase());
  });

  it('full flow: authorize → broadcast succeeds (Circle mocked) and returns txHash', async () => {
    const { env, kv } = makeEnv();
    await kv.put('session:' + SESSION_TOKEN, JSON.stringify({ userId: 'USR-1', email: 'a@b.c', walletAddress: WALLET_ADDRESS }));

    const { publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('api.circle.com') && u.includes('/config/entity')) {
        return { ok: true, json: async () => ({ data: { publicKey } }) };
      }
      if (u.includes('api.circle.com') && u.includes('contractExecution')) {
        return { ok: true, json: async () => ({ data: { id: 'tx_1', state: 'PENDING', txHash: '0x' + 'cd'.repeat(32) } }) };
      }
      if (u.includes('arc-testnet') || u.includes('drpc')) {
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x0' }) };
      }
      throw new Error('unexpected fetch ' + url);
    };

    const authResp = await authorizePost({ request: req(baseBody(), SESSION_TOKEN), env });
    const authData = await authResp.json();
    expect(authData.ok).toBe(true);

    const r = await postBroadcast(env, baseBody({ authorizationProof: authData.authorizationProof }));
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
    expect(r.data.txHash).toBe('0x' + 'cd'.repeat(32));
  });
});

describe('AUTONOMA-6C — client-side structural invariants', () => {
  const providerSrc = fs.readFileSync(path.join(root, 'shared', 'secureSignerProvider.js'), 'utf8');
  const executorSrc = fs.readFileSync(path.join(root, 'shared', 'agentScheduleExecutor.js'), 'utf8');
  const srcHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

  it('16. no Circle/proof secret material in client-side code', () => {
    for (const src of [providerSrc, executorSrc, srcHtml]) {
      expect(src).not.toContain('CIRCLE_ENTITY_SECRET');
      expect(src).not.toContain('CIRCLE_API_KEY');
      expect(src).not.toContain('entitySecretCiphertext');
      expect(src).not.toContain('AGENT_SIGNER_PROOF_SECRET');
    }
    // The signer-authority modules themselves never touch raw keys/mnemonics.
    expect(providerSrc).not.toContain('privateKey');
    expect(providerSrc).not.toContain('mnemonic');
    expect(executorSrc).not.toContain('mnemonic');
  });

  it('17. SecureSignerProvider creates no second broadcast authority (no raw signing)', () => {
    expect(providerSrc).not.toContain('eth_sendRawTransaction');
    expect(providerSrc).not.toContain('signer.signTransaction');
    expect(providerSrc).not.toContain('signTransaction(');
  });

  it('18. eth_sendRawTransaction remains ONLY inside agentScheduleExecutor.js', () => {
    const files = new Set();
    for (const name of fs.readdirSync(path.join(root, 'shared'))) {
      if (!name.endsWith('.js')) continue;
      const c = fs.readFileSync(path.join(root, 'shared', name), 'utf8');
      if (c.includes('eth_sendRawTransaction')) files.add('shared/' + name);
    }
    expect([...files]).toEqual(['shared/agentScheduleExecutor.js']);
  });

  it('19. circle mode never silently falls back (broadcast requires structured request + authorize)', () => {
    expect(providerSrc).toContain('/api/agent-signer/authorize');
    expect(providerSrc).toContain('circle descriptor missing');
    // browser broadcast delegation must remain, but ONLY in browser mode
    expect(providerSrc).toContain('isBrowserMode()');
  });

  it('20. browser mode still delegates to AgentScheduleExecutor (single authority)', () => {
    expect(providerSrc).toContain('a.broadcast(signer, provider, rawTx)');
    expect(executorSrc).toContain('broadcast: _signAndSend');
    expect(executorSrc).toContain('signer.signTransaction(rawTx)');
  });
});
