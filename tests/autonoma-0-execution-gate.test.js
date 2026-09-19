/**
 * AUTONOMA-0 — Containment & Execution Safety Gate tests
 * ═══════════════════════════════════════════════════════════════════════
 * Proves Autonoma cannot broadcast a financial transaction unless the
 * operation passes through the single centralized execution gate
 * (window.AutonomaExecutionGate.authorizeAutonomaExecution).
 *
 * The REAL production modules are executed here:
 *   - shared/autonomaExecutionGate.js  (the gate under test)
 *   - shared/agentAuthorization.js     (authorization decisions)
 *   - shared/policyEngine.js           (policy decisions)
 *   - index.html ScheduleEngine        (shared execution claim / idempotency)
 *
 * No network calls are made.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ethers as realEthers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const gateSrc = fs.readFileSync(path.join(root, 'public', 'shared', 'autonomaExecutionGate.js'), 'utf8');
const authSrc = fs.readFileSync(path.join(root, 'public', 'shared', 'agentAuthorization.js'), 'utf8');
const policySrc = fs.readFileSync(path.join(root, 'public', 'shared', 'policyEngine.js'), 'utf8');
const srcHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const RCPT = '0x' + '11'.repeat(20);
const AGENT_ADDR = '0x' + '22'.repeat(20);
const USER_ADDR = '0x' + '33'.repeat(20);
const OTHER_AGENT = '0x' + '44'.repeat(20);
const OTHER_USER = '0x' + '55'.repeat(20);

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

// Real ScheduleEngine claim store (idempotency authority).
function extractScheduleEngine(srcHtml2) {
  const start = srcHtml2.indexOf('const ScheduleEngine = (() => {');
  if (start < 0) throw new Error('ScheduleEngine not found');
  const bodyStart = srcHtml2.indexOf('{', start);
  let depth = 0, end = -1;
  for (let j = bodyStart; j < srcHtml2.length; j++) {
    if (srcHtml2[j] === '{') depth++;
    else if (srcHtml2[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
  }
  return srcHtml2.slice(start, end + 1) + ')();';
}

function makeEngine(localStorage) {
  const context = {
    Store: { load: () => [], save: () => {} },
    localStorage,
    document: { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} },
    Date, JSON, Object, Array, Promise, Math, Number, String,
  };
  vm.createContext(context);
  vm.runInContext(extractScheduleEngine(srcHtml), context);
  return { engine: vm.runInContext('ScheduleEngine', context), context };
}

// A probe that records any financial broadcast. The gate must never trigger these.
function makeBroadcastProbe() {
  const probe = { sendTransaction: 0, eth_sendRawTransaction: 0, writeContract: 0, sendCalls: 0 };
  return {
    probe,
    signer: {
      async sendTransaction() { probe.sendTransaction++; throw new Error('signer.sendTransaction called'); },
      async signTransaction(tx) { return '0xdeadbeef'; },
    },
    provider: {
      async send(method) {
        if (method === 'eth_sendRawTransaction') probe.eth_sendRawTransaction++;
        throw new Error('provider.send called');
      },
      async writeContract() { probe.writeContract++; throw new Error('provider.writeContract called'); },
      async sendCalls() { probe.sendCalls++; throw new Error('provider.sendCalls called'); },
    },
  };
}

function evalModule(src, paramNames, args, winRef) {
  const fn = new Function(...paramNames, src);
  fn.apply(null, args);
  return winRef;
}

function bootGate(opts = {}) {
  const ls = opts.ls || makeLocalStorage();
  const { probe, signer, provider } = makeBroadcastProbe();
  const { engine } = makeEngine(ls);

  // Authorization (real module).
  const authWin = {};
  evalModule(authSrc, ['window', 'localStorage'], [authWin, ls]);
  const AgentAuthorization = authWin.AgentAuthorization;

  // Policy (real module).
  const polWin = {};
  evalModule(policySrc, ['window'], [polWin]);
  const PolicyEngine = polWin.PolicyEngine;

  const wm = Object.assign({
    isShutdown: () => false,
    isPaused: () => false,
    getAgentAddress: () => AGENT_ADDR,
    getSupportedChains: () => ['Arc Testnet'],
    recordExecution: () => {},
    recordOperationSuccess: () => {},
  }, opts.wmOverrides || {});

  globalThis.localStorage = ls;
  globalThis.ScheduleEngine = engine;
  globalThis.AgentAuthorization = AgentAuthorization;
  globalThis.PolicyEngine = PolicyEngine;
  globalThis.AgentWalletManager = wm;
  if (opts.walletAddress !== undefined) globalThis.walletAddress = opts.walletAddress;
  else globalThis.walletAddress = USER_ADDR;

  const gateWin = {};
  evalModule(gateSrc, ['window'], [gateWin]);
  const gate = gateWin.AutonomaExecutionGate;

  return { gate, ls, engine, AgentAuthorization, PolicyEngine, wm, probe, signer, provider, gateWin };
}

function grant(az, over = {}) {
  return az.createAuthorization(Object.assign({
    maxSpending: 1000, dailyLimit: 1000,
    allowedTokens: ['USDC'], allowedNetworks: ['Arc Testnet'],
    allowPayments: true, allowSwap: true, allowBridge: true,
    agentWallet: AGENT_ADDR, grantedBy: USER_ADDR,
    durationMs: 3600000, maxRiskLevel: 'MEDIUM',
  }, over));
}

function paymentIntent(over = {}) {
  return Object.assign({ operation: 'payment', amount: 50, asset: 'USDC', network: 'Arc Testnet', destination: RCPT, chainId: 5042002 }, over);
}

beforeEach(() => {
  delete globalThis.ScheduleEngine;
  delete globalThis.AgentAuthorization;
  delete globalThis.PolicyEngine;
  delete globalThis.AgentWalletManager;
  delete globalThis.walletAddress;
  delete globalThis.getCachedProvider;
  delete globalThis._agentStateMsg;
  delete globalThis.AgentScheduleExecutor;
});

describe('AUTONOMA-0 — execution gate (fail-closed)', () => {
  it('1. missing authorization → BLOCK, zero broadcasts', async () => {
    const env = bootGate();
    const res = await env.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(res.ok).toBe(false);
    expect(res.code).toBe('authorization_missing');
    expect(env.probe.sendTransaction).toBe(0);
    expect(env.probe.eth_sendRawTransaction).toBe(0);
    expect(env.probe.writeContract).toBe(0);
    expect(env.probe.sendCalls).toBe(0);
  });

  it('2. invalid authorization (operation not permitted) → BLOCK, zero broadcasts', async () => {
    const env = bootGate();
    grant(env.AgentAuthorization, { allowPayments: false });
    const res = await env.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(res.ok).toBe(false);
    expect(res.code).toBe('authorization_denied');
    expect(env.probe.eth_sendRawTransaction).toBe(0);
    expect(env.probe.sendTransaction).toBe(0);
    expect(env.probe.writeContract).toBe(0);
    expect(env.probe.sendCalls).toBe(0);
  });

  it('2b. revoked authorization → BLOCK', async () => {
    const env = bootGate();
    const a = grant(env.AgentAuthorization);
    env.AgentAuthorization.revokeAuthorization(a.id, 'test');
    const res = await env.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(res.ok).toBe(false);
  });

  it('3. policy denied → BLOCK, zero broadcasts', async () => {
    const env = bootGate();
    grant(env.AgentAuthorization);
    env.PolicyEngine.validateExecution = () => ({ valid: false, failedRules: [{ rule: 'Custom', reason: 'denied by policy' }] });
    const res = await env.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(res.ok).toBe(false);
    expect(res.code).toBe('policy_denied');
    expect(env.probe.eth_sendRawTransaction).toBe(0);
    expect(env.probe.sendTransaction).toBe(0);
    expect(env.probe.writeContract).toBe(0);
    expect(env.probe.sendCalls).toBe(0);
  });

  it('4. policy unavailable → BLOCK, zero broadcasts', async () => {
    const env = bootGate();
    grant(env.AgentAuthorization);
    delete globalThis.PolicyEngine;
    const res = await env.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(res.ok).toBe(false);
    expect(res.code).toBe('policy_unavailable');
    expect(env.probe.eth_sendRawTransaction).toBe(0);
  });

  it('5. approval missing (no active grant) → BLOCK', async () => {
    const env = bootGate();
    const res = await env.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(res.ok).toBe(false);
    expect(res.code).toBe('authorization_missing');
    expect(env.probe.eth_sendRawTransaction).toBe(0);
  });

  it('6. wrong wallet (authorization belongs to another agent wallet) → BLOCK', async () => {
    const env = bootGate();
    grant(env.AgentAuthorization, { agentWallet: OTHER_AGENT });
    const res = await env.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(res.ok).toBe(false);
    expect(res.code).toBe('agent_wallet_mismatch');
    expect(env.probe.eth_sendRawTransaction).toBe(0);
  });

  it('7. wrong chain → BLOCK, zero broadcasts', async () => {
    const env = bootGate();
    grant(env.AgentAuthorization);
    const res = await env.gate.authorizeAutonomaExecution(paymentIntent({ chainId: 1 }), {});
    expect(res.ok).toBe(false);
    expect(res.code).toBe('wrong_chain');
    expect(env.probe.eth_sendRawTransaction).toBe(0);
  });

  it('8. duplicate chat intent → maximum ONE execution', async () => {
    const env = bootGate();
    grant(env.AgentAuthorization);
    const first = await env.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(first.ok).toBe(true);
    const second = await env.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(second.ok).toBe(false);
    expect(second.code).toBe('duplicate_intent');
  });

  it('9. two Autonoma instances → maximum ONE execution', async () => {
    const ls = makeLocalStorage();
    const envA = bootGate({ ls });
    grant(envA.AgentAuthorization);
    const ra = await envA.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(ra.ok).toBe(true);

    // A second independent gate instance sharing the same storage.
    const envB = bootGate({ ls });
    const rb = await envB.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(rb.ok).toBe(false);
    expect(rb.code).toBe('duplicate_intent');
  });

  it('10. Autonoma + Schedule same occurrence → maximum ONE execution (shared claim)', async () => {
    const env = bootGate();
    grant(env.AgentAuthorization);
    // Simulate the schedule path claiming the same occurrence slot first.
    const claimKey = env.gate.intentKey({ operation: 'payment', wallet: AGENT_ADDR, asset: 'USDC', amount: 50, destinations: [RCPT], destination: RCPT, chainId: 5042002 });
    const schedClaim = await env.engine.claimExecution(claimKey, 'agent_schedule_executor', { scheduleId: 'SCH_X', occurrenceId: claimKey, wallet: AGENT_ADDR, chain: 'Arc Testnet' });
    expect(schedClaim.acquired).toBe(true);
    // The gate must NOT broadcast a second time for the same financial intent.
    const res = await env.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(res.ok).toBe(false);
    expect(res.code).toBe('duplicate_intent');
  });

  it('11. reload during pending operation → no duplicate broadcast', async () => {
    const ls = makeLocalStorage();
    const envA = bootGate({ ls });
    grant(envA.AgentAuthorization);
    const first = await envA.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(first.ok).toBe(true);
    // A broadcast happened; the tx is submitted. Persist that state.
    envA.engine.updateExecutionClaim(first.claimKey, 'autonoma_execution_gate', { status: 'submitted', txHash: '0xabc' });

    // Reload: a fresh instance reading the same storage must not re-claim/re-broadcast.
    const envB = bootGate({ ls });
    const res = await envB.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(res.ok).toBe(false);
    expect(res.code).toBe('duplicate_intent');
  });

  it('12. receipt timeout → no duplicate broadcast', async () => {
    const ls = makeLocalStorage();
    const envA = bootGate({ ls });
    grant(envA.AgentAuthorization);
    const first = await envA.gate.authorizeAutonomaExecution(paymentIntent(), {});
    envA.engine.updateExecutionClaim(first.claimKey, 'autonoma_execution_gate', { status: 'submitted', txHash: '0x123' });
    const envB = bootGate({ ls });
    const res = await envB.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(res.ok).toBe(false);
  });

  it('13. lost transaction → no blind rebroadcast', async () => {
    const ls = makeLocalStorage();
    const envA = bootGate({ ls });
    grant(envA.AgentAuthorization);
    const first = await envA.gate.authorizeAutonomaExecution(paymentIntent(), {});
    envA.engine.updateExecutionClaim(first.claimKey, 'autonoma_execution_gate', { status: 'submitted', txHash: '0xdead' });
    const envB = bootGate({ ls });
    const res = await envB.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(res.ok).toBe(false);
    expect(res.code).toBe('duplicate_intent');
  });

  it('14. Agent Wallet A cannot execute using Wallet B authorization', async () => {
    const env = bootGate({ wmOverrides: { getAgentAddress: () => OTHER_AGENT } });
    grant(env.AgentAuthorization, { agentWallet: AGENT_ADDR });
    const res = await env.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(res.ok).toBe(false);
    expect(res.code).toBe('agent_wallet_mismatch');
  });

  it('15. session from wallet A cannot authorize wallet B', async () => {
    const env = bootGate({ walletAddress: OTHER_USER });
    grant(env.AgentAuthorization, { grantedBy: USER_ADDR });
    const res = await env.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(res.ok).toBe(false);
    expect(res.code).toBe('user_wallet_mismatch');
  });

  it('16. missing Agent Wallet state → BLOCK, never fallback unsafely', async () => {
    const env = bootGate({ wmOverrides: { getAgentAddress: () => null } });
    grant(env.AgentAuthorization);
    const res = await env.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(res.ok).toBe(false);
    expect(res.code).toBe('agent_wallet_unavailable');
    expect(env.probe.eth_sendRawTransaction).toBe(0);
  });

  it('17. read-only Autonoma remains functional (valid intent still authorizes)', async () => {
    const env = bootGate();
    grant(env.AgentAuthorization);
    // Read-only surfaces are untouched.
    expect(env.engine.getAll()).toBeInstanceOf(Array);
    expect(typeof env.PolicyEngine.getDefaults().maxGasUsd).toBe('number');
    // A valid intent passes the gate (execution is not blanket-disabled).
    const res = await env.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(res.ok).toBe(true);
    expect(res.claimKey).toMatch(/^aut0_/);
  });

  it('delegated schedule execution passes through without re-claiming', async () => {
    const env = bootGate();
    grant(env.AgentAuthorization);
    env.gateWin.__autonomaScheduledDelegation = { schedId: 'SCH_X', key: 'SCH_X|now' };
    const res = await env.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(res.ok).toBe(true);
    expect(res.delegated).toBe(true);
    expect(res.claimKey).toBe(null);
  });

  it('happy path: valid intent is authorized and acquires the shared claim', async () => {
    const env = bootGate();
    const a = grant(env.AgentAuthorization);
    const res = await env.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(res.ok).toBe(true);
    expect(res.code).toBe('authorized');
    expect(res.auth.id).toBe(a.id);
    expect(res.agentWallet).toBe(AGENT_ADDR);
    expect(res.claimKey).toMatch(/^aut0_/);
  });
});

describe('AUTONOMA-0 — source wiring (index.html)', () => {
  it('loads the execution gate module', () => {
    expect(srcHtml).toContain('<script src="/shared/autonomaExecutionGate.js"></script>');
  });

  function fnSlice(src, from, to) {
    const a = src.indexOf(from);
    const b = src.indexOf(to, a + from.length);
    if (a < 0 || b < 0) return '';
    return src.slice(a, b);
  }

  function assertGated(fn, name) {
    const gateIdx = fn.indexOf('_agentGateCheck');
    const brIdx = fn.indexOf('_agentBroadcast');
    expect(gateIdx, name + ' must call the gate').toBeGreaterThan(-1);
    expect(brIdx, name + ' must broadcast via the single authority').toBeGreaterThan(gateIdx);
    // AUTONOMA-1: the adapter must NEVER broadcast directly.
    expect(fn.indexOf('eth_sendRawTransaction'), name + ' must not broadcast directly').toBe(-1);
    expect(fn.indexOf('signer.signTransaction'), name + ' must not sign directly').toBe(-1);
  }

  it('_agentExecuteOp (payment) is gated before broadcast', () => {
    const fn = fnSlice(srcHtml, 'async function _agentExecuteOp(', 'function _agentAddMsg');
    assertGated(fn, '_agentExecuteOp');
  });

  it('_agentExecuteSwap is gated before broadcast', () => {
    const fn = fnSlice(srcHtml, 'async function _agentExecuteSwap(', 'async function _agentExecuteBridge');
    assertGated(fn, '_agentExecuteSwap');
  });

  it('_agentExecuteBridge is gated before broadcast', () => {
    const fn = fnSlice(srcHtml, 'async function _agentExecuteBridge(', 'async function _agentExecuteTurboBridge');
    assertGated(fn, '_agentExecuteBridge');
  });

  it('_agentExecuteMultiSend is gated before broadcast', () => {
    const fn = fnSlice(srcHtml, 'async function _agentExecuteMultiSend(', 'async function _agentExecuteSchedule');
    assertGated(fn, '_agentExecuteMultiSend');
  });

  it('_agentExecuteLiquidity is gated before broadcast', () => {
    const fn = fnSlice(srcHtml, 'async function _agentExecuteLiquidity(', 'async function _agentExecuteMultiSend');
    assertGated(fn, '_agentExecuteLiquidity');
  });

  it('fail-open helpers are now fail-closed', () => {
    const revalidate = fnSlice(srcHtml, 'function _agentRevalidateAuth(', 'function _agentPreValidate');
    expect(revalidate).toContain('return { ok: false, reason: \'Authorization system unavailable\' }');

    const canExecute = fnSlice(srcHtml, 'function _agentCanExecute(', 'async function _agentGateCheck');
    expect(canExecute).toContain('return false;');
    expect(canExecute).not.toContain('return true;');

    const preValidate = fnSlice(srcHtml, 'function _agentPreValidate(', 'function _agentCanExecute');
    expect(preValidate).toContain('return false;');
  });
});

describe('AUTONOMA-0 — end-to-end broadcast guard (_agentExecuteOp payment)', () => {
  // Evaluate the REAL _agentExecuteOp + helpers and prove the gate blocks the
  // actual eth_sendRawTransaction call path.
  function bootAgentOp(opts = {}) {
    const env = bootGate(opts);
    const start = srcHtml.indexOf('var _agentExecState = {};');
    const end = srcHtml.indexOf('function _agentAddMsg(msg)');
    const block = srcHtml.slice(start, end) + '\nwindow._agentExecuteOp = _agentExecuteOp;';

    // Counting provider that records eth_sendRawTransaction and satisfies the
    // raw payment path (nonce / feeData / waitForTransaction).
    const probe = { eth_sendRawTransaction: 0, sent: [] };
    const provider = {
      async getFeeData() { return { maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }; },
      async getBalance() { return 10n ** 18n; },
      async send(method) {
        if (method === 'eth_getTransactionCount') return '0x0';
        if (method === 'eth_sendRawTransaction') { probe.eth_sendRawTransaction++; probe.sent.push(arguments[1] && arguments[1][0]); return '0x' + 'ab'.repeat(32); }
        throw new Error('unexpected ' + method);
      },
      async waitForTransaction() { return { status: 1, blockNumber: 1, gasUsed: 21000n }; },
    };
    const signer = new realEthers.Wallet('0x' + '22'.repeat(32)).connect(provider);

    // The gate expects the agent address from AgentWalletManager; make the
    // signer source consistent (same provider, so eth_sendRawTransaction is captured).
    env.wm.getSessionSigner = async () => signer;
    env.wm.getAgentProvider = () => provider;
    env.wm.validatePreExecution = () => ({ ok: true });

    // _agentGetProvider falls back to getCachedProvider (a free global in the block).
    globalThis.getCachedProvider = () => provider;
    globalThis._agentStateMsg = () => {};

    // AUTONOMA-1: the adapter routes broadcast/nonce/receipt through the single
    // execution authority (AgentScheduleExecutor). Stub its primitives and count
    // the authoritative broadcast.
    globalThis.AgentScheduleExecutor = {
      broadcast: async (signer, provider, rawTx) => { probe.eth_sendRawTransaction++; return '0x' + 'ab'.repeat(32); },
      nextNonce: async (provider, from) => '0x0',
      waitReceipt: async (provider, txHash) => ({ ok: true, receipt: { status: 1, blockNumber: 1, gasUsed: 21000n } }),
    };

    const R = { sep: () => '', section: () => '', row: () => '' };
    const win = {};
    const documentStub = {
      getElementById: () => ({ insertAdjacentHTML() {}, scrollTop: 0, scrollHeight: 0 }),
    };
    const params = ['window', 'R', 'AgentWalletManager', 'AgentAuthorization', 'AutonomaExecutionGate', 'AgentAudit', 'AgentReputation', 'ethers', 'document', 'ScheduleEngine'];
    const fn = new Function(...params, block);
    fn.call(null, win, R, env.wm, env.AgentAuthorization, env.gate, { recordExecution: () => {} }, { recordSuccess: () => {} }, realEthers, documentStub, env.engine);

    return { win, probe, provider, env };
  }

  it('missing authorization → the raw executor never broadcasts', async () => {
    const env = bootAgentOp();
    await env.win._agentExecuteOp('payment', 50, 'USDC', JSON.stringify({ address: RCPT }));
    expect(env.probe.eth_sendRawTransaction).toBe(0);
  });

  it('authorized → the raw executor broadcasts exactly once', async () => {
    const env = bootAgentOp();
    grant(env.env.AgentAuthorization);
    await env.win._agentExecuteOp('payment', 50, 'USDC', JSON.stringify({ address: RCPT }));
    expect(env.probe.eth_sendRawTransaction).toBe(1);
  });
});
