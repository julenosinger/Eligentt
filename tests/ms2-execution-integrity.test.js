/**
 * MS-2 — EXECUTION INTEGRITY TESTS
 * ═══════════════════════════════════════════════════════════════════════
 * Verifies the anti-duplicate-broadcast guarantees added in MS-2:
 *   - Receipt timeout after a KNOWN txHash never produces a second broadcast.
 *   - A submitted occurrence is reconciled (polled), not re-sent.
 *   - BatchExecutionEngine never marks ok:false / revert as completed.
 */
import { describe, it, expect } from 'vitest';
import { ethers as realEthers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const executorSrc = fs.readFileSync(path.join(root, 'public', 'shared', 'agentScheduleExecutor.js'), 'utf8');
const batchSrc = fs.readFileSync(path.join(root, 'public', 'shared', 'BatchExecutionEngine.js'), 'utf8');
const authSrc = fs.readFileSync(path.join(root, 'public', 'shared', 'agentAuthorization.js'), 'utf8');
const policySrc = fs.readFileSync(path.join(root, 'public', 'shared', 'policyEngine.js'), 'utf8');

const RCPT = '0x' + '11'.repeat(20);
const BAL_HEX = '0x' + (10n ** 12n).toString(16).padStart(64, '0');

function makeLocalStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i] || null,
    get length() { return m.size; },
  };
}

function makeSchedule(over = {}) {
  return Object.assign({
    id: 'SCH_MS2', type: 'payment', name: 'Pay', token: 'USDC',
    amount: 50, total: 50, recipients: [{ addr: RCPT, amount: 50 }], address: '',
    freq: 'once', maxEx: 0, gas: 0.1,
    nextRun: new Date(Date.now() - 60000).toISOString(),
    execCount: 0, executionHistory: [], status: 'Active',
    created: new Date().toISOString(), createdBy: 'user',
    agentExecution: true, walletAddress: '0x' + '22'.repeat(20),
  }, over);
}

// Provider whose receipt wait always times out — the tx IS broadcast (hash returned).
function makeTimeoutProvider() {
  return {
    sent: [], simCalls: [],
    async getNetwork() { return { chainId: BigInt(5042002) }; },
    async call(tx) { if (tx && tx.data && tx.data.startsWith('0xa9059cbb')) this.simCalls.push(tx); return BAL_HEX; },
    async getBalance() { return 10n ** 18n; },
    async send(method, params) {
      if (method === 'eth_getTransactionCount') return '0x' + this.sent.length.toString(16);
      if (method === 'eth_sendRawTransaction') { this.sent.push(params[0]); return '0x' + 'cd'.repeat(32); }
      throw new Error('unexpected rpc ' + method);
    },
    async waitForTransaction() { throw new Error('timeout'); },
    async getTransactionReceipt() { return null; },
  };
}

function boot(opts = {}) {
  const ls = makeLocalStorage();
  const provider = opts.provider || makeTimeoutProvider();
  const signer = new realEthers.Wallet('0x' + '22'.repeat(32));
  const engine = {
    _s: opts.schedules || [makeSchedule()],
    getAll() { return this._s; },
    getById(id) { return this._s.find((x) => x.id === id); },
    update(id, ch) { const s = this.getById(id); if (s) Object.assign(s, ch); return s; },
    claimExecution: async () => ({ acquired: true, claim: {} }),
    releaseExecutionClaim: () => true,
    renewExecutionClaim: () => true,
    updateExecutionClaim: () => true,
  };

  globalThis.localStorage = ls;
  globalThis.ethers = realEthers;
  globalThis.ScheduleEngine = engine;
  globalThis.toast = () => {};
  globalThis.AgentWalletManager = Object.assign({
    isShutdown: () => false,
    isPaused: () => false,
    getAgentProvider: () => provider,
    getSessionSigner: async () => signer,
    getAgentAddress: () => signer.address,
    validatePreExecution: () => ({ ok: true }),
    recordExecution: () => {},
    recordOperationSuccess: () => {},
    getSupportedChains: () => ['Arc Testnet'],
  }, opts.wmOverrides || {});

  delete globalThis.RiskEngine;
  delete globalThis.ExecutionQueue;
  delete globalThis.ExecutionHistory;
  delete globalThis.AgentAudit;
  delete globalThis.AgentReputation;
  delete globalThis.ElligenteContracts;
  delete globalThis.ElligenteCCTP;

  const authWin = {};
  new Function('window', 'localStorage', authSrc)(authWin, ls);
  globalThis.AgentAuthorization = authWin.AgentAuthorization;

  const polWin = {};
  new Function('window', policySrc)(polWin);
  globalThis.PolicyEngine = polWin.PolicyEngine;

  const exWin = {};
  new Function('window', 'localStorage', 'document', executorSrc)(exWin, ls, undefined);
  const executor = exWin.AgentScheduleExecutor;

  return { executor, engine, provider, signer, ls, auth: authWin.AgentAuthorization };
}

function grant(auth) {
  return auth.createAuthorization({
    maxSpending: 5000, dailyLimit: null,
    allowedTokens: ['USDC'], allowedNetworks: ['Arc Testnet'],
    allowedOperations: ['payment'], allowPayments: true, allowScheduled: true,
    durationMs: 3600000, maxRiskLevel: 'MEDIUM',
  });
}

describe('MS-2 — receipt timeout never re-broadcasts a submitted occurrence', () => {
  it('single payment: receipt timeout leaves status=submitted and sends exactly ONE tx', async () => {
    const env = boot();
    grant(env.auth);

    const r1 = await env.executor.tickNow();
    expect(env.provider.sent.length).toBe(1);
    expect(r1.results[0].status).toBe('submitted');

    // Second tick: occurrence already has a txHash → reconcile, do NOT re-send.
    const r2 = await env.executor.tickNow();
    expect(env.provider.sent.length).toBe(1);
    expect(r2.results[0].status).toBe('reconciling');

    const log = env.executor.getExecutionLog(5);
    expect(log[0].status).toBe('submitted');
    expect(log[0].txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('multisend: a timed-out row is persisted as submitted and never re-sent', async () => {
    const rcpts = [
      { addr: RCPT, amount: 10 },
      { addr: '0x' + '33'.repeat(20), amount: 15 },
    ];
    const env = boot({ schedules: [makeSchedule({ type: 'multisend', recipients: rcpts, amount: 0, total: 25, freq: 'once' })] });
    grant(env.auth);

    const r1 = await env.executor.tickNow();
    expect(env.provider.sent.length).toBe(1); // first row broadcast, receipt timeout
    expect(r1.results[0].status).toBe('submitted');

    const r2 = await env.executor.tickNow();
    expect(env.provider.sent.length).toBe(1); // no second broadcast
    expect(r2.results[0].status).toBe('reconciling');
  });
});

describe('MS-2 — BatchExecutionEngine never marks ok:false / revert as completed', () => {
  function bootBatch(msStub) {
    const ls = makeLocalStorage();
    globalThis.localStorage = ls;
    globalThis.document = { readyState: 'complete', addEventListener() {}, dispatchEvent() {}, removeEventListener() {} };
    globalThis.CustomEvent = class { constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; } };
    globalThis.ScheduleEngine = {
      claimExecution: async () => ({ acquired: true, claim: {} }),
      releaseExecutionClaim: () => true,
      updateExecutionClaim: () => true,
      getById: (id) => ({ id, freq: 'once', execCount: 0, status: 'Active', nextRun: new Date().toISOString() }),
      update: () => {},
      getAll: () => [],
    };
    globalThis.AgentWalletManager = { isPaused: () => false, getAgentAddress: () => '0x' + '44'.repeat(20) };
    globalThis.AIWallet = { getIntents: () => [], isEmergencyStopped: () => false };
    globalThis._agentExecuteMultiSend = msStub;
    const g = globalThis;
    new Function('window', batchSrc)(g);
    return g;
  }

  const sched = {
    id: 'SCH_BATX', type: 'multisend', token: 'USDC',
    recipients: [{ addr: RCPT, amount: 10 }], amount: 0, total: 10,
    freq: 'once', maxEx: 1, nextRun: new Date().toISOString(),
    status: 'Active', createdBy: 'aiwallet', walletAddress: '0x' + '22'.repeat(20),
  };

  it('ok:false from _agentExecuteMultiSend → execEntry.status = failed (NOT completed)', async () => {
    const g = bootBatch(async () => ({ ok: false, error: 'insufficient balance' }));
    const res = await g.BatchExecutionEngine.executeBatchSchedule(sched);
    expect(res.ok).toBe(false);
    const entries = g.BatchExecutionEngine.getState().executions;
    expect(entries[0].status).toBe('failed');
  });

  it('ok:true from _agentExecuteMultiSend → completed', async () => {
    const g = bootBatch(async () => ({ ok: true, txHash: '0x' + 'ab'.repeat(32) }));
    const res = await g.BatchExecutionEngine.executeBatchSchedule(sched);
    expect(res.ok).toBe(true);
    const entries = g.BatchExecutionEngine.getState().executions;
    expect(entries[0].status).toBe('completed');
  });

  it('a throw from _agentExecuteMultiSend → failed (NOT completed)', async () => {
    const g = bootBatch(async () => { throw new Error('rpc boom'); });
    const res = await g.BatchExecutionEngine.executeBatchSchedule(sched);
    expect(res.ok).toBe(false);
    const entries = g.BatchExecutionEngine.getState().executions;
    expect(entries[0].status).toBe('failed');
  });
});
