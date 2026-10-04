/**
 * Unified Balance — EVM Wallet routing rules (Swap + Bridge).
 * ═══════════════════════════════════════════════════════════════════════
 * Proves that, when the Unified Balance operation drawer sources funds from the
 * EVM Wallet:
 *   · Swap excludes the local pool (LI.FI/Tower only) — from the moment the
 *     drawer opens, during quoting AND selection, never just at execution.
 *   · Bridge routes through BridgeKitRouter → CCTP (USDC/EURC compatible) or
 *     LI.FI (otherwise), and Turbo Bridge is never selected.
 *   · The Circle AI Smart Wallet (agent) flow is untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const aggSrc = fs.readFileSync(path.join(root, 'shared', 'SwapAggregator.js'), 'utf8');
const routerSrc = fs.readFileSync(path.join(root, 'shared', 'bridgeKitRouter.js'), 'utf8');

const ADDR = '0x2de8906a641d65d490bc60a4179d961d59742bcb';

function evalModule(src, win) {
  const fn = new Function('window', src);
  fn.call(null, win);
}

function loadAggregator() {
  const w = {};
  evalModule(aggSrc, w);
  return w.SwapAggregator;
}

function loadRouter() {
  const w = {};
  evalModule(routerSrc, w);
  return w.BridgeKitRouter;
}

function towerQuote(src, over) {
  return Object.assign({
    source: src, ok: true, tokenIn: 'USDC', tokenOut: 'EURC', chainId: 5042,
    amountInRaw: 1000000n, expectedOutRaw: 1000000n, minOutRaw: 995000n,
    priceImpactBps: null, feeBps: null, route: null, calldata: null, to: null,
    spender: null, expiresAt: Date.now() + 60000, executionType: 'tower',
  }, over || {});
}

function lifiQuote(over) {
  return Object.assign({
    source: 'lifi', ok: true, tokenIn: 'USDC', tokenOut: 'USDC',
    amountInRaw: 1000000n, expectedOutRaw: 1000000n, minOutRaw: 995000n,
    fromChainId: 1, toChainId: 8453, calldata: '0xabcd', to: ADDR, spender: ADDR,
  }, over || {});
}

describe('SwapAggregator — excludeLocal (Unified Balance EVM swap)', () => {
  beforeEach(() => {
    delete globalThis.TowerAdapter;
    delete globalThis.LocalAdapter;
    delete globalThis.LiFiAdapter;
  });
  afterEach(() => {
    delete globalThis.TowerAdapter;
    delete globalThis.LocalAdapter;
    delete globalThis.LiFiAdapter;
  });

  const opts = { tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 1000000n, slippageBps: 50, chainId: 5042 };

  it('excludeLocal: true → LocalAdapter is never quoted (not a candidate)', async () => {
    let localCalls = 0;
    globalThis.TowerAdapter = { getQuote: async () => towerQuote('tower', { calldata: '0xabcd', to: ADDR, spender: ADDR }) };
    globalThis.LocalAdapter = { getQuote: async () => { localCalls++; return towerQuote('local', { executionType: 'local' }); } };
    globalThis.LiFiAdapter = { getQuote: async () => ({ source: 'lifi', ok: false, error: 'offline' }) };
    const agg = loadAggregator();
    const r = await agg.getBestQuote(Object.assign({}, opts, { excludeLocal: true }));
    expect(localCalls).toBe(0);
    expect(r.quotes.some(q => q.source === 'local' && q.ok === true)).toBe(false);
    expect(r.bestExecutable.source).toBe('tower');
  });

  it('excludeLocal: true → local excluded even when it would otherwise win', async () => {
    globalThis.TowerAdapter = { getQuote: async () => towerQuote('tower', { expectedOutRaw: 900000n, calldata: '0xabcd', to: ADDR, spender: ADDR }) };
    globalThis.LocalAdapter = { getQuote: async () => towerQuote('local', { expectedOutRaw: 1012000n, executionType: 'local' }) };
    globalThis.LiFiAdapter = { getQuote: async () => ({ source: 'lifi', ok: false }) };
    const agg = loadAggregator();
    const r = await agg.getBestQuote(Object.assign({}, opts, { hasLocalPool: true, excludeLocal: true }));
    expect(r.bestExecutable.source).toBe('tower');
    expect(r.quotes.some(q => q.source === 'local' && q.ok === true)).toBe(false);
  });

  it('excludeLocal: true + Tower offline → LI.FI is selected (never local)', async () => {
    globalThis.TowerAdapter = { getQuote: async () => ({ source: 'tower', ok: false, error: 'offline' }) };
    globalThis.LocalAdapter = { getQuote: async () => towerQuote('local', { executionType: 'local' }) };
    globalThis.LiFiAdapter = { getQuote: async () => lifiQuote({ tokenOut: 'EURC', fromChainId: 5042, toChainId: 5042 }) };
    const agg = loadAggregator();
    const r = await agg.getBestQuote(Object.assign({}, opts, { excludeLocal: true }));
    expect(r.bestExecutable.source).toBe('lifi');
    expect(r.quotes.some(q => q.source === 'local' && q.ok === true)).toBe(false);
  });

  it('cross-chain EVM (fromChainId ≠ toChainId) + excludeLocal → LI.FI', async () => {
    // Tower reports a single-chain quote → rejected for cross-chain; local is
    // excluded; only LI.FI is executable.
    globalThis.TowerAdapter = { getQuote: async () => towerQuote('tower', { tokenOut: 'USDC', chainId: 1, calldata: '0xabcd', to: ADDR, spender: ADDR }) };
    globalThis.LocalAdapter = { getQuote: async () => towerQuote('local', { tokenOut: 'USDC', executionType: 'local' }) };
    globalThis.LiFiAdapter = { getQuote: async () => lifiQuote({ fromChainId: 1, toChainId: 8453 }) };
    const agg = loadAggregator();
    const r = await agg.getBestQuote({
      tokenIn: 'USDC', tokenOut: 'USDC', amountInRaw: 1000000n, slippageBps: 50,
      fromChainId: 1, toChainId: 8453, excludeLocal: true,
    });
    expect(r.bestExecutable).toBeTruthy();
    expect(r.bestExecutable.source).toBe('lifi');
  });

  it('normal swap (no excludeLocal) still allows LocalAdapter as a candidate', async () => {
    globalThis.TowerAdapter = { getQuote: async () => ({ source: 'tower', ok: false }) };
    globalThis.LocalAdapter = { getQuote: async () => towerQuote('local', { executionType: 'local' }) };
    globalThis.LiFiAdapter = { getQuote: async () => ({ source: 'lifi', ok: false }) };
    const agg = loadAggregator();
    const r = await agg.getBestQuote(Object.assign({}, opts, { hasLocalPool: true }));
    expect(r.bestExecutable.source).toBe('local');
  });
});

describe('Unified Balance EVM — drawer context (source inspection)', () => {
  it('sets the EVM-op context when the drawer opens (not only at execution)', () => {
    expect(html).toContain("_ubEVMOpActive = (_ubSourceWallet === 'evm') && (op === 'swap' || op === 'bridge')");
  });

  it('clears the context on close/cancel (_cleanupAll)', () => {
    const fn = html.slice(html.indexOf('function _cleanupAll'), html.indexOf('function hideOperation'));
    expect(fn).toContain('_ubEVMOpActive = false');
  });

  it('clears the context when the fund source changes (_ubSetSource)', () => {
    const fn = html.slice(html.indexOf('function _ubSetSource'), html.indexOf('function _ubInjectSourceSelector'));
    expect(fn).toContain('_ubEVMOpActive = false');
  });

  it('passes excludeLocal during the canonical quote (updateSwapRate)', () => {
    const fn = html.slice(html.indexOf('async function updateSwapRate'), html.indexOf('function calcRoutePriceImpact'));
    expect(fn).toContain('excludeLocal: _ubEVMOpActive === true');
    expect(fn).toContain('const hasLocalPool = _ubEVMOpActive ? false :');
  });

  it('swap drawer never hardcodes "Direct Pool" as the route', () => {
    expect(html).not.toContain('>Direct Pool<');
    expect(html).toContain('id="ub-scr-swap-route"');
  });

  it('swap drawer provider label maps only LI.FI / Tower (never Direct Pool)', () => {
    const fn = html.slice(html.indexOf('function _ubSwapProviderLabel'), html.indexOf('function _flipSwap'));
    expect(fn).toContain("return 'LI.FI'");
    expect(fn).toContain("return 'Tower'");
    expect(fn).not.toContain('Direct Pool');
  });

  it('swap drawer quotes directly through SwapAggregator (excludeLocal, no fixed wait)', () => {
    const fn = html.slice(html.indexOf('async function _ubQuoteSwap'), html.indexOf('function _ubSwapProviderLabel'));
    expect(fn).toContain('SwapAggregator.getBestQuote');
    expect(fn).toContain('excludeLocal: true');
    expect(fn).toContain('SWP.lastQuote');
    expect(fn).not.toContain('updateSwapRate()');
  });

  it('swap drawer converts the human amount to raw units with token decimals', () => {
    const fn = html.slice(html.indexOf('async function _ubQuoteSwap'), html.indexOf('function _ubSwapProviderLabel'));
    expect(fn).toContain('SwapMath.parseUnits');
    expect(fn).toContain('ti2.decimals');
    expect(fn).toContain('SwapMath.formatUnits');
    expect(fn).toContain('to2.decimals');
  });

  it('swap drawer refreshes on amount AND token change', () => {
    expect(html).toContain("amtEl.addEventListener('input', UBScreen._refreshSwap)");
    expect(html).toContain("fromSel.addEventListener('change', UBScreen._refreshSwap)");
    expect(html).toContain("toSel.addEventListener('change', UBScreen._refreshSwap)");
  });
});

describe('Unified Balance EVM — bridge routing (source inspection)', () => {
  it('bridge drawer selects CCTP/LI.FI via BridgeKitRouter (never Turbo)', () => {
    const fn = html.slice(html.indexOf('function _refreshBridge()'), html.indexOf('function _setBridgeAmt'));
    expect(fn).toContain('BridgeKitRouter.route');
    expect(fn).not.toContain("'Turbo Engine'");
    expect(fn).not.toContain('⚡ Turbo');
    expect(fn).not.toContain('Turbo Instant');
    expect(fn).not.toContain('isTurbo');
  });

  it('execBridge routes through executeBridgeOrTurbo (no legacy Turbo executor)', () => {
    const start = html.indexOf('async function execBridge()');
    const fn = html.slice(start, html.indexOf('openSend: openSend', start));
    expect(fn).toContain('executeBridgeOrTurbo()');
    expect(fn).not.toContain('xcExecuteSend');
    expect(fn).not.toContain('executeTurbo');
  });

  it('executeBridgeOrTurbo never falls back to Turbo (CCTP → LI.FI only)', () => {
    const fn = html.slice(html.indexOf('function executeBridgeOrTurbo'), html.indexOf('async function executeBridgeViaCCTP'));
    expect(fn).toContain('BridgeKitRouter.route');
    expect(fn).toContain('executeBridgeViaCCTP()');
    expect(fn).toContain('executeBridgeViaLiFi()');
    expect(fn).not.toContain('executeTurbo');
    expect(fn).not.toContain('xcExecuteSend');
  });
});

describe('BridgeKitRouter — UB EVM routing matrix', () => {
  const R = loadRouter();

  it('USDC/EURC compatible route → CCTP first', () => {
    expect(R.route(1, 5042, 'USDC').provider).toBe('cctp');
    expect(R.route(5042, 8453, 'EURC').provider).toBe('cctp');
  });

  it('non-CCTP route → LI.FI', () => {
    expect(R.route(1, 5042, 'ETH').provider).toBe('lifi');
    expect(R.route(999999, 5042, 'USDC').provider).toBe('lifi');
  });

  it('never returns a turbo provider', () => {
    expect(R.route(1, 5042, 'USDC').provider).not.toBe('turbo');
    expect(R.route(1, 5042, 'ETH').provider).not.toBe('turbo');
  });
});

describe('SwapAggregator — LI.FI as a real selectable provider (UB EVM)', () => {
  beforeEach(() => {
    delete globalThis.TowerAdapter;
    delete globalThis.LocalAdapter;
    delete globalThis.LiFiAdapter;
  });
  afterEach(() => {
    delete globalThis.TowerAdapter;
    delete globalThis.LocalAdapter;
    delete globalThis.LiFiAdapter;
  });

  const opts = { tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 1000000n, slippageBps: 50, chainId: 5042, fromChainId: 5042, toChainId: 5042 };

  it('LiFiAdapter.getQuote is called by SwapAggregator', async () => {
    let lifiCalls = 0;
    globalThis.TowerAdapter = { getQuote: async () => ({ source: 'tower', ok: false }) };
    globalThis.LocalAdapter = { getQuote: async () => ({ source: 'local', ok: false }) };
    globalThis.LiFiAdapter = { getQuote: async () => { lifiCalls++; return lifiQuote({ tokenIn: 'USDC', tokenOut: 'EURC', fromChainId: 5042, toChainId: 5042 }); } };
    const agg = loadAggregator();
    await agg.getBestQuote(Object.assign({}, opts, { excludeLocal: true }));
    expect(lifiCalls).toBe(1);
  });

  it('a valid LI.FI quote enters candidates and can be bestExecutable', async () => {
    globalThis.TowerAdapter = { getQuote: async () => ({ source: 'tower', ok: false }) };
    globalThis.LocalAdapter = { getQuote: async () => ({ source: 'local', ok: false }) };
    globalThis.LiFiAdapter = { getQuote: async () => lifiQuote({ tokenIn: 'USDC', tokenOut: 'EURC', fromChainId: 5042, toChainId: 5042 }) };
    const agg = loadAggregator();
    const r = await agg.getBestQuote(Object.assign({}, opts, { excludeLocal: true }));
    expect(r.quotes.some(q => q.source === 'lifi' && q.ok === true)).toBe(true);
    expect(r.bestExecutable).toBeTruthy();
    expect(r.bestExecutable.source).toBe('lifi');
  });

  it('same-chain LI.FI works (fromChainId === toChainId)', async () => {
    globalThis.TowerAdapter = { getQuote: async () => ({ source: 'tower', ok: false }) };
    globalThis.LocalAdapter = { getQuote: async () => ({ source: 'local', ok: false }) };
    globalThis.LiFiAdapter = { getQuote: async () => lifiQuote({ tokenIn: 'USDC', tokenOut: 'EURC', fromChainId: 5042, toChainId: 5042 }) };
    const agg = loadAggregator();
    const r = await agg.getBestQuote(Object.assign({}, opts, { excludeLocal: true }));
    expect(r.bestExecutable.source).toBe('lifi');
  });

  it('Tower still works when LI.FI is unavailable (no LI.FI priority)', async () => {
    globalThis.TowerAdapter = { getQuote: async () => towerQuote('tower', { calldata: '0xabcd', to: ADDR, spender: ADDR }) };
    globalThis.LocalAdapter = { getQuote: async () => ({ source: 'local', ok: false }) };
    globalThis.LiFiAdapter = { getQuote: async () => ({ source: 'lifi', ok: false }) };
    const agg = loadAggregator();
    const r = await agg.getBestQuote(Object.assign({}, opts, { excludeLocal: true }));
    expect(r.bestExecutable.source).toBe('tower');
  });
});

describe('Unified Balance EVM — LI.FI execution chain (source inspection)', () => {
  it('execSwap gates on the external quote (LI.FI/Tower), never the local pool route', () => {
    const fn = html.slice(html.indexOf('async function execSwap()'), html.indexOf('async function execBridge()'));
    expect(fn).toContain('SWP._towerQuoteData');
    expect(fn).toContain('SWP._towerQuoteData.calldata');
    expect(fn).not.toContain('SWP.lastRoute || SWP.lastRoute.noLiq');
  });

  it('executeSwap dispatches a selected LI.FI quote to swpExecuteLiFi', () => {
    const start = html.indexOf('async function executeSwap()');
    const fn = html.slice(start, html.indexOf('function swpAddHistory', start));
    expect(fn).toContain("SWP._towerQuoteData.source === 'lifi'");
    expect(fn).toContain('swpExecuteLiFi(');
    expect(fn).toContain('swpExecuteTowerOnly(');
  });

  it('swpExecuteLiFi executes the LI.FI calldata/to/value after validation', () => {
    const fn = html.slice(html.indexOf('async function swpExecuteLiFi'), html.indexOf('// ── Execute Swap'));
    expect(fn).toContain('LiFiAdapter.validateRoute');
    expect(fn).toContain('q.calldata');
    expect(fn).toContain('q.to');
    expect(fn).toContain('q.value');
    expect(fn).toContain('signer.sendTransaction');
  });

  it('updateSwapRate records the selected LI.FI provider and preserves its quote data', () => {
    const fn = html.slice(html.indexOf('async function updateSwapRate'), html.indexOf('function calcRoutePriceImpact'));
    expect(fn).toContain("source = 'LI.FI'");
    expect(fn).toContain('SWP._towerQuoteData = selected.calldata ? selected : null');
  });
});

describe('Unified Balance EVM — bridge completion gating (source inspection)', () => {
  const wfn = html.slice(html.indexOf('function _ubBridgeEnsureWatcher'), html.indexOf('async function execBridge()'));
  const start = html.indexOf('async function execBridge()');
  const fn = html.slice(start, html.indexOf('if (document.readyState', start));

  it('reuses BridgeEngine lifecycle (bridgeCompleted / bridgeFailed) as the Done source of truth', () => {
    expect(wfn).toContain("BridgeEngine.watch('bridgeCompleted'");
    expect(wfn).toContain("BridgeEngine.watch('bridgeFailed'");
  });

  it('shows in-progress steps while the bridge settles (no premature Done)', () => {
    expect(fn).toContain("setStep(1, 'Waiting for wallet confirmation', 'active')");
    expect(fn).toContain("setStep(2, 'Bridge processing', 'active')");
  });

  it('only shows "Moved ..." (success/Done) AFTER the bridge outcome is confirmed', () => {
    const okIdx = fn.indexOf('_ubBridgeOutcome.ok');
    const movedIdx = fn.indexOf("showResult(true, 'Moved ' + amt + ' USDC')");
    expect(okIdx).toBeGreaterThan(-1);
    expect(movedIdx).toBeGreaterThan(-1);
    expect(movedIdx).toBeGreaterThan(okIdx);
  });

  it('never marks the operation complete immediately after executeBridgeOrTurbo', () => {
    expect(fn).not.toContain("setStep(1, 'Move completed', 'done')");
  });

  it('errors surface as Failed (not as a success result)', () => {
    expect(fn).toContain("showResult(false, _ubBridgeOutcome.err || 'Move failed')");
  });
});

describe('Circle AI Smart Wallet — flow unchanged', () => {
  it('agent panel still uses its own route label (Elligentt Pool / Direct Pool)', () => {
    expect(html).toContain('function _ubOpenAgentPanel');
    expect(html).toContain("'Elligentt Pool'");
    expect(html).toContain("'Direct Pool'");
  });

  it('_ubSetSource routes agent → _ubOpenAgentPanel (not the EVM drawer)', () => {
    const fn = html.slice(html.indexOf('function _ubSetSource'), html.indexOf('function _ubInjectSourceSelector'));
    expect(fn).toContain('_ubOpenAgentPanel');
  });
});
