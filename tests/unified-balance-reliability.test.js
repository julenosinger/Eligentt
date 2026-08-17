/**
 * UNIFIED BALANCE — UB-4 reliability, freshness & per-chain health.
 * ═══════════════════════════════════════════════════════════════════════════
 * Loads the FULL real UB engine. Verifies per-chain status (available/unavailable/
 * stale/not_supported), stale retention for failed chains, exponential backoff
 * retry, 429 rate-limit handling, "N/M networks updated" UI, and freshness states.
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
  const calls = { balanceOf: [], getBalance: [], aggregate3: [] };
  const sleep = latency ? () => new Promise((r) => setTimeout(r, latency)) : () => Promise.resolve();
  const ethersMock = {
    JsonRpcProvider: function (rpc) {
      return { rpc, getBalance: async function (addr) { calls.getBalance.push(addr); await sleep(); return getBalance ? await getBalance(addr) : 0n; } };
    },
    Contract: function (addr, abi, prov) {
      if (String(addr).toLowerCase() === MULTICALL3.toLowerCase()) {
        return {
          aggregate3: async function (calls_) {
            calls.aggregate3.push(calls_);
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
          },
        };
      }
      return {
        balanceOf: async function (w) { calls.balanceOf.push({ token: addr, wallet: w }); await sleep(); return balanceOf ? await balanceOf(addr, w) : 0n; },
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

function makeDoc() {
  const els = {};
  function get(id) {
    if (!els[id]) els[id] = { id, style: { display: (id === 'ub-content' ? 'none' : '') }, textContent: '', innerHTML: '', title: '' };
    return els[id];
  }
  return { get };
}

function load({ balanceOf, getBalance, getEthBalance, aggregate3, latency, multicall = true, chains, timeoutMs, findPool, poolData } = {}) {
  const { ethersMock, calls } = makeEthers({ multicall, balanceOf, getBalance, getEthBalance, aggregate3, latency });
  const doc = makeDoc();
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
    '\nreturn { UB, UnifiedBalanceEngine, FinancialMemory, ubRefresh, ubShowState, ubSetUpdating, ubMarkStale, ubRenderUpdated, ubRenderHero, ubRenderAssets, ubFetchAllBalances, ubBuildState, ubResult, ubFetchOne, ubFetchNativeBalance, ubTokenDeployed, _ubBackoffMs, _ubIsRateLimited, _ubChainStatus, _ubRetainStaleChains, setWallet: (w) => { walletAddress = w; }, getWallet: () => walletAddress, setActiveChain: (id) => { activeChainId = id; }, getGeneration: () => _ubGeneration, bumpGeneration: _ubBumpGeneration, getLastRenderedWallet: () => _ubLastRenderedWallet };';
  const fn = new Function(...names, body);
  const api = fn(...names.map((n) => globals[n]));
  api.calls = calls;
  api.ui = doc.get;
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

async function settle(eng, maxMs = 4000) {
  const start = Date.now();
  while ((eng.UB.loading || eng.UB._refreshQueued) && Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 10));
}

/* ── 1 — per-chain status ─────────────────────────────────────────── */
describe('UB-4 — per-chain status', () => {
  it('one chain offline → unavailable; others available', async () => {
    const eng = load({ balanceOf: async (addr) => { if (addr.startsWith('0xA')) throw new Error('DOWN'); return 1000000n; }, chains: [arcChain(), sepoliaChain()] });
    const state = eng.ubBuildState(await eng.ubFetchAllBalances('0xwallet'), 1);
    expect(state.chainStatus['Arc_Testnet']).toBe('unavailable');
    expect(state.chainStatus['Ethereum_Sepolia']).toBe('available');
  });

  it('multiple chains offline', async () => {
    const eng = load({ balanceOf: async (addr) => { if (addr.startsWith('0xA') || addr.startsWith('0x80002')) throw new Error('DOWN'); return 1000000n; }, chains: realChains() });
    const state = eng.ubBuildState(await eng.ubFetchAllBalances('0xwallet'), 1);
    expect(state.chainStatus['Arc_Testnet']).toBe('unavailable');
    expect(state.chainStatus['Polygon_Amoy']).toBe('unavailable');
    expect(state.chainStatus['Ethereum_Sepolia']).toBe('available');
  });

  it('not_supported chain/token does not count as available or unavailable', async () => {
    const eng = load({ balanceOf: async () => 1000000n, chains: [sepoliaChain()] });
    const results = await eng.ubFetchAllBalances('0xwallet');
    const state = eng.ubBuildState(results, 1);
    expect(state.chainStatus['Ethereum_Sepolia']).toBe('available');
    const cir = results.find((r) => r.token === 'cirBTC');
    expect(cir.status).toBe('not_supported');
  });

  it('all offline → aggregateStatus unavailable (never $0)', async () => {
    const eng = load({ balanceOf: async () => { throw new Error('DOWN'); }, chains: [arcChain()] });
    const state = eng.ubBuildState(await eng.ubFetchAllBalances('0xwallet'), 1);
    expect(state.aggregateStatus).toBe('unavailable');
    expect(state.totalUSD).toBe(0);
    expect(state.assets.length).toBe(0);
  });
});

/* ── 2 — stale retention for failed chains ────────────────────────── */
describe('UB-4 — stale retention (never erase valid balances)', () => {
  it('a chain that fails a later refresh retains its prior assets as stale (usd null)', async () => {
    let arcDown = false;
    const eng = load({
      balanceOf: async (addr) => { if (addr.startsWith('0xA')) { if (arcDown) throw new Error('DOWN'); return 1000000n; } return 2000000n; },
      chains: [arcChain(), sepoliaChain()],
    });
    eng.setWallet('0xwallet');
    eng.ubRefresh();
    await settle(eng);
    expect(eng.UB.state.assets.some((a) => a.chainId === 'Arc_Testnet' && !a.stale)).toBe(true);

    arcDown = true;
    eng.ubRefresh();
    await settle(eng);
    const arcStale = eng.UB.state.assets.filter((a) => a.chainId === 'Arc_Testnet' && a.stale);
    expect(arcStale.length).toBeGreaterThan(0);                 // not erased
    expect(arcStale.every((a) => a.usd === null)).toBe(true);   // not counted in totalUSD
    expect(eng.UB.state.assets.some((a) => a.chainId === 'Ethereum_Sepolia' && !a.stale)).toBe(true); // healthy chain fresh
  });

  it('retained stale assets do NOT contribute to totalUSD', async () => {
    let arcDown = false;
    const eng = load({
      balanceOf: async (addr) => { if (addr.startsWith('0xA')) { if (arcDown) throw new Error('DOWN'); return 1000000n; } return 2000000n; },
      chains: [arcChain(), sepoliaChain()],
    });
    eng.setWallet('0xwallet');
    eng.ubRefresh();
    await settle(eng);
    const before = eng.UB.state.totalUSD;
    expect(before).toBeGreaterThan(0);
    arcDown = true;
    eng.ubRefresh();
    await settle(eng);
    expect(eng.UB.state.totalUSD).toBeLessThan(before); // Arc dropped from total (not fabricated 0)
    expect(eng.UB.state.aggregateStatus).toBe('partial');
  });
});

/* ── 3 — retry + exponential backoff + rate limit ─────────────────── */
describe('UB-4 — retry / backoff / rate-limit', () => {
  it('exponential backoff grows and is capped', () => {
    const eng = load();
    expect(eng._ubBackoffMs(0)).toBe(250);
    expect(eng._ubBackoffMs(1)).toBe(500);
    expect(eng._ubBackoffMs(2)).toBe(1000);
    expect(eng._ubBackoffMs(3)).toBe(2000); // capped
    expect(eng._ubBackoffMs(4)).toBe(2000);
  });

  it('429 is recognized as rate-limited', () => {
    const eng = load();
    expect(eng._ubIsRateLimited({ code: 429 })).toBe(true);
    expect(eng._ubIsRateLimited({ message: 'Too Many Requests' })).toBe(true);
    expect(eng._ubIsRateLimited({ message: 'CALL_EXCEPTION' })).toBe(false);
  });

  it('retry only affects the failed call (healthy chains not re-fetched)', async () => {
    let a0 = 0;
    const eng = load({
      multicall: false,
      balanceOf: async (addr) => { if (addr === '0xA0') { a0++; if (a0 === 1) throw new Error('RPC_DOWN'); return 1000000n; } return 2000000n; },
      chains: [arcChain(), sepoliaChain()],
    });
    await eng.ubFetchAllBalances('0xwallet');
    expect(eng.calls.balanceOf.filter((c) => c.token === '0xA0').length).toBe(2); // failed → retried
    expect(eng.calls.balanceOf.filter((c) => c.token === '0xA1').length).toBe(1); // healthy → once
  });

  it('429 rate-limit recovers on retry (available)', async () => {
    let attempts = 0;
    const eng = load({
      multicall: false,
      balanceOf: async (addr) => { if (addr === '0xA0') { attempts++; if (attempts === 1) { const e = new Error('429'); e.code = 429; throw e; } return 1000000n; } return 2000000n; },
      chains: [arcChain()],
    });
    const results = await eng.ubFetchAllBalances('0xwallet');
    expect(results.find((r) => r.token === 'USDC').status).toBe('available');
    expect(attempts).toBe(2);
  });

  it('persistent failure → unavailable after retries (never 0)', async () => {
    const eng = load({ multicall: false, balanceOf: async () => { throw new Error('DOWN'); }, chains: [arcChain()] });
    const results = await eng.ubFetchAllBalances('0xwallet');
    expect(results.every((r) => r.status === 'unavailable')).toBe(true);
    expect(results.every((r) => r.raw === null)).toBe(true);
  });
});

/* ── 4 — freshness states + "N/M networks updated" ─────────────────── */
describe('UB-4 — freshness + chain health UI', () => {
  it('successful refresh records Updated timestamp', async () => {
    const eng = load({ balanceOf: async () => 1000000n, chains: [arcChain()] });
    eng.setWallet('0xwallet');
    eng.ubRefresh();
    await settle(eng);
    expect(eng.UnifiedBalanceEngine.getLastUpdated()).toBeGreaterThan(0);
    eng.ubRenderUpdated();
    expect(eng.ui('ub-updated').textContent).toContain('Updated ');
  });

  it('same-wallet refresh shows Updating… without clearing content', async () => {
    let gate = null;
    const eng = load({ balanceOf: async () => (gate ? gate.then(() => 1000000n) : 1000000n), chains: [arcChain()] });
    eng.setWallet('0xwallet');
    eng.ubRefresh();
    await settle(eng);
    expect(eng.ui('ub-content').style.display).not.toBe('none');

    let release;
    gate = new Promise((r) => { release = r; });
    eng.ubRefresh(); // gated same-wallet refresh
    expect(eng.ui('ub-updating').style.display).toBe('');          // Updating…
    expect(eng.ui('ub-content').style.display).not.toBe('none');   // content preserved
    release();
    await settle(eng);
  });

  it('hero shows "5/6 networks updated" with one chain down', () => {
    const eng = load();
    eng.UB.state = {
      assets: [], totalUSD: 0, aggregateStatus: 'partial', hasValuedUSD: false,
      chainStatus: { Arc_Testnet: 'available', Ethereum_Sepolia: 'available', Base_Sepolia: 'unavailable', Arbitrum_Sepolia: 'available', Optimism_Sepolia: 'available', Polygon_Amoy: 'available' },
    };
    eng.ubRenderHero();
    expect(eng.ui('ub-hero-chain-status').textContent).toBe('5/6 networks updated');
    expect(eng.ui('ub-hero-chain-status').title).toContain('Base_Sepolia');
  });

  it('hero shows "6/6 networks updated" when all healthy', () => {
    const eng = load();
    eng.UB.state = {
      assets: [], totalUSD: 0, aggregateStatus: 'complete', hasValuedUSD: true,
      chainStatus: { Arc_Testnet: 'available', Ethereum_Sepolia: 'available', Base_Sepolia: 'available', Arbitrum_Sepolia: 'available', Optimism_Sepolia: 'available', Polygon_Amoy: 'available' },
    };
    eng.ubRenderHero();
    expect(eng.ui('ub-hero-chain-status').textContent).toBe('6/6 networks updated');
  });
});
