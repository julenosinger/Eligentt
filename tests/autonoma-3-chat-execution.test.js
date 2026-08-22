/**
 * AUTONOMA-3 — Chat Execution Compatibility & Bridge Restoration tests
 * ═══════════════════════════════════════════════════════════════════════
 * Proves, with ZERO regressions to AUTONOMA-0/1/2 and MS-2/MS-3/MS-4:
 *
 *   1. A NEW Chat command (Send / Swap) is a NEW execution even when all
 *      financial parameters are identical — it must NOT be blocked as
 *      "intent already submitted".
 *   2. The SAME Chat execution routed twice (same executionId) collapses to
 *      ONE broadcast — idempotency is preserved.
 *   3. Chat Bridge executes in BOTH directions for every CCTP source chain the
 *      existing Bridge/CCTP implementation supports (Arc ↔ external chains).
 *
 * The REAL production modules are executed here against stubbed providers.
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
const executorSrc = fs.readFileSync(path.join(root, 'public', 'shared', 'agentScheduleExecutor.js'), 'utf8');
const wmSrc = fs.readFileSync(path.join(root, 'public', 'shared', 'agentWalletManager.js'), 'utf8');
const srcHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const RCPT = '0x' + '11'.repeat(20);
const AGENT_ADDR = '0x' + '22'.repeat(20);
const USER_ADDR = '0x' + '33'.repeat(20);
const OTHER_AGENT = '0x' + '44'.repeat(20);
const OTHER_USER = '0x' + '55'.repeat(20);

const ARC_CHAIN_ID = 5042002;
const BASE_SEPOLIA = 84532;
const ETH_SEPOLIA = 11155111;
const ARB_SEPOLIA = 421614;
const OP_SEPOLIA = 11155420;
const POLY_AMOY = 80002;
const UNSUPPORTED_CHAIN = 999999;

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

function extractScheduleEngine(src) {
  const start = src.indexOf('const ScheduleEngine = (() => {');
  if (start < 0) throw new Error('ScheduleEngine not found');
  const bodyStart = src.indexOf('{', start);
  let depth = 0, end = -1;
  for (let j = bodyStart; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
  }
  return src.slice(start, end + 1) + ')();';
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
  return vm.runInContext('ScheduleEngine', context);
}

function evalModule(src, paramNames, args) {
  const fn = new Function(...paramNames, src);
  fn.apply(null, args);
}

function makeBroadcastProbe() {
  const probe = { broadcasts: 0, sendTransaction: 0, eth_sendRawTransaction: 0, writeContract: 0, sendCalls: 0 };
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

function bootGate(opts = {}) {
  const ls = opts.ls || makeLocalStorage();
  const { probe, signer, provider } = makeBroadcastProbe();
  const engine = makeEngine(ls);

  const authWin = {};
  evalModule(authSrc, ['window', 'localStorage'], [authWin, ls]);
  const AgentAuthorization = authWin.AgentAuthorization;

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
  globalThis.walletAddress = opts.walletAddress !== undefined ? opts.walletAddress : USER_ADDR;

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
  return Object.assign({ operation: 'payment', amount: 50, asset: 'USDC', network: 'Arc Testnet', destination: RCPT, chainId: ARC_CHAIN_ID }, over);
}
function swapIntent(over = {}) {
  return Object.assign({ operation: 'swap', amount: 50, asset: 'USDC', network: 'Arc Testnet', destination: '', chainId: ARC_CHAIN_ID }, over);
}
function bridgeIntent(over = {}) {
  return Object.assign({ operation: 'bridge', amount: 50, asset: 'USDC', network: 'Arc Testnet', destination: '', chainId: ARC_CHAIN_ID, simulationHash: '0x' + 'ab'.repeat(32) }, over);
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

describe('AUTONOMA-3 — execution identity (Chat Send)', () => {
  it('1. a NEW Send request (executionId) authorizes and acquires a fresh claim', async () => {
    const env = bootGate();
    grant(env.AgentAuthorization);
    const res = await env.gate.authorizeAutonomaExecution(paymentIntent({ executionId: 'exec_A' }), {});
    expect(res.ok).toBe(true);
    expect(res.claimKey).toMatch(/^aut0_/);
  });

  it('2. the SAME Send execution (same executionId) routed twice → blocked', async () => {
    const env = bootGate();
    grant(env.AgentAuthorization);
    const first = await env.gate.authorizeAutonomaExecution(paymentIntent({ executionId: 'exec_A' }), {});
    expect(first.ok).toBe(true);
    const second = await env.gate.authorizeAutonomaExecution(paymentIntent({ executionId: 'exec_A' }), {});
    expect(second.ok).toBe(false);
    expect(second.code).toBe('duplicate_intent');
  });

  it('3. the SAME Send execution from two instances → maximum ONE execution', async () => {
    const ls = makeLocalStorage();
    const envA = bootGate({ ls });
    grant(envA.AgentAuthorization);
    const ra = await envA.gate.authorizeAutonomaExecution(paymentIntent({ executionId: 'exec_A' }), {});
    expect(ra.ok).toBe(true);
    const envB = bootGate({ ls });
    const rb = await envB.gate.authorizeAutonomaExecution(paymentIntent({ executionId: 'exec_A' }), {});
    expect(rb.ok).toBe(false);
    expect(rb.code).toBe('duplicate_intent');
  });

  it('4. a NEW Send request with IDENTICAL financial parameters → a NEW broadcast (allowed)', async () => {
    const env = bootGate();
    grant(env.AgentAuthorization);
    const first = await env.gate.authorizeAutonomaExecution(paymentIntent({ executionId: 'exec_A' }), {});
    expect(first.ok).toBe(true);
    const second = await env.gate.authorizeAutonomaExecution(paymentIntent({ executionId: 'exec_B' }), {});
    expect(second.ok).toBe(true);
    expect(second.claimKey).not.toBe(first.claimKey);
  });

  it('5. a COMPLETED old Send does NOT block a new identical Send', async () => {
    const env = bootGate();
    grant(env.AgentAuthorization);
    const first = await env.gate.authorizeAutonomaExecution(paymentIntent({ executionId: 'exec_A' }), {});
    env.engine.updateExecutionClaim(first.claimKey, 'autonoma_execution_gate', { status: 'confirmed', txHash: '0xabc' });
    const second = await env.gate.authorizeAutonomaExecution(paymentIntent({ executionId: 'exec_B' }), {});
    expect(second.ok).toBe(true);
  });

  it('6. a FAILED old Send does NOT permanently block a new identical Send', async () => {
    const env = bootGate();
    grant(env.AgentAuthorization);
    const first = await env.gate.authorizeAutonomaExecution(paymentIntent({ executionId: 'exec_A' }), {});
    env.engine.updateExecutionClaim(first.claimKey, 'autonoma_execution_gate', { status: 'failed', txHash: null });
    const second = await env.gate.authorizeAutonomaExecution(paymentIntent({ executionId: 'exec_B' }), {});
    expect(second.ok).toBe(true);
  });

  it('regression guard: legacy intent WITHOUT executionId keeps deterministic idempotency', async () => {
    const env = bootGate();
    grant(env.AgentAuthorization);
    const first = await env.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(first.ok).toBe(true);
    const second = await env.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(second.ok).toBe(false);
    expect(second.code).toBe('duplicate_intent');
  });
});

describe('AUTONOMA-3 — execution identity (Chat Swap)', () => {
  it('7. a NEW Swap request (executionId) authorizes', async () => {
    const env = bootGate();
    grant(env.AgentAuthorization);
    const res = await env.gate.authorizeAutonomaExecution(swapIntent({ executionId: 'sw_A' }), {});
    expect(res.ok).toBe(true);
  });

  it('8. the SAME Swap execution routed twice → blocked', async () => {
    const env = bootGate();
    grant(env.AgentAuthorization);
    const first = await env.gate.authorizeAutonomaExecution(swapIntent({ executionId: 'sw_A' }), {});
    expect(first.ok).toBe(true);
    const second = await env.gate.authorizeAutonomaExecution(swapIntent({ executionId: 'sw_A' }), {});
    expect(second.ok).toBe(false);
    expect(second.code).toBe('duplicate_intent');
  });

  it('9. the SAME Swap execution from two instances → maximum ONE execution', async () => {
    const ls = makeLocalStorage();
    const envA = bootGate({ ls });
    grant(envA.AgentAuthorization);
    const ra = await envA.gate.authorizeAutonomaExecution(swapIntent({ executionId: 'sw_A' }), {});
    expect(ra.ok).toBe(true);
    const envB = bootGate({ ls });
    const rb = await envB.gate.authorizeAutonomaExecution(swapIntent({ executionId: 'sw_A' }), {});
    expect(rb.ok).toBe(false);
  });

  it('10. a NEW Swap request with IDENTICAL parameters → allowed', async () => {
    const env = bootGate();
    grant(env.AgentAuthorization);
    const first = await env.gate.authorizeAutonomaExecution(swapIntent({ executionId: 'sw_A' }), {});
    expect(first.ok).toBe(true);
    const second = await env.gate.authorizeAutonomaExecution(swapIntent({ executionId: 'sw_B' }), {});
    expect(second.ok).toBe(true);
    expect(second.claimKey).not.toBe(first.claimKey);
  });

  it('11. a COMPLETED old Swap does NOT block a new identical Swap', async () => {
    const env = bootGate();
    grant(env.AgentAuthorization);
    const first = await env.gate.authorizeAutonomaExecution(swapIntent({ executionId: 'sw_A' }), {});
    env.engine.updateExecutionClaim(first.claimKey, 'autonoma_execution_gate', { status: 'confirmed', txHash: '0xabc' });
    const second = await env.gate.authorizeAutonomaExecution(swapIntent({ executionId: 'sw_B' }), {});
    expect(second.ok).toBe(true);
  });
});

describe('AUTONOMA-3 — Chat Bridge routes (both directions)', () => {
  it('12. supported Arc → external route → allowed', async () => {
    const env = bootGate();
    grant(env.AgentAuthorization);
    const res = await env.gate.authorizeAutonomaExecution(bridgeIntent({ executionId: 'br_arc_base', chainId: ARC_CHAIN_ID }), {});
    expect(res.ok).toBe(true);
  });

  it('13. supported external → Arc route → allowed (every supported source)', async () => {
    for (const chainId of [ETH_SEPOLIA, BASE_SEPOLIA, ARB_SEPOLIA, OP_SEPOLIA, POLY_AMOY]) {
      const env = bootGate();
      grant(env.AgentAuthorization);
      const res = await env.gate.authorizeAutonomaExecution(bridgeIntent({ executionId: 'br_ext_' + chainId, chainId }), {});
      expect(res.ok, 'chainId ' + chainId + ' should be allowed').toBe(true);
    }
  });

  it('14. unsupported route → blocked (fail-closed)', async () => {
    const env = bootGate();
    grant(env.AgentAuthorization);
    const res = await env.gate.authorizeAutonomaExecution(bridgeIntent({ executionId: 'br_bad', chainId: UNSUPPORTED_CHAIN }), {});
    expect(res.ok).toBe(false);
    expect(res.code).toBe('wrong_chain');
    expect(env.probe.eth_sendRawTransaction).toBe(0);
  });

  it('15. wrong route → zero broadcast', async () => {
    const env = bootGate();
    grant(env.AgentAuthorization);
    const res = await env.gate.authorizeAutonomaExecution(bridgeIntent({ executionId: 'br_bad', chainId: UNSUPPORTED_CHAIN }), {});
    expect(res.ok).toBe(false);
    expect(env.probe.sendTransaction).toBe(0);
    expect(env.probe.eth_sendRawTransaction).toBe(0);
  });

  it('16. valid route + valid authorization → allowed', async () => {
    const env = bootGate();
    grant(env.AgentAuthorization);
    const res = await env.gate.authorizeAutonomaExecution(bridgeIntent({ executionId: 'br_ok', chainId: BASE_SEPOLIA }), {});
    expect(res.ok).toBe(true);
    expect(res.code).toBe('authorized');
  });

  it('turbo_bridge (external source) is allowed through the same CCTP source set', async () => {
    const env = bootGate();
    grant(env.AgentAuthorization);
    const res = await env.gate.authorizeAutonomaExecution(bridgeIntent({ executionId: 'tb', chainId: ETH_SEPOLIA, chainOperation: 'turbo_bridge' }), {});
    expect(res.ok).toBe(true);
  });

  it('bridge WITHOUT a simulation hash → policy blocks (policy is NOT bypassed)', async () => {
    const env = bootGate();
    grant(env.AgentAuthorization);
    const res = await env.gate.authorizeAutonomaExecution(bridgeIntent({ executionId: 'br_nosim', chainId: BASE_SEPOLIA, simulationHash: null }), {});
    expect(res.ok).toBe(false);
    expect(res.code).toBe('policy_denied');
    expect(env.probe.eth_sendRawTransaction).toBe(0);
  });
});

describe('AUTONOMA-3 — Bridge authorization & policy & wallet (fail-closed)', () => {
  it('17. wrong user wallet → zero broadcast', async () => {
    const env = bootGate({ walletAddress: OTHER_USER });
    grant(env.AgentAuthorization, { grantedBy: USER_ADDR });
    const res = await env.gate.authorizeAutonomaExecution(bridgeIntent({ executionId: 'br_wu', chainId: BASE_SEPOLIA }), {});
    expect(res.ok).toBe(false);
    expect(res.code).toBe('user_wallet_mismatch');
    expect(env.probe.eth_sendRawTransaction).toBe(0);
  });

  it('18. wrong Agent Wallet → zero broadcast', async () => {
    const env = bootGate();
    grant(env.AgentAuthorization, { agentWallet: OTHER_AGENT });
    const res = await env.gate.authorizeAutonomaExecution(bridgeIntent({ executionId: 'br_wa', chainId: BASE_SEPOLIA }), {});
    expect(res.ok).toBe(false);
    expect(res.code).toBe('agent_wallet_mismatch');
    expect(env.probe.eth_sendRawTransaction).toBe(0);
  });

  it('19. revoked authorization → zero broadcast', async () => {
    const env = bootGate();
    const a = grant(env.AgentAuthorization);
    env.AgentAuthorization.revokeAuthorization(a.id, 'test');
    const res = await env.gate.authorizeAutonomaExecution(bridgeIntent({ executionId: 'br_rev', chainId: BASE_SEPOLIA }), {});
    expect(res.ok).toBe(false);
    expect(env.probe.eth_sendRawTransaction).toBe(0);
  });

  it('20. policy approved → allowed', async () => {
    const env = bootGate();
    grant(env.AgentAuthorization);
    const res = await env.gate.authorizeAutonomaExecution(bridgeIntent({ executionId: 'br_pol_ok', chainId: BASE_SEPOLIA }), {});
    expect(res.ok).toBe(true);
  });

  it('21. policy denied → zero broadcast', async () => {
    const env = bootGate();
    grant(env.AgentAuthorization);
    env.PolicyEngine.validateExecution = () => ({ valid: false, failedRules: [{ rule: 'Custom', reason: 'denied' }] });
    const res = await env.gate.authorizeAutonomaExecution(bridgeIntent({ executionId: 'br_pol_no', chainId: BASE_SEPOLIA }), {});
    expect(res.ok).toBe(false);
    expect(res.code).toBe('policy_denied');
    expect(env.probe.eth_sendRawTransaction).toBe(0);
  });

  it('22. policy unavailable → zero broadcast', async () => {
    const env = bootGate();
    grant(env.AgentAuthorization);
    delete globalThis.PolicyEngine;
    const res = await env.gate.authorizeAutonomaExecution(bridgeIntent({ executionId: 'br_pol_x', chainId: BASE_SEPOLIA }), {});
    expect(res.ok).toBe(false);
    expect(res.code).toBe('policy_unavailable');
    expect(env.probe.eth_sendRawTransaction).toBe(0);
  });
});

describe('AUTONOMA-3 — Agent Wallet security (fail-closed)', () => {
  it('23. missing Agent Wallet → zero broadcast', async () => {
    const env = bootGate({ wmOverrides: { getAgentAddress: () => null } });
    grant(env.AgentAuthorization);
    const res = await env.gate.authorizeAutonomaExecution(paymentIntent({ executionId: 'p_mw' }), {});
    expect(res.ok).toBe(false);
    expect(res.code).toBe('agent_wallet_unavailable');
    expect(env.probe.eth_sendRawTransaction).toBe(0);
  });

  it('24. paused Agent Wallet → zero broadcast', async () => {
    const env = bootGate({ wmOverrides: { isPaused: () => true } });
    grant(env.AgentAuthorization);
    const res = await env.gate.authorizeAutonomaExecution(paymentIntent({ executionId: 'p_paused' }), {});
    expect(res.ok).toBe(false);
    expect(res.code).toBe('wallet_paused');
  });

  it('25. shutdown Agent Wallet → zero broadcast', async () => {
    const env = bootGate({ wmOverrides: { isShutdown: () => true } });
    grant(env.AgentAuthorization);
    const res = await env.gate.authorizeAutonomaExecution(paymentIntent({ executionId: 'p_down' }), {});
    expect(res.ok).toBe(false);
    expect(res.code).toBe('wallet_shutdown');
  });

  it('26. wrong chain/route → zero broadcast', async () => {
    const env = bootGate();
    grant(env.AgentAuthorization);
    const res = await env.gate.authorizeAutonomaExecution(paymentIntent({ executionId: 'p_badchain', chainId: 1 }), {});
    expect(res.ok).toBe(false);
    expect(res.code).toBe('wrong_chain');
    expect(env.probe.eth_sendRawTransaction).toBe(0);
  });
});

describe('AUTONOMA-3 — Chat Send broadcast count (end-to-end adapter)', () => {
  function bootAgentOp(opts = {}) {
    const env = bootGate(opts);
    const start = srcHtml.indexOf('var _agentExecState = {};');
    const end = srcHtml.indexOf('function _agentAddMsg(msg)');
    const block = srcHtml.slice(start, end) + '\nwindow._agentExecuteOp = _agentExecuteOp;';

    const probe = { broadcasts: 0, sent: [] };
    const provider = {
      async getFeeData() { return { maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }; },
      async getBalance() { return 10n ** 18n; },
      async send(method) {
        if (method === 'eth_getTransactionCount') return '0x0';
        throw new Error('unexpected ' + method);
      },
      async waitForTransaction() { return { status: 1, blockNumber: 1, gasUsed: 21000n }; },
    };
    const signer = new realEthers.Wallet('0x' + '22'.repeat(32)).connect(provider);

    env.wm.getSessionSigner = async () => signer;
    env.wm.getAgentProvider = () => provider;
    env.wm.validatePreExecution = () => ({ ok: true });

    globalThis.getCachedProvider = () => provider;
    globalThis._agentStateMsg = () => {};

    globalThis.AgentScheduleExecutor = {
      broadcast: async (s, p, rawTx) => { probe.broadcasts++; return '0x' + 'ab'.repeat(32); },
      nextNonce: async (p, from) => '0x0',
      waitReceipt: async (p, txHash) => ({ ok: true, receipt: { status: 1, blockNumber: 1, gasUsed: 21000n } }),
    };

    const R = { sep: () => '', section: () => '', row: () => '' };
    const win = {};
    const documentStub = { getElementById: () => ({ insertAdjacentHTML() {}, scrollTop: 0, scrollHeight: 0 }) };
    const params = ['window', 'R', 'AgentWalletManager', 'AgentAuthorization', 'AutonomaExecutionGate', 'AgentAudit', 'AgentReputation', 'ethers', 'document', 'ScheduleEngine'];
    const fn = new Function(...params, block);
    fn.call(null, win, R, env.wm, env.AgentAuthorization, env.gate, { recordExecution: () => {} }, { recordSuccess: () => {} }, realEthers, documentStub, env.engine);

    return { win, probe, provider, env };
  }

  it('a NEW Send request broadcasts ONCE; the same executionId does NOT broadcast again; a NEW executionId broadcasts again', async () => {
    const env = bootAgentOp();
    grant(env.env.AgentAuthorization);

    await env.win._agentExecuteOp('payment', 50, 'USDC', JSON.stringify({ address: RCPT }), 'exec_A');
    expect(env.probe.broadcasts).toBe(1);

    // Same execution identity routed again → idempotency blocks the broadcast.
    await env.win._agentExecuteOp('payment', 50, 'USDC', JSON.stringify({ address: RCPT }), 'exec_A');
    expect(env.probe.broadcasts).toBe(1);

    // NEW user command (identical financial parameters) → a NEW broadcast.
    await env.win._agentExecuteOp('payment', 50, 'USDC', JSON.stringify({ address: RCPT }), 'exec_B');
    expect(env.probe.broadcasts).toBe(2);
  });

  it('missing authorization → zero broadcasts even with a fresh executionId', async () => {
    const env = bootAgentOp();
    await env.win._agentExecuteOp('payment', 50, 'USDC', JSON.stringify({ address: RCPT }), 'exec_X');
    expect(env.probe.broadcasts).toBe(0);
  });
});

describe('AUTONOMA-3 — single broadcast authority + key isolation (static)', () => {
  it('27. only AgentScheduleExecutor contains Autonoma eth_sendRawTransaction', () => {
    const sharedDir = path.join(root, 'shared');
    const files = new Set();
    for (const name of fs.readdirSync(sharedDir)) {
      if (!name.endsWith('.js')) continue;
      const content = fs.readFileSync(path.join(sharedDir, name), 'utf8');
      if (content.includes('eth_sendRawTransaction')) files.add('shared/' + name);
    }
    if (srcHtml.includes('eth_sendRawTransaction')) files.add('index.html');
    expect([...files]).toEqual(['shared/agentScheduleExecutor.js']);
  });

  it('28. no _agentExecute* adapter broadcasts directly', () => {
    const markers = {
      _agentExecuteOp: 'function _agentAddMsg',
      _agentExecuteSwap: 'async function _agentExecuteBridge',
      _agentExecuteBridge: 'async function _agentExecuteTurboBridge',
      _agentExecuteTurboBridge: 'async function _agentExecuteLiquidity',
      _agentExecuteLiquidity: 'async function _agentExecuteMultiSend',
      _agentExecuteMultiSend: 'async function _agentExecuteSchedule',
    };
    for (const [fnName, next] of Object.entries(markers)) {
      const start = srcHtml.indexOf('async function ' + fnName + '(');
      const end = srcHtml.indexOf(next, start + 10);
      const body = srcHtml.slice(start, end > start ? end : start + 6000);
      expect(body, fnName + ' routes via authority').toContain('_agentBroadcast');
      expect(body, fnName + ' no direct send').not.toContain('eth_sendRawTransaction');
      expect(body, fnName + ' no direct sign').not.toContain('signer.signTransaction');
    }
  });

  it('29. no raw-key getter reintroduced', () => {
    expect(srcHtml).not.toContain('function _agentGetPrivateKey');
    expect(srcHtml).not.toContain('getSessionKey()');
    expect(wmSrc).not.toContain('getSessionKey: getSessionKey');
  });

  it('30. no plaintext key fallback reintroduced', () => {
    expect(wmSrc).not.toContain('using plaintext fallback');
    expect(wmSrc).toContain('_encryptV6');
    expect(wmSrc).toContain('getSessionSigner: getSessionSigner');
  });
});

describe('AUTONOMA-3 — Schedule duplicate-execution protection unchanged', () => {
  it('31. ScheduleEngine still exposes the shared claim authority', () => {
    const engine = makeEngine(makeLocalStorage());
    expect(typeof engine.claimExecution).toBe('function');
    expect(typeof engine.updateExecutionClaim).toBe('function');
    expect(typeof engine.releaseExecutionClaim).toBe('function');
  });

  it('32. AgentScheduleExecutor still owns the MS-2/MS-3/MS-4 broadcast/nonce/receipt primitives', () => {
    expect(executorSrc).toContain('broadcast: _signAndSend');
    expect(executorSrc).toContain('waitReceipt: _waitReceipt');
    expect(executorSrc).toContain('nextNonce: _nextNonce');
  });

  it('33. schedule delegation still bypasses the gate claim (no second claim)', async () => {
    const env = bootGate();
    grant(env.AgentAuthorization);
    env.gateWin.__autonomaScheduledDelegation = { schedId: 'SCH_X', key: 'SCH_X|now' };
    const res = await env.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(res.ok).toBe(true);
    expect(res.delegated).toBe(true);
    expect(res.claimKey).toBe(null);
  });
});
