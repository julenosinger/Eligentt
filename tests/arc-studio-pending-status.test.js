/**
 * ARC-STUDIO — "Transaction dropped" false status regression tests.
 * ═══════════════════════════════════════════════════════════════════════
 * Real repro: a 0.01 USDC transfer confirmed on Arc Mainnet (tx
 * 0x9fe011c2947fb1eaca2e2ab96348afec0f64c8eb4c802da33065080ccb728ef0) but the
 * UI showed "Transaction dropped / Not confirmed / Pending" because the Circle
 * operation UUID was treated as an EVM tx hash.
 *
 * Covers:
 *   1. Circle returns a UUID with the EVM hash initially absent.
 *   2. Circle later exposes the EVM hash → confirmed.
 *   3. Success receipt → Confirmed.
 *   4. Revert receipt → Failed.
 *   5. RPC unavailable / timeout → NOT "dropped" (submitted/pending).
 *   6. Circle UUID is never used as an EVM hash / explorer link.
 *   7. Repeated polling does not duplicate payments.
 *   8. Autonoma + Smart Wallet share the same correct behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { onRequestPost as statusPost } from '../functions/api/agent-signer/status.js';
import { onRequestPost as broadcastPost } from '../functions/api/agent-signer/broadcast.js';
import { issueProof } from '../functions/api/agent-signer/_proof.mjs';
import { mapStructuredRequest } from '../functions/api/agent-signer/_circle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const providerSrc = fs.readFileSync(path.join(root, 'shared', 'secureSignerProvider.js'), 'utf8');
const executorSrc = fs.readFileSync(path.join(root, 'shared', 'agentScheduleExecutor.js'), 'utf8');
const smartWalletSrc = fs.readFileSync(path.join(root, 'shared', 'aiSmartWallet.js'), 'utf8');
const srcHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const USDC = '0x3600000000000000000000000000000000000000';
const RCPT = '0x01dE545e8Fea5EcAAb78eC2C09E6D98117f7687d';
const REAL_TX = '0x9fe011c2947fb1eaca2e2ab96348afec0f64c8eb4c802da33065080ccb728ef0';
const WALLET_ADDRESS = '0x' + '66'.repeat(20);
const WALLET_ID = 'wallet_test';
const SECRET = 'agent-signer-proof-secret-0123456789';
const EXEC = 'exec_pending_123456';
const SESSION_TOKEN = 'abcdef'.repeat(6);

function makeKV() {
  const map = new Map();
  return {
    async get(k) { return map.has(k) ? map.get(k) : null; },
    async put(k, v) { map.set(k, v); return true; },
    async delete(k) { map.delete(k); return true; },
    _map: map,
  };
}
function makeEnv(over = {}) {
  const kv = makeKV();
  return {
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
}
async function seedSession(env) {
  await env.AUTH_KV.put('session:' + SESSION_TOKEN, JSON.stringify({ userId: 'USR-1', email: 'a@b.c', walletAddress: WALLET_ADDRESS }));
}
function req(body) {
  return new Request('https://example.com/api/agent-signer/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'elligente_sid=' + SESSION_TOKEN },
    body: JSON.stringify(body),
  });
}

describe('ARC-STUDIO — /api/agent-signer/status reconciliation', () => {
  beforeEach(() => { delete globalThis.fetch; });
  afterEach(() => { delete globalThis.fetch; });

  it('1. no EVM hash yet (Circle op UUID only) → pending', async () => {
    const env = makeEnv();
    await seedSession(env);
    await env.AUTH_KV.put('agent:exec:' + EXEC, JSON.stringify({
      executionId: EXEC, chainId: 5042, walletAddress: WALLET_ADDRESS.toLowerCase(),
      status: 'pending', circleId: 'op-uuid-1', circleState: 'PENDING', txHash: null,
    }));
    // Circle getTransaction returns no txHash yet
    globalThis.fetch = async (url) => {
      if (String(url).includes('/transactions/op-uuid-1')) return { ok: true, json: async () => ({ data: { id: 'op-uuid-1', state: 'PENDING', txHash: null } }) };
      throw new Error('unexpected ' + url);
    };
    const r = await statusPost({ request: req({ executionId: EXEC }), env });
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d.status).toBe('pending');
    expect(d.txHash).toBeNull();
    expect(d.circleOperationId).toBe('op-uuid-1');
  });

  it('2. Circle later exposes EVM hash → submitted (then confirmed via receipt)', async () => {
    const env = makeEnv();
    await seedSession(env);
    await env.AUTH_KV.put('agent:exec:' + EXEC, JSON.stringify({
      executionId: EXEC, chainId: 5042, walletAddress: WALLET_ADDRESS.toLowerCase(),
      status: 'pending', circleId: 'op-uuid-1', circleState: 'COMPLETE', txHash: null,
    }));
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/transactions/op-uuid-1')) return { ok: true, json: async () => ({ data: { id: 'op-uuid-1', state: 'COMPLETE', txHash: REAL_TX } }) };
      if (u.includes('rpc.mainnet.arc.io') || u.includes('drpc')) return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: null }) };
      throw new Error('unexpected ' + url);
    };
    const r = await statusPost({ request: req({ executionId: EXEC }), env });
    const d = await r.json();
    expect(d.txHash).toBe(REAL_TX);
    expect(d.status).toBe('submitted');
  });

  it('3. receipt status 1 → confirmed (with the real EVM hash)', async () => {
    const env = makeEnv();
    await seedSession(env);
    await env.AUTH_KV.put('agent:exec:' + EXEC, JSON.stringify({
      executionId: EXEC, chainId: 5042, walletAddress: WALLET_ADDRESS.toLowerCase(),
      status: 'submitted', circleId: 'op-uuid-1', circleState: 'COMPLETE', txHash: REAL_TX,
    }));
    globalThis.fetch = async (url) => {
      if (String(url).includes('rpc.mainnet.arc.io') || String(url).includes('drpc')) {
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: { status: '0x1', blockNumber: '0x1827d8b', transactionHash: REAL_TX } }) };
      }
      throw new Error('unexpected ' + url);
    };
    const r = await statusPost({ request: req({ executionId: EXEC }), env });
    const d = await r.json();
    expect(d.status).toBe('confirmed');
    expect(d.txHash).toBe(REAL_TX);
  });

  it('4. receipt status 0 → failed (proven revert)', async () => {
    const env = makeEnv();
    await seedSession(env);
    await env.AUTH_KV.put('agent:exec:' + EXEC, JSON.stringify({
      executionId: EXEC, chainId: 5042, walletAddress: WALLET_ADDRESS.toLowerCase(),
      status: 'submitted', circleId: 'op-uuid-1', circleState: 'COMPLETE', txHash: REAL_TX,
    }));
    globalThis.fetch = async (url) => {
      if (String(url).includes('rpc.mainnet.arc.io') || String(url).includes('drpc')) {
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: { status: '0x0', transactionHash: REAL_TX } }) };
      }
      throw new Error('unexpected ' + url);
    };
    const r = await statusPost({ request: req({ executionId: EXEC }), env });
    const d = await r.json();
    expect(d.status).toBe('failed');
  });

  it('5. RPC unavailable → submitted (NOT failed / dropped)', async () => {
    const env = makeEnv();
    await seedSession(env);
    await env.AUTH_KV.put('agent:exec:' + EXEC, JSON.stringify({
      executionId: EXEC, chainId: 5042, walletAddress: WALLET_ADDRESS.toLowerCase(),
      status: 'submitted', circleId: 'op-uuid-1', circleState: 'COMPLETE', txHash: REAL_TX,
    }));
    globalThis.fetch = async () => { throw new Error('network down'); };
    const r = await statusPost({ request: req({ executionId: EXEC }), env });
    const d = await r.json();
    expect(d.status).toBe('submitted');
    expect(d.txHash).toBe(REAL_TX);
  });
});

describe('ARC-STUDIO — broadcast never returns a Circle UUID as tx hash', () => {
  function evalProvider(win) {
    const fn = new Function('window', providerSrc);
    fn.call(null, win);
    return win.SecureSignerProvider;
  }
  beforeEach(() => {
    delete globalThis.fetch;
    delete globalThis.localStorage;
    delete globalThis.AgentScheduleExecutor;
  });
  afterEach(() => { delete globalThis.fetch; delete globalThis.localStorage; });

  it('6. broadcast returns "pending:" marker when Circle returns UUID with no EVM hash', async () => {
    const win = { SecureSignerProvider: undefined, AUTONOMA_SIGNER_PROVIDER: undefined };
    const p = evalProvider(win);
    p.setMode('circle');
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes('/config')) return { ok: true, json: async () => ({ available: true, address: WALLET_ADDRESS }) };
      if (u.includes('/authorize')) return { ok: true, json: async () => ({ ok: true, authorizationProof: 'proof.aaaa' }) };
      if (u.includes('/broadcast')) return { ok: true, json: async () => ({ ok: true, txHash: null, id: 'op-uuid-1', state: 'PENDING' }) };
      throw new Error('unexpected ' + u);
    };
    const out = await p.broadcast({}, {}, { chainId: 5042 }, { operation: 'payment', executionId: EXEC, circle: { type: 'transfer', tokenAddress: USDC, to: RCPT, amount: '20000' } });
    expect(out).toMatch(/^pending:/);
    expect(out).not.toBe('op-uuid-1');
    expect(out).not.toContain('0x'); // no fake hash
  });

  it('6b. broadcast returns the REAL EVM hash when present', async () => {
    const win = { SecureSignerProvider: undefined, AUTONOMA_SIGNER_PROVIDER: undefined };
    const p = evalProvider(win);
    p.setMode('circle');
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/config')) return { ok: true, json: async () => ({ available: true, address: WALLET_ADDRESS }) };
      if (u.includes('/authorize')) return { ok: true, json: async () => ({ ok: true, authorizationProof: 'proof.aaaa' }) };
      if (u.includes('/broadcast')) return { ok: true, json: async () => ({ ok: true, txHash: REAL_TX, id: 'op-uuid-1', state: 'COMPLETE' }) };
      throw new Error('unexpected ' + u);
    };
    const out = await p.broadcast({}, {}, { chainId: 5042 }, { operation: 'payment', executionId: EXEC, circle: { type: 'transfer', tokenAddress: USDC, to: RCPT, amount: '20000' } });
    expect(out).toBe(REAL_TX);
  });
});

describe('ARC-STUDIO — structural invariants (no false "dropped", no UUID-as-hash)', () => {
  it('7. agentScheduleExecutor reconciles pending markers and never reports "dropped" on timeout', () => {
    expect(executorSrc).toContain("indexOf('pending:') === 0");
    expect(executorSrc).toContain('_waitPendingOperation');
    expect(executorSrc).toContain('getOperationStatus');
    expect(executorSrc).not.toContain("'DROPPED'");
  });

  it('8. index.html payment path renders ArcScan link only for a real EVM hash', () => {
    const payBranch = srcHtml.slice(srcHtml.indexOf("var _hasEVM"), srcHtml.indexOf("else if(operation==='swap')"));
    expect(payBranch).toContain('/^0x[0-9a-fA-F]{64}$/');
    expect(payBranch).toContain('_hasEVM');
    expect(payBranch).toContain('_resolvedHash');
    expect(payBranch).not.toContain("'DROPPED'");
    expect(payBranch).not.toContain("'Not confirmed'");
  });

  it('8b. Smart Wallet uses waitReceipt to reconcile pending (no false confirmed/failed)', () => {
    const agentSend = smartWalletSrc.slice(smartWalletSrc.indexOf('if (aSigner.isRemote)'), smartWalletSrc.indexOf('Browser/dev mode'));
    expect(agentSend).toContain('SecureSignerProvider.waitReceipt');
    expect(agentSend).toContain('pending');
  });

  it('8c. secureSignerProvider exposes getOperationStatus for reconciliation', () => {
    expect(providerSrc).toContain('getOperationStatus');
    expect(providerSrc).toContain('/api/agent-signer/status');
    // never return the Circle UUID as the tx hash
    expect(providerSrc).not.toContain('return res.id');
  });
});

describe('ARC-STUDIO — idempotency (repeated polling does not duplicate payments)', () => {
  it('broadcast endpoint returns idempotent for an already-submitted executionId', async () => {
    delete globalThis.fetch;
    const env = makeEnv();
    await seedSession(env);
    const desc = mapStructuredRequest({ type: 'transfer', tokenAddress: USDC, to: RCPT, amount: '20000' });
    const proof = await issueProof(env, {
      executionId: EXEC, userId: 'USR-1', chainId: 5042, operation: 'payment',
      walletId: WALLET_ID, walletAddress: WALLET_ADDRESS.toLowerCase(),
      contractAddress: desc.contractAddress, abiFunctionSignature: desc.abiFunctionSignature,
      abiParameters: desc.abiParameters, destination: RCPT.toLowerCase(), amount: '20000',
    });
    await env.AUTH_KV.put('agent:exec:' + EXEC, JSON.stringify({ executionId: EXEC, status: 'submitted', txHash: REAL_TX, circleId: 'op-uuid-1' }));
    globalThis.fetch = async (url) => {
      if (String(url).includes('rpc.mainnet.arc.io') || String(url).includes('drpc')) return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x0' }) };
      throw new Error('unexpected ' + url);
    };
    const r = await broadcastPost({ request: req({ executionId: EXEC, chainId: 5042, operation: 'payment', authorizationProof: proof.token, request: { type: 'transfer', tokenAddress: USDC, to: RCPT, amount: '20000' } }), env });
    const d = await r.json();
    expect(d.idempotent).toBe(true);
    expect(d.txHash).toBe(REAL_TX);
  });
});
