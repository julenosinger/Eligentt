/**
 * UNIFIED BALANCE — UB-2.5 production validation & no-regression hardening.
 * ═══════════════════════════════════════════════════════════════════════════
 * Loads the FULL real UB engine (engine + state + price + analyze + memory +
 * refresh + fetch + render) into a sandbox with a stateful DOM. Verifies the
 * remaining production-invariant gaps: disconnect/connect during refresh, RPC
 * failures (timeout / single-chain-down / all-down), oracle/pool price outages,
 * and UI never rendering NaN / "undefined" / "$0.00" for unavailable values.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function slice(from, to) {
  const i = src.indexOf(from);
  if (i < 0) throw new Error('marker not found: ' + from);
  const j = to ? src.indexOf(to, i) : src.length;
  return src.slice(i, j < 0 ? src.length : j);
}

function assemble(timeoutMs) {
  const engineObj = slice('const UnifiedBalanceEngine = {', 'const UB = {');
  const ubState = slice('const UB = {', 'const UB_TOKEN_META');
  let constants = slice('const UB_RPC_TIMEOUT_MS', 'UB.analyze = function');
  const analyze = slice('UB.analyze = function', 'const FinancialMemory = (function()');
  const finMem = slice('const FinancialMemory = (function()', 'UB.getRecommendations');
  const refresh = slice('function ubRefresh()', 'function ubFetchAllBalances');
  const engineFetch = slice('function _ubProvider', 'function ubRenderAll');
  const render = slice('function ubRenderAll()', 'window.ubInit = ubInit;');
  if (timeoutMs != null) constants = constants.replace('const UB_RPC_TIMEOUT_MS = 8000', 'const UB_RPC_TIMEOUT_MS = ' + timeoutMs);
  return 'let walletAddress = "";\nlet activeChainId = 5042002;\n' +
    engineObj + '\n' + ubState + '\n' + constants + '\n' + analyze + '\n' + finMem + '\n' + refresh + '\n' + engineFetch + '\n' + render;
}

function makeEthers(balanceOf, getBalance) {
  const calls = { balanceOf: [], getBalance: [] };
  const ethersMock = {
    JsonRpcProvider: function (rpc) {
      return { rpc, getBalance: async function (addr) { calls.getBalance.push(addr); return getBalance ? await getBalance(addr) : 0n; } };
    },
    Contract: function (addr, abi, prov) {
      return { balanceOf: async function (w) { calls.balanceOf.push({ token: addr, wallet: w }); return balanceOf ? await balanceOf(addr, w) : 0n; } };
    },
  };
  return { ethersMock, calls };
}

function makeDoc() {
  const els = {};
  function get(id) {
    if (!els[id]) els[id] = { id, style: { display: (id === 'ub-content' ? 'none' : '') }, textContent: '', innerHTML: '' };
    return els[id];
  }
  return { els, get };
}

function load({ balanceOf, getBalance, chains, timeoutMs, findPool, poolData, OracleInterop } = {}) {
  const { ethersMock, calls } = makeEthers(balanceOf, getBalance);
  const doc = makeDoc();
  const localStorageMock = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } };
  const globals = {
    ethers: ethersMock,
    getCachedProvider: (rpc) => new ethersMock.JsonRpcProvider(rpc),
    localStorage: localStorageMock,
    UB_TOKEN_META: {
      USDC: { name: 'USD Coin', icon: 'U', color: '#2775ca' },
      EURC: { name: 'Euro Coin', icon: 'E', color: '#2562de' },
      cirBTC: { name: 'Circle BTC', icon: 'B', color: '#f7931a' },
      ETH: { name: 'Ether', icon: 'E', color: '#627eea' },
    },
    findPool: findPool || ((a, b) => {
      if ((a === 'USDC' && b === 'EURC') || (a === 'EURC' && b === 'USDC')) return { id: 'usdc-eurc', tokenA: 'USDC', tokenB: 'EURC' };
      return null;
    }),
    poolData: poolData || { 'usdc-eurc': { loaded: true, reserveA: 110000000, reserveB: 100000000 } },
    OracleInterop,
    CHAINS: chains || [arcChain()],
    USDC_ABI: ['function balanceOf(address) view returns (uint256)'],
    normalizeTokenList: (tokens) => tokens,
    document: { getElementById: (id) => doc.get(id), addEventListener: () => {} },
    performance: { now: () => Date.now() },
    UBScreen: { refreshDashboard: () => {} },
    toast: () => {},
  };
  const names = Object.keys(globals);
  const body = assemble(timeoutMs) +
    '\nreturn { UnifiedBalanceEngine, FinancialMemory, UB, ubRefresh, ubShowState, ubSetUpdating, ubMarkStale, ubRenderUpdated, ubRenderHero, ubRenderAssets, ubRenderIntelligence, ubRenderHealth, ubRenderAll, ubFetchAllBalances, ubBuildState, ubResult, ubFetchOne, ubResolveTokenPrice, ubTokenDeployed, setWallet: (w) => { walletAddress = w; }, getWallet: () => walletAddress, setActiveChain: (id) => { activeChainId = id; }, getGeneration: () => _ubGeneration, bumpGeneration: _ubBumpGeneration, getLastRenderedWallet: () => _ubLastRenderedWallet };';
  const fn = new Function(...names, body);
  const api = fn(...names.map((n) => globals[n]));
  api.calls = calls;
  api.ui = doc.get;
  api.localStorage = localStorageMock;
  return api;
}

function arcChain() {
  return {
    id: 'Arc_Testnet', name: 'Arc Testnet', shortName: 'Arc', chainId: 5042002, rpc: 'https://arc', isEvm: true,
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    tokens: { USDC: { address: '0xA0', decimals: 6 }, EURC: { address: '0xA1', decimals: 6 }, cirBTC: { address: '0xA2', decimals: 8 } },
  };
}
function evmChain(o) {
  return Object.assign({ rpc: 'https://rpc', isEvm: true, tokens: { USDC: { address: '0x' + o.chainId + 'A', decimals: 6 }, EURC: { address: '0x' + o.chainId + 'B', decimals: 6 }, cirBTC: { address: '0x' + o.chainId + 'C', decimals: 8 } } }, o);
}
function sepoliaChain() { return evmChain({ id: 'Ethereum_Sepolia', name: 'Ethereum Sepolia', shortName: 'Sepolia', chainId: 11155111, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } }); }

async function settle(eng, maxMs = 3000) {
  const start = Date.now();
  while ((eng.UB.loading || eng.UB._refreshQueued) && Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 10));
}

/* ── 1 — wallet disconnect / connect during refresh ─────────────── */
describe('Wallet switch — disconnect / connect during refresh', () => {
  it('disconnect during in-flight refresh discards results (no stale A data)', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const eng = load({ balanceOf: async () => gate.then(() => 1000000n), chains: [arcChain()] });
    eng.setWallet('0xaaaa');
    eng.ubRefresh();          // A in-flight (gated)
    eng.setWallet('');        // disconnect mid-flight
    eng.bumpGeneration();
    release();
    await settle(eng);
    expect(eng.UB.state.assets.length).toBe(0);
    expect(eng.UB.state.aggregateStatus).toBe('unavailable');
  });

  it('connect then refresh populates state for the new wallet', async () => {
    const eng = load({ balanceOf: async () => 1000000n, chains: [arcChain()] });
    eng.setWallet('0xbbbb');
    eng.ubRefresh();
    await settle(eng);
    expect(eng.UB.state.assets.length).toBeGreaterThan(0);
    expect(eng.getLastRenderedWallet()).toBe('0xbbbb');
  });

  it('wallet switch + network switch simultaneously → last wallet wins', async () => {
    let releaseA;
    const gateA = new Promise((r) => { releaseA = r; });
    const eng = load({
      balanceOf: async (addr, w) => (w === '0xaaaa' ? gateA.then(() => 1000000n) : 2000000n),
      chains: [arcChain()],
    });
    eng.setWallet('0xaaaa');
    eng.ubRefresh();               // A in-flight
    eng.setWallet('0xbbbb');
    eng.setActiveChain(11155111); // network switch
    eng.bumpGeneration();
    eng.ubRefresh();               // queued
    releaseA();
    await settle(eng);
    expect(eng.UB.state.assets.find((a) => a.token === 'USDC').balance).toBe(2);
  });
});

/* ── 2 — cache: reload + after TTL ───────────────────────────────── */
describe('Cache — reload + TTL', () => {
  it('reload (fresh engine instance) starts with cold cache', () => {
    const eng = load();
    expect(eng.UnifiedBalanceEngine.isCacheValid('0xwallet')).toBe(false);
    expect(eng.UnifiedBalanceEngine.getCacheState().hasData).toBe(false);
  });

  it('stale cache (after TTL) is re-fetched on refresh (never authoritative)', async () => {
    const eng = load({ balanceOf: async () => 1000000n, chains: [arcChain()] });
    eng.setWallet('0xaaaa');
    eng.ubRefresh();
    await settle(eng);
    eng.UnifiedBalanceEngine._cache._lastFetch = Date.now() - 20000; // force stale
    expect(eng.UnifiedBalanceEngine.getCacheState().stale).toBe(true);
    const before = eng.calls.balanceOf.length;
    eng.ubRefresh(); // manual refresh → re-fetch despite cache
    await settle(eng);
    expect(eng.calls.balanceOf.length).toBeGreaterThan(before);
    expect(eng.UnifiedBalanceEngine.getCacheState().stale).toBe(false); // refreshed
  });
});

/* ── 3 — RPC failures ────────────────────────────────────────────── */
describe('RPC failures — isolation', () => {
  it('single chain down → that chain unavailable, others still available', async () => {
    const eng = load({
      balanceOf: async (addr) => { if (addr.startsWith('0xA')) throw new Error('ARC_DOWN'); return 1000000n; },
      chains: [arcChain(), sepoliaChain()],
    });
    const results = await eng.ubFetchAllBalances('0xwallet');
    const arc = results.filter((r) => r.chainId === 'Arc_Testnet');
    const sep = results.filter((r) => r.chainId === 'Ethereum_Sepolia');
    expect(arc.every((r) => r.status === 'unavailable')).toBe(true);
    expect(sep.some((r) => r.status === 'available')).toBe(true);
  });

  it('timeout → unavailable (no fabricated zero), other results preserved', async () => {
    const eng = load({
      balanceOf: async (addr) => (addr === '0xA1' ? new Promise(() => {}) : 1000000n), // EURC never resolves
      chains: [arcChain()],
      timeoutMs: 25,
    });
    const results = await eng.ubFetchAllBalances('0xwallet');
    const eurc = results.find((r) => r.token === 'EURC');
    const usdc = results.find((r) => r.token === 'USDC');
    expect(eurc.status).toBe('unavailable');
    expect(eurc.amount).toBeNull();
    expect(usdc.status).toBe('available');
  });

  it('all chains down → all unavailable, never zero', async () => {
    const eng = load({ balanceOf: async () => { throw new Error('DOWN'); }, chains: [arcChain()] });
    const results = await eng.ubFetchAllBalances('0xwallet');
    expect(results.every((r) => r.status === 'unavailable')).toBe(true);
    expect(results.every((r) => r.raw === null)).toBe(true);
  });
});

/* ── 4 — price outage (oracle / pool) ────────────────────────────── */
describe('Price outage — oracle / pool', () => {
  it('oracle unavailable → price null (never hardcoded)', () => {
    const eng = load({ findPool: () => null, poolData: {}, OracleInterop: undefined });
    expect(eng.ubResolveTokenPrice('EURC')).toEqual({ status: 'unavailable', price: null });
    expect(eng.ubResolveTokenPrice('cirBTC')).toEqual({ status: 'unavailable', price: null });
    expect(eng.ubResolveTokenPrice('ETH')).toEqual({ status: 'unavailable', price: null });
  });

  it('oracle throws → price null (never hardcoded)', () => {
    const eng = load({ findPool: () => null, poolData: {}, OracleInterop: { getMarketData: () => { throw new Error('ORACLE_DOWN'); } } });
    expect(eng.ubResolveTokenPrice('EURC')).toEqual({ status: 'unavailable', price: null });
  });

  it('pool reserves unavailable → pool-derived price null', () => {
    const eng = load({ findPool: (a, b) => ({ id: 'p', tokenA: 'USDC', tokenB: 'EURC' }), poolData: { p: { loaded: false } } });
    expect(eng.ubResolveTokenPrice('EURC')).toEqual({ status: 'unavailable', price: null });
  });

  it('no hardcoded valuation anywhere in the UB section', () => {
    const ub = slice('const UnifiedBalanceEngine = {', 'window.ubInit = ubInit;');
    expect(ub).not.toContain('67000');
    expect(ub).not.toContain('2500');
    expect(ub).not.toContain('1.08');
    expect(ub).not.toContain('BTC_USD_PRICE');
    expect(ub).not.toContain('ETH_USD_PRICE');
    expect(ub).not.toContain('EURC_USD_RATE');
  });
});

/* ── 5 — UI: no NaN / undefined / "$0.00" for unavailable ────────── */
describe('UI — no NaN / undefined / fabricated $0', () => {
  function setState(eng, s) { eng.UB.state = s; }

  it('unavailable total renders "—" not "$0.00"', () => {
    const eng = load();
    setState(eng, { assets: [], totalUSD: 0, aggregateStatus: 'unavailable', hasValuedUSD: false });
    eng.ubRenderHero();
    expect(eng.ui('ub-hero-total').textContent).toBe('—');
    expect(eng.ui('ub-hero-total').textContent).not.toContain('NaN');
    expect(eng.ui('ub-hero-total').textContent).not.toContain('undefined');
  });

  it('asset with null usd renders "—" (not "$0.00", no NaN)', () => {
    const eng = load();
    setState(eng, {
      assets: [{ token: 'EURC', tokenName: 'Euro Coin', icon: 'E', color: '#2562de', chainId: 'Arc_Testnet', chainName: 'Arc', symbol: 'EURC', balance: 0.5, usd: null, address: '0xA1', status: 'available', decimals: 6 }],
      totalUSD: 0, aggregateStatus: 'partial', hasValuedUSD: false,
    });
    eng.ubRenderAssets();
    const html = eng.ui('ub-asset-tbody').innerHTML;
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('undefined');
    expect(html).toContain('—'); // unavailable usd shown as dash
  });

  it('concentration breakdown shows "—" for null-usd token (not $0.00)', () => {
    const eng = load();
    setState(eng, {
      assets: [
        { token: 'USDC', chainId: 'Arc_Testnet', chainName: 'Arc', usd: 1, balance: 1 },
        { token: 'EURC', chainId: 'Arc_Testnet', chainName: 'Arc', usd: null, balance: 0.5 },
      ],
      totalUSD: 1, aggregateStatus: 'partial', hasValuedUSD: true,
    });
    eng.ubRenderIntelligence();
    const html = eng.ui('ub-intelligence').innerHTML;
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('undefined');
    expect(html).toContain('—'); // EURC (unavailable) shown as dash in breakdown
  });

  it('health card renders without NaN when no assets', () => {
    const eng = load();
    setState(eng, { assets: [], totalUSD: 0, aggregateStatus: 'unavailable', hasValuedUSD: false });
    eng.ubRenderHealth();
    expect(eng.ui('ub-health-body').innerHTML).not.toContain('NaN');
    expect(eng.ui('ub-health-body').innerHTML).not.toContain('undefined');
  });
});
