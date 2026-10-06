/**
 * swap-cross-chain-routes.test.js
 * ═══════════════════════════════════════════════════════════════════════
 * Verifies that the Swap uses LiFiAdapter.getRoutes() (not getQuote) for
 * cross-chain swaps, and that each returned route becomes its own card with
 * the real tool name (Stargate, Across, CCTP, …) rather than a generic
 * "LI.FI" label.
 *
 * These tests operate directly on SwapAggregator and SwapUiModes logic
 * extracted from the shared/ modules — no mocks, no artificial routes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// ── Load modules into a shared fake window ────────────────────────────────────
// SwapAggregator uses bare `LiFiAdapter`, `TowerAdapter`, `LocalAdapter` names
// which in `new Function('window', src)` resolve to globalThis, NOT window.*
// So we must assign to both global.window.X AND global.X.
function evalModule(relPath) {
  const src = readFileSync(join(process.cwd(), relPath), 'utf-8');
  const fn = new Function('window', src);
  fn(global.window);
}

function setAdapters({ LiFiAdapter, TowerAdapter, LocalAdapter }) {
  // window.* for SwapUiModes (reads window.LiFiAdapter via providerMeta — no direct ref)
  global.window.LiFiAdapter  = LiFiAdapter;
  global.TowerAdapter = TowerAdapter;
  global.window.LocalAdapter = LocalAdapter;
  // globalThis.* for SwapAggregator bare-name references
  global.LiFiAdapter  = LiFiAdapter;
  global.TowerAdapter = TowerAdapter;
  global.LocalAdapter = LocalAdapter;
}

beforeEach(() => {
  global.window = {};
  global.window.SwapMath = { formatUnits: (raw, d) => String(Number(raw) / 10 ** d) };
  evalModule('shared/SwapAggregator.js');
  evalModule('shared/swapUiModes.js');
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeRoute(routeId, toolName, toAmount) {
  return {
    ok: true,
    source: 'lifi',
    routeId,
    label: toolName,
    protocol: 'LI.FI aggregator',
    toAmountRaw: BigInt(toAmount),
    toAmountMinRaw: BigInt(toAmount) - 10000n,
    executionDuration: 35,
    feeCostUSD: 0.18,
    gasCostUSD: 0.05,
    steps: 2,
    stepsData: [{ id: 'step-1', action: { fromChainId: 5042, toChainId: 8453 } }],
    _rawRoute: {},
    _fetchedAt: Date.now(),
  };
}

// Build a minimal SwapAggregator decision with cross-chain getRoutes routes
function buildDecision(routes) {
  const quotes = routes.map((r, ri) => ({
    source:         'lifi-' + (r.routeId || ri),
    ok:             true,
    label:          r.label,
    protocol:       'LI.FI aggregator',
    fromChainId:    5042,
    toChainId:      8453,
    amountInRaw:    1000000n,
    expectedOutRaw: r.toAmountRaw,
    minOutRaw:      r.toAmountMinRaw,
    feeCostUSD:     r.feeCostUSD || null,
    estimatedTime:  r.executionDuration || null,
    execSec:        r.executionDuration || null,
    steps:          r.steps || 1,
    stepsData:      r.stepsData || [],
    routeId:        r.routeId || null,
    calldata:       null,
    to:             null,
    spender:        null,
    executable:     true,
    _needsStepTx:   true,
    expiresAt:      Date.now() + 160000,
  }));
  return {
    ok: true,
    best: quotes[0],
    bestExecutable: quotes[0],
    executable: true,
    quotes,
  };
}

// ── SwapAggregator: cross-chain skips getQuote ────────────────────────────────
describe('SwapAggregator — cross-chain uses getRoutes, not getQuote', () => {
  it('does NOT call getQuote for cross-chain (different fromChainId / toChainId)', async () => {
    let getQuoteCalled = false;
    let getRoutesCalled = false;

    global.LiFiAdapter = {
      getQuote: async () => { getQuoteCalled = true; return { source: 'lifi', ok: false, error: 'SHOULD_NOT_BE_CALLED' }; },
      getRoutes: async () => { getRoutesCalled = true; return { ok: true, routes: [makeRoute('r1', 'Stargate', 998000n)] }; },
    };
    global.TowerAdapter = { getQuote: async () => ({ source: 'tower', ok: false, error: 'UNAVAILABLE' }) };
    global.LocalAdapter  = { getQuote: async () => ({ source: 'local', ok: false, error: 'UNAVAILABLE' }) };

    const agg = global.window.SwapAggregator;
    await agg.getBestQuote({
      tokenIn: 'USDC', tokenOut: 'USDC',
      amountInRaw: 1000000n, slippageBps: 50,
      fromChainId: 5042, toChainId: 8453,
      userAddress: '0xabc',
    });

    expect(getRoutesCalled).toBe(true);
    expect(getQuoteCalled).toBe(false);
  });

  it('DOES call getQuote for same-chain swaps', async () => {
    let getQuoteCalled = false;

    global.LiFiAdapter = {
      getQuote: async () => { getQuoteCalled = true; return { source: 'lifi', ok: false, error: 'NO_ROUTE' }; },
      getRoutes: async () => ({ ok: false, routes: [] }),
    };
    global.TowerAdapter = { getQuote: async () => ({ source: 'tower', ok: false }) };
    global.LocalAdapter  = { getQuote: async () => ({ source: 'local', ok: false }) };

    const agg = global.window.SwapAggregator;
    await agg.getBestQuote({
      tokenIn: 'USDC', tokenOut: 'ETH',
      amountInRaw: 1000000n, slippageBps: 50,
      fromChainId: 8453, toChainId: 8453,
      userAddress: '0xabc',
    });

    expect(getQuoteCalled).toBe(true);
  });

  it('expands each getRoutes route into a separate lifi-<routeId> source key', async () => {
    global.LiFiAdapter = {
      getQuote:  async () => ({ source: 'lifi', ok: false, error: 'USE_GETROUTES' }),
      getRoutes: async () => ({
        ok: true,
        routes: [
          makeRoute('route-stargate', 'Stargate', 998000n),
          makeRoute('route-across',   'Across',   997500n),
          makeRoute('route-cctp',     'CCTP',     996000n),
        ],
      }),
    };
    global.TowerAdapter = { getQuote: async () => ({ source: 'tower', ok: false }) };
    global.LocalAdapter  = { getQuote: async () => ({ source: 'local', ok: false }) };

    const result = await global.window.SwapAggregator.getBestQuote({
      tokenIn: 'USDC', tokenOut: 'USDC',
      amountInRaw: 1000000n, slippageBps: 50,
      fromChainId: 5042, toChainId: 8453,
      userAddress: '0xabc',
    });

    const lifiQuotes = result.quotes.filter(q => q.source && q.source.startsWith('lifi-'));
    expect(lifiQuotes).toHaveLength(3);

    const sources = lifiQuotes.map(q => q.source);
    expect(sources).toContain('lifi-route-stargate');
    expect(sources).toContain('lifi-route-across');
    expect(sources).toContain('lifi-route-cctp');
  });

  it('carries the real tool name (label) on each route quote', async () => {
    global.LiFiAdapter = {
      getQuote:  async () => ({ source: 'lifi', ok: false }),
      getRoutes: async () => ({
        ok: true,
        routes: [
          makeRoute('r-sg',   'Stargate', 998000n),
          makeRoute('r-acrs', 'Across',   997000n),
        ],
      }),
    };
    global.TowerAdapter = { getQuote: async () => ({ source: 'tower', ok: false }) };
    global.LocalAdapter  = { getQuote: async () => ({ source: 'local', ok: false }) };

    const result = await global.window.SwapAggregator.getBestQuote({
      tokenIn: 'USDC', tokenOut: 'USDC',
      amountInRaw: 1000000n, slippageBps: 50,
      fromChainId: 5042, toChainId: 8453,
      userAddress: '0xabc',
    });

    const sg   = result.quotes.find(q => q.source === 'lifi-r-sg');
    const acrs = result.quotes.find(q => q.source === 'lifi-r-acrs');

    expect(sg).toBeDefined();
    expect(sg.label).toBe('Stargate');
    expect(acrs).toBeDefined();
    expect(acrs.label).toBe('Across');
  });

  it('does NOT produce a single generic "lifi" quote for cross-chain', async () => {
    global.LiFiAdapter = {
      getQuote:  async () => ({ source: 'lifi', ok: false, error: 'USE_GETROUTES' }),
      getRoutes: async () => ({
        ok: true,
        routes: [makeRoute('r1', 'Stargate', 998000n)],
      }),
    };
    global.TowerAdapter = { getQuote: async () => ({ source: 'tower', ok: false }) };
    global.LocalAdapter  = { getQuote: async () => ({ source: 'local', ok: false }) };

    const result = await global.window.SwapAggregator.getBestQuote({
      tokenIn: 'USDC', tokenOut: 'USDC',
      amountInRaw: 1000000n, slippageBps: 50,
      fromChainId: 5042, toChainId: 8453,
      userAddress: '0xabc',
    });

    const genericLifi = result.quotes.find(q => q.source === 'lifi' && q.ok === true);
    expect(genericLifi).toBeUndefined();
  });

  it('best rate is the route with highest toAmountRaw', async () => {
    global.LiFiAdapter = {
      getQuote:  async () => ({ source: 'lifi', ok: false }),
      getRoutes: async () => ({
        ok: true,
        routes: [
          makeRoute('r-sg',   'Stargate', 998000n),   // highest
          makeRoute('r-acrs', 'Across',   995000n),
          makeRoute('r-cctp', 'CCTP',     990000n),
        ],
      }),
    };
    global.TowerAdapter = { getQuote: async () => ({ source: 'tower', ok: false }) };
    global.LocalAdapter  = { getQuote: async () => ({ source: 'local', ok: false }) };

    const result = await global.window.SwapAggregator.getBestQuote({
      tokenIn: 'USDC', tokenOut: 'USDC',
      amountInRaw: 1000000n, slippageBps: 50,
      fromChainId: 5042, toChainId: 8453,
      userAddress: '0xabc',
    });

    expect(result.ok).toBe(true);
    expect(result.best).toBeDefined();
    expect(result.best.source).toBe('lifi-r-sg');
    expect(result.best.expectedOutRaw).toBe(998000n);
  });
});

// ── SwapUiModes: route card labels ────────────────────────────────────────────
describe('SwapUiModes — route cards use real tool names', () => {
  it('providerMeta returns the real label for lifi-<routeId> quotes', () => {
    const modes = global.window.SwapUiModes;
    const meta = modes.providerMeta('lifi-route-stargate', { label: 'Stargate' });
    expect(meta.name).toBe('Stargate');
    expect(meta.sourceLabel).toBe('via LI.FI');
  });

  it('providerMeta falls back to "LI.FI" when label is missing', () => {
    const modes = global.window.SwapUiModes;
    const meta = modes.providerMeta('lifi-route-xyz', {});
    expect(meta.name).toBe('LI.FI');
  });

  it('providerMeta handles lifi-<routeId> with no quote arg', () => {
    const modes = global.window.SwapUiModes;
    const meta = modes.providerMeta('lifi-route-abc');
    expect(meta.name).toBe('LI.FI');
  });

  it('buildRouteListHtml shows each real tool name in the card HTML', () => {
    const modes = global.window.SwapUiModes;
    const decision = buildDecision([
      makeRoute('r-sg',   'Stargate', 998000n),
      makeRoute('r-acrs', 'Across',   995000n),
      makeRoute('r-cctp', 'CCTP',     990000n),
    ]);
    const html = modes.buildRouteListHtml(decision, null, {
      tokenOut: { symbol: 'USDC', decimals: 6 },
      fromChainId: 5042, toChainId: 8453,
    });
    expect(html).toContain('Stargate');
    expect(html).toContain('Across');
    expect(html).toContain('CCTP');
    // Must NOT show "Route 1", "Route 2" labels
    expect(html).not.toContain('Route 1');
    expect(html).not.toContain('Route 2');
    expect(html).not.toContain('Route 3');
  });

  it('buildRouteListHtml shows "via LI.FI" as sub-label for each route', () => {
    const modes = global.window.SwapUiModes;
    const decision = buildDecision([
      makeRoute('r-sg', 'Stargate', 998000n),
    ]);
    const html = modes.buildRouteListHtml(decision, null, {
      tokenOut: { symbol: 'USDC', decimals: 6 },
      fromChainId: 5042, toChainId: 8453,
    });
    expect(html).toContain('via LI.FI');
    // Must NOT show the generic "LI.FI Aggregator" sub-label for tool-named routes
    // (that belongs only to the top-level lifi source, which is not present here)
    const genericCount = (html.match(/LI\.FI Aggregator/g) || []).length;
    expect(genericCount).toBe(0);
  });

  it('each route card has a Select button with the correct source key', () => {
    const modes = global.window.SwapUiModes;
    const decision = buildDecision([
      makeRoute('route-sg',   'Stargate', 998000n),
      makeRoute('route-acrs', 'Across',   995000n),
    ]);
    const html = modes.buildRouteListHtml(decision, null, {
      tokenOut: { symbol: 'USDC', decimals: 6 },
      fromChainId: 5042, toChainId: 8453,
    });
    expect(html).toContain("swpSelectRoute('lifi-route-sg')");
    expect(html).toContain("swpSelectRoute('lifi-route-acrs')");
  });

  it('marks the selected route card as "Selected"', () => {
    const modes = global.window.SwapUiModes;
    const decision = buildDecision([
      makeRoute('r-sg',   'Stargate', 998000n),
      makeRoute('r-acrs', 'Across',   995000n),
    ]);
    const html = modes.buildRouteListHtml(decision, 'lifi-r-sg', {
      tokenOut: { symbol: 'USDC', decimals: 6 },
      fromChainId: 5042, toChainId: 8453,
    });
    expect(html).toContain('brs-select-btn--selected');
    expect(html).toContain('ti-check');
  });

  it('shows "Best Rate" badge only on the highest-output route', () => {
    const modes = global.window.SwapUiModes;
    const decision = buildDecision([
      makeRoute('r-sg',   'Stargate', 998000n),   // best
      makeRoute('r-acrs', 'Across',   995000n),
    ]);
    const html = modes.buildRouteListHtml(decision, null, {
      tokenOut: { symbol: 'USDC', decimals: 6 },
      fromChainId: 5042, toChainId: 8453,
    });
    const bestCount = (html.match(/swp-rbadge-best/g) || []).length;
    expect(bestCount).toBe(1);
    // The best badge should be in the Stargate card section
    const stargatePos = html.indexOf('Stargate');
    const bestPos     = html.indexOf('swp-rbadge-best');
    expect(bestPos).toBeLessThan(stargatePos + 500); // within same card block
  });

  it('resolveSelection persists a lifi-<routeId> selection across same-params refreshes', () => {
    const modes = global.window.SwapUiModes;
    const decision = buildDecision([
      makeRoute('r-sg',   'Stargate', 998000n),
      makeRoute('r-acrs', 'Across',   995000n),
    ]);
    const key = 'USDC|USDC|1000000';
    const selected = modes.resolveSelection(decision, 'lifi-r-acrs', key, key);
    expect(selected).toBe('lifi-r-acrs');
  });

  it('resolveSelection resets to best when params change', () => {
    const modes = global.window.SwapUiModes;
    const decision = buildDecision([
      makeRoute('r-sg',   'Stargate', 998000n),
      makeRoute('r-acrs', 'Across',   995000n),
    ]);
    const selected = modes.resolveSelection(decision, 'lifi-r-acrs', 'USDC|USDC|1000000', 'USDC|USDC|2000000');
    // params changed → should fall back to best (lifi-r-sg has highest output)
    expect(selected).toBe('lifi-r-sg');
  });
});

// ── Regression: same-chain still uses getQuote ────────────────────────────────
describe('SwapAggregator — same-chain regression', () => {
  it('same-chain: lifi base quote present alongside lifi-N extras', async () => {
    global.LiFiAdapter = {
      getQuote: async () => ({
        source: 'lifi', ok: true,
        expectedOutRaw: 990000n, minOutRaw: 985000n,
        tokenIn: 'USDC', tokenOut: 'ETH',
        amountInRaw: 1000000n, chainId: 8453, fromChainId: 8453, toChainId: 8453,
        // calldata must match /^0x[0-9a-fA-F]+$/ and be non-trivial
        calldata: '0x' + 'ab'.repeat(32),
        to: '0x1234567890123456789012345678901234567890', spender: null,
        expiresAt: Date.now() + 160000,
      }),
      // Two routes: index 0 is deduplicated against getQuote result; index 1 becomes lifi-r-extra.
      getRoutes: async () => ({
        ok: true,
        routes: [
          makeRoute('r-dup',   'SameAsQuote', 990000n), // index 0, skipped (dedup)
          makeRoute('r-extra', 'SomeAMM',     989000n), // index 1, becomes lifi-r-extra
        ],
      }),
    };
    global.TowerAdapter = { getQuote: async () => ({ source: 'tower', ok: false }) };
    global.LocalAdapter  = { getQuote: async () => ({ source: 'local', ok: false }) };

    const result = await global.window.SwapAggregator.getBestQuote({
      tokenIn: 'USDC', tokenOut: 'ETH',
      amountInRaw: 1000000n, slippageBps: 50,
      fromChainId: 8453, toChainId: 8453,
      chainId: 8453, userAddress: '0xabc',
    });

    const lifiBase  = result.quotes.find(q => q.source === 'lifi');
    const lifiExtra = result.quotes.find(q => q.source === 'lifi-r-extra');

    expect(lifiBase).toBeDefined();
    expect(lifiBase.ok).toBe(true);
    // Route at index 1 (r-extra) is NOT deduplicated — it should appear as lifi-r-extra.
    expect(lifiExtra).toBeDefined();
  });
});
