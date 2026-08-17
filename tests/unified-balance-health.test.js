/**
 * UNIFIED BALANCE — UB-5 per-chain health & observability panel.
 * ═══════════════════════════════════════════════════════════════════════════
 * Loads the FULL real UB engine. Verifies the health panel derives exclusively
 * from UB state (no RPC), per-chain status/reason/timestamp, wallet-switch
 * isolation of chain health, and no NaN/undefined/fabricated $0 in the UI.
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

function assemble() {
  const engineObj = slice('const UnifiedBalanceEngine = {', 'const UB = {');
  const ubState = slice('const UB = {', 'const UB_TOKEN_META');
  const constants = slice('const UB_RPC_TIMEOUT_MS', 'UB.analyze = function');
  const analyze = slice('UB.analyze = function', 'const FinancialMemory = (function()');
  const finMem = slice('const FinancialMemory = (function()', 'UB.getRecommendations');
  const refresh = slice('function ubRefresh()', 'function ubFetchAllBalances');
  const engineFetch = slice('function _ubProvider', 'function ubRenderAll');
  const render = slice('function ubRenderAll()', 'window.ubInit = ubInit;');
  return 'let walletAddress = "";\nlet activeChainId = 5042002;\n' +
    engineObj + '\n' + ubState + '\n' + constants + '\n' + analyze + '\n' + finMem + '\n' + refresh + '\n' + engineFetch + '\n' + render;
}

function makeEthers({ multicall = true, balanceOf, getBalance, getEthBalance, aggregate3 } = {}) {
  const calls = { balanceOf: [], getBalance: [], aggregate3: [] };
  const ethersMock = {
    JsonRpcProvider: function (rpc) {
      return { rpc, getBalance: async function (addr) { calls.getBalance.push(addr); return getBalance ? await getBalance(addr) : 0n; } };
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
      return { balanceOf: async function (w) { calls.balanceOf.push({ token: addr, wallet: w }); return balanceOf ? await balanceOf(addr, w) : 0n; } };
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
    if (!els[id]) els[id] = { id, style: { display: (id === 'ub-content' || id === 'ub-networks-body' || id === 'ub-networks-advanced' ? 'none' : '') }, textContent: '', innerHTML: '', title: '', className: '' };
    return els[id];
  }
  return { get };
}

function load({ balanceOf, getBalance, getEthBalance, aggregate3, multicall = true, chains } = {}) {
  const { ethersMock, calls } = makeEthers({ multicall, balanceOf, getBalance, getEthBalance, aggregate3 });
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
  const body = assemble() +
    '\nreturn { UB, UnifiedBalanceEngine, FinancialMemory, ubRefresh, ubShowState, ubSetUpdating, ubMarkStale, ubRenderUpdated, ubRenderHero, ubRenderNetworks, ubToggleNetworks, ubToggleNetworksAdvanced, ubRenderAll, ubFetchAllBalances, ubBuildState, ubResult, ubTokenDeployed, _ubChainStatus, _ubChainHealth, _ubErrorReason, setWallet: (w) => { walletAddress = w; }, getWallet: () => walletAddress, setActiveChain: (id) => { activeChainId = id; }, getGeneration: () => _ubGeneration, bumpGeneration: _ubBumpGeneration, getLastRenderedWallet: () => _ubLastRenderedWallet };';
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
function evmChain(o) { return Object.assign({ rpc: 'https://rpc', isEvm: true, tokens: { USDC: { address: '0x' + o.chainId + 'A', decimals: 6 }, EURC: { address: '0x' + o.chainId + 'B', decimals: 6 }, cirBTC: { address: '0x' + o.chainId + 'C', decimals: 8 } } }, o); }
function sepoliaChain() { return evmChain({ id: 'Ethereum_Sepolia', name: 'Ethereum Sepolia', shortName: 'Sepolia', chainId: 11155111, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } }); }

async function settle(eng, maxMs = 4000) {
  const start = Date.now();
  while ((eng.UB.loading || eng.UB._refreshQueued) && Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 10));
}

/* ── 1 — error reason mapping ─────────────────────────────────────── */
describe('UB-5 — error reason mapping', () => {
  it('maps timeout / rate-limit / generic', () => {
    const eng = load();
    expect(eng._ubErrorReason('RPC_TIMEOUT')).toBe('RPC timeout');
    expect(eng._ubErrorReason({ message: '429 Too Many Requests' })).toBe('RPC rate limit');
    expect(eng._ubErrorReason('CALL_EXCEPTION')).toBe('RPC error');
  });
});

/* ── 2 — per-chain health derivation ──────────────────────────────── */
describe('UB-5 — per-chain health derivation', () => {
  it('available chain gets lastSuccessAt; unavailable gets reason + 0 lastSuccess', () => {
    const eng = load();
    const results = [
      { chainId: 'Arc_Testnet', token: 'USDC', status: 'available', error: null },
      { chainId: 'Base_Sepolia', token: 'USDC', status: 'unavailable', error: 'RPC_TIMEOUT' },
    ];
    const health = eng._ubChainHealth(results, { Arc_Testnet: 'available', Base_Sepolia: 'unavailable' }, null);
    expect(health['Arc_Testnet'].status).toBe('available');
    expect(health['Arc_Testnet'].lastSuccessAt).toBeGreaterThan(0);
    expect(health['Base_Sepolia'].status).toBe('unavailable');
    expect(health['Base_Sepolia'].reason).toBe('RPC timeout');
    expect(health['Base_Sepolia'].lastSuccessAt).toBe(0);
  });

  it('429 becomes "RPC rate limit" reason', () => {
    const eng = load();
    const results = [{ chainId: 'Base_Sepolia', token: 'USDC', status: 'unavailable', error: '429 Too Many Requests' }];
    const health = eng._ubChainHealth(results, { Base_Sepolia: 'unavailable' }, null);
    expect(health['Base_Sepolia'].reason).toBe('RPC rate limit');
  });
});

/* ── 3 — panel renders from state only (no RPC) ───────────────────── */
describe('UB-5 — network health panel', () => {
  function state(chainStatus, chainHealth) {
    return { assets: [], totalUSD: 0, aggregateStatus: 'complete', hasValuedUSD: false, chainStatus: chainStatus, chainHealth: chainHealth };
  }

  it('renders "2/2 updated" and per-chain Fresh status', () => {
    const eng = load();
    eng.UB.state = state(
      { Arc_Testnet: 'available', Ethereum_Sepolia: 'available' },
      { Arc_Testnet: { status: 'available', reason: null, lastSuccessAt: 123 }, Ethereum_Sepolia: { status: 'available', reason: null, lastSuccessAt: 123 } },
    );
    eng.ubRenderNetworks();
    expect(eng.ui('ub-networks-summary').textContent).toBe('2/2 updated');
    expect(eng.ui('ub-networks-list').innerHTML).toContain('Fresh');
  });

  it('renders "1/2 updated" with unavailable reason (no NaN/undefined)', () => {
    const eng = load();
    eng.UB.state = state(
      { Arc_Testnet: 'available', Ethereum_Sepolia: 'unavailable' },
      { Arc_Testnet: { status: 'available', reason: null, lastSuccessAt: 123 }, Ethereum_Sepolia: { status: 'unavailable', reason: 'RPC timeout', lastSuccessAt: 0 } },
    );
    eng.ubRenderNetworks();
    expect(eng.ui('ub-networks-summary').textContent).toBe('1/2 updated');
    const html = eng.ui('ub-networks-list').innerHTML;
    expect(html).toContain('Unavailable');
    expect(html).toContain('RPC timeout');
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('undefined');
  });

  it('panel triggers no RPC and does not alter totalUSD', () => {
    const eng = load();
    eng.UB.state = { assets: [{ token: 'USDC', usd: 1, balance: 1, chainId: 'Arc_Testnet' }], totalUSD: 1, aggregateStatus: 'complete', hasValuedUSD: true, chainStatus: { Arc_Testnet: 'available' }, chainHealth: { Arc_Testnet: { status: 'available', reason: null, lastSuccessAt: 1 } } };
    const before = eng.UB.state.totalUSD;
    eng.ubRenderNetworks();
    expect(eng.calls.balanceOf.length).toBe(0);
    expect(eng.calls.aggregate3.length).toBe(0);
    expect(eng.calls.getBalance.length).toBe(0);
    expect(eng.UB.state.totalUSD).toBe(before);
  });

  it('toggle expands/collapses the body', () => {
    const eng = load();
    eng.UB.state = state({ Arc_Testnet: 'available' }, { Arc_Testnet: { status: 'available', reason: null, lastSuccessAt: 1 } });
    eng.ubRenderNetworks();
    expect(eng.ui('ub-networks-body').style.display).toBe('none');
    eng.ubToggleNetworks();
    expect(eng.ui('ub-networks-body').style.display).toBe('flex');
    eng.ubToggleNetworks();
    expect(eng.ui('ub-networks-body').style.display).toBe('none');
  });

  it('hides card when no chain status (wallet disconnected/empty)', () => {
    const eng = load();
    eng.UB.state = { assets: [], totalUSD: 0, aggregateStatus: 'unavailable', hasValuedUSD: false, chainStatus: {}, chainHealth: {} };
    eng.ubRenderNetworks();
    expect(eng.ui('ub-networks-card').style.display).toBe('none');
  });

  it('clean list excludes technical details (they live in Advanced)', () => {
    const eng = load();
    eng.UB.state = state(
      { Arc_Testnet: 'available' },
      { Arc_Testnet: { status: 'available', reason: null, lastSuccessAt: 123, attempts: 1, retries: 0, latencyMs: 182, lastAttemptAt: 123, lastFailureAt: 0 } },
    );
    eng.ubRenderNetworks();
    const list = eng.ui('ub-networks-list').innerHTML;
    expect(list).toContain('Fresh');
    expect(list).not.toContain('Retries');
    expect(list).not.toContain('Latency');
    expect(list).not.toContain('Chain ');
    const adv = eng.ui('ub-networks-advanced').innerHTML;
    expect(adv).toContain('Retries');
    expect(adv).toContain('Latency');
    expect(adv).toContain('Chain ');
  });

  it('advanced details toggle expands/collapses', () => {
    const eng = load();
    eng.UB.state = state({ Arc_Testnet: 'available' }, { Arc_Testnet: { status: 'available', reason: null, lastSuccessAt: 1 } });
    eng.ubRenderNetworks();
    expect(eng.ui('ub-networks-advanced').style.display).toBe('none');
    eng.ubToggleNetworksAdvanced();
    expect(eng.ui('ub-networks-advanced').style.display).toBe('flex');
    eng.ubToggleNetworksAdvanced();
    expect(eng.ui('ub-networks-advanced').style.display).toBe('none');
  });
});

/* ── 4 — wallet-switch isolation of chain health ──────────────────── */
describe('UB-5 — wallet switch health isolation', () => {
  it('wallet switch does not leak prior wallet chain health', async () => {
    let failArc = false;
    const eng = load({
      balanceOf: async (addr) => { if (addr.startsWith('0xA')) { if (failArc) throw new Error('DOWN'); return 1000000n; } return 2000000n; },
      chains: [arcChain(), sepoliaChain()],
    });
    eng.setWallet('0xaaaa');
    eng.ubRefresh();
    await settle(eng);
    expect(eng.UB.state.chainHealth['Arc_Testnet'].status).toBe('available');
    expect(eng.UB.state.chainHealth['Arc_Testnet'].lastSuccessAt).toBeGreaterThan(0);

    eng.setWallet('0xbbbb');
    failArc = true;
    eng.bumpGeneration();
    eng.ubRefresh();
    await settle(eng);
    // B's Arc is unavailable → lastSuccessAt must NOT be A's timestamp (0)
    expect(eng.UB.state.chainHealth['Arc_Testnet'].status).toBe('unavailable');
    expect(eng.UB.state.chainHealth['Arc_Testnet'].lastSuccessAt).toBe(0);
    // B's Sepolia is available (fresh)
    expect(eng.UB.state.chainHealth['Ethereum_Sepolia'].status).toBe('available');
  });

  it('A → B → A returns to A with fresh health', async () => {
    const eng = load({ balanceOf: async (addr, w) => (w === '0xbbbb' ? 2000000n : 1000000n), chains: [arcChain()] });
    eng.setWallet('0xaaaa'); eng.ubRefresh(); await settle(eng);
    eng.setWallet('0xbbbb'); eng.bumpGeneration(); eng.ubRefresh(); await settle(eng);
    expect(eng.UB.state.assets.find((a) => a.token === 'USDC').balance).toBe(2);
    eng.setWallet('0xaaaa'); eng.bumpGeneration(); eng.ubRefresh(); await settle(eng);
    expect(eng.UB.state.assets.find((a) => a.token === 'USDC').balance).toBe(1);
    expect(eng.UB.state.chainHealth['Arc_Testnet'].status).toBe('available');
  });
});

/* ── 5 — correct states after successful retry ────────────────────── */
describe('UB-5 — retry → fresh', () => {
  it('a chain that recovers after retry becomes available (Fresh)', async () => {
    let attempts = 0;
    const eng = load({
      multicall: false,
      balanceOf: async (addr) => { if (addr === '0xA0') { attempts++; if (attempts === 1) throw new Error('RPC_TIMEOUT'); return 1000000n; } return 2000000n; },
      chains: [arcChain()],
    });
    eng.setWallet('0xwallet');
    eng.ubRefresh();
    await settle(eng);
    expect(eng.UB.state.chainStatus['Arc_Testnet']).toBe('available');
    expect(eng.UB.state.chainHealth['Arc_Testnet'].status).toBe('available');
    expect(attempts).toBe(2);
  });
});
