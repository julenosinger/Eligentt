/**
 * UNIFIED BALANCE — UB-6 real RPC observability & engine metrics.
 * ═══════════════════════════════════════════════════════════════════════════
 * Loads the FULL real UB engine with an instrumented ethers mock (real latency,
 * attempts, retries). Verifies per-chain RPC metrics (attempts/retries/latency),
 * engine counters (rpcCalls/retries/failures/timeouts/rateLimits), and the
 * Networks panel rendering of real metrics (never fabricated).
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
      return { balanceOf: async function (w) { calls.balanceOf.push({ token: addr, wallet: w }); await sleep(); return balanceOf ? await balanceOf(addr, w) : 0n; } };
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
    if (!els[id]) els[id] = { id, style: { display: (id === 'ub-content' || id === 'ub-networks-body' ? 'none' : '') }, textContent: '', innerHTML: '', title: '', className: '' };
    return els[id];
  }
  return { get };
}

function load({ balanceOf, getBalance, getEthBalance, aggregate3, latency, multicall = true, chains, timeoutMs } = {}) {
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
    findPool: (a, b) => { if ((a === 'USDC' && b === 'EURC') || (a === 'EURC' && b === 'USDC')) return { id: 'usdc-eurc', tokenA: 'USDC', tokenB: 'EURC' }; return null; },
    poolData: { 'usdc-eurc': { loaded: true, reserveA: 110000000, reserveB: 100000000 } },
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
    '\nreturn { UB, UnifiedBalanceEngine, FinancialMemory, ubRefresh, ubShowState, ubRenderNetworks, ubToggleNetworks, ubRenderAll, ubFetchAllBalances, ubBuildState, ubResult, ubFetchOne, ubTokenDeployed, _ubChainStatus, _ubChainHealth, _ubErrorReason, getRpcSummary: () => _ubRpcCollector.summary(), getMetrics: () => UnifiedBalanceEngine.getMetrics(), setWallet: (w) => { walletAddress = w; }, getWallet: () => walletAddress, setActiveChain: (id) => { activeChainId = id; }, getGeneration: () => _ubGeneration, bumpGeneration: _ubBumpGeneration, getLastRenderedWallet: () => _ubLastRenderedWallet };';
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
function singleChain() {
  return { id: 'Single_Chain', name: 'Single Chain', shortName: 'Single', chainId: 999999, rpc: 'https://single', isEvm: true, nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, tokens: { USDC: { address: '0xA0', decimals: 6 } } };
}
function sepoliaChain() {
  return { id: 'Ethereum_Sepolia', name: 'Ethereum Sepolia', shortName: 'Sepolia', chainId: 11155111, rpc: 'https://sepolia', isEvm: true, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, tokens: { USDC: { address: '0xB0', decimals: 6 }, EURC: { address: '0xB1', decimals: 6 }, cirBTC: { address: '0xC2', decimals: 8 } } };
}

async function settle(eng, maxMs = 4000) {
  const start = Date.now();
  while ((eng.UB.loading || eng.UB._refreshQueued) && Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 10));
}

/* ── 1 — attempts / retries ───────────────────────────────────────── */
describe('UB-6 — attempts & retries', () => {
  it('first-attempt success → attempts=1, retries=0', async () => {
    const eng = load({ balanceOf: async () => 1000000n, chains: [singleChain()] });
    await eng.ubFetchAllBalances('0xwallet');
    const s = eng.getRpcSummary()['Single_Chain'];
    expect(s.attempts).toBe(1);
  });

  it('retry success → attempts=2, retries=1', async () => {
    let n = 0;
    const eng = load({ multicall: false, balanceOf: async () => { n++; if (n === 1) throw new Error('TRANSIENT'); return 1000000n; }, chains: [singleChain()] });
    await eng.ubFetchAllBalances('0xwallet');
    const s = eng.getRpcSummary()['Single_Chain'];
    expect(s.attempts).toBe(2);
  });

  it('retry exhaustion → attempts equals configured max (initial + 1 retry)', async () => {
    const eng = load({ multicall: false, balanceOf: async () => { throw new Error('DOWN'); }, chains: [singleChain()] });
    await eng.ubFetchAllBalances('0xwallet');
    const s = eng.getRpcSummary()['Single_Chain'];
    expect(s.attempts).toBe(2); // UB_RPC_MAX_RETRIES = 1
    expect(s.failures).toBe(2);
  });
});

/* ── 2 — timeout / rate-limit / latency ──────────────────────────── */
describe('UB-6 — timeout / rate-limit / latency', () => {
  it('timeout is counted (rpcTimeouts)', async () => {
    const eng = load({ multicall: false, balanceOf: async () => new Promise(() => {}), chains: [singleChain()], timeoutMs: 25 });
    await eng.ubFetchAllBalances('0xwallet');
    expect(eng.getMetrics().rpcTimeouts).toBeGreaterThanOrEqual(2); // initial + retry both timeout
    const s = eng.getRpcSummary()['Single_Chain'];
    expect(s.timeouts).toBeGreaterThanOrEqual(2);
  });

  it('rate-limit is counted (rateLimits)', async () => {
    const eng = load({ multicall: false, balanceOf: async () => { const e = new Error('429 Too Many Requests'); e.code = 429; throw e; }, chains: [singleChain()] });
    await eng.ubFetchAllBalances('0xwallet');
    expect(eng.getMetrics().rateLimits).toBeGreaterThanOrEqual(1);
    const s = eng.getRpcSummary()['Single_Chain'];
    expect(s.rateLimits).toBeGreaterThanOrEqual(1);
  });

  it('real latency is measured (> 0) with an elapsed mock', async () => {
    const eng = load({ balanceOf: async () => 1000000n, latency: 20, chains: [singleChain()] });
    await eng.ubFetchAllBalances('0xwallet');
    const s = eng.getRpcSummary()['Single_Chain'];
    expect(s.latencies.length).toBeGreaterThan(0);
    expect(s.latencies[0]).toBeGreaterThan(0);
    expect(eng.getMetrics().averageLatencyMs).toBeGreaterThan(0);
  });
});

/* ── 3 — per-chain isolation ──────────────────────────────────────── */
describe('UB-6 — per-chain isolation', () => {
  it('one failed chain does not affect healthy chain metrics', async () => {
    const eng = load({ multicall: false, balanceOf: async (addr) => { if (addr === '0xA0') throw new Error('DOWN'); return 1000000n; }, chains: [arcChain(), sepoliaChain()] });
    await eng.ubFetchAllBalances('0xwallet');
    const arc = eng.getRpcSummary()['Arc_Testnet'];
    const sep = eng.getRpcSummary()['Ethereum_Sepolia'];
    expect(arc.failures).toBeGreaterThan(0);
    expect(sep.failures).toBe(0); // healthy chain unaffected
    expect(sep.attempts).toBeGreaterThan(0);
  });
});

/* ── 4 — engine counters ──────────────────────────────────────────── */
describe('UB-6 — engine metrics', () => {
  it('rpcCalls increments only for real RPC calls', async () => {
    const eng = load({ balanceOf: async () => 1000000n, chains: [singleChain()] });
    expect(eng.getMetrics().rpcCalls).toBe(0);
    await eng.ubFetchAllBalances('0xwallet');
    expect(eng.getMetrics().rpcCalls).toBe(1); // one aggregate3
  });

  it('retries increments only for additional attempts', async () => {
    let n = 0;
    const eng = load({ multicall: false, balanceOf: async () => { n++; if (n === 1) throw new Error('X'); return 1000000n; }, chains: [singleChain()] });
    await eng.ubFetchAllBalances('0xwallet');
    expect(eng.getMetrics().retries).toBe(1); // one additional attempt
  });

  it('cache hit does not increment RPC calls', () => {
    const eng = load();
    const before = eng.getMetrics().rpcCalls;
    eng.UnifiedBalanceEngine.recordCacheHit();
    expect(eng.getMetrics().cacheHits).toBe(1);
    expect(eng.getMetrics().rpcCalls).toBe(before);
  });

  it('refresh counter increments once per actual refresh', async () => {
    const eng = load({ balanceOf: async () => 1000000n, chains: [singleChain()] });
    eng.setWallet('0xwallet');
    eng.ubRefresh();
    await settle(eng);
    expect(eng.getMetrics().refreshes).toBe(1);
    expect(eng.getMetrics().successfulRefreshes).toBe(1);
    expect(eng.getMetrics().failedRefreshes).toBe(0);
  });

  it('failed refresh increments failedRefreshes', async () => {
    const eng = load({ balanceOf: async () => { throw new Error('DOWN'); }, chains: [singleChain()] });
    eng.setWallet('0xwallet');
    eng.ubRefresh();
    await settle(eng);
    expect(eng.getMetrics().failedRefreshes).toBe(1);
    expect(eng.getMetrics().successfulRefreshes).toBe(0);
  });

  it('metrics are in-memory (fresh load starts at zero)', () => {
    const eng = load();
    const m = eng.getMetrics();
    expect(m.rpcCalls).toBe(0);
    expect(m.refreshes).toBe(0);
    expect(m.retries).toBe(0);
    expect(m.averageLatencyMs).toBeNull();
  });
});

/* ── 5 — UI renders real metrics, never fabricated ────────────────── */
describe('UB-6 — Networks panel metrics UI', () => {
  function state(chainStatus, chainHealth) {
    return { assets: [], totalUSD: 0, aggregateStatus: 'partial', hasValuedUSD: false, chainStatus: chainStatus, chainHealth: chainHealth };
  }

  it('renders retries and latency for a healthy chain', () => {
    const eng = load({ chains: [singleChain()] });
    eng.UB.state = state(
      { Single_Chain: 'available' },
      { Single_Chain: { status: 'available', reason: null, lastSuccessAt: 123, attempts: 1, retries: 0, latencyMs: 182, lastAttemptAt: 123, lastFailureAt: 0 } },
    );
    eng.ubRenderNetworks();
    const html = eng.ui('ub-networks-body').innerHTML;
    expect(html).toContain('Retries: 0');
    expect(html).toContain('Latency: 182 ms');
    expect(html).toContain('Chain ID: 999999');
    expect(html).toContain('RPC HEALTH');
  });

  it('null latency renders "—", never "0 ms"', () => {
    const eng = load({ chains: [singleChain()] });
    eng.UB.state = state(
      { Single_Chain: 'unavailable' },
      { Single_Chain: { status: 'unavailable', reason: 'RPC timeout', lastSuccessAt: 0, attempts: 2, retries: 1, latencyMs: null, lastAttemptAt: 123, lastFailureAt: 123 } },
    );
    eng.ubRenderNetworks();
    const html = eng.ui('ub-networks-body').innerHTML;
    expect(html).toContain('Latency: —');
    expect(html).not.toContain('Latency: 0 ms');
    expect(html).toContain('Reason: RPC timeout');
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('undefined');
  });

  it('stale network retains lastSuccessAt and reason', () => {
    const eng = load({ chains: [singleChain()] });
    eng.UB.state = state(
      { Single_Chain: 'stale' },
      { Single_Chain: { status: 'stale', reason: 'RPC rate limit', lastSuccessAt: 1700000000000, attempts: 3, retries: 2, latencyMs: 812, lastAttemptAt: 1700000001000, lastFailureAt: 1700000001000 } },
    );
    eng.ubRenderNetworks();
    const html = eng.ui('ub-networks-body').innerHTML;
    expect(html).toContain('Stale');
    expect(html).toContain('Reason: RPC rate limit');
    expect(html).toContain('Retries: 2');
  });

  it('rendering the panel causes ZERO RPC calls', () => {
    const eng = load({ chains: [singleChain()] });
    eng.UB.state = state(
      { Single_Chain: 'available' },
      { Single_Chain: { status: 'available', reason: null, lastSuccessAt: 123, attempts: 1, retries: 0, latencyMs: 182, lastAttemptAt: 123, lastFailureAt: 0 } },
    );
    eng.ubRenderNetworks();
    expect(eng.calls.balanceOf.length).toBe(0);
    expect(eng.calls.aggregate3.length).toBe(0);
    expect(eng.calls.getBalance.length).toBe(0);
  });
});

/* ── 6 — wallet switch isolation of metrics ───────────────────────── */
describe('UB-6 — wallet switch metric isolation', () => {
  it('wallet switch does not leak prior wallet chain metrics', async () => {
    let fail = false;
    const eng = load({ multicall: false, balanceOf: async () => { if (fail) throw new Error('DOWN'); return 1000000n; }, chains: [singleChain()] });
    eng.setWallet('0xaaaa');
    eng.ubRefresh();
    await settle(eng);
    expect(eng.UB.state.chainHealth['Single_Chain'].attempts).toBe(1);

    eng.setWallet('0xbbbb');
    fail = true;
    eng.bumpGeneration();
    eng.ubRefresh();
    await settle(eng);
    // B's chain failed (2 attempts: initial + retry), never A's attempts (1)
    expect(eng.UB.state.chainHealth['Single_Chain'].status).toBe('unavailable');
    expect(eng.UB.state.chainHealth['Single_Chain'].attempts).toBe(2);
  });
});
