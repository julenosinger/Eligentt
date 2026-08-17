/**
 * UNIFIED BALANCE ENGINE — UB-2.1 hardening tests.
 * ═══════════════════════════════════════════════════════════════════════════
 * Loads the REAL inline UB engine functions from index.html into a sandbox with
 * deterministic mocks (mock ethers/providers/CHAINS). Verifies balance status
 * model, timeout+retry, per-chain isolation, wallet snapshot, generation/stale
 * discard, cirBTC deployment validation, and raw BigInt preservation.
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

// Assemble the real UB engine + refresh code into an eval-able unit.
function assemble(timeoutMs, retries) {
  const ubState = slice('const UB = {', 'const UB_TOKEN_META');
  let constants = slice('const UB_RPC_TIMEOUT_MS', 'UB.analyze = function');
  const refresh = slice('function ubRefresh()', 'function ubFetchAllBalances');
  const engine = slice('function _ubProvider', 'function ubRenderAll');
  if (timeoutMs != null) constants = constants.replace('const UB_RPC_TIMEOUT_MS = 8000', 'const UB_RPC_TIMEOUT_MS = ' + timeoutMs);
  if (retries != null) constants = constants.replace('const UB_RPC_MAX_RETRIES = 1', 'const UB_RPC_MAX_RETRIES = ' + retries);
  return 'let walletAddress = "";\n' + ubState + '\n' + constants + '\n' + refresh + '\n' + engine;
}

function makeEthers(balanceOf, getBalance) {
  const calls = { balanceOf: [], getBalance: [] };
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
      return {
        balanceOf: async function (w) {
          calls.balanceOf.push({ token: addr, wallet: w });
          if (balanceOf) return await balanceOf(addr, w);
          return 0n;
        },
      };
    },
  };
  return { ethersMock, calls };
}

function load({ balanceOf, getBalance, chains, timeoutMs, retries } = {}) {
  const { ethersMock, calls } = makeEthers(balanceOf, getBalance);
  const globals = {
    ethers: ethersMock,
    getCachedProvider: (rpc) => new ethersMock.JsonRpcProvider(rpc),
    UB_TOKEN_META: {
      USDC: { name: 'USD Coin', icon: 'U', color: '#2775ca' },
      EURC: { name: 'Euro Coin', icon: 'E', color: '#2562de' },
      cirBTC: { name: 'Circle BTC', icon: 'B', color: '#f7931a' },
      ETH: { name: 'Ether', icon: 'E', color: '#627eea' },
    },
    // Real on-chain pool price source (mocked with valid reserves so EURC/cirBTC
    // prices are AVAILABLE for balance-engine tests).
    findPool: (a, b) => {
      if ((a === 'USDC' && b === 'EURC') || (a === 'EURC' && b === 'USDC')) return { id: 'usdc-eurc', tokenA: 'USDC', tokenB: 'EURC' };
      if ((a === 'USDC' && b === 'cirBTC') || (a === 'cirBTC' && b === 'USDC')) return { id: 'usdc-cirbtc', tokenA: 'USDC', tokenB: 'cirBTC' };
      return null;
    },
    poolData: {
      'usdc-eurc': { loaded: true, reserveA: 110000000, reserveB: 100000000 },      // EURC rate 1.10
      'usdc-cirbtc': { loaded: true, reserveA: 7000000000000, reserveB: 100000000 }, // cirBTC rate 70000
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
    '\nreturn { ubFetchOne, ubFetchNativeBalance, ubFetchAllBalances, ubBuildState, ubResult, ubRefresh, ubShowState, UB, ubTokenDeployed, _ubCallWithRetry, _ubFormatAmount, _ubWithTimeout, setWallet: (w) => { walletAddress = w; }, getWallet: () => walletAddress, getGeneration: () => _ubGeneration, bumpGeneration: _ubBumpGeneration };';
  const fn = new Function(...names, body);
  const api = fn(...names.map((n) => globals[n]));
  api.calls = calls;
  return api;
}

function arcChain(o = {}) {
  return Object.assign({
    id: 'Arc_Testnet', name: 'Arc Testnet', shortName: 'Arc', chainId: 5042002, rpc: 'https://arc', isEvm: true,
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    tokens: {
      USDC: { address: '0xA0', decimals: 6 },
      EURC: { address: '0xA1', decimals: 6 },
      cirBTC: { address: '0xA2', decimals: 8 },
    },
  }, o);
}
function sepoliaChain(o = {}) {
  return Object.assign({
    id: 'Ethereum_Sepolia', name: 'Ethereum Sepolia', shortName: 'Sepolia', chainId: 11155111, rpc: 'https://sepolia', isEvm: true,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    tokens: {
      USDC: { address: '0xB0', decimals: 6 },
      EURC: { address: '0xB1', decimals: 6 },
      cirBTC: { address: '0xC2', decimals: 8 }, // not deployed on Sepolia → must be marked not_supported
    },
  }, o);
}
function singleChain(o = {}) {
  return Object.assign({
    id: 'Arc_Testnet', name: 'Arc Testnet', shortName: 'Arc', chainId: 5042002, rpc: 'https://arc', isEvm: true,
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    tokens: { USDC: { address: '0xA0', decimals: 6 } },
  }, o);
}
// Poll until the refresh lifecycle fully settles (loading false, no queued follow-up).
async function settle(eng, maxMs = 3000) {
  const start = Date.now();
  while ((eng.UB.loading || eng.UB._refreshQueued) && Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 10));
}

/* ── 1/2/3/4 — successful + zero balances ─────────────────────────── */
describe('Balance fetch — success + zero', () => {
  it('successful USDC balance → available, exact raw BigInt, correct amount', async () => {
    const eng = load({ balanceOf: async () => 1000000n });
    const r = await eng.ubFetchOne(arcChain(), 'USDC', '0xA0', '0xwallet');
    expect(r.status).toBe('available');
    expect(r.raw).toBe(1000000n);
    expect(r.amount).toBe(1);
    expect(r.decimals).toBe(6);
  });

  it('successful EURC balance → available', async () => {
    const eng = load({ balanceOf: async () => 899200n });
    const r = await eng.ubFetchOne(arcChain(), 'EURC', '0xA1', '0xwallet');
    expect(r.status).toBe('available');
    expect(r.amount).toBeCloseTo(0.8992, 6);
  });

  it('successful cirBTC balance (8 decimals) → available', async () => {
    const eng = load({ balanceOf: async () => 100000000n }); // 1 cirBTC
    const r = await eng.ubFetchOne(arcChain(), 'cirBTC', '0xA2', '0xwallet');
    expect(r.status).toBe('available');
    expect(r.amount).toBe(1);
    expect(r.decimals).toBe(8);
  });

  it('real zero balance → status available, amount 0 (not omitted)', async () => {
    const eng = load({ balanceOf: async () => 0n });
    const r = await eng.ubFetchOne(arcChain(), 'USDC', '0xA0', '0xwallet');
    expect(r.status).toBe('available');
    expect(r.raw).toBe(0n);
    expect(r.amount).toBe(0);
  });
});

/* ── 5/6/7/8 — failure, timeout, retry ────────────────────────────── */
describe('Balance fetch — failure / timeout / retry', () => {
  it('RPC failure → unavailable (never 0)', async () => {
    const eng = load({ balanceOf: async () => { throw new Error('RPC_DOWN'); } });
    const r = await eng.ubFetchOne(arcChain(), 'USDC', '0xA0', '0xwallet');
    expect(r.status).toBe('unavailable');
    expect(r.amount).toBeNull();
    expect(r.raw).toBeNull();
    expect(r.error).toBe('RPC_DOWN');
  });

  it('timeout → unavailable with RPC_TIMEOUT (after retry)', async () => {
    const eng = load({ balanceOf: async () => new Promise(() => {}), timeoutMs: 25, retries: 1 });
    const r = await eng.ubFetchOne(arcChain(), 'USDC', '0xA0', '0xwallet');
    expect(r.status).toBe('unavailable');
    expect(r.error).toBe('RPC_TIMEOUT');
    expect(eng.calls.balanceOf.length).toBe(2); // initial + 1 retry
  });

  it('retries once and succeeds on 2nd attempt', async () => {
    let attempts = 0;
    const eng = load({
      balanceOf: async () => { attempts++; if (attempts === 1) throw new Error('TRANSIENT'); return 500000n; },
    });
    const r = await eng.ubFetchOne(arcChain(), 'USDC', '0xA0', '0xwallet');
    expect(r.status).toBe('available');
    expect(attempts).toBe(2);
  });

  it('retry exhausted → unavailable (exactly 2 attempts, no infinite retry)', async () => {
    let attempts = 0;
    const eng = load({ balanceOf: async () => { attempts++; throw new Error('STILL_DOWN'); } });
    const r = await eng.ubFetchOne(arcChain(), 'USDC', '0xA0', '0xwallet');
    expect(r.status).toBe('unavailable');
    expect(attempts).toBe(2);
  });
});

/* ── 9 — one chain failure does not block others ──────────────────── */
describe('Per-chain failure isolation', () => {
  it('a failing chain yields unavailable results while others succeed', async () => {
    const eng = load({
      balanceOf: async (addr) => { if (addr.startsWith('0xA')) throw new Error('ARC_DOWN'); return 123456n; },
      chains: [arcChain(), sepoliaChain()],
    });
    const results = await eng.ubFetchAllBalances('0xwallet');
    const arc = results.filter((r) => r.chainId === 'Arc_Testnet' && r.status === 'unavailable');
    const sep = results.filter((r) => r.chainId === 'Ethereum_Sepolia' && r.status === 'available');
    expect(arc.length).toBeGreaterThan(0);
    expect(sep.length).toBeGreaterThan(0);
    // USDC + EURC available on Sepolia; cirBTC not_supported there
    expect(sep.filter((r) => r.token === 'USDC' || r.token === 'EURC').length).toBe(2);
  });
});

/* ── 10/11/12 — wallet snapshot + generation ──────────────────────── */
describe('Wallet snapshot + generation protection', () => {
  it('ubFetchOne uses the wallet snapshot, never the mutable global', async () => {
    const eng = load({ balanceOf: async () => 1n });
    eng.setWallet('0xGLOBALB');
    await eng.ubFetchOne(arcChain(), 'USDC', '0xA0', '0xSNAPSHOT_A');
    expect(eng.calls.balanceOf[0].wallet).toBe('0xSNAPSHOT_A');
  });

  it('stale old-wallet response is discarded after wallet switch', async () => {
    let releaseA;
    const gateA = new Promise((r) => { releaseA = r; });
    const eng = load({
      balanceOf: async (addr, w) => {
        if (w === '0xaaaa') return gateA.then(() => 1000000n); // wallet A: 1 USDC (gated)
        return 2000000n;                                        // wallet B: 2 USDC
      },
      chains: [singleChain()],
    });
    eng.setWallet('0xaaaa');
    eng.ubRefresh();               // refresh A begins (gated)
    eng.setWallet('0xbbbb');       // wallet switches
    eng.bumpGeneration();          // generation++
    eng.ubRefresh();               // B queued (A still in-flight)
    releaseA();                    // A's balanceOf resolves
    await settle(eng);
    // A's results were discarded; B is authoritative.
    expect(eng.UB.state.assets.length).toBe(1);
    const usdc = eng.UB.state.assets.find((a) => a.token === 'USDC');
    expect(usdc.balance).toBe(2); // B's balance, never A's (1)
  });

  it('refresh requested during in-flight refresh runs exactly one follow-up (no lost refresh)', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let calls = 0;
    const eng = load({
      balanceOf: async () => { calls++; return gate.then(() => 1000000n); },
      chains: [singleChain()],
    });
    eng.setWallet('0xaaaa');
    eng.ubRefresh();               // in-flight (gated)
    eng.ubRefresh();               // requested while in-flight → queued
    release();
    await settle(eng);
    expect(calls).toBe(2);         // exactly one follow-up refresh (2 balanceOf calls), not dropped
    expect(eng.UB.state.aggregateStatus).toBe('complete');
    expect(eng.UB.state.assets.length).toBe(1);
  });
});

/* ── 14/15/16 — cache scoping (state integrity) ───────────────────── */
describe('State integrity + aggregate status', () => {
  it('aggregateStatus = complete when all available', async () => {
    const eng = load({ balanceOf: async () => 1000000n, chains: [arcChain()] });
    const results = await eng.ubFetchAllBalances('0xwallet');
    const state = eng.ubBuildState(results, 1);
    expect(state.aggregateStatus).toBe('complete');
  });

  it('aggregateStatus = partial when some unavailable', async () => {
    const eng = load({ balanceOf: async (addr) => { if (addr === '0xA1') throw new Error('EURC_DOWN'); return 1000000n; }, chains: [arcChain()] });
    const results = await eng.ubFetchAllBalances('0xwallet');
    const state = eng.ubBuildState(results, 1);
    expect(state.aggregateStatus).toBe('partial');
  });

  it('unavailable balance never contributes to totalUSD as zero', async () => {
    const eng = load({ balanceOf: async (addr) => { if (addr === '0xA0') throw new Error('USDC_DOWN'); return 500000n; }, chains: [arcChain()] });
    const results = await eng.ubFetchAllBalances('0xwallet');
    const state = eng.ubBuildState(results, 1);
    // USDC is unavailable → totalUSD must NOT include 0 for USDC; only available EURC/cirBTC count.
    expect(state.assets.find((a) => a.token === 'USDC')).toBeUndefined();
    expect(state.totalUSD).toBeGreaterThan(0);
  });
});

/* ── 17 — cirBTC deployment validation ────────────────────────────── */
describe('cirBTC deployment validation', () => {
  it('cirBTC is not queried on unsupported chains (not_supported, no RPC)', async () => {
    const eng = load({ balanceOf: async () => 1n, chains: [arcChain(), sepoliaChain()] });
    const results = await eng.ubFetchAllBalances('0xwallet');
    const sepCir = results.find((r) => r.chainId === 'Ethereum_Sepolia' && r.token === 'cirBTC');
    expect(sepCir.status).toBe('not_supported');
    // No balanceOf call was made for the Sepolia cirBTC address (0xC2).
    const sepCirCall = eng.calls.balanceOf.find((c) => c.token === '0xC2');
    expect(sepCirCall).toBeUndefined();
    // Arc cirBTC (0xA2) IS queried (deployed).
    const arcCirCall = eng.calls.balanceOf.find((c) => c.token === '0xA2');
    expect(arcCirCall).toBeDefined();
  });
});

/* ── 18/19/20 — decimals + raw integer + unavailable≠0 ────────────── */
describe('Decimal / raw integer integrity', () => {
  it('raw is preserved as exact BigInt; amount is derived at the boundary', async () => {
    const eng = load({ balanceOf: async () => 12345678901234567890n });
    const r = await eng.ubFetchOne(arcChain(), 'USDC', '0xA0', '0xwallet');
    expect(r.raw).toBe(12345678901234567890n);
    expect(typeof r.amount).toBe('number');
  });

  it('unavailable balance amount/raw are null (never 0)', async () => {
    const eng = load({ balanceOf: async () => { throw new Error('DOWN'); } });
    const r = await eng.ubFetchOne(arcChain(), 'USDC', '0xA0', '0xwallet');
    expect(r.status).toBe('unavailable');
    expect(r.amount).toBeNull();
    expect(r.raw).toBeNull();
  });
});

/* ── UB-2.1.1 — cirBTC canonical chain-ID regression ─────────────── */
describe('cirBTC canonical chain-ID deployment guard', () => {
  function chainWithCir(id, shortName, chainId, cirAddr) {
    return {
      id, name: id.replace(/_/g, ' '), shortName, chainId, rpc: 'https://' + shortName, isEvm: true,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      tokens: { USDC: { address: '0x1' + chainId + '00', decimals: 6 }, cirBTC: { address: cirAddr, decimals: 8 } },
    };
  }
  const ALL_CHAINS = [
    chainWithCir('Arc_Testnet', 'Arc', 5042002, '0xA2'),
    chainWithCir('Ethereum_Sepolia', 'Sepolia', 11155111, '0xB2'),
    chainWithCir('Base_Sepolia', 'Base', 84532, '0xC2'),
    chainWithCir('Arbitrum_Sepolia', 'Arb', 421614, '0xD2'),
    chainWithCir('Optimism_Sepolia', 'OP', 11155420, '0xE2'),
    chainWithCir('Polygon_Amoy', 'Polygon', 80002, '0xF2'),
  ];

  it('Arc (5042002) queries cirBTC; every other chain is not_supported with no balanceOf', async () => {
    const eng = load({ balanceOf: async () => 1n, chains: ALL_CHAINS });
    const results = await eng.ubFetchAllBalances('0xwallet');

    // Arc cirBTC → available (queried).
    const arcCir = results.find((r) => r.token === 'cirBTC' && r.chainId === 'Arc_Testnet');
    expect(arcCir.status).toBe('available');

    // Non-Arc chains → not_supported + no balanceOf for their cirBTC address.
    for (const c of ALL_CHAINS.filter((c) => c.chainId !== 5042002)) {
      const r = results.find((x) => x.token === 'cirBTC' && x.chainId === c.id);
      expect(r.status).toBe('not_supported');
      const call = eng.calls.balanceOf.find((x) => x.token === c.tokens.cirBTC.address);
      expect(call).toBeUndefined();
    }

    // Arc cirBTC address queried exactly once.
    expect(eng.calls.balanceOf.filter((x) => x.token === '0xA2').length).toBe(1);
  });
});

/* ── UB-2.1.1 — refresh queue (3 requests → 1 follow-up) ──────────── */
describe('Refresh queue robustness', () => {
  it('3 extra refresh requests during in-flight → exactly one follow-up', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let calls = 0;
    const eng = load({ balanceOf: async () => { calls++; return gate.then(() => 1000000n); }, chains: [singleChain()] });
    eng.setWallet('0xaaaa');
    eng.ubRefresh();
    eng.ubRefresh(); eng.ubRefresh(); eng.ubRefresh(); // 3 additional requests
    release();
    await settle(eng);
    expect(calls).toBe(2); // initial + exactly one follow-up (never 4)
    expect(eng.UB.state.assets.length).toBe(1);
  });
});

/* ── UB-2.1.1 — aggregate status: unavailable ─────────────────────── */
describe('Aggregate status — unavailable', () => {
  it('aggregateStatus = unavailable when every query fails (never 0 fallback)', async () => {
    const eng = load({ balanceOf: async () => { throw new Error('DOWN'); }, chains: [singleChain()] });
    const results = await eng.ubFetchAllBalances('0xwallet');
    const state = eng.ubBuildState(results, 1);
    expect(state.aggregateStatus).toBe('unavailable');
    expect(state.totalUSD).toBe(0);
    expect(state.assets.length).toBe(0);
  });
});
