/**
 * UNIFIED BALANCE PRICE INTEGRITY — UB-2.2.
 * ═══════════════════════════════════════════════════════════════════════════
 * Verifies no hardcoded financial fallback (67000/1.08/2500) survives in the UB
 * valuation path, unavailable prices are null (never 0/fake), the USD aggregation
 * distinguishes balance-status from price-status, and the single balance engine
 * does not fetch redundantly. Loads the REAL inline engine into a sandbox.
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

function load({ findPool, poolData, OracleInterop, balanceOf, getBalance, chains } = {}) {
  const ubState = slice('const UB = {', 'const UB_TOKEN_META');
  const constants = slice('const UB_RPC_TIMEOUT_MS', 'UB.analyze = function');
  const refresh = slice('function ubRefresh()', 'function ubFetchAllBalances');
  const engine = slice('function _ubProvider', 'function ubRenderAll');

  const calls = { balanceOf: [], getBalance: [] };
  const ethersMock = {
    JsonRpcProvider: function (rpc) {
      return { rpc, getBalance: async function (a) { calls.getBalance.push(a); return getBalance ? await getBalance(a) : 0n; } };
    },
    Contract: function (addr, abi, prov) {
      return { balanceOf: async function (w) { calls.balanceOf.push({ token: addr, wallet: w }); return balanceOf ? await balanceOf(addr, w) : 0n; } };
    },
  };

  const globals = {
    ethers: ethersMock,
    getCachedProvider: (rpc) => new ethersMock.JsonRpcProvider(rpc),
    UB_TOKEN_META: {
      USDC: { name: 'USD Coin', icon: 'U', color: '#2775ca' },
      EURC: { name: 'Euro Coin', icon: 'E', color: '#2562de' },
      cirBTC: { name: 'Circle BTC', icon: 'B', color: '#f7931a' },
      ETH: { name: 'Ether', icon: 'E', color: '#627eea' },
    },
    findPool: findPool || (() => null),
    poolData: poolData || {},
    OracleInterop: OracleInterop || undefined,
    CHAINS: chains || [arcChain()],
    USDC_ABI: ['function balanceOf(address) view returns (uint256)'],
    document: { getElementById: () => ({ style: { display: '' }, textContent: '' }) },
    performance: { now: () => Date.now() },
    UBScreen: { refreshDashboard: () => {} },
    UnifiedBalanceEngine: {
      notifyRefreshStart() {}, notifyRefreshComplete() {}, notifyRefreshFailed() {},
      recordRefresh() {}, recordError() {}, invalidate() {}, reconcile() {}, isCacheValid: () => false,
    },
    ubRenderAll: () => {},
  };
  const names = Object.keys(globals);
  const body = 'let walletAddress = "";\n' + ubState + '\n' + constants + '\n' + refresh + '\n' + engine +
    '\nreturn { ubResolveTokenPrice, _ubPoolDerivedRate, ubBuildState, ubResult, ubFetchAllBalances, ubFetchOne, ubRefresh, UB, setWallet: (w) => { walletAddress = w; }, getGeneration: () => _ubGeneration, bumpGeneration: _ubBumpGeneration };';
  const fn = new Function(...names, body);
  const api = fn(...names.map((n) => globals[n]));
  api.calls = calls;
  return api;
}

function arcChain() {
  return {
    id: 'Arc_Testnet', name: 'Arc Testnet', shortName: 'Arc', chainId: 5042002, rpc: 'https://arc', isEvm: true,
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    tokens: { USDC: { address: '0xA0', decimals: 6 }, EURC: { address: '0xA1', decimals: 6 }, cirBTC: { address: '0xA2', decimals: 8 } },
  };
}
function usdcPool(a = 110000000, b = 100000000) { return { findPool: () => ({ id: 'p', tokenA: 'USDC', tokenB: 'EURC' }), poolData: { p: { loaded: true, reserveA: a, reserveB: b } } }; }

function res(o) {
  return Object.assign({
    token: o.token, tokenName: o.token, icon: '?', color: '#888',
    chainId: 'Arc_Testnet', chainName: 'Arc', address: '0x', decimals: 6,
    raw: null, amount: null, price: null, priceStatus: 'unavailable', usd: null, status: 'available', error: null,
  }, o);
}

/* ── 1/2/3/4 — price resolution (no hardcoded fallback) ───────────── */
describe('Price resolution — real sources only', () => {
  it('USDC → available at 1.00 (base stablecoin)', () => {
    const eng = load({ findPool: () => null });
    expect(eng.ubResolveTokenPrice('USDC')).toEqual({ status: 'available', price: 1.0 });
  });

  it('EURC with no pool → unavailable (never 1.08)', () => {
    const eng = load({ findPool: () => null });
    expect(eng.ubResolveTokenPrice('EURC')).toEqual({ status: 'unavailable', price: null });
  });

  it('cirBTC with no pool/oracle → unavailable (never 67000)', () => {
    const eng = load({ findPool: () => null });
    expect(eng.ubResolveTokenPrice('cirBTC')).toEqual({ status: 'unavailable', price: null });
  });

  it('ETH with no oracle/pool → unavailable (never 2500)', () => {
    const eng = load({ findPool: () => null });
    expect(eng.ubResolveTokenPrice('ETH')).toEqual({ status: 'unavailable', price: null });
  });

  it('EURC with a real USDC pool → available at the real reserve ratio', () => {
    const eng = load(usdcPool(110000000, 100000000));
    const p = eng.ubResolveTokenPrice('EURC');
    expect(p.status).toBe('available');
    expect(p.price).toBeCloseTo(1.1, 6);
  });

  it('cirBTC with oracle market data → available at the oracle price', () => {
    const eng = load({ OracleInterop: { getMarketData: (s) => (s === 'cirBTC' ? { price: 70123.45 } : null) }, findPool: () => null });
    const p = eng.ubResolveTokenPrice('cirBTC');
    expect(p.status).toBe('available');
    expect(p.price).toBe(70123.45);
  });
});

/* ── 5/6/7 — USD aggregation semantics ────────────────────────────── */
describe('USD aggregation — balance status vs price status', () => {
  it('unavailable price → usd null (never 0)', () => {
    const eng = load({ findPool: () => null });
    const state = eng.ubBuildState([
      res({ token: 'USDC', raw: 1000000n, amount: 1, price: 1.0, priceStatus: 'available', status: 'available' }),
      res({ token: 'EURC', raw: 500000n, amount: 0.5, price: null, priceStatus: 'unavailable', status: 'available' }),
    ], 1);
    const eurc = state.assets.find((a) => a.token === 'EURC');
    expect(eurc.usd).toBeNull();          // retained asset, null usd
    expect(state.totalUSD).toBe(1);       // only USDC valued
  });

  it('available balance + unavailable price → asset retained with usd null', () => {
    const eng = load({ findPool: () => null });
    const state = eng.ubBuildState([
      res({ token: 'cirBTC', raw: 100000000n, amount: 1, price: null, priceStatus: 'unavailable', status: 'available' }),
    ], 1);
    expect(state.assets.length).toBe(1);
    expect(state.assets[0].usd).toBeNull();
    expect(state.totalUSD).toBe(0);
  });

  it('zero balance + available price → usd 0', () => {
    const eng = load({ findPool: () => null });
    const state = eng.ubBuildState([
      res({ token: 'USDC', raw: 0n, amount: 0, price: 1.0, priceStatus: 'available', status: 'available' }),
    ], 1);
    expect(state.results[0].usd).toBe(0); // zero balance → usd 0
  });

  it('unavailable balance → amount null, usd null (never 0)', () => {
    const eng = load({ findPool: () => null });
    const state = eng.ubBuildState([
      res({ token: 'USDC', raw: null, amount: null, price: 1.0, priceStatus: 'available', status: 'unavailable', error: 'RPC_DOWN' }),
    ], 1);
    expect(state.results[0].usd).toBeNull();
    expect(state.assets.length).toBe(0);
    expect(state.totalUSD).toBe(0);
  });
});

/* ── 8/9/10/11 — aggregate status ─────────────────────────────────── */
describe('Aggregate status', () => {
  it('complete: all balances + prices available', () => {
    const eng = load({ findPool: () => null });
    const state = eng.ubBuildState([
      res({ token: 'USDC', raw: 1000000n, amount: 1, price: 1.0, priceStatus: 'available', status: 'available' }),
    ], 1);
    expect(state.aggregateStatus).toBe('complete');
  });

  it('partial: some real asset has unavailable price', () => {
    const eng = load({ findPool: () => null });
    const state = eng.ubBuildState([
      res({ token: 'USDC', raw: 1000000n, amount: 1, price: 1.0, priceStatus: 'available', status: 'available' }),
      res({ token: 'EURC', raw: 500000n, amount: 0.5, price: null, priceStatus: 'unavailable', status: 'available' }),
    ], 1);
    expect(state.aggregateStatus).toBe('partial');
  });

  it('unavailable: no trustworthy USD valuation (no available balance)', () => {
    const eng = load({ findPool: () => null });
    const state = eng.ubBuildState([
      res({ token: 'USDC', raw: null, amount: null, price: null, priceStatus: 'unavailable', status: 'unavailable', error: 'RPC_DOWN' }),
    ], 1);
    expect(state.aggregateStatus).toBe('unavailable');
    expect(state.hasValuedUSD).toBe(false);
  });

  it('totalUSD never includes fabricated values', () => {
    const eng = load({ findPool: () => null });
    const state = eng.ubBuildState([
      res({ token: 'USDC', raw: 1000000n, amount: 1, price: 1.0, priceStatus: 'available', status: 'available' }),
      res({ token: 'EURC', raw: 500000n, amount: 0.5, price: null, priceStatus: 'unavailable', status: 'available' }),
      res({ token: 'cirBTC', raw: null, amount: null, price: null, priceStatus: 'unavailable', status: 'unavailable' }),
    ], 1);
    expect(state.totalUSD).toBe(1); // 1 USDC only — no 1.08/67000/0 fabrication
  });
});

/* ── 12/13 — single authoritative balance engine (static) ─────────── */
describe('Single balance engine', () => {
  it('no hardcoded financial fallback remains in the UB valuation path', () => {
    const priceFns = slice('function ubResolveTokenPrice', 'const UB_TOKEN_META');
    expect(priceFns).not.toContain('67000');
    expect(priceFns).not.toContain('2500');
    expect(priceFns).not.toContain('1.08');
    expect(priceFns).not.toContain('BTC_USD_PRICE');
    expect(priceFns).not.toContain('EURC_USD_RATE');
    expect(priceFns).not.toContain('ETH_USD_PRICE');
  });

  it('UB refresh path does not call legacy refreshBalance (one engine)', () => {
    const refresh = slice('function ubRefresh()', 'function ubFetchAllBalances');
    expect(refresh).not.toContain('refreshBalance(');
  });
});

/* ── 18/19 — cirBTC Arc-only + no redundant fetch ─────────────────── */
describe('Single engine — no redundant fetch', () => {
  it('each wallet/token/chain is fetched exactly once per refresh', async () => {
    const eng = load({
      balanceOf: async () => 1000000n,
      chains: [
        arcChain(),
        { id: 'Ethereum_Sepolia', name: 'Ethereum Sepolia', shortName: 'Sepolia', chainId: 11155111, rpc: 'https://sep', isEvm: true, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, tokens: { USDC: { address: '0xB0', decimals: 6 }, EURC: { address: '0xB1', decimals: 6 }, cirBTC: { address: '0xC2', decimals: 8 } } },
      ],
    });
    await eng.ubFetchAllBalances('0xwallet');
    const keys = eng.calls.balanceOf.map((c) => c.token + ':' + c.wallet);
    expect(new Set(keys).size).toBe(keys.length); // no duplicate token+wallet
    // cirBTC only on Arc (0xA2), never on Sepolia (0xC2)
    expect(eng.calls.balanceOf.some((c) => c.token === '0xA2')).toBe(true);
    expect(eng.calls.balanceOf.some((c) => c.token === '0xC2')).toBe(false);
  });
});
