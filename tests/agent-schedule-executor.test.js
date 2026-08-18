/**
 * AGENT SCHEDULE EXECUTOR — Delegated scheduled-intent execution via Agent Wallet
 * ═══════════════════════════════════════════════════════════════════════════════
 * Covers the surgical feature: Autonoma/Agent Wallet executes due Schedules-tab
 * intents on-chain, gated by AgentAuthorization (spending limits, daily limits,
 * allowed tokens/operations, revocation) with simulation + replay protection.
 *
 * The real production modules (agentAuthorization.js, policyEngine.js,
 * agentScheduleExecutor.js) are executed here against stubbed providers so the
 * exact shipped logic is what gets tested. No network calls are made.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ethers as realEthers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const executorSrc = fs.readFileSync(path.join(root, 'public', 'shared', 'agentScheduleExecutor.js'), 'utf8');
const authSrc = fs.readFileSync(path.join(root, 'public', 'shared', 'agentAuthorization.js'), 'utf8');
const policySrc = fs.readFileSync(path.join(root, 'public', 'shared', 'policyEngine.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const srcHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const RCPT = '0x' + '11'.repeat(20);
const BAL_HEX = '0x' + (10n ** 12n).toString(16).padStart(64, '0'); // 1,000,000 USDC (6 dec)

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

function makeProvider(opts = {}) {
  return {
    sent: [],
    simCalls: [],
    async getNetwork() { return { chainId: BigInt(opts.chainId ?? 5042002) }; },
    async call(tx) {
      if (tx && tx.data && tx.data.startsWith('0xa9059cbb')) {
        this.simCalls.push(tx);
        if (opts.revertTransferSim) throw new Error('execution reverted');
      }
      return BAL_HEX;
    },
    async getBalance() { return 10n ** 18n; },
    async send(method, params) {
      if (method === 'eth_getTransactionCount') return '0x0';
      if (method === 'eth_sendRawTransaction') {
        if (opts.failSend) throw new Error('insufficient funds for gas');
        this.sent.push(params[0]);
        return '0x' + 'ab'.repeat(32);
      }
      throw new Error('unexpected rpc ' + method);
    },
    async waitForTransaction() {
      return { status: opts.revertOnChain ? 0 : 1, blockNumber: 123, gasUsed: 21000n };
    },
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

function makeSchedule(over = {}) {
  return Object.assign({
    id: 'SCH_TEST_1', type: 'payment', name: 'Supplier pay', token: 'USDC',
    amount: 50, total: 50,
    recipients: [{ addr: RCPT, amount: 50 }], address: '',
    freq: 'once', maxEx: 0, gas: 0.1,
    nextRun: new Date(Date.now() - 60000).toISOString(),
    execCount: 0, executionHistory: [], status: 'Active',
    created: new Date().toISOString(), createdBy: 'user',
    agentExecution: true, walletAddress: '',
  }, over);
}

function boot(opts = {}) {
  const ls = makeLocalStorage();
  const provider = opts.provider || makeProvider(opts.providerOpts || {});
  const signer = new realEthers.Wallet('0x' + '22'.repeat(32));
  signer.provider2 = provider;
  const toasts = [];
  const engine = makeEngine(opts.schedules || [makeSchedule()]);

  globalThis.localStorage = ls;
  globalThis.ethers = realEthers;
  globalThis.ScheduleEngine = engine;
  globalThis.toast = (m, t) => toasts.push({ m, t });
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
  delete globalThis.ContractRegistry;
  delete globalThis.ExecutionQueue;
  delete globalThis.ExecutionHistory;
  delete globalThis.AgentAudit;
  delete globalThis.AgentReputation;
  delete globalThis.ElligenteContracts;
  delete globalThis.ElligenteCCTP;
  delete globalThis.PermitEngine;

  const authWin = {};
  new Function('window', 'localStorage', authSrc)(authWin, ls);
  globalThis.AgentAuthorization = authWin.AgentAuthorization;

  const polWin = {};
  new Function('window', policySrc)(polWin);
  globalThis.PolicyEngine = polWin.PolicyEngine;

  const exWin = {
    _agentExecuteSwap: opts.swapStub || (async function () { return { ok: true, txHash: '0x' + 'ee'.repeat(32) }; }),
    _agentExecuteBridge: opts.bridgeStub || (async function () { return { ok: true, txHash: '0x' + 'ff'.repeat(32), mintTxHash: '0x' + 'aa'.repeat(32) }; }),
  };
  new Function('window', 'localStorage', 'document', executorSrc)(exWin, ls, undefined);
  const executor = exWin.AgentScheduleExecutor;

  return { executor, auth: authWin.AgentAuthorization, engine, provider, signer, toasts, ls };
}

function grantScheduledAuth(auth, over = {}) {
  return auth.createAuthorization(Object.assign({
    maxSpending: 500, dailyLimit: 200,
    allowedTokens: ['USDC'], allowedNetworks: ['Arc Testnet'],
    allowedOperations: ['payment'], allowPayments: true, allowScheduled: true,
    durationMs: 3600000, maxRiskLevel: 'MEDIUM',
  }, over));
}

beforeEach(() => {
  delete globalThis.AgentScheduleExecutor;
});

describe('AgentScheduleExecutor — authorization gating', () => {
  it('never executes without an active scheduled authorization', async () => {
    const env = boot();
    const summary = await env.executor.tickNow();
    expect(env.provider.sent.length).toBe(0);
    expect(summary.executed).toBe(0);
    const log = env.executor.getExecutionLog(5);
    expect(log[0].status).toBe('awaiting_auth');
    expect(env.engine.getById('SCH_TEST_1').execCount).toBe(0);
  });

  it('notifies the user only once while waiting for authorization (no spam)', async () => {
    const env = boot();
    await env.executor.tickNow();
    await env.executor.tickNow();
    const blockedToasts = env.toasts.filter((t) => /cannot execute/i.test(t.m));
    expect(blockedToasts.length).toBe(1);
  });

  it('blocks execution after the authorization is revoked', async () => {
    const env = boot();
    grantScheduledAuth(env.auth);
    env.auth.revokeAll('test revocation');
    await env.executor.tickNow();
    expect(env.provider.sent.length).toBe(0);
    expect(env.executor.getExecutionLog(5)[0].status).toBe('awaiting_auth');
  });

  it('respects maxSpending limits from the authorization', async () => {
    const env = boot({ schedules: [makeSchedule({ amount: 900, total: 900, recipients: [{ addr: RCPT, amount: 900 }] })] });
    grantScheduledAuth(env.auth, { maxSpending: 500, dailyLimit: null });
    const summary = await env.executor.tickNow();
    expect(env.provider.sent.length).toBe(0);
    expect(summary.results[0].reason).toMatch(/Max spending|Daily limit/i);
  });

  it('respects dailyLimit from the authorization', async () => {
    const env = boot({ schedules: [makeSchedule({ amount: 120, total: 120, recipients: [{ addr: RCPT, amount: 120 }] })] });
    grantScheduledAuth(env.auth, { maxSpending: 5000, dailyLimit: 100 });
    const summary = await env.executor.tickNow();
    expect(env.provider.sent.length).toBe(0);
    expect(summary.results[0].reason).toMatch(/Daily limit/i);
  });

  it('rejects tokens outside the allowedTokens list', async () => {
    const env = boot({ schedules: [makeSchedule({ token: 'EURC' })] });
    grantScheduledAuth(env.auth, { allowedTokens: ['USDC'] });
    const summary = await env.executor.tickNow();
    expect(env.provider.sent.length).toBe(0);
    expect(summary.results[0].reason).toMatch(/Token EURC not allowed/i);
  });
});

describe('AgentScheduleExecutor — on-chain execution (happy path)', () => {
  it('executes a due payment schedule via the Agent Wallet and records everything', async () => {
    const env = boot();
    const auth = grantScheduledAuth(env.auth);
    const summary = await env.executor.tickNow();

    expect(summary.executed).toBe(1);
    expect(env.provider.sent.length).toBe(1);
    expect(env.provider.simCalls.length).toBe(1);

    const sched = env.engine.getById('SCH_TEST_1');
    expect(sched.execCount).toBe(1);
    expect(sched.status).toBe('Completed');
    expect(sched.executionHistory[0].status).toBe('executed');
    expect(sched.executionHistory[0].executor).toBe('agent_wallet');
    expect(sched.executionHistory[0].txHash).toMatch(/^0x/);

    const log = env.executor.getExecutionLog(5);
    expect(log[0].status).toBe('executed');
    expect(log[0].txHash).toMatch(/^0x/);

    const active = env.auth.getActive();
    expect(active[0].id).toBe(auth.id);
    expect(active[0].usedSpending).toBe(50);
    expect(active[0].useCount).toBe(1);

    expect(env.toasts.some((t) => t.t === 'success')).toBe(true);
  });

  it('signed transaction targets the Arc USDC contract on chain 5042002', async () => {
    const env = boot();
    grantScheduledAuth(env.auth);
    await env.executor.tickNow();
    const parsed = realEthers.Transaction.from(env.provider.sent[0]);
    expect(Number(parsed.chainId)).toBe(5042002);
    expect(parsed.to.toLowerCase()).toBe('0x3600000000000000000000000000000000000000');
    expect(parsed.from).toBe(env.signer.address);
  });

  it('executes a scheduled MultiSend sequentially — one confirmed tx before the next', async () => {
    const rcpts = [
      { addr: RCPT, amount: 10 },
      { addr: '0x' + '33'.repeat(20), amount: 15 },
      { addr: '0x' + '44'.repeat(20), amount: 25 },
    ];
    const log = [];
    const provider = {
      sent: [], simCalls: [], log,
      async getNetwork() { return { chainId: BigInt(5042002) }; },
      async call(tx) { if (tx && tx.data && tx.data.startsWith('0xa9059cbb')) this.simCalls.push(tx); return BAL_HEX; },
      async getBalance() { return 10n ** 18n; },
      async send(method, params) {
        if (method === 'eth_getTransactionCount') return '0x' + this.sent.length.toString(16);
        if (method === 'eth_sendRawTransaction') { log.push('send'); this.sent.push(params[0]); return '0x' + 'ab'.repeat(32); }
        throw new Error('unexpected rpc ' + method);
      },
      async waitForTransaction() { log.push('wait'); return { status: 1, blockNumber: 123, gasUsed: 21000n }; },
    };
    const env = boot({ provider, schedules: [makeSchedule({ type: 'multisend', recipients: rcpts, amount: 0, total: 50, freq: 'once' })] });
    grantScheduledAuth(env.auth, { maxSpending: 1000, dailyLimit: null });
    await env.executor.tickNow();

    // One individual transaction per recipient, sequentially.
    expect(env.provider.sent.length).toBe(3);
    expect(env.provider.simCalls.length).toBe(3);
    // Strict send → wait ordering proves each row waits for the previous receipt (no concurrency).
    expect(log).toEqual(['send', 'wait', 'send', 'wait', 'send', 'wait']);

    const sched = env.engine.getById('SCH_TEST_1');
    expect(sched.status).toBe('Completed');      // one-time multisend completes
    expect(sched.execCount).toBe(1);
    expect(sched.recipients.length).toBe(3);     // recipients preserved
    expect(sched.executionHistory[0].rows.length).toBe(3);
    expect(sched.executionHistory[0].rows.every((r) => r.status === 'completed')).toBe(true);
    expect(sched.executionHistory[0].rows.every((r) => r.txHash && /^0x[0-9a-f]{64}$/.test(r.txHash))).toBe(true);
    expect(env.auth.getActive()[0].usedSpending).toBe(50);
  });
});

describe('AgentScheduleExecutor — scheduled MultiSend (sequential execution)', () => {
  const THREE = [
    { addr: RCPT, amount: 100 },
    { addr: '0x' + '33'.repeat(20), amount: 50 },
    { addr: '0x' + '44'.repeat(20), amount: 25 },
  ];

  function orderedProvider() {
    const log = [];
    return {
      sent: [], simCalls: [], log,
      async getNetwork() { return { chainId: BigInt(5042002) }; },
      async call(tx) { if (tx && tx.data && tx.data.startsWith('0xa9059cbb')) this.simCalls.push(tx); return BAL_HEX; },
      async getBalance() { return 10n ** 18n; },
      async send(method, params) {
        if (method === 'eth_getTransactionCount') return '0x' + this.sent.length.toString(16);
        if (method === 'eth_sendRawTransaction') { log.push('send'); this.sent.push(params[0]); return '0x' + 'ab'.repeat(32); }
        throw new Error('unexpected rpc ' + method);
      },
      async waitForTransaction() { log.push('wait'); return { status: 1, blockNumber: 123, gasUsed: 21000n }; },
    };
  }

  it('TEST 1 — preserves every CSV row (3 recipients) through the schedule data model', () => {
    const sched = makeSchedule({ type: 'multisend', recipients: THREE, amount: 0, total: 175, freq: 'once' });
    expect(sched.type).toBe('multisend');
    expect(sched.recipients.length).toBe(3);
    expect(sched.recipients[0].addr).toBe(RCPT);
    expect(sched.recipients[0].amount).toBe(100);
    expect(sched.recipients[1].amount).toBe(50);
    expect(sched.recipients[2].amount).toBe(25);
    expect(sched.total).toBe(175);
  });

  it('TEST 2/3/4 — sends rows sequentially: each row waits for the previous receipt', async () => {
    const env = boot({ provider: orderedProvider(), schedules: [makeSchedule({ type: 'multisend', recipients: THREE, amount: 0, total: 175, freq: 'once' })] });
    grantScheduledAuth(env.auth, { maxSpending: 1000, dailyLimit: null });
    await env.executor.tickNow();
    expect(env.provider.sent.length).toBe(3);
    // send → wait interleaving proves recipient #N+1 does NOT start before #N is confirmed.
    expect(env.provider.log).toEqual(['send', 'wait', 'send', 'wait', 'send', 'wait']);
  });

  it('TEST 5 — does not use Promise.all() for scheduled recipient execution', () => {
    const fn = executorSrc.slice(executorSrc.indexOf('async function _executeMultiSendSequential'), executorSrc.indexOf('async function _delegateExecution'));
    expect(fn).not.toContain('Promise.all');
  });

  it('TEST 6/7 — never calls the batch contract (sendTokenBatch / MultiSendExecutor)', () => {
    expect(executorSrc).not.toContain('sendTokenBatch');
    expect(executorSrc).not.toContain('batchTransfer');
    expect(executorSrc).not.toContain('MultiSendExecutor');
    expect(executorSrc).not.toContain('EXECUTOR_V4');
    expect(executorSrc).not.toContain('_agentExecuteMultiSend');
  });

  it('TEST 8 — converts amounts safely to 6-decimal base units (61.5 USDC → 61500000)', async () => {
    const env = boot({ schedules: [makeSchedule({ type: 'multisend', recipients: [{ addr: RCPT, amount: 61.5 }], amount: 0, total: 61.5, freq: 'once' })] });
    grantScheduledAuth(env.auth, { maxSpending: 1000, dailyLimit: null });
    await env.executor.tickNow();
    expect(env.provider.sent.length).toBe(1);
    const tx = realEthers.Transaction.from(env.provider.sent[0]);
    const decoded = new realEthers.Interface(['function transfer(address to, uint256 amount)']).decodeFunctionData('transfer', tx.data);
    expect(decoded[1].toString()).toBe('61500000');
  });

  it('TEST 9 — a failed row halts execution: #1 completed, #2 failed, #3 pending and NOT sent', async () => {
    let waitCalls = 0;
    const provider = {
      sent: [], simCalls: [],
      async getNetwork() { return { chainId: BigInt(5042002) }; },
      async call(tx) { if (tx && tx.data && tx.data.startsWith('0xa9059cbb')) this.simCalls.push(tx); return BAL_HEX; },
      async getBalance() { return 10n ** 18n; },
      async send(method, params) {
        if (method === 'eth_getTransactionCount') return '0x' + this.sent.length.toString(16);
        if (method === 'eth_sendRawTransaction') { this.sent.push(params[0]); return '0x' + 'ab'.repeat(32); }
        throw new Error('unexpected rpc ' + method);
      },
      async waitForTransaction() {
        waitCalls++;
        return { status: waitCalls === 2 ? 0 : 1, blockNumber: 123, gasUsed: 21000n };
      },
    };
    const env = boot({ provider, schedules: [makeSchedule({ type: 'multisend', recipients: THREE, amount: 0, total: 175, freq: 'once' })] });
    grantScheduledAuth(env.auth, { maxSpending: 1000, dailyLimit: null });
    await env.executor.tickNow();

    expect(env.provider.sent.length).toBe(2);       // row 1 + row 2 broadcast; row 3 NOT sent

    const sched = env.engine.getById('SCH_TEST_1');
    expect(sched.status).toBe('Failed');            // one-time failure is terminal, not Completed
    expect(sched.recipients.length).toBe(3);        // recipients preserved

    const log = env.executor.getExecutionLog(5)[0];
    expect(log.status).toBe('failed');
    expect(log.rows.length).toBe(3);
    expect(log.rows[0].status).toBe('completed');
    expect(log.rows[0].txHash).toMatch(/^0x[0-9a-f]{64}$/);   // completed row keeps its tx hash
    expect(log.rows[1].status).toBe('failed');
    expect(log.rows[2].status).toBe('pending');
    expect(log.rows[2].txHash).toBeNull();                     // pending row has no tx hash
  });

  it('TEST 10 — already-completed rows are not re-sent on a second scheduler tick', async () => {
    const env = boot({ schedules: [makeSchedule({ type: 'multisend', recipients: THREE, amount: 0, total: 175, freq: 'daily' })] });
    grantScheduledAuth(env.auth, { maxSpending: 1000, dailyLimit: null });
    const originalRun = env.engine.getById('SCH_TEST_1').nextRun;
    await env.executor.tickNow();
    expect(env.provider.sent.length).toBe(3);
    env.engine.update('SCH_TEST_1', { nextRun: originalRun, status: 'Active' });
    const summary2 = await env.executor.tickNow();
    expect(env.provider.sent.length).toBe(3);       // replay-blocked: no additional sends
    expect(summary2.executed).toBe(0);
  });

  it('TEST 11 — recurring MultiSend advances nextRun and keeps recipients intact', async () => {
    const env = boot({ schedules: [makeSchedule({ type: 'multisend', recipients: THREE, amount: 0, total: 175, freq: 'weekly' })] });
    grantScheduledAuth(env.auth, { maxSpending: 1000, dailyLimit: null });
    const before = env.engine.getById('SCH_TEST_1').nextRun;
    await env.executor.tickNow();
    const sched = env.engine.getById('SCH_TEST_1');
    expect(sched.status).toBe('Active');
    expect(sched.execCount).toBe(1);
    expect(sched.nextRun).not.toBe(before);
    expect(new Date(sched.nextRun).getTime()).toBeGreaterThan(Date.now());
    expect(sched.recipients.length).toBe(3);
  });

  it('TEST 12 — a normal single-recipient Payment still uses the single-payment path', async () => {
    const env = boot({ schedules: [makeSchedule({ type: 'payment', amount: 50, total: 50, recipients: [{ addr: RCPT, amount: 50 }] })] });
    grantScheduledAuth(env.auth);
    await env.executor.tickNow();
    expect(env.provider.sent.length).toBe(1);
  });

  it('TEST 13 — AI Smart Wallet MultiSend is deferred to BatchExecutionEngine (untouched here)', async () => {
    const env = boot({ schedules: [makeSchedule({ type: 'multisend', recipients: THREE, amount: 0, total: 175, freq: 'once', createdBy: 'aiwallet' })] });
    grantScheduledAuth(env.auth, { maxSpending: 1000, dailyLimit: null });
    const summary = await env.executor.tickNow();
    expect(summary.processed).toBe(0);              // aiwallet multisend is not handled by this executor
    expect(env.provider.sent.length).toBe(0);
  });

  it('authorization is evaluated against the TOTAL value of all recipients', async () => {
    const env = boot({ schedules: [makeSchedule({ type: 'multisend', recipients: THREE, amount: 0, total: 175, freq: 'once' })] });
    // Authorization limit 150 < total 175 → the whole schedule is blocked up-front.
    grantScheduledAuth(env.auth, { maxSpending: 150, dailyLimit: null });
    await env.executor.tickNow();
    expect(env.provider.sent.length).toBe(0);
    expect(env.engine.getById('SCH_TEST_1').execCount).toBe(0);
    expect(env.engine.getById('SCH_TEST_1').recipients.length).toBe(3);
  });
});

describe('AgentScheduleExecutor — swap / bridge / crosschain schedule tx recording', () => {
  it('records the swap transaction hash from the delegated executor', async () => {
    const env = boot({
      schedules: [makeSchedule({ type: 'swap', amount: 30, total: 30, swapToToken: 'EURC', recipients: [], address: '' })],
      swapStub: async function () { return { ok: true, txHash: '0x' + 'ab'.repeat(32) }; },
    });
    grantScheduledAuth(env.auth, { allowedOperations: ['swap'] });
    const summary = await env.executor.tickNow();
    expect(summary.executed).toBe(1);
    const sched = env.engine.getById('SCH_TEST_1');
    expect(sched.status).toBe('Completed');
    expect(sched.executionHistory[0].txHash).toBe('0x' + 'ab'.repeat(32));
  });

  it('records the bridge transaction hash + mint hash from the delegated executor', async () => {
    const env = boot({
      schedules: [makeSchedule({ type: 'bridge', amount: 30, total: 30, toNetwork: 'Base_Sepolia', recipients: [], address: '' })],
      bridgeStub: async function () { return { ok: true, txHash: '0x' + 'cd'.repeat(32), mintTxHash: '0x' + 'ef'.repeat(32) }; },
    });
    grantScheduledAuth(env.auth, { allowedOperations: ['bridge'] });
    const summary = await env.executor.tickNow();
    expect(summary.executed).toBe(1);
    const sched = env.engine.getById('SCH_TEST_1');
    expect(sched.executionHistory[0].txHash).toBe('0x' + 'cd'.repeat(32));
    expect(sched.executionHistory[0].mintTxHash).toBe('0x' + 'ef'.repeat(32));
  });

  it('passes the crosschain recipient to the delegated bridge executor', async () => {
    let capturedRecipient = null;
    const env = boot({
      schedules: [makeSchedule({ type: 'crosschain', amount: 30, total: 30, toNetwork: 'Base_Sepolia', recipients: [{ addr: RCPT, amount: 30 }], address: RCPT })],
      bridgeStub: async function (amount, domain, chainName, calldataId, srcChain, recipientAddr) {
        capturedRecipient = recipientAddr;
        return { ok: true, txHash: '0x' + 'cd'.repeat(32) };
      },
    });
    grantScheduledAuth(env.auth, { allowedOperations: ['crosschain'] });
    await env.executor.tickNow();
    expect(capturedRecipient).toBe(RCPT);
  });

  it('delegated failure (ok:false) is recorded as failed and never marks Completed', async () => {
    const env = boot({
      schedules: [makeSchedule({ type: 'swap', amount: 30, total: 30, swapToToken: 'EURC', recipients: [], address: '' })],
      swapStub: async function () { return { ok: false, error: 'No liquidity for USDC → EURC' }; },
    });
    grantScheduledAuth(env.auth, { allowedOperations: ['swap'] });
    const summary = await env.executor.tickNow();
    expect(summary.executed).toBe(0);
    const sched = env.engine.getById('SCH_TEST_1');
    expect(sched.status).not.toBe('Completed');
  });

  it('Schedule form shows + captures a recipient address for crosschain (distinct from bridge)', () => {
    const select = srcHtml.slice(srcHtml.indexOf('function schSelectType'), srcHtml.indexOf('function scheduleCreateNew'));
    expect(select).toContain('isCrosschain');
    expect(select).toContain('isPayment || isLink || isMultiSend || isCrosschain');
    const submit = srcHtml.slice(srcHtml.indexOf('function scheduleSubmit()'), srcHtml.indexOf('function schTypeLabel'));
    expect(submit).toContain("type === 'crosschain'");
    expect(submit).toContain('cross-chain delivery');
  });
});

describe('AgentScheduleExecutor — replay, simulation and safety', () => {
  it('replay protection: the same run key is never broadcast twice', async () => {
    const env = boot({ schedules: [makeSchedule({ freq: 'daily' })] });
    grantScheduledAuth(env.auth);
    const originalRun = env.engine.getById('SCH_TEST_1').nextRun;
    await env.executor.tickNow();
    expect(env.provider.sent.length).toBe(1);
    env.engine.update('SCH_TEST_1', { nextRun: originalRun, status: 'Active' });
    const summary2 = await env.executor.tickNow();
    expect(env.provider.sent.length).toBe(1);
    expect(summary2.executed).toBe(0);
  });

  it('aborts before broadcast when the eth_call simulation reverts', async () => {
    const env = boot({ providerOpts: { revertTransferSim: true } });
    grantScheduledAuth(env.auth);
    const summary = await env.executor.tickNow();
    expect(env.provider.sent.length).toBe(0);
    expect(summary.results[0].status).toBe('simulation_failed');
    expect(env.engine.getById('SCH_TEST_1').execCount).toBe(0);
  });

  it('aborts when connected to the wrong chain', async () => {
    const env = boot({ providerOpts: { chainId: 11155111 } });
    grantScheduledAuth(env.auth);
    const summary = await env.executor.tickNow();
    expect(env.provider.sent.length).toBe(0);
    expect(summary.results[0].reason).toMatch(/Wrong chain/i);
  });

  it('skips stale runs outside the 24h execution window (deadline protection)', async () => {
    const env = boot({ schedules: [makeSchedule({ nextRun: new Date(Date.now() - 48 * 3600000).toISOString() })] });
    grantScheduledAuth(env.auth);
    await env.executor.tickNow();
    expect(env.provider.sent.length).toBe(0);
    const sched = env.engine.getById('SCH_TEST_1');
    expect(sched.executionHistory[0].status).toBe('skipped');
    expect(env.executor.getExecutionLog(5)[0].status).toBe('skipped_stale');
  });

  it('does not touch schedules with agent auto-execution disabled', async () => {
    const env = boot({ schedules: [makeSchedule({ agentExecution: false })] });
    grantScheduledAuth(env.auth);
    const summary = await env.executor.tickNow();
    expect(summary.processed).toBe(0);
    expect(env.provider.sent.length).toBe(0);
  });

  it('does not execute paused or completed schedules', async () => {
    const env = boot({ schedules: [makeSchedule({ status: 'Paused' }), makeSchedule({ id: 'SCH_TEST_2', status: 'Completed' })] });
    grantScheduledAuth(env.auth);
    const summary = await env.executor.tickNow();
    expect(summary.processed).toBe(0);
    expect(env.provider.sent.length).toBe(0);
  });

  it('halts the agent when the wallet is paused (kill switch respected)', async () => {
    const env = boot({ wmOverrides: { isPaused: () => true } });
    grantScheduledAuth(env.auth);
    await env.executor.tickNow();
    expect(env.provider.sent.length).toBe(0);
  });

  it('records failure and pauses the schedule when the tx reverts on-chain', async () => {
    const env = boot({ providerOpts: { revertOnChain: true } });
    grantScheduledAuth(env.auth);
    const summary = await env.executor.tickNow();
    expect(summary.failed).toBe(1);
    const sched = env.engine.getById('SCH_TEST_1');
    expect(sched.status).toBe('Failed');            // one-time revert → terminal Failed (H3)
    expect(sched.executionHistory[0].status).toBe('failed');
    expect(env.executor.getExecutionLog(5)[0].status).toBe('failed');
    expect(env.toasts.some((t) => t.t === 'error')).toBe(true);
  });
});

describe('AgentScheduleExecutor — module source safety checks', () => {
  it('simulates before broadcasting and validates before signing', () => {
    const execBody = executorSrc.slice(executorSrc.indexOf('async function _executeSchedule'));
    const vIdx = execBody.indexOf('await _validateIntent');
    const simIdx = execBody.indexOf('await _simulateTransfers');
    const brIdx = execBody.indexOf('await _sendTransfer');
    expect(vIdx).toBeGreaterThan(-1);
    expect(simIdx).toBeGreaterThan(vIdx);
    expect(brIdx).toBeGreaterThan(simIdx);
  });

  it('checks authorization, policy, risk, balance, chain and pre-execution gates', () => {
    expect(executorSrc).toContain('hasOperationAuth');
    expect(executorSrc).toContain('validateExecution');
    expect(executorSrc).toContain('checkOperationPermission');
    expect(executorSrc).toContain('PolicyEngine.validateExecution');
    expect(executorSrc).toContain('RiskEngine.quickAssess');
    expect(executorSrc).toContain('balanceOf');
    expect(executorSrc).toContain('getNetwork');
    expect(executorSrc).toContain('validatePreExecution');
    expect(executorSrc).toContain('recordUsage');
  });

  it('never reads the user wallet private key — only the Agent Wallet signer', () => {
    expect(executorSrc).toContain('getSessionSigner');
    expect(executorSrc).not.toContain('window.ethereum');
    expect(executorSrc).not.toContain('eth_requestAccounts');
    expect(executorSrc).not.toContain('personal_sign');
  });

  it('does not touch forbidden modules (treasury, permits, multisend contract paths)', () => {
    expect(executorSrc).not.toContain('PermitEngine');
    expect(executorSrc).not.toContain('AgentTreasury');
    expect(executorSrc).not.toContain('TREASURY_VAULT');
    expect(executorSrc).not.toContain('aggregate3');
  });
});

describe('Schedules tab + Autonoma wiring (index.html)', () => {
  it('loads the executor module', () => {
    expect(html).toContain('<script src="/shared/agentScheduleExecutor.js"></script>');
  });

  it('new schedules are assigned to the Agent Wallet (agentExecution flag)', () => {
    const fn = html.slice(html.indexOf('function scheduleSubmit()'), html.indexOf('function schTypeLabel'));
    expect(fn).toContain('agentExecution: true');
  });

  it('chat-created schedules are assigned to the Agent Wallet too', () => {
    const fn = html.slice(html.indexOf('function _agentScheduleToEngine'), html.indexOf('function _agentScheduleToEngine') + 6000);
    expect(fn).toContain("createdBy: 'autonoma'");
    expect(fn).toContain('agentExecution: true');
  });

  it('Schedules tab exposes a per-intent agent toggle and AUTO badge', () => {
    expect(html).toContain('function scheduleToggleAgent(id)');
    const render = html.slice(html.indexOf('function renderSchedules()'), html.indexOf('function checkDueSchedules'));
    expect(render).toContain('scheduleToggleAgent');
    expect(render).toContain('AUTO');
  });

  it('executor is started on init via checkDueSchedules', () => {
    const fn = html.slice(html.indexOf('function checkDueSchedules()'), html.indexOf('function checkDueSchedules()') + 800);
    expect(fn).toContain('AgentScheduleExecutor.start()');
  });

  it('Autonoma "allow agent" understands scheduled execution grants', () => {
    const fn = html.slice(html.indexOf('function _handleAgentAllow'), html.indexOf('function _handleAgentLimit'));
    expect(fn).toContain("ops.push('scheduled')");
  });

  it('Autonoma "execute schedules" integrates the Agent Wallet executor', () => {
    const fn = html.slice(html.indexOf('function _handleExecuteSchedules'), html.indexOf('function _handleMultiStepWorkflow'));
    expect(fn).toContain('AgentScheduleExecutor.getDueSchedules');
    expect(fn).toContain('AgentScheduleExecutor.tickNow');
    expect(fn).toContain('hasScheduledAuth');
  });

  it('does not alter the manual scheduleRun flow', () => {
    const fn = html.slice(html.indexOf('async function scheduleRun(id)'), html.indexOf('function schedulePause'));
    expect(fn).toContain("showPage('batch')");
    expect(fn).toContain("showPage('swap')");
    expect(fn).toContain("showPage('bridge')");
  });
});
