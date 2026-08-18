/**
 * MS-3 — FAILURE RECOVERY & CHAOS VALIDATION TESTS
 * ═══════════════════════════════════════════════════════════════════════
 * Proves: a failure at ANY point of execution never produces a second
 * financial broadcast for the same occurrence.
 */
import { describe, it, expect } from 'vitest';
import { ethers as realEthers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const executorSrc = fs.readFileSync(path.join(root, 'public', 'shared', 'agentScheduleExecutor.js'), 'utf8');
const authSrc = fs.readFileSync(path.join(root, 'public', 'shared', 'agentAuthorization.js'), 'utf8');
const policySrc = fs.readFileSync(path.join(root, 'public', 'shared', 'policyEngine.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const RCPT = '0x' + '11'.repeat(20);
const BAL_HEX = '0x' + (10n ** 12n).toString(16).padStart(64, '0');

function makeLocalStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

function makeSchedule(over = {}) {
  return Object.assign({
    id: 'SCH_MS3', type: 'payment', name: 'Pay', token: 'USDC',
    amount: 50, total: 50, recipients: [{ addr: RCPT, amount: 50 }], address: '',
    freq: 'once', maxEx: 0, gas: 0.1,
    nextRun: new Date(Date.now() - 60000).toISOString(),
    execCount: 0, executionHistory: [], status: 'Active',
    created: new Date().toISOString(), createdBy: 'user',
    agentExecution: true, walletAddress: '0x' + '22'.repeat(20),
  }, over);
}

function makeProvider(opts = {}) {
  return {
    sent: [], simCalls: [], sendCalls: 0,
    async getNetwork() { return { chainId: BigInt(opts.chainId ?? 5042002) }; },
    async call(tx) { if (tx && tx.data && tx.data.startsWith('0xa9059cbb')) this.simCalls.push(tx); return BAL_HEX; },
    async getBalance() { return 10n ** 18n; },
    async send(method, params) {
      if (method === 'eth_getTransactionCount') return '0x' + this.sent.length.toString(16);
      if (method === 'eth_sendRawTransaction') {
        this.sendCalls++;
        if (opts.failSend) throw new Error(opts.failSend);
        this.sent.push(params[0]);
        return '0x' + 'ab'.repeat(32);
      }
      throw new Error('unexpected rpc ' + method);
    },
    async waitForTransaction() {
      if (opts.receiptTimeout) throw new Error('timeout');
      return { status: opts.revert ? 0 : 1, blockNumber: 123, gasUsed: 21000n };
    },
    async getTransactionReceipt() { return null; },
  };
}

function boot(opts = {}) {
  const ls = makeLocalStorage();
  const provider = opts.provider || makeProvider(opts.providerOpts || {});
  const signer = new realEthers.Wallet('0x' + '22'.repeat(32));
  const engine = {
    _s: opts.schedules || [makeSchedule(opts.schedule || {})],
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
  globalThis.walletAddress = opts.walletAddress; // simulate a user wallet switch
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

describe('MS-3 — once-schedule failure is terminal (H3)', () => {
  it('on-chain revert → status "Failed" (NOT Active/Paused with nextRun=null)', async () => {
    const env = boot({ providerOpts: { revert: true } });
    grant(env.auth);
    const summary = await env.executor.tickNow();
    expect(summary.failed).toBe(1);
    const sched = env.engine.getById('SCH_MS3');
    expect(sched.status).toBe('Failed');
    expect(sched.nextRun).toBeNull();
    expect(sched.execCount).toBe(0);
  });

  it('broadcast failure (no txHash) → status "Failed", and NOT retried', async () => {
    const env = boot({ providerOpts: { failSend: 'insufficient funds for gas' } });
    grant(env.auth);
    const r1 = await env.executor.tickNow();
    expect(r1.results[0].status).toBe('failed');
    expect(env.provider.sendCalls).toBe(1);
    const r2 = await env.executor.tickNow();
    expect(env.provider.sendCalls).toBe(1); // never re-broadcast
    expect(r2.processed).toBe(0);            // no longer eligible (terminal Failed)
    expect(env.engine.getById('SCH_MS3').status).toBe('Failed');
  });
});

describe('MS-3 — ambiguous broadcast (sendRawTransaction throws)', () => {
  it('a throwing send is treated as unknown → exactly ONE send attempt, no retry', async () => {
    const env = boot({ providerOpts: { failSend: 'network timeout' } });
    grant(env.auth);
    await env.executor.tickNow();
    expect(env.provider.sendCalls).toBe(1);
    await env.executor.tickNow();
    await env.executor.tickNow();
    expect(env.provider.sendCalls).toBe(1); // no blind retry
  });
});

describe('MS-3 — receipt timeout never re-broadcasts', () => {
  it('receipt timeout → submitted + exactly ONE send across ticks', async () => {
    const env = boot({ providerOpts: { receiptTimeout: true } });
    grant(env.auth);
    await env.executor.tickNow();
    expect(env.provider.sendCalls).toBe(1);
    const r2 = await env.executor.tickNow();
    expect(r2.results[0].status).toBe('reconciling');
    expect(env.provider.sendCalls).toBe(1);
  });
});

describe('MS-3 — wallet switch isolation', () => {
  it('agent always signs with the agent signer, ignoring the user wallet', async () => {
    const env = boot({ walletAddress: '0x' + '99'.repeat(20) }); // user switched to wallet B
    grant(env.auth);
    await env.executor.tickNow();
    expect(env.provider.sent.length).toBe(1);
    const parsed = realEthers.Transaction.from(env.provider.sent[0]);
    expect(parsed.from.toLowerCase()).toBe(env.signer.address.toLowerCase()); // agent, not wallet B
  });
});

describe('MS-3 — recurring occurrence isolation', () => {
  it('a failed recurring occurrence advances nextRun (no double, no stuck)', async () => {
    const env = boot({ schedule: { freq: 'daily' }, providerOpts: { revert: true } });
    grant(env.auth);
    const before = env.engine.getById('SCH_MS3').nextRun;
    await env.executor.tickNow();
    const sched = env.engine.getById('SCH_MS3');
    expect(sched.status).toBe('Paused');            // recurring pauses, does not go terminal
    expect(sched.nextRun).not.toBe(before);         // occurrence advanced → new identity
    expect(new Date(sched.nextRun).getTime()).toBeGreaterThan(Date.now());
    // Re-run the SAME (already failed) occurrence → replay-blocked, no re-broadcast.
    env.engine.update('SCH_MS3', { nextRun: before, status: 'Active' });
    await env.executor.tickNow();
    expect(env.provider.sendCalls).toBe(1);         // only the first (failed) attempt
  });
});

describe('MS-3 — 3 simultaneous instances claim the same occurrence', () => {
  function extractEngine() {
    const start = htmlSrc.indexOf('const ScheduleEngine = (() => {');
    const bodyStart = htmlSrc.indexOf('{', start);
    let depth = 0, end = -1;
    for (let j = bodyStart; j < htmlSrc.length; j++) {
      if (htmlSrc[j] === '{') depth++;
      else if (htmlSrc[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    return htmlSrc.slice(start, end + 1) + ')();';
  }
  function makeEngine(ls) {
    const ctx = {
      Store: { load: () => [], save: () => {} },
      localStorage: ls,
      document: { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} },
      Date, JSON, Object, Array, Promise, Math, Number, String,
    };
    vm.createContext(ctx);
    vm.runInContext(extractEngine(), ctx);
    return vm.runInContext('ScheduleEngine', ctx);
  }
  it('A wins, B and C rejected', async () => {
    const ls = makeLocalStorage();
    const A = makeEngine(ls), B = makeEngine(ls), C = makeEngine(ls);
    const key = 'SCH1|2026-01-01T00:00:00.000Z';
    const meta = { scheduleId: 'SCH1', occurrenceId: key, wallet: '0xaaa', chain: 'Arc Testnet' };
    const ra = await A.claimExecution(key, 'agent_schedule_executor', meta);
    const rb = await B.claimExecution(key, 'batch_execution_engine', meta);
    const rc = await C.claimExecution(key, 'manual', meta);
    expect(ra.acquired).toBe(true);
    expect(rb.acquired).toBe(false);
    expect(rc.acquired).toBe(false);
  });
});
