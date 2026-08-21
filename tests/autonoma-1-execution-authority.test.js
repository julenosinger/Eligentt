/**
 * AUTONOMA-1 — Single Financial Execution Authority tests
 * ═══════════════════════════════════════════════════════════════════════
 * Proves the Autonoma financial execution architecture has converged to ONE
 * authoritative broadcast path:
 *
 *   Chat / DocIntel / Agent / Batch  →  _agentExecute* adapter
 *        → AutonomaExecutionGate (auth + policy + wallet + chain + claim)
 *        → AgentScheduleExecutor.broadcast (the ONLY eth_sendRawTransaction)
 *        → blockchain
 *
 * And Schedule → ScheduleEngine → AgentScheduleExecutor (MS-2/MS-3/MS-4).
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
const srcHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const executorSrc = fs.readFileSync(path.join(root, 'public', 'shared', 'agentScheduleExecutor.js'), 'utf8');
const gateSrc = fs.readFileSync(path.join(root, 'public', 'shared', 'autonomaExecutionGate.js'), 'utf8');
const authSrc = fs.readFileSync(path.join(root, 'public', 'shared', 'agentAuthorization.js'), 'utf8');
const policySrc = fs.readFileSync(path.join(root, 'public', 'shared', 'policyEngine.js'), 'utf8');

const RCPT = '0x' + '11'.repeat(20);
const AGENT_ADDR = '0x' + '22'.repeat(20);
const USER_ADDR = '0x' + '33'.repeat(20);
const OTHER_AGENT = '0x' + '44'.repeat(20);

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

function boot(opts = {}) {
  const ls = opts.ls || makeLocalStorage();
  const engine = makeEngine(ls);

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
  globalThis.walletAddress = opts.walletAddress !== undefined ? opts.walletAddress : USER_ADDR;

  // Single execution authority (real agentScheduleExecutor module).
  const exWin = {};
  evalModule(executorSrc, ['window', 'localStorage', 'document'], [exWin, ls, undefined]);
  const authority = exWin.AgentScheduleExecutor;

  // Gate (real module).
  const gateWin = {};
  evalModule(gateSrc, ['window'], [gateWin]);
  const gate = gateWin.AutonomaExecutionGate;

  return { ls, engine, AgentAuthorization, PolicyEngine, wm, authority, gate, gateWin };
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
  delete globalThis.AgentScheduleExecutor;
});

describe('AUTONOMA-1 — single broadcast authority (live code audit)', () => {
  it('eth_sendRawTransaction exists ONLY inside AgentScheduleExecutor (the authority)', () => {
    const files = new Set();
    const sharedDir = path.join(root, 'shared');
    for (const name of fs.readdirSync(sharedDir)) {
      if (!name.endsWith('.js')) continue;
      const content = fs.readFileSync(path.join(sharedDir, name), 'utf8');
      if (content.includes('eth_sendRawTransaction')) files.add('shared/' + name);
    }
    if (srcHtml.includes('eth_sendRawTransaction')) files.add('index.html');
    expect([...files]).toEqual(['shared/agentScheduleExecutor.js']);
  });

  it('index.html no longer signs or broadcasts directly (adapters only)', () => {
    expect(srcHtml).not.toContain('eth_sendRawTransaction');
    expect(srcHtml).not.toContain('signer.signTransaction');
    expect(srcHtml).toContain('_agentBroadcast');
    expect(srcHtml).toContain('_agentNextNonce');
    expect(srcHtml).toContain('_agentWaitReceipt');
  });

  it('the authority exposes the single broadcast/nonce/receipt primitives', () => {
    expect(executorSrc).toContain('broadcast: _signAndSend');
    expect(executorSrc).toContain('waitReceipt: _waitReceipt');
    expect(executorSrc).toContain('nextNonce: _nextNonce');
  });

  it('every _agentExecute* adapter is gated and routes broadcast through the authority', () => {
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
      expect(body, fnName + ' gate').toContain('_agentGateCheck');
      expect(body, fnName + ' authority').toContain('_agentBroadcast');
      expect(body, fnName + ' no direct send').not.toContain('eth_sendRawTransaction');
      expect(body, fnName + ' no direct sign').not.toContain('signer.signTransaction');
    }
  });
});

describe('AUTONOMA-1 — single authority broadcast primitive (dynamic)', () => {
  it('AgentScheduleExecutor.broadcast is the only sign+send path', async () => {
    const env = boot();
    const calls = [];
    const provider = {
      async send(method, params) {
        calls.push(method);
        if (method === 'eth_sendRawTransaction') return '0x' + 'ab'.repeat(32);
        throw new Error('unexpected ' + method);
      },
    };
    const signer = new realEthers.Wallet('0x' + '22'.repeat(32)).connect(provider);
    const rawTx = {
      type: 2, chainId: 5042002, to: '0x3600000000000000000000000000000000000000',
      data: '0x', value: '0x0', gasLimit: '0x1d4c0', nonce: '0x0',
      maxFeePerGas: '0x2540be400', maxPriorityFeePerGas: '0x3b9aca00',
    };
    const txHash = await env.authority.broadcast(signer, provider, rawTx);
    expect(txHash).toBe('0x' + 'ab'.repeat(32));
    expect(calls.filter((c) => c === 'eth_sendRawTransaction').length).toBe(1);
  });

  it('nextNonce reads the pending nonce through the authority', async () => {
    const env = boot();
    const provider = { async send(method, params) { return method === 'eth_getTransactionCount' ? '0x2a' : '0x0'; } };
    const nonce = await env.authority.nextNonce(provider, AGENT_ADDR);
    expect(nonce).toBe('0x2a');
  });
});

describe('AUTONOMA-1 — adapter routes through the single authority (payment)', () => {
  function bootPayment() {
    const env = boot();
    const probe = { eth_sendRawTransaction: 0 };
    const provider = {
      async getFeeData() { return { maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }; },
      async getBalance() { return 10n ** 18n; },
      async send(method) { throw new Error('direct provider.send: ' + method); },
    };
    const signer = new realEthers.Wallet('0x' + '22'.repeat(32)).connect(provider);

    env.wm.getSessionSigner = async () => signer;
    env.wm.getAgentProvider = () => provider;
    env.wm.validatePreExecution = () => ({ ok: true });

    // The authority's broadcast is the single broadcast point.
    env.authority.broadcast = async (s, p, rawTx) => { probe.eth_sendRawTransaction++; return '0x' + 'ab'.repeat(32); };
    env.authority.nextNonce = async () => '0x0';
    env.authority.waitReceipt = async () => ({ ok: true, receipt: { status: 1, blockNumber: 1, gasUsed: 21000n } });
    globalThis.AgentScheduleExecutor = env.authority;

    const start = srcHtml.indexOf('var _agentExecState = {};');
    const end = srcHtml.indexOf('function _agentAddMsg(msg)');
    const block = srcHtml.slice(start, end) + '\nwindow._agentExecuteOp = _agentExecuteOp;';
    globalThis.getCachedProvider = () => provider;
    globalThis._agentStateMsg = () => {};

    const R = { sep: () => '', section: () => '', row: () => '' };
    const win = {};
    const documentStub = { getElementById: () => ({ insertAdjacentHTML() {}, scrollTop: 0, scrollHeight: 0 }) };
    const params = ['window', 'R', 'AgentWalletManager', 'AgentAuthorization', 'AutonomaExecutionGate', 'AgentAudit', 'AgentReputation', 'ethers', 'document', 'ScheduleEngine'];
    const fn = new Function(...params, block);
    fn.call(null, win, R, env.wm, env.AgentAuthorization, env.gate, { recordExecution: () => {} }, { recordSuccess: () => {} }, realEthers, documentStub, env.engine);

    return { win, probe, env };
  }

  it('authorized payment → exactly ONE broadcast via the authority', async () => {
    const env = bootPayment();
    grant(env.env.AgentAuthorization);
    await env.win._agentExecuteOp('payment', 50, 'USDC', JSON.stringify({ address: RCPT }));
    expect(env.probe.eth_sendRawTransaction).toBe(1);
  });

  it('missing authorization → zero broadcasts', async () => {
    const env = bootPayment();
    await env.win._agentExecuteOp('payment', 50, 'USDC', JSON.stringify({ address: RCPT }));
    expect(env.probe.eth_sendRawTransaction).toBe(0);
  });

  it('wrong wallet (agent mismatch) → zero broadcasts', async () => {
    const env = bootPayment();
    grant(env.env.AgentAuthorization, { agentWallet: OTHER_AGENT });
    await env.win._agentExecuteOp('payment', 50, 'USDC', JSON.stringify({ address: RCPT }));
    expect(env.probe.eth_sendRawTransaction).toBe(0);
  });

  it('policy denied → zero broadcasts', async () => {
    const env = bootPayment();
    grant(env.env.AgentAuthorization);
    env.env.PolicyEngine.validateExecution = () => ({ valid: false, failedRules: [{ rule: 'Custom', reason: 'denied' }] });
    await env.win._agentExecuteOp('payment', 50, 'USDC', JSON.stringify({ address: RCPT }));
    expect(env.probe.eth_sendRawTransaction).toBe(0);
  });
});

describe('AUTONOMA-1 — idempotency via single claim authority', () => {
  it('duplicate chat intent → maximum ONE broadcast', async () => {
    const env = boot();
    grant(env.AgentAuthorization);
    const first = await env.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(first.ok).toBe(true);
    const second = await env.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(second.ok).toBe(false);
    expect(second.code).toBe('duplicate_intent');
  });

  it('two Autonoma instances → maximum ONE broadcast', async () => {
    const ls = makeLocalStorage();
    const envA = boot({ ls });
    grant(envA.AgentAuthorization);
    const ra = await envA.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(ra.ok).toBe(true);
    const envB = boot({ ls });
    const rb = await envB.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(rb.ok).toBe(false);
    expect(rb.code).toBe('duplicate_intent');
  });

  it('reload during pending → no duplicate broadcast', async () => {
    const ls = makeLocalStorage();
    const envA = boot({ ls });
    grant(envA.AgentAuthorization);
    const first = await envA.gate.authorizeAutonomaExecution(paymentIntent(), {});
    envA.engine.updateExecutionClaim(first.claimKey, 'autonoma_execution_gate', { status: 'submitted', txHash: '0xabc' });
    const envB = boot({ ls });
    const res = await envB.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(res.ok).toBe(false);
    expect(res.code).toBe('duplicate_intent');
  });

  it('schedule delegation passes through without a second claim', async () => {
    const env = boot();
    grant(env.AgentAuthorization);
    env.gateWin.__autonomaScheduledDelegation = { schedId: 'SCH_X', key: 'SCH_X|now' };
    const res = await env.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(res.ok).toBe(true);
    expect(res.delegated).toBe(true);
    expect(res.claimKey).toBe(null);
  });
});
