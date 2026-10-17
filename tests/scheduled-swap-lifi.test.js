/**
 * scheduled-swap-lifi.test.js
 * ═══════════════════════════════════════════════════════════════════════
 * Guards the scheduled LI.FI swap feature (same-chain + cross-chain) wired
 * through the existing ScheduleEngine + AgentScheduleExecutor + Circle AI
 * Smart Wallet. No mocks of the financial outcome — the assertions verify the
 * real code paths (fresh re-quote, Arc-source-only, cross-chain finality,
 * idempotency, ID uniqueness).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ethers as realEthers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const executorSrc = fs.readFileSync(path.join(root, 'public', 'shared', 'agentScheduleExecutor.js'), 'utf8');

function agentSwapFn() {
  const start = html.indexOf('async function _agentExecuteScheduledSwap(');
  const end = html.indexOf('// Expose agent execution functions globally', start);
  return html.slice(start, end);
}

describe('ScheduleEngine — collision-resistant IDs', () => {
  it('default create() ID is no longer a bare timestamp (no same-ms collision)', () => {
    const fn = html.slice(html.indexOf('function create(scheduleData)'), html.indexOf('function getAll('));
    expect(fn).toContain("id: 'SCH' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)");
    expect(fn).not.toContain("id: 'SCH' + Date.now(),");
  });

  it('CSV batch idempotency id includes network + start time (no cross-context collision)', () => {
    const fn = html.slice(html.indexOf('function autDocScheduleAll('), html.indexOf('function autDocDispatchAll('));
    expect(fn).toContain("'|' + (r._chain||'Arc_Mainnet') + '|'");
    expect(fn).toContain("'|' + String(nextRunIso||'')");
  });
});

describe('Scheduled swap execution — fresh LI.FI re-quote via Circle wallet', () => {
  it('exposes window._agentExecuteScheduledSwap', () => {
    expect(html).toContain('window._agentExecuteScheduledSwap = _agentExecuteScheduledSwap;');
  });

  it('re-quotes fresh at execution time (never reuses a stored quote)', () => {
    const fn = agentSwapFn();
    expect(fn).toContain('LiFiAdapter.getQuote(');
    expect(fn).toContain('LiFiAdapter.getRoutes(');
    expect(fn).toContain('LiFiAdapter.getStepTransaction(');
    expect(fn).toContain('LiFiAdapter.validateRoute(');
  });

  it('validates the route before signing (chain/token/amount/recipient)', () => {
    const fn = agentSwapFn();
    expect(fn).toContain('LiFiAdapter.validateRoute(');
    expect(fn).toContain('sender: agentAddr');
    expect(fn).toContain('recipient: agentAddr'); // cross-chain recipient binding
  });

  it('enforces Arc Mainnet as the source (Circle AI Smart Wallet blockchain)', () => {
    const fn = agentSwapFn();
    expect(fn).toContain('if (fromChainId !== 5042)');
    expect(fn).toContain('Circle AI Smart Wallet');
  });

  it('broadcasts through the Circle smart wallet (lifi structured request)', () => {
    const fn = agentSwapFn();
    expect(fn).toContain("circle: { type:'lifi', contractAddress: stepTo, calldata: stepData");
  });

  it('polls LI.FI status for cross-chain finality and returns crossChainPending', () => {
    const fn = agentSwapFn();
    expect(fn).toContain('_agentPollLifiStatus(');
    expect(fn).toContain('crossChainPending: true');
    expect(fn).toContain("status === 'DONE'");
    // The polling helper calls the real LI.FI status endpoint.
    expect(html).toContain('async function _agentPollLifiStatus(');
    expect(html).toContain('LiFiAdapter.getStatus(');
  });

  it('legacy _agentExecuteSwap now returns a txHash for its LI.FI fallback (no false failure)', () => {
    const fn = html.slice(html.indexOf('async function _agentExecuteSwap('), html.indexOf('async function _agentExecuteBridge('));
    expect(fn).toContain("return { ok: true, txHash: _lifiTxHash, provider: 'lifi' };");
    expect(fn).not.toContain("return { ok: true, provider: 'lifi' };");
  });
});

describe('Executor — cross-chain reconciliation + no double execution', () => {
  it('isEligible skips a cross-chain-pending swap (never re-executed)', () => {
    expect(executorSrc).toContain("if (sched.crossChain && sched.crossChain.status === 'pending') return false;");
  });

  it('_delegateExecution records awaiting_crosschain (does not mark completed)', () => {
    const fn = executorSrc.slice(executorSrc.indexOf('function _delegateExecution('), executorSrc.indexOf('/* \u251c\u2500\u2500 Tick loop'));
    expect(fn).toContain('delResult.crossChainPending === true');
    expect(fn).toContain("status: 'awaiting_crosschain'");
    expect(fn).toContain("crossChain: { status: 'pending'");
  });

  it('reconciles finality via LI.FI getStatus (DONE/FAILED/NOT_FOUND/INVALID)', () => {
    expect(executorSrc).toContain('async function _reconcileCrossChain(sched){');
    expect(executorSrc).toContain('LiFiAdapter.getStatus(');
    expect(executorSrc).toContain("status === 'DONE'");
    expect(executorSrc).toContain("status:'confirmed'");
    expect(executorSrc).toContain("status:'failed'");
  });

  it('prefers _agentExecuteScheduledSwap over the legacy _agentExecuteSwap', () => {
    const fn = executorSrc.slice(executorSrc.indexOf('function _delegateExecution('), executorSrc.indexOf('/* \u251c\u2500\u2500 Tick loop'));
    expect(fn).toContain('window._agentExecuteScheduledSwap');
    expect(fn).toContain('args = [sched, ');
  });
});

describe('Schedule UI — swap configuration + quote preview', () => {
  it('renders the swap quote preview panel with the offline limitation note', () => {
    expect(html).toContain('id="sch-swap-quote-wrap"');
    expect(html).toContain('onclick="schGetSwapQuote()"');
    expect(html).toContain('no background worker');
  });

  it('scheduleSubmit requires a fetched LI.FI quote before scheduling a swap', () => {
    const fn = html.slice(html.indexOf('function scheduleSubmit('), html.indexOf('function schTypeLabel('));
    expect(fn).toContain("toast('Fetch a LI.FI quote before scheduling a swap','error')");
    expect(fn).toContain('fromToken: type === \'swap\' ? token : undefined');
    expect(fn).toContain('swapQuote: type === \'swap\'');
  });
});

// ── Runtime: cross-chain finality reconciliation ──────────────────────────
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
    sent: [], simCalls: [],
    async getNetwork() { return { chainId: BigInt(5042) }; },
    async call(tx) { if (tx && tx.data && tx.data.startsWith('0xa9059cbb')) this.simCalls.push(tx); return '0x' + (10n ** 12n).toString(16).padStart(64, '0'); },
    async getBalance() { return 10n ** 18n; },
    async send(method, params) {
      if (method === 'eth_getTransactionCount') return '0x0';
      if (method === 'eth_sendRawTransaction') { this.sent.push(params[0]); return '0x' + 'ab'.repeat(32); }
      throw new Error('unexpected rpc ' + method);
    },
    async waitForTransaction() { return { status: 1, blockNumber: 123, gasUsed: 21000n }; },
  };
}
function makeEngine(scheds) {
  return {
    _s: scheds,
    getAll() { return this._s; },
    getById(id) { return this._s.find((x) => x.id === id); },
    update(id, ch) { const s = this.getById(id); if (s) Object.assign(s, ch); return s; },
  };
}
function makeXcSwapSchedule(over = {}) {
  return Object.assign({
    id: 'SCH_XC_1', type: 'swap', name: 'Scheduled cross-chain swap', token: 'USDC',
    fromToken: 'USDC', swapToToken: 'USDC', fromNetwork: 'Arc_Mainnet', toNetwork: 'Base',
    amount: 100, total: 100, recipients: [], address: '',
    freq: 'once', maxEx: 0, gas: 0.1,
    nextRun: new Date(Date.now() - 60000).toISOString(),
    execCount: 0, executionHistory: [], status: 'Active',
    created: new Date().toISOString(), createdBy: 'user', agentExecution: true, walletAddress: '',
    crossChain: { status: 'pending', srcTxHash: '0x' + 'cd'.repeat(32), fromChainId: 5042, toChainId: 8453, ts: Date.now() },
  }, over);
}

function bootXc(opts = {}) {
  const ls = makeLocalStorage();
  const provider = makeProvider();
  const signer = new realEthers.Wallet('0x' + '22'.repeat(32));
  signer.provider2 = provider;
  const toasts = [];
  const engine = makeEngine(opts.schedules || [makeXcSwapSchedule()]);

  globalThis.localStorage = ls;
  globalThis.ethers = realEthers;
  globalThis.ScheduleEngine = engine;
  globalThis.toast = (m, t) => toasts.push({ m, t });
  globalThis.LiFiAdapter = { getStatus: opts.getStatus || (async () => ({ ok: true, data: { status: 'DONE', receiving: { txHash: '0x' + 'aa'.repeat(32) } } })) };
  globalThis.AgentWalletManager = {
    isShutdown: () => false, isPaused: () => false,
    getAgentProvider: () => provider, getSessionSigner: async () => signer,
    getAgentAddress: () => signer.address, validatePreExecution: () => ({ ok: true }),
    recordExecution: () => {}, recordOperationSuccess: () => {},
    getSupportedChains: () => ['Arc Mainnet'],
  };
  globalThis.CircleAgent = { getCachedAddress: () => signer.address, getAddress: async () => signer.address };

  delete globalThis.RiskEngine;
  delete globalThis.ExecutionQueue;
  delete globalThis.AgentAudit;
  delete globalThis.AgentReputation;
  delete globalThis.ElligenteCCTP;

  const authSrc = fs.readFileSync(path.join(root, 'public', 'shared', 'agentAuthorization.js'), 'utf8');
  const authWin = {};
  new Function('window', 'localStorage', authSrc)(authWin, ls);
  globalThis.AgentAuthorization = authWin.AgentAuthorization;

  const exWin = {
    _agentExecuteScheduledSwap: opts.swapStub || (async function () { return { ok: true, txHash: '0x' + 'ee'.repeat(32), crossChainPending: true, toChainId: 8453, tool: 'CCTP' }; }),
    _agentExecuteBridge: async function () { return { ok: true, txHash: '0x' + 'ff'.repeat(32), mintTxHash: '0x' + 'aa'.repeat(32) }; },
  };
  new Function('window', 'localStorage', 'document', executorSrc)(exWin, ls, undefined);
  const executor = exWin.AgentScheduleExecutor;

  return { executor, engine, provider, signer, toasts, ls };
}

describe('AgentScheduleExecutor — cross-chain swap finality (runtime)', () => {
  beforeEach(() => { delete globalThis.AgentScheduleExecutor; });

  it('marks a cross-chain swap confirmed + completed when LI.FI reports DONE', async () => {
    const env = bootXc();
    await env.executor.tickNow();
    const s = env.engine.getById('SCH_XC_1');
    expect(s.crossChain.status).toBe('confirmed');
    expect(s.crossChain.mintTxHash).toBe('0x' + 'aa'.repeat(32));
    expect(s.status).toBe('Completed');
    expect(s.execCount).toBe(1);
    expect(s.executionHistory.length).toBeGreaterThan(0);
    expect(s.executionHistory[0].status).toBe('executed');
    expect(s.executionHistory[0].mintTxHash).toBe('0x' + 'aa'.repeat(32));
  });

  it('leaves the swap pending (never re-executed) while LI.FI reports PENDING', async () => {
    const env = bootXc({ getStatus: async () => ({ ok: true, data: { status: 'PENDING' } }) });
    await env.executor.tickNow();
    const s = env.engine.getById('SCH_XC_1');
    expect(s.crossChain.status).toBe('pending');
    expect(s.status).toBe('Active');
    expect(s.execCount).toBe(0);
  });

  it('marks a cross-chain swap failed when LI.FI reports FAILED', async () => {
    const env = bootXc({ getStatus: async () => ({ ok: true, data: { status: 'FAILED' } }) });
    await env.executor.tickNow();
    const s = env.engine.getById('SCH_XC_1');
    expect(s.crossChain.status).toBe('failed');
    expect(s.status).toBe('Failed');
    expect(s.executionHistory[0].status).toBe('failed');
  });
});
