/**
 * swap-quote-speed.test.js
 * ═══════════════════════════════════════════════════════════════════════
 * Proves progressive quote rendering: the first VALID route is surfaced via
 * `onProgress` as soon as the fastest provider settles — without waiting for
 * the slow providers (LI.FI /advanced/routes) to finish.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const aggSrc = fs.readFileSync(path.join(root, 'shared', 'SwapAggregator.js'), 'utf8');

const ADDR = '0x2de8906a641d65d490bc60a4179d961d59742bcb';

function evalModule(src, win) { new Function('window', src).call(null, win); }

function loadAgg() {
  const w = { TowerAdapter: undefined, LocalAdapter: undefined, LiFiAdapter: undefined };
  evalModule(aggSrc, w);
  return w.SwapAggregator;
}

function towerQuote(over) {
  return Object.assign({
    source: 'tower', ok: true, tokenIn: 'USDC', tokenOut: 'EURC', chainId: 5042,
    fromChainId: 5042, toChainId: 5042,
    amountInRaw: 1000000n, expectedOutRaw: 1010000n, minOutRaw: 1004950n,
    priceImpactBps: null, feeBps: null, route: null,
    calldata: '0xabcd', to: ADDR, spender: ADDR, value: '0',
    expiresAt: Date.now() + 60000, executionType: 'tower',
  }, over || {});
}

describe('SwapAggregator — progressive rendering (first route fast)', () => {
  it('surfaces the first valid route via onProgress before slow providers settle', async () => {
    const agg = loadAgg();

    // Fast Tower (resolves immediately with a valid executable quote).
    globalThis.TowerAdapter = { getQuote: async () => towerQuote() };
    // Local rejected immediately.
    globalThis.LocalAdapter = { getQuote: async () => ({ source: 'local', ok: false }) };
    // Slow LI.FI: getRoutes hangs (never resolves) — forced to timeout below.
    globalThis.LiFiAdapter = {
      getQuote: async () => ({ source: 'lifi', ok: false }),
      getRoutes: () => new Promise(() => {}),
    };

    const progress = [];
    const r = await agg.getBestQuote({
      tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 1000000n, slippageBps: 50,
      chainId: 5042, fromChainId: 5042, toChainId: 5042,
      hasLocalPool: false, timeoutMs: 150,
      onProgress: function (partial) {
        progress.push(partial);
      },
    });

    // onProgress fired before the slow LI.FI sources timed out.
    expect(progress.length).toBeGreaterThan(0);
    // The first progress already contains an executable Tower route.
    expect(progress[0].bestExecutable).toBeTruthy();
    expect(progress[0].bestExecutable.source).toBe('tower');
    // The final result agrees (Tower is the executable route).
    expect(r.bestExecutable.source).toBe('tower');
  });

  it('a hanging provider never blocks the other providers (isolated failure)', async () => {
    const agg = loadAgg();
    globalThis.TowerAdapter = { getQuote: async () => towerQuote() };
    globalThis.LocalAdapter = { getQuote: async () => ({ source: 'local', ok: false }) };
    globalThis.LiFiAdapter = {
      getQuote: () => new Promise(() => {}),
      getRoutes: () => new Promise(() => {}),
    };
    const r = await agg.getBestQuote({
      tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 1000000n, slippageBps: 50,
      chainId: 5042, fromChainId: 5042, toChainId: 5042,
      hasLocalPool: false, timeoutMs: 120,
    });
    expect(r.bestExecutable).toBeTruthy();
    expect(r.bestExecutable.source).toBe('tower');
  });

  it('cross-chain uses getRoutes and expands every route into its own card', async () => {
    const agg = loadAgg();
    globalThis.TowerAdapter = { getQuote: async () => ({ source: 'tower', ok: false }) };
    globalThis.LocalAdapter = { getQuote: async () => ({ source: 'local', ok: false }) };
    globalThis.LiFiAdapter = {
      getQuote: async () => ({ source: 'lifi', ok: false, error: 'USE_GETROUTES' }),
      getRoutes: async () => ({
        ok: true,
        routes: [
          { routeId: 'sg', label: 'Stargate', stepsData: [{ id: 's1', action: {} }], toAmountRaw: 1010000n, toAmountMinRaw: 1004950n, steps: 1, executionDuration: 30 },
          { routeId: 'acrs', label: 'Across', stepsData: [{ id: 's2', action: {} }], toAmountRaw: 1009000n, toAmountMinRaw: 1003955n, steps: 1, executionDuration: 20 },
        ],
      }),
    };
    const r = await agg.getBestQuote({
      tokenIn: 'USDC', tokenOut: 'USDC', amountInRaw: 1000000n, slippageBps: 50,
      fromChainId: 8453, toChainId: 5042,
      hasLocalPool: false,
    });
    const lifiQuotes = r.quotes.filter((q) => q.source && q.source.indexOf('lifi-') === 0);
    expect(lifiQuotes.length).toBe(2);
    expect(lifiQuotes.every((q) => q._needsStepTx === true)).toBe(true);
  });
});
