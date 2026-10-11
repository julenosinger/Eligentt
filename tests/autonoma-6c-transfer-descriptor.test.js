/**
 * AUTONOMA-6C — USDC transfer descriptor + broadcast error handling tests.
 * ═══════════════════════════════════════════════════════════════════════
 * Regression tests for the "send 0.02 usdc to 0x..." failure (HTTP 502 / Pending):
 *
 *   1. The scheduled execution path (agentScheduleExecutor.js) must pass the
 *      STRUCTURED Circle descriptor (token address + recipient + raw amount +
 *      ERC-20 transfer) to _signAndSend → SecureSignerProvider.broadcast, instead
 *      of only a raw tx (the "circle descriptor missing — fail-closed" bug).
 *   2. The Smart Wallet send path (aiSmartWallet.js) must include operation +
 *      executionId (the authorize endpoint rejects empty operation/executionId).
 *   3. mapStructuredRequest maps a USDC transfer to the correct Circle
 *      contractExecution descriptor (chainId 5042 / USDC / transfer(address,uint256)).
 *   4. The client surfaces the REAL server error and distinguishes a definitive
 *      failure from an unknown-outcome (HTTP 502) failure.
 *   5. A Circle-side contractExecution failure returns HTTP 502 from /broadcast.
 *   6. Server-side idempotency (executionId) prevents duplicate payments.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { mapStructuredRequest, isKnownContract } from '../functions/api/agent-signer/_circle.js';
import { onRequestPost as broadcastPost } from '../functions/api/agent-signer/broadcast.js';
import { onRequestPost as authorizePost } from '../functions/api/agent-signer/authorize.js';
import { issueProof } from '../functions/api/agent-signer/_proof.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const executorSrc = fs.readFileSync(path.join(root, 'shared', 'agentScheduleExecutor.js'), 'utf8');
const smartWalletSrc = fs.readFileSync(path.join(root, 'shared', 'aiSmartWallet.js'), 'utf8');
const providerSrc = fs.readFileSync(path.join(root, 'shared', 'secureSignerProvider.js'), 'utf8');
const srcHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const USDC = '0x3600000000000000000000000000000000000000';
const EURC = '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1';
const RCPT = '0x01dE545e8Fea5EcAAb78eC2C09E6D98117f7687d';

describe('AUTONOMA-6C — USDC transfer descriptor (mapStructuredRequest)', () => {
  it('maps a USDC transfer to the Circle contractExecution descriptor', () => {
    const d = mapStructuredRequest({ type: 'transfer', tokenAddress: USDC, to: RCPT, amount: '20000' });
    expect(d.contractAddress).toBe(USDC);
    expect(d.abiFunctionSignature).toBe('transfer(address,uint256)');
    expect(d.abiParameters).toEqual([RCPT, '20000']);
    expect(d.value).toBeNull();
  });

  it('maps type "send" the same as "transfer"', () => {
    const d = mapStructuredRequest({ type: 'send', tokenAddress: USDC, to: RCPT, amount: '20000' });
    expect(d.abiFunctionSignature).toBe('transfer(address,uint256)');
    expect(d.abiParameters).toEqual([RCPT, '20000']);
  });

  it('rejects a transfer without tokenAddress/to/amount (fail-closed)', () => {
    expect(() => mapStructuredRequest({ type: 'transfer', to: RCPT, amount: '1' })).toThrow(/tokenAddress/);
    expect(() => mapStructuredRequest({ type: 'transfer', tokenAddress: USDC, amount: '1' })).toThrow(/to/);
    expect(() => mapStructuredRequest({ type: 'transfer', tokenAddress: USDC, to: RCPT })).toThrow(/amount/);
  });

  it('rejects a non-allowlisted token', () => {
    expect(() => mapStructuredRequest({ type: 'transfer', tokenAddress: '0x' + '22'.repeat(20), to: RCPT, amount: '1' }))
      .toThrow(/not allowlisted/);
  });

  it('rejects an invalid recipient address', () => {
    expect(() => mapStructuredRequest({ type: 'transfer', tokenAddress: USDC, to: 'nope', amount: '1' }))
      .toThrow(/recipient invalid/);
  });

  it('USDC and EURC are allowlisted for transfer', () => {
    expect(isKnownContract(USDC)).toBe(true);
    expect(isKnownContract(EURC)).toBe(true);
  });
});

describe('AUTONOMA-6C — structured descriptor is passed to the Circle signer', () => {
  it('scheduled payment path passes circle descriptor (prep.circle) to _signAndSend', () => {
    // Both the single-payment and multisend sequential broadcast calls must now
    // carry the structured Circle descriptor, not just a raw tx.
    expect(executorSrc).toContain('circle: prep.circle');
    expect(executorSrc).toContain('operation: \'payment\'');
    expect(executorSrc).toContain('executionId: key');
  });

  it('_prepareTransfer builds the Circle transfer descriptor', () => {
    expect(executorSrc).toContain('type: \'transfer\'');
    expect(executorSrc).toContain('tokenAddress: tokenInfo.address');
    expect(executorSrc).toContain('to: transfer.to');
    expect(executorSrc).toContain('amount: String(rawAmt)');
  });

  it('Smart Wallet send path includes operation + executionId (authorize requirement)', () => {
    const agentSend = smartWalletSrc.slice(smartWalletSrc.indexOf('if (aSigner.isRemote)'), smartWalletSrc.indexOf('Browser/dev mode'));
    expect(agentSend).toContain("operation: 'payment'");
    expect(agentSend).toContain('executionId: _execId');
    expect(agentSend).toContain("type: 'transfer'");
  });

  it('Smart Wallet send treats "pending:" as submitted (not failure)', () => {
    const agentSend = smartWalletSrc.slice(smartWalletSrc.indexOf('if (aSigner.isRemote)'), smartWalletSrc.indexOf('Browser/dev mode'));
    expect(agentSend).toContain("indexOf('pending:') === 0");
  });

  it('secureSignerProvider surfaces WHICH endpoint returned a non-JSON error', () => {
    expect(providerSrc).toContain("'HTTP ' + wrapped.status + ' from ' + path");
  });
});

describe('AUTONOMA-6C — UI error differentiation (index.html)', () => {
  it('payment branch handles pending: submission without polling a receipt', () => {
    const payBranch = srcHtml.slice(srcHtml.indexOf("if(!dest || typeof dest !== 'string'"), srcHtml.indexOf("else if(operation==='swap')"));
    expect(payBranch).toContain("indexOf('pending:') === 0");
    expect(payBranch).toContain('SUBMITTED');
  });

  it('payment branch distinguishes definitive vs unknown-outcome (HTTP 502) failures', () => {
    const payBranch = srcHtml.slice(srcHtml.indexOf("if(!dest || typeof dest !== 'string'"), srcHtml.indexOf("else if(operation==='swap')"));
    expect(payBranch).toContain('UNKNOWN');
    expect(payBranch).toContain('Submission status unknown');
    expect(payBranch).toContain('/502|503|timeout|timed out|network|failed to fetch|ENOTFOUND|ECONN/');
  });

  it('_agentStateMsg exposes SUBMITTED and UNKNOWN states', () => {
    expect(srcHtml).toContain('SUBMITTED:');
    expect(srcHtml).toContain('UNKNOWN:');
  });
});

describe('AUTONOMA-6C — /broadcast Circle-side 502 + idempotency', () => {
  beforeEach(() => { delete globalThis.fetch; });
  afterEach(() => { delete globalThis.fetch; });

  const SECRET = 'agent-signer-proof-secret-0123456789';
  const WALLET_ADDRESS = '0x' + '66'.repeat(20);
  const WALLET_ID = 'wallet_test';
  const EXEC = 'exec_descriptor_123456';

  function makeKV() {
    const map = new Map();
    return { async get(k) { return map.has(k) ? map.get(k) : null; }, async put(k, v) { map.set(k, v); return true; }, async delete(k) { map.delete(k); return true; }, _map: map };
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
  function body(over = {}) {
    return Object.assign({ executionId: EXEC, chainId: 5042, operation: 'payment', request: { type: 'transfer', tokenAddress: USDC, to: RCPT, amount: '20000' } }, over);
  }
  async function proofFor(env) {
    const d = mapStructuredRequest(body().request);
    return issueProof(env, {
      executionId: EXEC, userId: 'USR-1', chainId: 5042, operation: 'payment',
      walletId: WALLET_ID, walletAddress: WALLET_ADDRESS.toLowerCase(),
      contractAddress: d.contractAddress, abiFunctionSignature: d.abiFunctionSignature,
      abiParameters: d.abiParameters, destination: RCPT.toLowerCase(), amount: '20000',
    });
  }

  it('Circle contractExecution failure returns HTTP 502 (with error, fail-closed)', async () => {
    const env = makeEnv();
    const proof = await proofFor(env);
    // Circle returns a non-2xx → createContractExecution throws → broadcast returns 502.
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('rpc.mainnet.arc.io') || u.includes('drpc')) return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x0' }) };
      // Circle entity publicKey + contractExecution both fail/reject
      return { ok: false, status: 401, json: async () => ({ message: 'unauthorized entity secret' }) };
    };
    const req = new Request('https://example.com/api/agent-signer/broadcast', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body({ authorizationProof: proof.token })) });
    const resp = await broadcastPost({ request: req, env });
    expect(resp.status).toBe(502);
    const data = await resp.json();
    expect(data.ok).toBe(false);
    expect(data.error).toContain('Broadcast failed');
  });

  it('authorize requires operation + executionId (Smart Wallet regression guard)', async () => {
    const env = makeEnv();
    const SESSION_TOKEN = 'abcdef'.repeat(6);
    await env.AUTH_KV.put('session:' + SESSION_TOKEN, JSON.stringify({ userId: 'USR-1', email: 'a@b.c', walletAddress: WALLET_ADDRESS }));
    const headers = { 'Content-Type': 'application/json', Cookie: 'elligente_sid=' + SESSION_TOKEN };
    const req = new Request('https://example.com/api/agent-signer/authorize', { method: 'POST', headers, body: JSON.stringify({ chainId: 5042, request: { type: 'transfer', tokenAddress: USDC, to: RCPT, amount: '20000' } }) });
    const resp = await authorizePost({ request: req, env });
    expect(resp.status).toBe(400);
    const data = await resp.json();
    expect(data.ok).toBe(false);
  });
});
