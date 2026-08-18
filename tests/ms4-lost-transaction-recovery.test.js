/**
 * MS-4 — LOST TRANSACTION RECOVERY & NONCE RECONCILIATION TESTS
 * ═══════════════════════════════════════════════════════════════════════
 * Proves: if eth_sendRawTransaction may already have broadcast a transaction
 * and the app crashes before persisting the txHash, the original transaction is
 * recovered by nonce + fingerprint WITHOUT ever broadcasting a second time.
 */
import { describe, it, expect } from 'vitest';
import { ethers as realEthers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const executorSrc = fs.readFileSync(path.join(root, 'public', 'shared', 'agentScheduleExecutor.js'), 'utf8');
const authSrc = fs.readFileSync(path.join(root, 'public', 'shared', 'agentAuthorization.js'), 'utf8');
const policySrc = fs.readFileSync(path.join(root, 'public', 'shared', 'policyEngine.js'), 'utf8');

const RCPT = '0x' + '11'.repeat(20);
const USDC = '0x3600000000000000000000000000000000000000';
const BAL_HEX = '0x' + (10n ** 12n).toString(16).padStart(64, '0');
const LEDGER_KEY = 'elligentt_agent_sched_exec_v1';

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
    id: 'SCH_MS4', type: 'payment', name: 'Pay', token: 'USDC',
    amount: 50, total: 50, recipients: [{ addr: RCPT, amount: 50 }], address: '',
    freq: 'once', maxEx: 0, gas: 0.1,
    nextRun: new Date(Date.now() - 60000).toISOString(),
    execCount: 0, executionHistory: [], status: 'Active',
    created: new Date().toISOString(), createdBy: 'user',
    agentExecution: true, walletAddress: '0x' + '22'.repeat(20),
  }, over);
}

// Provider for MS-4: tracks send calls, supports eth_getTransactionByNonce.
function makeProvider(opts = {}) {
  const txByNonce = opts.txByNonce; // function(nonce) -> tx object | null
  return {
    sent: [], simCalls: [], sendCalls: 0, ledgerAtSend: null, lastSigned: null,
    async getNetwork() { return { chainId: BigInt(5042002) }; },
    async call(tx) { if (tx && tx.data && tx.data.startsWith('0xa9059cbb')) this.simCalls.push(tx); return BAL_HEX; },
    async getBalance() { return 10n ** 18n; },
    async send(method, params) {
      if (method === 'eth_getTransactionCount') {
        if (params[1] === 'pending') return '0x' + (opts.pendingCount ?? this.sent.length).toString(16);
        return '0x' + (opts.latestCount ?? this.sent.length).toString(16);
      }
      if (method === 'eth_getTransactionByNonce') {
        // If requested, reconstruct the exact tx from the last signed raw tx (simulates
        // the network accepting it even though eth_sendRawTransaction later threw).
        if (opts.resolveSent && this.lastSigned) {
          const parsed = realEthers.Transaction.from(this.lastSigned);
          return { hash: parsed.hash, from: parsed.from, to: parsed.to, input: parsed.data, value: parsed.value, nonce: parsed.nonce };
        }
        const nonce = parseInt(params[1], 16);
        return (typeof txByNonce === 'function') ? txByNonce(nonce) : null;
      }
      if (method === 'eth_sendRawTransaction') {
        this.sendCalls++;
        this.lastSigned = params[0];
        this.ledgerAtSend = (typeof localStorage !== 'undefined') ? localStorage.getItem(LEDGER_KEY) : null;
        if (opts.failSend) throw new Error(opts.failSend);
        this.sent.push(params[0]);
        return realEthers.Transaction.from(params[0]).hash;
      }
      throw new Error('unexpected rpc ' + method);
    },
    async waitForTransaction() {
      if (opts.receiptTimeout) throw new Error('timeout');
      return { status: opts.revert ? 0 : 1, blockNumber: 123, gasUsed: 21000n };
    },
    async getTransactionReceipt() {
      if (opts.noReceipt) return null;
      return { status: opts.receiptStatus ?? 1, blockNumber: 123, gasUsed: 21000n };
    },
  };
}

function boot(opts = {}) {
  const ls = opts.ls || makeLocalStorage();
  const provider = opts.provider || makeProvider(opts.providerOpts || {});
  const signer = new realEthers.Wallet('0x' + '22'.repeat(32));
  const schedule = makeSchedule(opts.schedule || {});
  const engine = {
    _s: [schedule],
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

  return { executor, engine, provider, signer, ls, auth: authWin.AgentAuthorization, schedule };
}

function grant(auth) {
  return auth.createAuthorization({
    maxSpending: 5000, dailyLimit: null,
    allowedTokens: ['USDC'], allowedNetworks: ['Arc Testnet'],
    allowedOperations: ['payment'], allowPayments: true, allowScheduled: true,
    durationMs: 3600000, maxRiskLevel: 'MEDIUM',
  });
}

function injectUnknownIntent(ls, schedule, agentAddr, intent) {
  const key = schedule.id + '|' + schedule.nextRun;
  const ledger = JSON.parse(ls.getItem(LEDGER_KEY) || '{}');
  ledger[key] = Object.assign({
    status: 'execution_unknown', nonce: 0, from: agentAddr,
    to: USDC, data: '0xa9059cbb', value: '0x0', chainId: 5042002,
    fingerprint: 'fp', ts: Date.now(), attempts: 1,
  }, intent);
  ls.setItem(LEDGER_KEY, JSON.stringify(ledger));
  return key;
}

describe('MS-4 — intent is persisted before broadcast', () => {
  it('the ledger holds execution_unknown + nonce BEFORE eth_sendRawTransaction', async () => {
    const env = boot({ providerOpts: {} });
    grant(env.auth);
    await env.executor.tickNow();
    expect(env.provider.sendCalls).toBe(1);
    // At the moment of send, the ledger must already contain the execution intent.
    const atSend = JSON.parse(env.provider.ledgerAtSend || '{}');
    const keys = Object.keys(atSend);
    expect(keys.length).toBe(1);
    expect(atSend[keys[0]].status).toBe('execution_unknown');
    expect(atSend[keys[0]].nonce).toBe(0);
    expect(atSend[keys[0]].from.toLowerCase()).toBe(env.signer.address.toLowerCase());
  });
});

describe('MS-4 — crash after successful broadcast is recovered (no second broadcast)', () => {
  it('recovers txHash by nonce/fingerprint and never re-broadcasts', async () => {
    const ls = makeLocalStorage();
    const schedule = makeSchedule();
    // Simulate a crash: the intent exists in the ledger but no txHash was persisted.
    injectUnknownIntent(ls, schedule, new realEthers.Wallet('0x' + '22'.repeat(32)).address, {
      nonce: 0, from: new realEthers.Wallet('0x' + '22'.repeat(32)).address,
      to: USDC, data: '0xa9059cbb', value: '0x0',
    });

    const provider = makeProvider({
      txByNonce: (n) => n === 0
        ? { hash: '0x' + 'cc'.repeat(32), from: new realEthers.Wallet('0x' + '22'.repeat(32)).address, to: USDC, input: '0xa9059cbb', value: '0x0', nonce: '0x0' }
        : null,
      receiptStatus: 1,
    });
    const env = boot({ ls, provider, schedule });
    grant(env.auth);

    const summary = await env.executor.tickNow();
    expect(summary.executed).toBe(1);
    expect(env.provider.sendCalls).toBe(0); // NO new broadcast
    const log = env.executor.getExecutionLog(5)[0];
    expect(log.status).toBe('executed');
    expect(log.txHash).toBe('0x' + 'cc'.repeat(32)); // original txHash recovered
  });

  it('pending transaction (receipt unavailable) → reconciling, no re-broadcast', async () => {
    const ls = makeLocalStorage();
    const schedule = makeSchedule();
    injectUnknownIntent(ls, schedule, new realEthers.Wallet('0x' + '22'.repeat(32)).address, {
      nonce: 0, from: new realEthers.Wallet('0x' + '22'.repeat(32)).address, to: USDC, data: '0xa9059cbb', value: '0x0',
    });
    const provider = makeProvider({
      txByNonce: (n) => n === 0
        ? { hash: '0x' + 'cc'.repeat(32), from: new realEthers.Wallet('0x' + '22'.repeat(32)).address, to: USDC, input: '0xa9059cbb', value: '0x0', nonce: '0x0' }
        : null,
      noReceipt: true, // receipt not yet available
    });
    const env = boot({ ls, provider, schedule });
    grant(env.auth);

    const summary = await env.executor.tickNow();
    expect(env.provider.sendCalls).toBe(0);
    expect(summary.results[0].status).toBe('reconciling');
  });
});

describe('MS-4 — ambiguous sendRawTransaction never causes a blind retry', () => {
  it('send throws but tx IS on-chain → recovered via nonce, exactly 1 send call', async () => {
    const provider = makeProvider({ failSend: 'network timeout', resolveSent: true });
    const env = boot({ provider });
    grant(env.auth);

    const summary = await env.executor.tickNow();
    expect(env.provider.sendCalls).toBe(1); // the ambiguous attempt only
    expect(summary.executed).toBe(1);        // recovered as confirmed
    const expectedHash = realEthers.Transaction.from(env.provider.lastSigned).hash;
    expect(env.executor.getExecutionLog(5)[0].txHash).toBe(expectedHash);
  });

  it('send throws and no tx exists → failed, exactly 1 send call, no retry', async () => {
    const provider = makeProvider({ failSend: 'insufficient funds', txByNonce: () => null });
    const env = boot({ provider });
    grant(env.auth);

    const r1 = await env.executor.tickNow();
    expect(r1.results[0].status).toBe('failed');
    expect(env.provider.sendCalls).toBe(1);
    await env.executor.tickNow();
    expect(env.provider.sendCalls).toBe(1); // never blindly retried
  });

  it('nonce conflict (unrelated tx at same nonce) → failed, not attributed, no rebroadcast', async () => {
    const provider = makeProvider({
      failSend: 'network timeout',
      txByNonce: (n) => n === 0
        ? { hash: '0x' + 'ee'.repeat(32), from: new realEthers.Wallet('0x' + '22'.repeat(32)).address, to: '0x' + '99'.repeat(20), input: '0xdeadbeef', value: '0x0', nonce: '0x0' } // DIFFERENT to+data
        : null,
    });
    const env = boot({ provider });
    grant(env.auth);

    const r1 = await env.executor.tickNow();
    expect(r1.results[0].status).toBe('failed');
    expect(r1.results[0].reason).toBe('nonce_conflict');
    expect(env.provider.sendCalls).toBe(1);
    expect(env.executor.getExecutionLog(5)[0].txHash).toBeUndefined();
  });
});

describe('MS-4 — terminal occurrences never rebroadcast', () => {
  it('a recovered/confirmed occurrence is not executed again', async () => {
    const ls = makeLocalStorage();
    const schedule = makeSchedule();
    injectUnknownIntent(ls, schedule, new realEthers.Wallet('0x' + '22'.repeat(32)).address, {
      nonce: 0, from: new realEthers.Wallet('0x' + '22'.repeat(32)).address, to: USDC, data: '0xa9059cbb', value: '0x0',
    });
    const provider = makeProvider({
      txByNonce: (n) => n === 0
        ? { hash: '0x' + 'cc'.repeat(32), from: new realEthers.Wallet('0x' + '22'.repeat(32)).address, to: USDC, input: '0xa9059cbb', value: '0x0', nonce: '0x0' }
        : null,
    });
    const env = boot({ ls, provider, schedule });
    grant(env.auth);

    await env.executor.tickNow(); // recovers → executed
    expect(env.provider.sendCalls).toBe(0);
    const r2 = await env.executor.tickNow(); // completed → not due again
    expect(env.provider.sendCalls).toBe(0);
    expect(r2.processed).toBe(0);
  });
});
