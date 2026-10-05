/**
 * ARC MAINNET CHAIN AVAILABILITY — Autonoma regression tests
 * ═══════════════════════════════════════════════════════════════════════
 * Proves the Autonoma pipeline recognizes Arc Mainnet (chainId 5042) as a
 * supported chain regardless of chain-name casing/alias or a stale persisted
 * `agentState.supportedChains` (legacy "Arc Testnet" from pre-mainnet).
 *
 * Covers:
 *   - PolicyEngine chain availability (the "Chain Availability" rule)
 *   - AgentAuthorization network scope acceptance
 *   - normalization: Arc / Arc Mainnet / arc / ARC / 5042 / Arc Testnet → 5042
 *
 * Real production modules are executed (shared/policyEngine.js,
 * shared/agentAuthorization.js). No network calls are made.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const policySrc = fs.readFileSync(path.join(root, 'public', 'shared', 'policyEngine.js'), 'utf8');
const authSrc = fs.readFileSync(path.join(root, 'public', 'shared', 'agentAuthorization.js'), 'utf8');

function makeLocalStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

function evalModule(src, paramNames, args, winRef) {
  const fn = new Function(...paramNames, src);
  fn.apply(null, args);
  return winRef;
}

// STALE legacy state (pre-mainnet) — the exact source of the production bug.
const STALE_SUPPORTED_CHAINS = ['Arc Testnet', 'Base', 'Ethereum', 'Arbitrum', 'Optimism', 'Polygon'];

function bootPolicy(opts = {}) {
  const wm = Object.assign({
    isShutdown: () => false,
    isPaused: () => false,
    getSupportedChains: () => (opts.supportedChains || STALE_SUPPORTED_CHAINS).slice(),
    validatePreExecution: () => ({ ok: true }),
  }, opts.wmOverrides || {});
  globalThis.AgentWalletManager = wm;
  globalThis.localStorage = opts.ls || makeLocalStorage();
  const polWin = {};
  evalModule(policySrc, ['window'], [polWin]);
  return { PolicyEngine: polWin.PolicyEngine, wm };
}

function chainRule(res) {
  return (res.results || []).find((r) => r.rule === 'Chain Availability') || null;
}

function bootAuth(opts = {}) {
  const ls = opts.ls || makeLocalStorage();
  globalThis.localStorage = ls;
  globalThis.walletAddress = opts.grantedBy || '0x' + '33'.repeat(20);
  globalThis.CircleAgent = { getCachedAddress: () => ('0x' + '22'.repeat(20)) };
  const win = {};
  evalModule(authSrc, ['window', 'localStorage'], [win, ls]);
  return { AgentAuthorization: win.AgentAuthorization, ls };
}

beforeEach(() => {
  delete globalThis.AgentWalletManager;
  delete globalThis.localStorage;
  delete globalThis.AgentAuthorization;
  delete globalThis.walletAddress;
  delete globalThis.CircleAgent;
});

describe('PolicyEngine — chain availability (Arc Mainnet canonical)', () => {
  it('accepts "Arc Mainnet" even with a stale "Arc Testnet" supported-chains list', () => {
    const { PolicyEngine } = bootPolicy();
    const res = PolicyEngine.quickCheck('payment', 0.01, 'USDC', 'Arc Mainnet');
    expect(chainRule(res)).toBeTruthy();
    expect(chainRule(res).passed).toBe(true);
  });

  it('normalizes Arc / arc / ARC / 5042 / Arc Testnet → 5042 (all available)', () => {
    const { PolicyEngine } = bootPolicy();
    for (const net of ['Arc', 'arc', 'ARC', '5042', 'Arc Testnet', 'ARC MAINNET']) {
      const res = PolicyEngine.quickCheck('payment', 0.01, 'USDC', net);
      const rule = chainRule(res);
      expect(rule, 'network ' + net).toBeTruthy();
      expect(rule.passed, 'network ' + net).toBe(true);
    }
  });

  it('keeps existing networks supported (Base, Ethereum, Arbitrum, Optimism, Polygon)', () => {
    const { PolicyEngine } = bootPolicy({ supportedChains: ['Arc Mainnet', 'Base', 'Ethereum', 'Arbitrum', 'Optimism', 'Polygon'] });
    for (const net of ['Base', 'Ethereum', 'Arbitrum', 'Optimism', 'Polygon']) {
      const res = PolicyEngine.quickCheck('payment', 0.01, 'USDC', net);
      expect(chainRule(res).passed, 'network ' + net).toBe(true);
    }
  });

  it('blocks an unknown network (no fabricated support)', () => {
    const { PolicyEngine } = bootPolicy();
    const res = PolicyEngine.quickCheck('payment', 0.01, 'USDC', 'FooChain');
    expect(chainRule(res).passed).toBe(false);
    expect(chainRule(res).reason).toContain('not in supported chains');
  });

  it('does NOT produce a Chain Availability failure for the reported scenario', () => {
    const { PolicyEngine } = bootPolicy();
    const res = PolicyEngine.quickCheck('payment', 0.01, 'USDC', 'Arc Mainnet');
    const failed = (res.failedRules || []).filter((r) => r.rule === 'Chain Availability');
    expect(failed.length).toBe(0);
  });
});

describe('AgentAuthorization — Arc network acceptance', () => {
  it('accepts Arc Mainnet with default allowedNetworks', () => {
    const { AgentAuthorization } = bootAuth();
    const auth = AgentAuthorization.createAuthorization({
      maxSpending: 1000, allowedTokens: ['USDC'], allowedNetworks: ['Arc Mainnet'],
      allowPayments: true, grantedBy: globalThis.walletAddress,
      agentWallet: '0x' + '22'.repeat(20),
    });
    const v = AgentAuthorization.validateExecution({ operation: 'payment', amount: 0.01, asset: 'USDC', network: 'Arc Mainnet' });
    expect(v.valid).toBe(true);
  });

  it('accepts Arc / arc / ARC / 5042 as Arc Mainnet', () => {
    const { AgentAuthorization } = bootAuth();
    AgentAuthorization.createAuthorization({
      maxSpending: 1000, allowedTokens: ['USDC'], allowedNetworks: ['Arc Mainnet'],
      allowPayments: true, grantedBy: globalThis.walletAddress,
      agentWallet: '0x' + '22'.repeat(20),
    });
    for (const net of ['Arc', 'arc', 'ARC', '5042']) {
      const v = AgentAuthorization.validateExecution({ operation: 'payment', amount: 0.01, asset: 'USDC', network: net });
      expect(v.valid, 'network ' + net).toBe(true);
    }
  });

  it('still rejects a network outside the allowed scope', () => {
    const { AgentAuthorization } = bootAuth();
    AgentAuthorization.createAuthorization({
      maxSpending: 1000, allowedTokens: ['USDC'], allowedNetworks: ['Arc Mainnet'],
      allowPayments: true, grantedBy: globalThis.walletAddress,
      agentWallet: '0x' + '22'.repeat(20),
    });
    const v = AgentAuthorization.validateExecution({ operation: 'payment', amount: 0.01, asset: 'USDC', network: 'Base' });
    expect(v.valid).toBe(false);
  });
});
