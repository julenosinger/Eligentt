/**
 * UNIFIED BALANCE — UB-2.3 multicall + performance hardening.
 * ═══════════════════════════════════════════════════════════════════════════
 * Loads the REAL inline UB engine into a sandbox with a multicall-capable ethers
 * mock. Verifies: per-chain ERC20 balanceOf aggregation into a single aggregate3,
 * strict success/failure semantics (never a fabricated zero), cirBTC Arc-only,
 * per-chain fallback to individual calls, timeout/retry, deduplication, wallet-switch
 * protection during an in-flight multicall, stale-generation discard, and the
 * RPC-call reduction relative to the individual-call baseline.
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

function assemble(timeoutMs, retries) {
  const ubState = slice('const UB = {', 'const UB_TOKEN_META');
  let constants = slice('const UB_RPC_TIMEOUT_MS', 'UB.analyze = function');
  const refresh = slice('function ubRefresh()', 'function ubFetchAllBalances');
  const engine = slice('function _ubProvider', 'function ubRenderAll');
  if (timeoutMs != null) constants = constants.replace('const UB_RPC_TIMEOUT_MS = 8000', 'const UB_RPC_TIMEOUT_MS = ' + timeoutMs);
  if (retries != null) constants = constants.replace('const UB_RPC_MAX_RETRIES = 1', 'const UB_RPC_MAX_RETRIES = ' + retries);
  return 'let walletAddress = "";\n' + ubState + '\n' + constants + '\n' + refresh + '\n' + engine;
}

function makeEthers({ multicall = true, balanceOf, getBalance, aggregate3 } = {}) {
  const calls = { balanceOf: [], getBalance: [], aggregate3: [] };
  const ethersMock = {
    JsonRpcProvider: function (rpc) {
      return {
        rpc,
        getBalance: async function (addr) {
          calls.getBalance.push(addr);
          if (getBalance) return await getBalance(addr);
          return 0n;
        },
      };
    },
    Contract: function (addr, abi, prov) {
      if (String(addr).toLowerCase() === MULTICALL3.toLowerCase()) {
        return {
          aggregate3: async function (calls_) {
            calls.aggregate3.push(calls_);
            if (aggregate3) return await aggregate3(calls_);
            const out = [];
            for (const c of calls_) {
              const wallet = c.callData && c.callData.__wallet;
              try {
                const v = balanceOf ? await balanceOf(c.target, wallet) : 0n;
                out.push({ success: true, returnData: v });
              } catch (_e) {
                out.push({ success: false, returnData: '0x' });
              }
            }
            return out;
          },
        };
      }
      return {
        balanceOf: async function (w) {
          calls.balanceOf.push({ token: addr, wallet: w });
          if (balanceOf) return await balanceOf(addr, w);
          return 0n;
        },
      };
    },
  };
  if (multicall) {
    ethersMock.Interface = function () {
      return {
        encodeFunctionData: function (_sig, args) { return { __sig: _sig, __wallet: args[0] }; },
        decodeFunctionResult: function (_sig, data) { return [data]; },
      };
    };
  }
  return { ethersMock, calls };
}

function load({ balanceOf, getBalance, aggregate3, chains, multicall = true, timeoutMs, retries } = {}) {
  const { ethersMock, calls } = makeEthers({ multicall, balanceOf, getBalance, aggregate3 });
  const globals = {
    ethers: ethersMock,
    getCachedProvider: (rpc) => new ethersMock.JsonRpcProvider(rpc),
    Multicall: { MULTICALL3 },
    UB_TOKEN_META: {
      USDC: { name: 'USD Coin', icon: 'U', color: '#2775ca' },
      EURC: { name: 'Euro Coin', icon: 'E', color: '#2562de' },
      cirBTC: { name: 'Circle BTC', icon: 'B', color: '#f7931a' },
      ETH: { name: 'Ether', icon: 'E', color: '#627eea' },
    },
    findPool: (a, b) => {
      if ((a === 'USDC' && b === 'EURC') || (a === 'EURC' && b === 'USDC')) return { id: 'usdc-eurc', tokenA: 'USDC', tokenB: 'EURC' };
      if ((a === 'USDC' && b === 'cirBTC') || (a === 'cirBTC' && b === 'USDC')) return { id: 'usdc-cirbtc', tokenA: 'USDC', tokenB: 'cirBTC' };
      return null;
    },
    poolData: {
      'usdc-eurc': { loaded: true, reserveA: 110000000, reserveB: 100000000 },      // EURC 1.10
      'usdc-cirbtc': { loaded: true, reserveA: 7000000000000, reserveB: 100000000 }, // cirBTC 70000
    },
    CHAINS: chains || [arcChain()],
    USDC_ABI: ['function balanceOf(address) view returns (uint256)'],
    document: { getElementById: () => ({ style: { display: '' }, textContent: '' }) },
    performance: { now: () => Date.now() },
    UBScreen: { refreshDashboard: () => {} },
    UnifiedBalanceEngine: {
      notifyRefreshStart() {}, notifyRefreshComplete() {}, notifyRefreshFailed() {},
      recordRefresh() {}, recordError() {}, invalidate() {}, reconcile() {},
      isCacheValid: () => false,
    },
    ubRenderAll: () => {},
  };
  const names = Object.keys(globals);
  const body = assemble(timeoutMs, retries) +
    '\nreturn { ubFetchOne, ubFetchNativeBalance, ubFetchAllBalances, ubBuildState, ubResult, ubRefresh, ubShowState, UB, ubTokenDeployed, _ubCallWithRetry, _ubFormatAmount, _ubWithTimeout, _ubMulticallChain, setWallet: (w) => { walletAddress = w; }, getWallet: () => walletAddress, getGeneration: () => _ubGeneration, bumpGeneration: _ubBumpGeneration };';
  const fn = new Function(...names, body);
  const api = fn(...names.map((n) => globals[n]));
  api.calls = calls;
  return api;
}

/* ── Production-shaped chain registry (mirrors CHAINS in index.html) ── */
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
function arcChain() {
  return evmChain({ id: 'Arc_Testnet', name: 'Arc Testnet', shortName: 'Arc', chainId: 5042002, nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 } });
}
function sepoliaChain() {
  return evmChain({ id: 'Ethereum_Sepolia', name: 'Ethereum Sepolia', shortName: 'Sepolia', chainId: 11155111, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } });
}
function baseChain() {
  return evmChain({ id: 'Base_Sepolia', name: 'Base Sepolia', shortName: 'Base', chainId: 84532, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } });
}
function arbChain() {
  return evmChain({ id: 'Arbitrum_Sepolia', name: 'Arbitrum Sepolia', shortName: 'Arb', chainId: 421614, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } });
}
function opChain() {
  return evmChain({ id: 'Optimism_Sepolia', name: 'Optimism Sepolia', shortName: 'OP', chainId: 11155420, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } });
}
function polygonChain() {
  return evmChain({ id: 'Polygon_Amoy', name: 'Polygon Amoy', shortName: 'Amoy', chainId: 80002, nativeCurrency: { name: 'MATIC', symbol: 'MATIC', decimals: 18 } });
}
function realChains() {
  return [arcChain(), sepoliaChain(), baseChain(), arbChain(), opChain(), polygonChain()];
}
async function settle(eng, maxMs = 3000) {
  const start = Date.now();
  while ((eng.UB.loading || eng.UB._refreshQueued) && Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 10));
}

/* ── 1/2/3/4 — multicall success, zero, not-supported, cirBTC Arc-only ── */
describe('Multicall — ERC20 aggregation', () => {
  it('one aggregate3 per chain batches USDC+EURC; success → available', async () => {
    const eng = load({ balanceOf: async (addr) => (addr.endsWith('A') ? 1000000n : 500000n), chains: realChains() });
    const results = await eng.ubFetchAllBalances('0xwallet');
    expect(eng.calls.aggregate3.length).toBe(6);   // one per EVM chain
    expect(eng.calls.balanceOf.length).toBe(0);    // no individual balanceOf
    const arcUsdc = results.find((r) => r.chainId === 'Arc_Testnet' && r.token === 'USDC');
    expect(arcUsdc.status).toBe('available');
    expect(arcUsdc.raw).toBe(1000000n);
  });

  it('cirBTC is included only in the Arc multicall (deployment guard)', async () => {
    const eng = load({ balanceOf: async () => 1n, chains: realChains() });
    await eng.ubFetchAllBalances('0xwallet');
    const arcCir = '0x5042002C';
    const sepCir = '0x11155111C';
    const allTargets = eng.calls.aggregate3.flat().map((c) => c.target);
    expect(allTargets.includes(arcCir)).toBe(true);      // Arc cirBTC batched
    expect(allTargets.includes(sepCir)).toBe(false);     // Sepolia cirBTC never batched
    // Non-Arc cirBTC results are not_supported.
    const results = await eng.ubFetchAllBalances('0xwallet');
    const sep = results.find((r) => r.chainId === 'Ethereum_Sepolia' && r.token === 'cirBTC');
    expect(sep.status).toBe('not_supported');
  });

  it('token not deployed → not_supported, no multicall call for it', async () => {
    const eng = load({ balanceOf: async () => 1n, chains: [sepoliaChain()] });
    const results = await eng.ubFetchAllBalances('0xwallet');
    const sepCir = results.find((r) => r.chainId === 'Ethereum_Sepolia' && r.token === 'cirBTC');
    expect(sepCir.status).toBe('not_supported');
    const targets = eng.calls.aggregate3.flat().map((c) => c.target);
    expect(targets.includes('0x11155111C')).toBe(false);
  });

  it('real zero balance → available with amount 0 (not fabricated, not omitted)', async () => {
    const eng = load({ balanceOf: async () => 0n, chains: [arcChain()] });
    const results = await eng.ubFetchAllBalances('0xwallet');
    const usdc = results.find((r) => r.token === 'USDC');
    expect(usdc.status).toBe('available');
    expect(usdc.raw).toBe(0n);
    expect(usdc.amount).toBe(0);
  });
});

/* ── 5/6 — partial failure, total failure + fallback ──────────────── */
describe('Multicall — failure semantics', () => {
  it('partial failure keeps valid results; failed call → unavailable (never 0)', async () => {
    const eng = load({
      balanceOf: async (addr) => { if (addr.endsWith('B')) throw new Error('EURC_DOWN'); return 1000000n; },
      chains: [arcChain()],
    });
    const results = await eng.ubFetchAllBalances('0xwallet');
    const usdc = results.find((r) => r.token === 'USDC');
    const eurc = results.find((r) => r.token === 'EURC');
    expect(usdc.status).toBe('available');
    expect(usdc.raw).toBe(1000000n);             // valid result NOT discarded
    expect(eurc.status).toBe('unavailable');
    expect(eurc.amount).toBeNull();              // never coerced to 0
    expect(eurc.raw).toBeNull();
  });

  it('total multicall failure → per-chain fallback to individual calls succeeds', async () => {
    const eng = load({
      balanceOf: async (addr) => (addr.endsWith('A') ? 1000000n : 500000n),
      aggregate3: async () => { throw new Error('MULTICALL_DOWN'); },
      chains: [arcChain()],
    });
    const results = await eng.ubFetchAllBalances('0xwallet');
    expect(eng.calls.balanceOf.length).toBe(3);  // fallback: USDC+EURC+cirBTC individually
    const usdc = results.find((r) => r.token === 'USDC');
    expect(usdc.status).toBe('available');
    expect(usdc.raw).toBe(1000000n);
  });

  it('total multicall failure + individual failure → unavailable (never 0)', async () => {
    const eng = load({
      balanceOf: async () => { throw new Error('DOWN'); },
      aggregate3: async () => { throw new Error('MULTICALL_DOWN'); },
      chains: [arcChain()],
    });
    const results = await eng.ubFetchAllBalances('0xwallet');
    expect(results.every((r) => r.status === 'unavailable')).toBe(true);
    expect(results.every((r) => r.raw === null)).toBe(true);
  });
});

/* ── 7/8 — retry + timeout preserve semantics ────────────────────── */
describe('Multicall — retry + timeout', () => {
  it('individual fallback still retries once and honors timeout', async () => {
    let attempts = 0;
    const eng = load({
      multicall: false,
      balanceOf: async () => { attempts++; throw new Error('DOWN'); },
      chains: [arcChain()],
    });
    await eng.ubFetchAllBalances('0xwallet');
    expect(attempts).toBe(6); // 3 tokens × (initial + 1 retry)
  });

  it('multicall timeout → fallback to individual (which uses same timeout/retry)', async () => {
    let balAttempts = 0;
    const eng = load({
      aggregate3: async () => new Promise(() => {}), // never resolves → timeout
      balanceOf: async () => { balAttempts++; return 1000000n; },
      timeoutMs: 25,
      chains: [arcChain()],
    });
    const results = await eng.ubFetchAllBalances('0xwallet');
    expect(eng.calls.balanceOf.length).toBe(3); // fell back
    expect(results.find((r) => r.token === 'USDC').status).toBe('available');
    expect(balAttempts).toBe(3);
  });
});

/* ── 9/10/11 — dedup + wallet-switch during multicall + stale discard ── */
describe('Multicall — dedup + concurrency', () => {
  it('each chain+wallet+token is consulted exactly once (no duplicate aggregate3 targets)', async () => {
    const eng = load({ balanceOf: async () => 1000000n, chains: realChains() });
    await eng.ubFetchAllBalances('0xwallet');
    const all = eng.calls.aggregate3.flat();
    const erc20Keys = all.filter((c) => c.target.toLowerCase() !== MULTICALL3.toLowerCase()).map((c) => c.target + ':' + c.callData.__wallet);
    const nativeTargets = all.filter((c) => c.target.toLowerCase() === MULTICALL3.toLowerCase());
    expect(new Set(erc20Keys).size).toBe(erc20Keys.length); // no duplicate ERC20 token+wallet
    expect(erc20Keys.length).toBe(13); // 3 (Arc) + 2×5 (others)
    expect(nativeTargets.length).toBe(4); // one getEthBalance per ETH-native chain
  });

  it('wallet switch during in-flight multicall → A discarded, B authoritative', async () => {
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
    eng.ubRefresh();               // refresh A begins (multicall gated)
    eng.setWallet('0xbbbb');       // wallet switches
    eng.bumpGeneration();          // generation++
    eng.ubRefresh();               // B queued (A still in-flight)
    releaseA();                    // A's aggregate3 resolves
    await settle(eng);
    const usdc = eng.UB.state.assets.find((a) => a.token === 'USDC');
    expect(usdc.balance).toBe(2);  // B's balance, never A's (1)
  });

  it('stale generation discards late multicall result', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let calls = 0;
    const eng = load({
      balanceOf: async () => { calls++; return gate.then(() => 1000000n); },
      chains: [arcChain()],
    });
    eng.setWallet('0xaaaa');
    eng.ubRefresh();
    eng.bumpGeneration();          // generation changed while A in-flight
    release();
    await settle(eng);
    // A's results were discarded; state has no assets from stale generation.
    expect(eng.UB.state.assets.length).toBe(0);
    expect(eng.UB.state.aggregateStatus).toBe('unavailable');
  });
});

/* ── 12/13/14/15 — valuation + price + aggregate status stay correct ── */
describe('Multicall — valuation integrity', () => {
  it('totalUSD remains honest across chains (multicall path)', async () => {
    // Arc: USDC 2, EURC 1, cirBTC 0.5 → 2 + 1.1 + 35000 = 35003.1
    const eng = load({
      balanceOf: async (addr) => {
        if (addr.endsWith('A')) return 2000000n;      // USDC 2
        if (addr.endsWith('B')) return 1000000n;      // EURC 1
        return 50000000n;                              // cirBTC 0.5 (8 decimals)
      },
      chains: [arcChain()],
    });
    const results = await eng.ubFetchAllBalances('0xwallet');
    const state = eng.ubBuildState(results, 1);
    expect(state.aggregateStatus).toBe('complete');
    expect(state.totalUSD).toBeCloseTo(2 + 1.1 + 0.5 * 70000, 6);
  });

  it('unavailable price → usd null, aggregateStatus partial (never fabricated)', async () => {
    const eng = load({
      balanceOf: async (addr) => (addr.endsWith('A') ? 1000000n : 500000n),
      chains: [arcChain()],
    });
    // Override pool so EURC/cirBTC prices are unavailable.
    const orig = eng.ubResolveTokenPrice;
    const results = await eng.ubFetchAllBalances('0xwallet');
    const state = eng.ubBuildState(results.map((r) => (r.token === 'USDC' ? r : Object.assign({}, r, { price: null, priceStatus: 'unavailable' }))), 1);
    expect(state.assets.find((a) => a.token === 'EURC').usd).toBeNull();
    expect(state.totalUSD).toBe(1); // only USDC valued
    expect(state.aggregateStatus).toBe('partial');
  });
});

/* ── 16/17/18 — no fabricated zero, no duplicates, no refreshBalance ── */
describe('Multicall — invariants', () => {
  it('no balance is fabricated as 0 (failures are null/unavailable)', async () => {
    const eng = load({
      aggregate3: async () => { throw new Error('MULTICALL_DOWN'); },
      balanceOf: async (addr) => { if (addr.endsWith('B')) throw new Error('EURC_DOWN'); return 0n; },
      chains: [arcChain()],
    });
    const results = await eng.ubFetchAllBalances('0xwallet');
    const eurc = results.find((r) => r.token === 'EURC');
    const usdc = results.find((r) => r.token === 'USDC');
    expect(eurc.status).toBe('unavailable');
    expect(eurc.amount).toBeNull();
    expect(usdc.status).toBe('available');   // real zero is still available
    expect(usdc.amount).toBe(0);
  });

  it('RPC calls are reduced: 6 aggregate3 + 0 getBalance (17 → 6)', async () => {
    const multi = load({ balanceOf: async () => 1000000n, chains: realChains() });
    await multi.ubFetchAllBalances('0xwallet');
    const after = multi.calls.aggregate3.length + multi.calls.getBalance.length;
    expect(multi.calls.aggregate3.length).toBe(6);
    expect(multi.calls.balanceOf.length).toBe(0);
    expect(multi.calls.getBalance.length).toBe(0); // native folded into aggregate3

    const baseline = load({ multicall: false, balanceOf: async () => 1000000n, chains: realChains() });
    await baseline.ubFetchAllBalances('0xwallet');
    const before = baseline.calls.balanceOf.length + baseline.calls.getBalance.length;
    expect(before).toBe(17); // 13 balanceOf + 4 getBalance

    expect(after).toBeLessThan(before); // 6 < 17, real reduction not an estimate
  });

  it('UB refresh path does not call legacy refreshBalance()', () => {
    const refresh = slice('function ubRefresh()', 'function ubFetchAllBalances');
    expect(refresh).not.toContain('refreshBalance(');
  });
});
