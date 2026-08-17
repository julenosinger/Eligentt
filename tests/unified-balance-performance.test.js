/**
 * UNIFIED BALANCE — UB-3 performance optimization (parallel fetch + native batching + price cache).
 * ═══════════════════════════════════════════════════════════════════════════
 * Loads the FULL real UB engine into a sandbox with a multicall-capable ethers
 * mock that instruments RPC concurrency. Verifies bounded parallel chain fetch,
 * native Multicall3.getEthBalance success/fallback, and the wallet-independent
 * price cache (hit / miss / expiry / oracle-down).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

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

function makeEthers({ multicall = true, balanceOf, getBalance, getEthBalance, aggregate3, latency = 0 } = {}) {
  const calls = { balanceOf: [], getBalance: [], aggregate3: [], active: 0, maxActive: 0 };
  const sleep = latency ? () => new Promise((r) => setTimeout(r, latency)) : () => Promise.resolve();
  const ethersMock = {
    JsonRpcProvider: function (rpc) {
      return {
        rpc,
        getBalance: async function (addr) {
          calls.getBalance.push(addr);
          calls.active++; calls.maxActive = Math.max(calls.maxActive, calls.active);
          try { await sleep(); return getBalance ? await getBalance(addr) : 0n; }
          finally { calls.active--; }
        },
      };
    },
    Contract: function (addr, abi, prov) {
      if (String(addr).toLowerCase() === MULTICALL3.toLowerCase()) {
        return {
          aggregate3: async function (calls_) {
            calls.aggregate3.push(calls_);
            calls.active++; calls.maxActive = Math.max(calls.maxActive, calls.active);
            try {
              await sleep();
              if (aggregate3) return await aggregate3(calls_);
              const out = [];
              for (const c of calls_) {
                const wallet = c.callData && c.callData.__wallet;
                const sig = c.callData && c.callData.__sig;
                if (sig === 'getEthBalance') {
                  try { out.push({ success: true, returnData: getEthBalance ? await getEthBalance(wallet) : 0n }); }
                  catch (_e) { out.push({ success: false, returnData: '0x' }); }
                } else {
                  try { out.push({ success: true, returnData: balanceOf ? await balanceOf(c.target, wallet) : 0n }); }
                  catch (_e) { out.push({ success: false, returnData: '0x' }); }
                }
              }
              return out;
            } finally { calls.active--; }
          },
        };
      }
      return {
        balanceOf: async function (w) {
          calls.balanceOf.push({ token: addr, wallet: w });
          calls.active++; calls.maxActive = Math.max(calls.maxActive, calls.active);
          try { await sleep(); return balanceOf ? await balanceOf(addr, w) : 0n; }
          finally { calls.active--; }
        },
      };
    },
  };
  if (multicall) {
    ethersMock.Interface = function () {
      return {
        encodeFunctionData: function (sig, args) { return { __sig: sig, __wallet: args[0] }; },
        decodeFunctionResult: function (_sig, data) { return [data]; },
      };
    };
  }
  return { ethersMock, calls };
}

function loadFull({ balanceOf, getBalance, getEthBalance, aggregate3, latency, multicall = true, chains, timeoutMs, findPool, poolData, OracleInterop } = {}) {
  const { ethersMock, calls } = makeEthers({ multicall, balanceOf, getBalance, getEthBalance, aggregate3, latency });
  const doc = {
    getElementById: () => ({ style: { display: '' }, textContent: '', innerHTML: '' }),
    addEventListener: () => {},
  };
  const globals = {
    ethers: ethersMock,
    getCachedProvider: (rpc) => new ethersMock.JsonRpcProvider(rpc),
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    Multicall: { MULTICALL3 },
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
    document: doc,
    performance: { now: () => Date.now() },
    UBScreen: { refreshDashboard: () => {} },
    toast: () => {},
  };
  const names = Object.keys(globals);
  const body = assemble(timeoutMs) +
    '\nreturn { UB, UnifiedBalanceEngine, FinancialMemory, ubRefresh, ubShowState, ubFetchAllBalances, ubBuildState, ubResult, ubFetchOne, ubFetchNativeBalance, ubResolveTokenPrice, _ubPoolDerivedRate, ubTokenDeployed, getPriceCache: () => _ubPriceCache, getPriceCacheTTL: () => UB_PRICE_CACHE_TTL_MS, setWallet: (w) => { walletAddress = w; }, getWallet: () => walletAddress, setActiveChain: (id) => { activeChainId = id; }, getGeneration: () => _ubGeneration, bumpGeneration: _ubBumpGeneration, getLastRenderedWallet: () => _ubLastRenderedWallet };';
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
function evmChain(o) {
  return Object.assign({ rpc: 'https://rpc', isEvm: true, tokens: { USDC: { address: '0x' + o.chainId + 'A', decimals: 6 }, EURC: { address: '0x' + o.chainId + 'B', decimals: 6 }, cirBTC: { address: '0x' + o.chainId + 'C', decimals: 8 } } }, o);
}
function sepoliaChain() { return evmChain({ id: 'Ethereum_Sepolia', name: 'Ethereum Sepolia', shortName: 'Sepolia', chainId: 11155111, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } }); }
function baseChain() { return evmChain({ id: 'Base_Sepolia', name: 'Base Sepolia', shortName: 'Base', chainId: 84532, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } }); }
function arbChain() { return evmChain({ id: 'Arbitrum_Sepolia', name: 'Arbitrum Sepolia', shortName: 'Arb', chainId: 421614, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } }); }
function opChain() { return evmChain({ id: 'Optimism_Sepolia', name: 'Optimism Sepolia', shortName: 'OP', chainId: 11155420, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } }); }
function polygonChain() { return evmChain({ id: 'Polygon_Amoy', name: 'Polygon Amoy', shortName: 'Amoy', chainId: 80002, nativeCurrency: { name: 'MATIC', symbol: 'MATIC', decimals: 18 } }); }
function realChains() { return [arcChain(), sepoliaChain(), baseChain(), arbChain(), opChain(), polygonChain()]; }

async function settle(eng, maxMs = 3000) {
  const start = Date.now();
  while ((eng.UB.loading || eng.UB._refreshQueued) && Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 10));
}

/* ── 1/2/3 — parallel fetch + concurrency limit + rate-limit ─────── */
describe('UB-3.1 — parallel multi-chain fetch', () => {
  it('fetches all chains in parallel (single pass, no serial delay)', async () => {
    const eng = loadFull({ balanceOf: async () => 1000000n, chains: realChains() });
    const results = await eng.ubFetchAllBalances('0xwallet');
    expect(eng.calls.aggregate3.length).toBe(6); // all 6 chains batched
    expect(results.filter((r) => r.status === 'available').length).toBeGreaterThan(0);
  });

  it('respects the concurrency limit (max in-flight ≤ 3)', async () => {
    const eng = loadFull({ balanceOf: async () => 1000000n, latency: 15, chains: realChains() });
    await eng.ubFetchAllBalances('0xwallet');
    expect(eng.calls.aggregate3.length).toBe(6); // all chains still fetched
    expect(eng.calls.maxActive).toBeLessThanOrEqual(3); // bounded, no unlimited RPC
  });

  it('rate-limit failure on one chain → that chain unavailable, others succeed', async () => {
    const eng = loadFull({
      balanceOf: async (addr) => { if (addr.startsWith('0xA')) { const e = new Error('429 Too Many Requests'); e.code = 429; throw e; } return 1000000n; },
      chains: [arcChain(), sepoliaChain()],
    });
    const results = await eng.ubFetchAllBalances('0xwallet');
    const arc = results.filter((r) => r.chainId === 'Arc_Testnet');
    const sep = results.filter((r) => r.chainId === 'Ethereum_Sepolia');
    expect(arc.every((r) => r.status === 'unavailable')).toBe(true);
    expect(sep.some((r) => r.status === 'available')).toBe(true);
  });
});

/* ── 6/7 — wallet/network switch during parallel fetch ───────────── */
describe('UB-3.1 — races during parallel fetch', () => {
  it('wallet switch during parallel fetch discards all stale A results', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const eng = loadFull({
      balanceOf: async (addr, w) => (w === '0xaaaa' ? gate.then(() => 1000000n) : 2000000n),
      chains: realChains(),
    });
    eng.setWallet('0xaaaa');
    eng.ubRefresh();          // parallel fetch for A (all chains gated)
    eng.setWallet('0xbbbb');
    eng.bumpGeneration();
    eng.ubRefresh();          // queued
    release();
    await settle(eng);
    const usdc = eng.UB.state.assets.find((a) => a.token === 'USDC');
    expect(usdc.balance).toBe(2); // B authoritative, never A (1)
  });
});

/* ── 8/9/10 — native Multicall3.getEthBalance ────────────────────── */
describe('UB-3.2 — native balance via Multicall3', () => {
  it('native balance via getEthBalance succeeds (no getBalance call)', async () => {
    const eng = loadFull({
      balanceOf: async () => 1000000n,
      getEthBalance: async () => 5000000000000000000n, // 5 ETH
      chains: [sepoliaChain()],
    });
    const results = await eng.ubFetchAllBalances('0xwallet');
    const eth = results.find((r) => r.token === 'ETH');
    expect(eth.status).toBe('available');
    expect(eth.raw).toBe(5000000000000000000n);
    expect(eth.amount).toBeCloseTo(5, 6);
    expect(eng.calls.getBalance.length).toBe(0); // no getBalance fallback
  });

  it('native Multicall3 unavailable → safe getBalance fallback', async () => {
    const eng = loadFull({
      aggregate3: async () => { throw new Error('NO_MULTICALL3'); },
      balanceOf: async () => 1000000n,
      getBalance: async () => 5000000000000000000n,
      chains: [sepoliaChain()],
    });
    const results = await eng.ubFetchAllBalances('0xwallet');
    const eth = results.find((r) => r.token === 'ETH');
    expect(eth.status).toBe('available');
    expect(eng.calls.getBalance.length).toBeGreaterThan(0); // fallback used
  });

  it('native getEthBalance failure → safe getBalance fallback', async () => {
    const eng = loadFull({
      balanceOf: async () => 1000000n,
      getEthBalance: async () => { throw new Error('NATIVE_FAIL'); },
      getBalance: async () => 5000000000000000000n,
      chains: [sepoliaChain()],
    });
    const results = await eng.ubFetchAllBalances('0xwallet');
    const eth = results.find((r) => r.token === 'ETH');
    expect(eth.status).toBe('available');
    expect(eng.calls.getBalance.length).toBe(1); // fallback getBalance used
  });

  it('native zero balance remains available zero (not unavailable)', async () => {
    const eng = loadFull({ balanceOf: async () => 1000000n, getEthBalance: async () => 0n, chains: [sepoliaChain()] });
    const results = await eng.ubFetchAllBalances('0xwallet');
    const eth = results.find((r) => r.token === 'ETH');
    expect(eth.status).toBe('available');
    expect(eth.raw).toBe(0n);
  });
});

/* ── 11-18 — price cache ─────────────────────────────────────────── */
describe('UB-3.3 — price cache (wallet-independent, TTL)', () => {
  it('price cache miss resolves from pool once', () => {
    let poolCalls = 0;
    const eng = loadFull({
      findPool: (a, b) => { poolCalls++; return { id: 'p', tokenA: 'USDC', tokenB: 'EURC' }; },
      poolData: { p: { loaded: true, reserveA: 110000000, reserveB: 100000000 } },
    });
    expect(eng.ubResolveTokenPrice('EURC')).toEqual({ status: 'available', price: 1.1 });
    expect(poolCalls).toBe(1);
  });

  it('price cache hit avoids redundant pool resolution', () => {
    let poolCalls = 0;
    const eng = loadFull({
      findPool: (a, b) => { poolCalls++; return { id: 'p', tokenA: 'USDC', tokenB: 'EURC' }; },
      poolData: { p: { loaded: true, reserveA: 110000000, reserveB: 100000000 } },
    });
    eng.ubResolveTokenPrice('EURC');
    eng.ubResolveTokenPrice('EURC');
    expect(poolCalls).toBe(1); // second call served from cache
  });

  it('expired price cache re-resolves', () => {
    let poolCalls = 0;
    const eng = loadFull({
      findPool: (a, b) => { poolCalls++; return { id: 'p', tokenA: 'USDC', tokenB: 'EURC' }; },
      poolData: { p: { loaded: true, reserveA: 110000000, reserveB: 100000000 } },
    });
    eng.ubResolveTokenPrice('EURC');
    eng.getPriceCache()['EURC'].ts = Date.now() - 60000; // force expiry
    eng.ubResolveTokenPrice('EURC');
    expect(poolCalls).toBe(2);
  });

  it('oracle down + fresh cache → cached price (available)', () => {
    const oracle = { getMarketData: (s) => (s === 'EURC' ? { price: 1.1 } : null) };
    const eng = loadFull({ OracleInterop: oracle, findPool: () => null, poolData: {} });
    expect(eng.ubResolveTokenPrice('EURC')).toEqual({ status: 'available', price: 1.1 });
    oracle.getMarketData = () => { throw new Error('ORACLE_DOWN'); };
    expect(eng.ubResolveTokenPrice('EURC')).toEqual({ status: 'available', price: 1.1 }); // cache hit
  });

  it('oracle down + expired cache → null (never stale-as-fresh)', () => {
    const oracle = { getMarketData: (s) => (s === 'EURC' ? { price: 1.1 } : null) };
    const eng = loadFull({ OracleInterop: oracle, findPool: () => null, poolData: {} });
    eng.ubResolveTokenPrice('EURC');
    eng.getPriceCache()['EURC'].ts = Date.now() - 60000; // expire
    oracle.getMarketData = () => { throw new Error('ORACLE_DOWN'); };
    expect(eng.ubResolveTokenPrice('EURC')).toEqual({ status: 'unavailable', price: null });
  });

  it('pool-derived price remains valid fallback when oracle absent', () => {
    const eng = loadFull({ findPool: (a, b) => ({ id: 'p', tokenA: 'USDC', tokenB: 'EURC' }), poolData: { p: { loaded: true, reserveA: 110000000, reserveB: 100000000 } } });
    expect(eng.ubResolveTokenPrice('EURC')).toEqual({ status: 'available', price: 1.1 });
  });

  it('price cache is wallet-independent (keyed by symbol only)', () => {
    const eng = loadFull({ findPool: (a, b) => ({ id: 'p', tokenA: 'USDC', tokenB: 'EURC' }), poolData: { p: { loaded: true, reserveA: 110000000, reserveB: 100000000 } } });
    eng.setWallet('0xaaaa');
    const p1 = eng.ubResolveTokenPrice('EURC');
    eng.setWallet('0xbbbb');
    const p2 = eng.ubResolveTokenPrice('EURC');
    expect(p2.price).toBe(p1.price);
    expect(Object.keys(eng.getPriceCache())).toEqual(['EURC']); // no wallet key
  });
});
