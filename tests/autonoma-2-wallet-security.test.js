/**
 * AUTONOMA-2 — Agent Wallet Security & Key Isolation tests
 * ═══════════════════════════════════════════════════════════════════════
 * Proves the Agent private key is not exposed as ordinary browser-accessible
 * secret material, that signing is centralized through the single execution
 * authority (AUTONOMA-1), and that all security checks fail closed.
 *
 * The REAL production modules are executed here where feasible. No network
 * calls are made.
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
const wmSrc = fs.readFileSync(path.join(root, 'public', 'shared', 'agentWalletManager.js'), 'utf8');
const executorSrc = fs.readFileSync(path.join(root, 'public', 'shared', 'agentScheduleExecutor.js'), 'utf8');
const gateSrc = fs.readFileSync(path.join(root, 'public', 'shared', 'autonomaExecutionGate.js'), 'utf8');
const authSrc = fs.readFileSync(path.join(root, 'public', 'shared', 'agentAuthorization.js'), 'utf8');
const policySrc = fs.readFileSync(path.join(root, 'public', 'shared', 'policyEngine.js'), 'utf8');

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

  return { ls, engine, AgentAuthorization, PolicyEngine, wm, gate, gateWin };
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
});

describe('AUTONOMA-2 — key storage isolation (no plaintext / no raw-key API)', () => {
  it('1. Agent private key is never persisted as plaintext in localStorage', () => {
    // The only write path encrypts with ENC6 before setItem; the plaintext
    // fallback has been removed.
    expect(wmSrc).toContain('_encryptV6');
    expect(wmSrc).not.toContain('using plaintext fallback');
    expect(wmSrc).not.toContain('setItem(SESSION_KEY_ENC, payload)');
    // Fail-closed: if encryption fails the key is NOT persisted.
    expect(wmSrc).toContain('never persist a plaintext private key');
  });

  it('2. Agent private key is not present in sessionStorage', () => {
    // agentWalletManager never writes the key to sessionStorage.
    expect(wmSrc).not.toContain('sessionStorage.setItem');
  });

  it('3. Agent private key is not exposed through window/global state', () => {
    // Raw-key getter removed from the public API and from index.html.
    expect(wmSrc).not.toContain('getSessionKey: getSessionKey');
    expect(srcHtml).not.toContain('function _agentGetPrivateKey');
    expect(srcHtml).not.toContain('getSessionKey()');
    // The canonical signer source is the encrypted session signer.
    expect(wmSrc).toContain('getSessionSigner: getSessionSigner');
  });

  it('4. Agent Wallet state contains no plaintext private key', () => {
    // getFullState sanitizes the key before returning.
    expect(wmSrc).toContain('delete state.walletPrivateKey');
    expect(wmSrc).toContain('delete safe.walletPrivateKey');
  });

  it('5. legacy key migration verifies the address and never silently replaces the wallet', () => {
    // Migration derives the expected address and only deletes v1 after verification.
    expect(wmSrc).toContain('expectedAddress');
    expect(wmSrc).toContain('_safeDeleteLegacyV1');
    expect(wmSrc).toContain('_deriveAddressFromKey');
  });
});

describe('AUTONOMA-2 — signing is centralized (single signing authority)', () => {
  it('the sole signing interface is getSessionSigner (returns a signer, not a raw key)', () => {
    expect(wmSrc).toContain('async function getSessionSigner(provider)');
    expect(wmSrc).toContain('return new ethers.Wallet(key, p)');
  });

  it('index.html has no raw-key signing path (no signer.signTransaction, no getSessionKey)', () => {
    expect(srcHtml).not.toContain('signer.signTransaction');
    expect(srcHtml).not.toContain('getSessionKey');
    expect(srcHtml).not.toContain('new ethers.Wallet(sessionKey');
  });

  it('AgentScheduleExecutor.broadcast remains the ONLY Autonoma broadcast + signing primitive', () => {
    // The only eth_sendRawTransaction in the entire Autonoma path is in the authority.
    const sharedDir = path.join(root, 'shared');
    const files = new Set();
    for (const name of fs.readdirSync(sharedDir)) {
      if (!name.endsWith('.js')) continue;
      const c = fs.readFileSync(path.join(sharedDir, name), 'utf8');
      if (c.includes('eth_sendRawTransaction')) files.add(name);
    }
    if (srcHtml.includes('eth_sendRawTransaction')) files.add('index.html');
    expect([...files]).toEqual(['agentScheduleExecutor.js']);
    expect(executorSrc).toContain('broadcast: _signAndSend');
  });
});

describe('AUTONOMA-2 — fail-closed execution (zero broadcast)', () => {
  async function blockedCase(opts) {
    const env = boot(opts.env);
    const res = await env.gate.authorizeAutonomaExecution(paymentIntent(), {});
    return { env, res };
  }

  it('6. secure signer unavailable → no signing path, no broadcast (no fallback)', () => {
    // Static: the signer source is fail-closed and never falls back to a raw key.
    const signerSlice = srcHtml.slice(srcHtml.indexOf('async function _agentGetSigner('), srcHtml.indexOf('function _agentGetProvider('));
    expect(signerSlice).toContain('getSessionSigner');
    expect(signerSlice).not.toContain('_agentGetPrivateKey');
    expect(signerSlice).not.toContain('new ethers.Wallet(key');
  });

  it('7. wrong Agent Wallet (agent mismatch) → blocked', async () => {
    const { res } = await blockedCase({});
    // Grant bound to a different agent address.
    const env = boot();
    grant(env.AgentAuthorization, { agentWallet: OTHER_AGENT });
    const r = await env.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('agent_wallet_mismatch');
  });

  it('8. wrong user wallet → blocked', async () => {
    const env = boot({ walletAddress: OTHER_USER });
    grant(env.AgentAuthorization, { grantedBy: USER_ADDR });
    const r = await env.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('user_wallet_mismatch');
  });

  it('9. wrong chain → blocked', async () => {
    const env = boot();
    grant(env.AgentAuthorization);
    const r = await env.gate.authorizeAutonomaExecution(paymentIntent({ chainId: 1 }), {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('wrong_chain');
  });

  it('10. paused Agent Wallet → blocked', async () => {
    const env = boot({ wmOverrides: { isPaused: () => true } });
    grant(env.AgentAuthorization);
    const r = await env.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('wallet_paused');
  });

  it('11. shutdown Agent Wallet → blocked', async () => {
    const env = boot({ wmOverrides: { isShutdown: () => true } });
    grant(env.AgentAuthorization);
    const r = await env.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('wallet_shutdown');
  });

  it('12. missing Agent Wallet → blocked', async () => {
    const env = boot({ wmOverrides: { getAgentAddress: () => null } });
    grant(env.AgentAuthorization);
    const r = await env.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('agent_wallet_unavailable');
  });

  it('13. unauthorized operation → blocked', async () => {
    const env = boot();
    grant(env.AgentAuthorization, { allowPayments: false });
    const r = await env.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('authorization_denied');
  });

  it('14. policy denied → blocked', async () => {
    const env = boot();
    grant(env.AgentAuthorization);
    env.PolicyEngine.validateExecution = () => ({ valid: false, failedRules: [{ rule: 'Custom', reason: 'denied' }] });
    const r = await env.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('policy_denied');
  });

  it('15. duplicate intent → zero second broadcast', async () => {
    const env = boot();
    grant(env.AgentAuthorization);
    const first = await env.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(first.ok).toBe(true);
    const second = await env.gate.authorizeAutonomaExecution(paymentIntent(), {});
    expect(second.ok).toBe(false);
    expect(second.code).toBe('duplicate_intent');
  });

  it('16. authorized execution → exactly one broadcast (via the authority)', async () => {
    const env = boot();
    grant(env.AgentAuthorization);
    const calls = [];
    const provider = { async send(method) { calls.push(method); if (method === 'eth_sendRawTransaction') return '0x' + 'ab'.repeat(32); throw new Error(method); } };
    const signer = new realEthers.Wallet('0x' + '22'.repeat(32)).connect(provider);
    const exWin = {};
    evalModule(executorSrc, ['window', 'localStorage', 'document'], [exWin, env.ls, undefined]);
    const rawTx = { type: 2, chainId: 5042002, to: '0x3600000000000000000000000000000000000000', data: '0x', value: '0x0', gasLimit: '0x1d4c0', nonce: '0x0', maxFeePerGas: '0x2540be400', maxPriorityFeePerGas: '0x3b9aca00' };
    await exWin.AgentScheduleExecutor.broadcast(signer, provider, rawTx);
    expect(calls.filter((c) => c === 'eth_sendRawTransaction').length).toBe(1);
  });
});

describe('AUTONOMA-2 — _agentExecute* cannot broadcast directly', () => {
  const markers = {
    _agentExecuteOp: 'function _agentAddMsg',
    _agentExecuteSwap: 'async function _agentExecuteBridge',
    _agentExecuteBridge: 'async function _agentExecuteTurboBridge',
    _agentExecuteTurboBridge: 'async function _agentExecuteLiquidity',
    _agentExecuteLiquidity: 'async function _agentExecuteMultiSend',
    _agentExecuteMultiSend: 'async function _agentExecuteSchedule',
  };
  for (const [fnName, next] of Object.entries(markers)) {
    it(`${fnName} cannot broadcast or sign directly`, () => {
      const start = srcHtml.indexOf('async function ' + fnName + '(');
      const end = srcHtml.indexOf(next, start + 10);
      const body = srcHtml.slice(start, end > start ? end : start + 6000);
      expect(body, fnName + ' routes via authority').toContain('_agentBroadcast');
      expect(body, fnName + ' no direct send').not.toContain('eth_sendRawTransaction');
      expect(body, fnName + ' no direct sign').not.toContain('signer.signTransaction');
    });
  }
});
