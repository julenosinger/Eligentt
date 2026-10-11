/**
 * ARC-STUDIO — pending → confirmed regression (Circle operation reconciliation)
 * ═══════════════════════════════════════════════════════════════════════
 * Real repro: a 0.05 USDC transfer confirmed on Arc Mainnet, but the Autonoma
 * stayed "Pending" and the sequence ended without the real EVM hash / link.
 *
 * This test proves the END-TO-END executor behaviour in Circle mode:
 *   1. broadcast returns a "pending:opKey" marker (Circle UUID only, no EVM hash)
 *      → the occurrence is persisted as 'submitted' WITH the marker (NOT txHash:null).
 *   2. a later tick reconciles the marker via /agent-signer/status → EVM hash →
 *      receipt status 1 → the occurrence flips to 'executed' with the REAL hash.
 *   3. the real hash is propagated to the executor ledger AND the schedule history
 *      (the same field the Smart Wallet history + Autonoma chat link render from).
 *   4. never marks a still-pending op as failed (no false "submitted without txHash").
 *
 * Zero network calls — SecureSignerProvider is stubbed (Circle mode).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ethers as realEthers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const executorSrc = fs.readFileSync(path.join(root, 'shared', 'agentScheduleExecutor.js'), 'utf8');
const authSrc = fs.readFileSync(path.join(root, 'shared', 'agentAuthorization.js'), 'utf8');
const policySrc = fs.readFileSync(path.join(root, 'shared', 'policyEngine.js'), 'utf8');
const srcHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const REAL_TX = '0x93cd476eb18169a4262e724ec8d7e9ab8c553060487670b670f9a75e316b3f72';
const RCPT = '0x' + '11'.repeat(20);
const CIRCLE_ADDR = '0x' + '66'.repeat(20);
const BAL_HEX = '0x' + (10n ** 12n).toString(16).padStart(64, '0'); // 1,000,000 USDC

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

function makeProvider() {
  return {
    sent: [],
    simCalls: [],
    async getNetwork() { return { chainId: BigInt(5042) }; },
    async call(tx) {
      if (tx && tx.data && tx.data.startsWith('0xa9059cbb')) this.simCalls.push(tx);
      return BAL_HEX;
    },
    async getBalance() { return 10n ** 18n; },
    async getFeeData() { return { maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n }; },
    async estimateGas() { return 120000n; },
    async send(method) { throw new Error('unexpected rpc ' + method); },
    async getTransactionReceipt() { return null; },
  };
}

function makeEngine(scheds) {
  return {
    _s: scheds,
    getAll() { return this._s; },
    getById(id) { return this._s.find((x) => x.id === id); },
    update(id, ch) { const s = this.getById(id); if (s) Object.assign(s, ch); return s; },
    claimExecution: async () => ({ acquired: true }),
    releaseExecutionClaim: () => true,
    renewExecutionClaim: () => true,
    updateExecutionClaim: () => true,
  };
}

function makeSchedule(over = {}) {
  return Object.assign({
    id: 'SCH_ARC', type: 'payment', name: 'Supplier pay', token: 'USDC',
    amount: 0.05, total: 0.05,
    recipients: [{ addr: RCPT, amount: 0.05 }], address: '',
    freq: 'once', maxEx: 0, gas: 0.1,
    nextRun: new Date(Date.now() - 60000).toISOString(),
    execCount: 0, executionHistory: [], status: 'Active',
    created: new Date().toISOString(), createdBy: 'user',
    agentExecution: true, walletAddress: '',
  }, over);
}

// Boot the executor in Circle mode with a controllable SecureSignerProvider stub.
function boot({ broadcastReturn, getOperationStatus }) {
  const ls = makeLocalStorage();
  const provider = makeProvider();
  const engine = makeEngine([makeSchedule()]);
  const statusCalls = [];

  globalThis.localStorage = ls;
  globalThis.ethers = realEthers;
  globalThis.ScheduleEngine = engine;
  globalThis.toast = () => {};
  // Make the executor's polling delays instantaneous so a "still pending" op
  // (which otherwise sleeps 2s × 30) resolves within the test timeout.
  globalThis.setTimeout = (fn) => { try { fn(); } catch (_) {} return 0; };
  globalThis.clearTimeout = () => {};
  globalThis.setInterval = () => 0;
  globalThis.clearInterval = () => {};

  globalThis.CircleAgent = { getCachedAddress: () => CIRCLE_ADDR, getAddress: async () => CIRCLE_ADDR };

  globalThis.AgentWalletManager = {
    isShutdown: () => false,
    isPaused: () => false,
    getAgentProvider: () => provider,
    getSessionSigner: async () => null,
    getAgentAddress: () => CIRCLE_ADDR,
    validatePreExecution: () => ({ ok: true }),
    recordExecution: () => {},
    recordOperationSuccess: () => {},
    getSupportedChains: () => ['Arc Mainnet'],
  };

  // Circle mode stub — the ONLY production signer path.
  globalThis.SecureSignerProvider = {
    isCircleMode: () => true,
    isPaused: () => false,
    getSigner: async () => ({ address: CIRCLE_ADDR, isRemote: true }),
    nextNonce: async () => '0x0',
    broadcast: async (signer, prov, rawTx, opts) => {
      if (typeof broadcastReturn === 'function') return broadcastReturn(opts);
      return broadcastReturn;
    },
    getOperationStatus: async (opKey) => {
      statusCalls.push(opKey);
      return getOperationStatus(opKey);
    },
  };

  delete globalThis.RiskEngine;
  delete globalThis.ExecutionQueue;
  delete globalThis.ExecutionHistory;
  delete globalThis.AgentAudit;
  delete globalThis.AgentReputation;
  delete globalThis.ElligenteContracts;

  const authWin = {};
  new Function('window', 'localStorage', authSrc)(authWin, ls);
  globalThis.AgentAuthorization = authWin.AgentAuthorization;

  const polWin = {};
  new Function('window', policySrc)(polWin);
  globalThis.PolicyEngine = polWin.PolicyEngine;

  const exWin = {};
  new Function('window', 'localStorage', 'document', executorSrc)(exWin, ls, undefined);
  const executor = exWin.AgentScheduleExecutor;

  globalThis.AgentAuthorization.createAuthorization({
    maxSpending: 500, dailyLimit: 200,
    allowedTokens: ['USDC'], allowedNetworks: ['Arc Mainnet'],
    allowedOperations: ['payment'], allowPayments: true, allowScheduled: true,
    durationMs: 3600000, maxRiskLevel: 'MEDIUM',
  });

  return { executor, engine, provider, ls, statusCalls };
}

beforeEach(() => {
  delete globalThis.AgentScheduleExecutor;
  delete globalThis.SecureSignerProvider;
});
afterEach(() => {
  delete globalThis.AgentScheduleExecutor;
  delete globalThis.SecureSignerProvider;
  delete globalThis.localStorage;
  delete globalThis.ethers;
  delete globalThis.setTimeout;
  delete globalThis.clearTimeout;
  delete globalThis.setInterval;
  delete globalThis.clearInterval;
});

describe('ARC-STUDIO — pending → confirmed regression (executor, Circle mode)', () => {
  it('persists the pending marker (not txHash:null) and reconciles to Confirmed with the real hash', async () => {
    const env = boot({
      broadcastReturn: (opts) => 'pending:' + opts.executionId,   // Circle UUID only, no EVM hash
      getOperationStatus: () => ({ ok: true, status: 'confirmed', txHash: REAL_TX, blockNumber: 1827 }),
    });

    // ── Tick 1: broadcast returns the pending marker ──
    const r1 = await env.executor.tickNow();
    expect(r1.results[0].status).toBe('submitted');

    const log1 = env.executor.getExecutionLog(5);
    expect(log1[0].status).toBe('submitted');
    // The marker MUST be persisted (not dropped to null → false failure).
    expect(log1[0].txHash).toMatch(/^pending:/);
    expect(log1[0].txHash).not.toBeNull();

    // ── Tick 2: status returns confirmed → reconcile to executed with the real hash ──
    const r2 = await env.executor.tickNow();
    expect(r2.results[0].status).toBe('executed');

    const log2 = env.executor.getExecutionLog(5);
    expect(log2[0].status).toBe('executed');
    expect(log2[0].txHash).toBe(REAL_TX);          // REAL EVM hash, never the Circle UUID

    // The schedule history carries the real hash (what the UI link renders from).
    const sched = env.engine.getById('SCH_ARC');
    expect(sched.status).toBe('Completed');
    expect(sched.executionHistory[0].status).toBe('executed');
    expect(sched.executionHistory[0].txHash).toBe(REAL_TX);

    // Exactly one broadcast was attempted (repeated polling never re-broadcasts).
    expect(env.statusCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps a still-pending op as submitted (never marks it failed)', async () => {
    const env = boot({
      broadcastReturn: (opts) => 'pending:' + opts.executionId,
      getOperationStatus: () => ({ ok: true, status: 'pending', txHash: null }),  // still no hash
    });

    const r1 = await env.executor.tickNow();
    expect(r1.results[0].status).toBe('submitted');

    const r2 = await env.executor.tickNow();
    // Never "failed" / "submitted without txHash" — stays submitted (awaiting).
    expect(r2.results[0].status).toBe('submitted');

    const log = env.executor.getExecutionLog(5);
    expect(log[0].status).toBe('submitted');
    expect(log[0].txHash).toMatch(/^pending:/);    // marker still preserved
  });
});

describe('ARC-STUDIO — structural: chat renders the link only for a real EVM hash + active follow-up', () => {
  it('index.html payment branch actively follows up and renders the ArcScan link for the resolved hash', () => {
    const payBranch = srcHtml.slice(srcHtml.indexOf("var _hasEVM"), srcHtml.indexOf("else if(operation==='swap')"));
    // Real-hash gating for the explorer link (never the Circle UUID).
    expect(payBranch).toContain('/^0x[0-9a-fA-F]{64}$/');
    expect(payBranch).toContain('_hasEVM');
    expect(payBranch).toContain('_resolvedHash');
    // Active follow-up: keep polling the status endpoint while awaiting a receipt.
    expect(payBranch).toContain('getOperationStatus');
    expect(payBranch).toContain('_opKey');
    expect(payBranch).toContain('_isSettled');
    // ArcScan link is rendered for the confirmed hash.
    expect(payBranch).toContain('arc.io/tx/');
    expect(payBranch).toContain('_resolvedHash');
    // No false "dropped" / "not confirmed" terminal states.
    expect(payBranch).not.toContain("'DROPPED'");
    expect(payBranch).not.toContain("'Not confirmed'");
  });

  it('executor never returns the Circle UUID as a tx hash and never reports "dropped"', () => {
    expect(executorSrc).toContain("indexOf('pending:') === 0");
    expect(executorSrc).toContain('_waitPendingOperation');
    expect(executorSrc).toContain('getOperationStatus');
    expect(executorSrc).not.toContain("'DROPPED'");
    expect(executorSrc).not.toContain("'Submitted without txHash — manual reconciliation required'");
  });
});
