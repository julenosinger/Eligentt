/**
 * UNIFIED BALANCE — UB-2.4 real-world cache + refresh hardening.
 * ═══════════════════════════════════════════════════════════════════════════
 * Loads the REAL UnifiedBalanceEngine, FinancialMemory, ubRefresh and ubShowState
 * into a sandbox with a stateful DOM + in-memory localStorage. Verifies:
 *   - cache: TTL, freshness/staleness, wallet-scoping, invalidation, never authoritative
 *   - refresh: coalescing, "updating" state, preserve-last-known-data on all-unavailable,
 *     wallet-switch blanks to loading (never shows wallet-A data for wallet-B),
 *     A→B→A, network-switch does not change multi-chain total
 *   - FinancialMemory: wallet-scoped history/trend, dedup on identical snapshot
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

function assemble() {
  const engineObj = slice('const UnifiedBalanceEngine = {', 'const UB = {');
  const ubState = slice('const UB = {', 'const UB_TOKEN_META');
  const constants = slice('const UB_RPC_TIMEOUT_MS', 'UB.analyze = function');
  const finMem = slice('const FinancialMemory = (function()', 'UB.getRecommendations');
  const refresh = slice('function ubRefresh()', 'function ubFetchAllBalances');
  const engineFetch = slice('function _ubProvider', 'function ubRenderAll');
  return 'let walletAddress = "";\nlet activeChainId = 5042002;\n' +
    engineObj + '\n' + ubState + '\n' + constants + '\n' + finMem + '\n' + refresh + '\n' + engineFetch;
}

function makeEthers(balanceOf, getBalance) {
  const calls = { balanceOf: [], getBalance: [] };
  const ethersMock = {
    JsonRpcProvider: function (rpc) {
      return { rpc, getBalance: async function (addr) { calls.getBalance.push(addr); return getBalance ? await getBalance(addr) : 0n; } };
    },
    // No `Interface` → UB multicall path falls back to individual balanceOf.
    Contract: function (addr, abi, prov) {
      return { balanceOf: async function (w) { calls.balanceOf.push({ token: addr, wallet: w }); return balanceOf ? await balanceOf(addr, w) : 0n; } };
    },
  };
  return { ethersMock, calls };
}

function makeDoc() {
  const els = {};
  function get(id) {
    if (!els[id]) els[id] = { id, style: { display: (id === 'ub-content' ? 'none' : '') }, textContent: '' };
    return els[id];
  }
  return { els, get };
}

function load({ balanceOf, getBalance, chains, store } = {}) {
  const { ethersMock, calls } = makeEthers(balanceOf, getBalance);
  const localStorageMock = {
    _m: store ? new Map(store) : new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
    removeItem(k) { this._m.delete(k); },
  };
  const doc = makeDoc();
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
    findPool: (a, b) => {
      if ((a === 'USDC' && b === 'EURC') || (a === 'EURC' && b === 'USDC')) return { id: 'usdc-eurc', tokenA: 'USDC', tokenB: 'EURC' };
      return null;
    },
    poolData: { 'usdc-eurc': { loaded: true, reserveA: 110000000, reserveB: 100000000 } },
    CHAINS: chains || [arcChain()],
    USDC_ABI: ['function balanceOf(address) view returns (uint256)'],
    document: { getElementById: (id) => doc.get(id) },
    performance: { now: () => Date.now() },
    UBScreen: { refreshDashboard: () => {} },
    ubRenderAll: () => {},
  };
  const names = Object.keys(globals);
  const body = assemble() +
    '\nreturn { UnifiedBalanceEngine, FinancialMemory, UB, ubRefresh, ubShowState, ubSetUpdating, ubMarkStale, ubRenderUpdated, ubFetchAllBalances, ubBuildState, ubResult, ubTokenDeployed, setWallet: (w) => { walletAddress = w; }, getWallet: () => walletAddress, setActiveChain: (id) => { activeChainId = id; }, getGeneration: () => _ubGeneration, bumpGeneration: _ubBumpGeneration, getLastRenderedWallet: () => _ubLastRenderedWallet };';
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
  return Object.assign({
    rpc: 'https://rpc', isEvm: true,
    tokens: {
      USDC: { address: '0x' + o.chainId + 'A', decimals: 6 },
      EURC: { address: '0x' + o.chainId + 'B', decimals: 6 },
      cirBTC: { address: '0x' + o.chainId + 'C', decimals: 8 },
    },
  }, o);
}
function sepoliaChain() { return evmChain({ id: 'Ethereum_Sepolia', name: 'Ethereum Sepolia', shortName: 'Sepolia', chainId: 11155111, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } }); }
function baseChain() { return evmChain({ id: 'Base_Sepolia', name: 'Base Sepolia', shortName: 'Base', chainId: 84532, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } }); }
function realChains() { return [arcChain(), sepoliaChain(), baseChain()]; }

async function settle(eng, maxMs = 3000) {
  const start = Date.now();
  while ((eng.UB.loading || eng.UB._refreshQueued) && Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 10));
}

/* ── 1 — cache TTL / freshness / staleness ─────────────────────── */
describe('Cache — TTL / fresh / stale', () => {
  it('cold cache → not valid, hasData false', () => {
    const eng = load();
    expect(eng.UnifiedBalanceEngine.isCacheValid('0xwallet')).toBe(false);
    expect(eng.UnifiedBalanceEngine.getCacheState().hasData).toBe(false);
    expect(eng.UnifiedBalanceEngine.getCacheState().fresh).toBe(false);
  });

  it('after notifyRefreshComplete → fresh within TTL', () => {
    const eng = load();
    eng.setWallet('0xwallet');
    eng.UnifiedBalanceEngine.notifyRefreshComplete([{ token: 'USDC' }], 1);
    expect(eng.UnifiedBalanceEngine.isCacheValid('0xwallet')).toBe(true);
    const s = eng.UnifiedBalanceEngine.getCacheState();
    expect(s.fresh).toBe(true);
    expect(s.stale).toBe(false);
    expect(s.hasData).toBe(true);
  });

  it('expired TTL → stale (never fresh)', () => {
    const eng = load();
    eng.setWallet('0xwallet');
    eng.UnifiedBalanceEngine.notifyRefreshComplete([{ token: 'USDC' }], 1);
    eng.UnifiedBalanceEngine._cache._lastFetch = Date.now() - 20000; // force age > 15s TTL
    expect(eng.UnifiedBalanceEngine.isCacheValid('0xwallet')).toBe(false);
    const s = eng.UnifiedBalanceEngine.getCacheState();
    expect(s.stale).toBe(true);
    expect(s.fresh).toBe(false);
  });

  it('invalidate clears cache', () => {
    const eng = load();
    eng.setWallet('0xwallet');
    eng.UnifiedBalanceEngine.notifyRefreshComplete([{ token: 'USDC' }], 1);
    eng.UnifiedBalanceEngine.invalidate();
    expect(eng.UnifiedBalanceEngine.isCacheValid('0xwallet')).toBe(false);
    expect(eng.UnifiedBalanceEngine.getCacheState().hasData).toBe(false);
  });

  it('cache is wallet-scoped (wallet A never valid for wallet B)', () => {
    const eng = load();
    eng.setWallet('0xaaaa');
    eng.UnifiedBalanceEngine.notifyRefreshComplete([{ token: 'USDC' }], 1);
    eng.setWallet('0xbbbb');
    expect(eng.UnifiedBalanceEngine.isCacheValid('0xbbbb')).toBe(false);
    expect(eng.UnifiedBalanceEngine.isCacheValid('0xaaaa')).toBe(true);
  });

  it('markUpdated sets timestamp; getLastUpdated returns it', () => {
    const eng = load();
    eng.setWallet('0xwallet');
    eng.UnifiedBalanceEngine.markUpdated('0xwallet');
    expect(eng.UnifiedBalanceEngine.getLastUpdated()).toBeGreaterThan(0);
    expect(eng.UnifiedBalanceEngine._cache._wallet).toBe('0xwallet');
  });
});

/* ── 2 — refresh coalescing + cache never authoritative ─────────── */
describe('Refresh — coalescing + cache-not-authoritative', () => {
  it('manual refresh always re-fetches (cache is not a source of truth)', async () => {
    const eng = load({ balanceOf: async () => 1000000n, chains: [arcChain()] });
    eng.setWallet('0xaaaa');
    eng.ubRefresh();
    await settle(eng);
    const first = eng.calls.balanceOf.length;
    eng.ubRefresh(); // manual refresh with fresh cache → still re-fetches
    await settle(eng);
    expect(eng.calls.balanceOf.length).toBeGreaterThan(first);
  });

  it('rapid repeated refresh coalesces to at most one follow-up', async () => {
    let calls = 0;
    const eng = load({ balanceOf: async () => { calls++; return 1000000n; }, chains: [arcChain()] });
    eng.setWallet('0xaaaa');
    eng.ubRefresh();
    eng.ubRefresh(); eng.ubRefresh(); eng.ubRefresh(); eng.ubRefresh();
    await settle(eng);
    expect(calls).toBeLessThanOrEqual(6); // initial + 1 follow-up (never 5)
  });
});

/* ── 3 — preserve last-known data on all-unavailable ─────────────── */
describe('Refresh — preserve last-known data', () => {
  it('all-unavailable refresh keeps prior data (stale) instead of blanking', async () => {
    let fail = false;
    const eng = load({ balanceOf: async () => { if (fail) throw new Error('DOWN'); return 1000000n; }, chains: [arcChain()] });
    eng.setWallet('0xaaaa');
    eng.ubRefresh();
    await settle(eng);
    expect(eng.UB.state.assets.length).toBeGreaterThan(0);
    expect(eng.ui('ub-content').style.display).not.toBe('none');

    fail = true; // RPC goes down
    eng.ubRefresh();
    await settle(eng);
    // Prior portfolio preserved (not blanked), marked stale, still content (not error).
    expect(eng.UB.state.assets.length).toBeGreaterThan(0);
    expect(eng.ui('ub-content').style.display).not.toBe('none');
    expect(eng.ui('ub-error').style.display).toBe('none');
    expect(eng.ui('ub-updated').textContent).toContain('Stale');
  });

  it('all-unavailable on FIRST load → unavailable state (no prior data to preserve)', async () => {
    const eng = load({ balanceOf: async () => { throw new Error('DOWN'); }, chains: [arcChain()] });
    eng.setWallet('0xaaaa');
    eng.ubRefresh();
    await settle(eng);
    expect(eng.UB.state.aggregateStatus).toBe('unavailable');
    expect(eng.UB.state.assets.length).toBe(0);
  });

  it('real zero balance → complete with empty assets (NOT preserved as stale)', async () => {
    const eng = load({ balanceOf: async () => 0n, chains: [arcChain()] });
    eng.setWallet('0xaaaa');
    eng.ubRefresh();
    await settle(eng);
    expect(eng.UB.state.aggregateStatus).toBe('complete');
    expect(eng.UB.state.assets.length).toBe(0);
  });
});

/* ── 4 — wallet switch: no stale wallet-A data shown for wallet-B ── */
describe('Wallet switch — visual isolation', () => {
  it('on wallet switch the prior wallet data is blanked to loading', async () => {
    let releaseB;
    const gateB = new Promise((r) => { releaseB = r; });
    const eng = load({
      balanceOf: async (addr, w) => {
        if (w === '0xbbbb') return gateB.then(() => 2000000n);
        return 1000000n;
      },
      chains: [arcChain()],
    });
    eng.setWallet('0xaaaa');
    eng.ubRefresh();
    await settle(eng);
    expect(eng.ui('ub-content').style.display).not.toBe('none'); // A content shown

    eng.setWallet('0xbbbb');
    eng.bumpGeneration();
    eng.ubRefresh(); // B starts (gated) — must blank A's content immediately
    expect(eng.ui('ub-content').style.display).toBe('none');
    expect(eng.ui('ub-loading').style.display).toBe('');

    releaseB();
    await settle(eng);
    const usdc = eng.UB.state.assets.find((a) => a.token === 'USDC');
    expect(usdc.balance).toBe(2); // B's balance, never A's (1)
    expect(eng.ui('ub-content').style.display).not.toBe('none');
  });

  it('A → B → A returns to A correctly (no cross-contamination)', async () => {
    const eng = load({
      balanceOf: async (addr, w) => (w === '0xbbbb' ? 2000000n : 1000000n),
      chains: [arcChain()],
    });
    eng.setWallet('0xaaaa'); eng.ubRefresh(); await settle(eng);
    eng.setWallet('0xbbbb'); eng.bumpGeneration(); eng.ubRefresh(); await settle(eng);
    expect(eng.UB.state.assets.find((a) => a.token === 'USDC').balance).toBe(2);
    eng.setWallet('0xaaaa'); eng.bumpGeneration(); eng.ubRefresh(); await settle(eng);
    expect(eng.UB.state.assets.find((a) => a.token === 'USDC').balance).toBe(1);
  });
});

/* ── 5 — network switch: multi-chain total invariant ─────────────── */
describe('Network switch — multi-chain invariant', () => {
  it('activeChainId does not change totalUSD or drop other chains', async () => {
    const eng = load({ balanceOf: async (addr) => (addr.endsWith('A') ? 1000000n : 500000n), chains: realChains() });
    eng.setWallet('0xaaaa');
    const r1 = await eng.ubFetchAllBalances('0xaaaa');
    const s1 = eng.ubBuildState(r1, 1);
    const chains1 = new Set(r1.filter((r) => r.status === 'available').map((r) => r.chainId));

    eng.setActiveChain(11155111); // Sepolia active — UB must stay multi-chain
    const r2 = await eng.ubFetchAllBalances('0xaaaa');
    const s2 = eng.ubBuildState(r2, 1);
    const chains2 = new Set(r2.filter((r) => r.status === 'available').map((r) => r.chainId));

    expect(s2.totalUSD).toBeCloseTo(s1.totalUSD, 6);
    expect([...chains2].sort()).toEqual([...chains1].sort()); // Arc + Sepolia + Base all preserved
  });

  it('wallet switch + network switch (generation bump) discards stale result', async () => {
    let releaseA;
    const gateA = new Promise((r) => { releaseA = r; });
    const eng = load({
      balanceOf: async (addr, w) => {
        if (w === '0xaaaa') return gateA.then(() => 1000000n);
        return 2000000n;
      },
      chains: [arcChain()],
    });
    eng.setWallet('0xaaaa');
    eng.ubRefresh();               // A in-flight (gated)
    eng.setWallet('0xbbbb');
    eng.setActiveChain(11155111); // network also switched
    eng.bumpGeneration();
    eng.ubRefresh();               // queued
    releaseA();
    await settle(eng);
    expect(eng.UB.state.assets.find((a) => a.token === 'USDC').balance).toBe(2);
  });
});

/* ── 6 — FinancialMemory: wallet-scoped + dedup ──────────────────── */
describe('FinancialMemory — wallet-scoped + dedup', () => {
  it('snapshots are wallet-scoped (wallet A history never shows for wallet B)', () => {
    const eng = load();
    eng.setWallet('0xaaaa');
    eng.UB.state = { assets: [{ token: 'USDC', usd: 1, chainId: 'Arc_Testnet' }], totalUSD: 1 };
    eng.FinancialMemory.takeSnapshot();
    eng.setWallet('0xbbbb');
    eng.UB.state = { assets: [], totalUSD: 0 };
    expect(eng.FinancialMemory.getHistory().length).toBe(0); // B sees none of A's snapshots
    eng.setWallet('0xaaaa');
    expect(eng.FinancialMemory.getHistory().length).toBe(1);
  });

  it('identical consecutive refresh does not stack duplicate snapshots', () => {
    const eng = load();
    eng.setWallet('0xaaaa');
    eng.UB.state = { assets: [{ token: 'USDC', usd: 1, chainId: 'Arc_Testnet' }], totalUSD: 1 };
    eng.FinancialMemory.takeSnapshot();
    eng.FinancialMemory.takeSnapshot();
    eng.FinancialMemory.takeSnapshot(); // same data, repeated
    expect(eng.FinancialMemory.getHistory().length).toBe(1);
  });

  it('a material change creates a new snapshot', () => {
    const eng = load();
    eng.setWallet('0xaaaa');
    eng.UB.state = { assets: [{ token: 'USDC', usd: 1, chainId: 'Arc_Testnet' }], totalUSD: 1 };
    eng.FinancialMemory.takeSnapshot();
    eng.UB.state = { assets: [{ token: 'USDC', usd: 1, chainId: 'Arc_Testnet' }, { token: 'EURC', usd: 1, chainId: 'Arc_Testnet' }], totalUSD: 2 };
    eng.FinancialMemory.takeSnapshot();
    expect(eng.FinancialMemory.getHistory().length).toBe(2);
  });

  it('trend is wallet-scoped (does not mix wallets)', () => {
    const eng = load();
    eng.setWallet('0xaaaa');
    eng.UB.state = { assets: [{ token: 'USDC', usd: 1, chainId: 'Arc_Testnet' }], totalUSD: 1 };
    eng.FinancialMemory.takeSnapshot();
    eng.UB.state = { assets: [{ token: 'USDC', usd: 2, chainId: 'Arc_Testnet' }], totalUSD: 2 };
    eng.FinancialMemory.takeSnapshot();
    eng.setWallet('0xbbbb');
    const trend = eng.FinancialMemory.getTrend();
    expect(trend.label).toBe('No trend data yet'); // B has no history of its own
  });

  it('legacy snapshot (no wallet field) is visible only when disconnected', () => {
    const eng = load({ store: [['arcpay_ub_memory', JSON.stringify([{ ts: '2020-01-01T00:00:00.000Z', totalUSD: 5, assets: 1, networks: 1, tokens: 1 }])]] });
    eng.setWallet('0xaaaa');
    expect(eng.FinancialMemory.getHistory().length).toBe(0); // legacy not shown while connected
    eng.setWallet('');
    expect(eng.FinancialMemory.getHistory().length).toBe(1); // shown when disconnected
  });
});
