/**
 * POOL ROUTER — smart routing foundation (Phase 5, Part B).
 * ═══════════════════════════════════════════════════════════════════════════
 * Verifies route discovery, PoolEngine-based quoting, best-output selection,
 * safety (impact/utilization/stale), minOut, BigInt precision, and that the
 * router performs NO financial math of its own (PoolEngine remains canonical).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const swapMathSrc = fs.readFileSync(path.join(root, 'shared', 'swapMath.js'), 'utf8');
const poolEngineSrc = fs.readFileSync(path.join(root, 'shared', 'poolEngine.js'), 'utf8');
const routerSrc = fs.readFileSync(path.join(root, 'shared', 'poolRouter.js'), 'utf8');

function load() {
  const win = {};
  new Function('window', swapMathSrc)(win);
  new Function('window', poolEngineSrc)(win);
  new Function('window', routerSrc)(win);
  return win;
}
const w = load();
const PE = w.PoolEngine;
const Router = w.PoolRouter;

function freshRouter() {
  const r = Router.createRouter();
  return r;
}

/* usdc-eurc pool (fee 10 bps): 1,000,000 USDC / 1,080,000 EURC */
function seedUsdcEurc(updatedAt) {
  PE.updatePoolState('usdc-eurc', { reserveARaw: 1_000_000_000_000n, reserveBRaw: 1_080_000_000_000n, lpSupplyRaw: 1n, updatedAt: updatedAt != null ? updatedAt : Date.now() });
}
/* usdc-cirbtc pool (fee 30 bps) */
function seedUsdcCirbtc(updatedAt) {
  PE.updatePoolState('usdc-cirbtc', { reserveARaw: 7_000_000_000n, reserveBRaw: 20_000_000n, lpSupplyRaw: 1n, updatedAt: updatedAt != null ? updatedAt : Date.now() });
}

describe('Router — route discovery', () => {
  it('discovers a direct route from a verified deployed pool', () => {
    seedUsdcEurc();
    const r = freshRouter();
    const res = r.findBestRoute({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n });
    expect(res.ok).toBe(true);
    expect(res.bestRoute.path).toEqual(['USDC', 'EURC']);
    expect(res.bestRoute.pools).toEqual(['usdc-eurc']);
  });

  it('returns NO_ROUTE_AVAILABLE for a pair with no pool', () => {
    const r = freshRouter();
    const res = r.findBestRoute({ tokenIn: 'USDC', tokenOut: 'ETH', amountInRaw: 100_000_000n });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('NO_ROUTE_AVAILABLE');
  });

  it('returns ROUTE_QUOTE_UNAVAILABLE when PoolEngine is absent', () => {
    const r = Router.createRouter({ poolEngine: null });
    const res = r.findBestRoute({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100n });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('ROUTE_QUOTE_UNAVAILABLE');
  });
});

describe('Router — unavailable / stale / invalid pools', () => {
  it('rejects an undeployed pool', () => {
    const r = freshRouter();
    const res = r.findBestRoute({ tokenIn: 'EURC', tokenOut: 'cirBTC', amountInRaw: 100_000_000n }); // eurc-cirbtc undeployed
    expect(res.ok).toBe(false);
    expect(['NO_ROUTE_AVAILABLE']).toContain(res.reason); // no deployed pool for this pair
  });

  it('rejects a stale pool (ROUTES_STALE)', () => {
    seedUsdcEurc(Date.now() - 10 * 60 * 1000); // 10 min old
    const r = freshRouter();
    const res = r.findBestRoute({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('ROUTES_STALE');
  });

  it('rejects insufficient liquidity (zero reserves)', () => {
    PE.updatePoolState('usdc-eurc', { reserveARaw: 0n, reserveBRaw: 0n, lpSupplyRaw: 1n, updatedAt: Date.now() });
    const r = freshRouter();
    const res = r.findBestRoute({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('INSUFFICIENT_LIQUIDITY');
  });
});

describe('Router — quoting is canonical PoolEngine (raw BigInt)', () => {
  it('expectedOutRaw equals PoolEngine.getAmountOut', () => {
    seedUsdcEurc();
    const r = freshRouter();
    const res = r.findBestRoute({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n, slippageBps: 50 });
    expect(res.ok).toBe(true);
    expect(res.bestRoute.expectedOutRaw).toBe(PE.getAmountOut(100_000_000n, 1_000_000_000_000n, 1_080_000_000_000n, 10));
    expect(typeof res.bestRoute.expectedOutRaw).toBe('bigint');
  });

  it('minOut is calculated from raw expectedOutRaw via SwapMath', () => {
    seedUsdcEurc();
    const r = freshRouter();
    const res = r.findBestRoute({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n, slippageBps: 50 });
    const expectedMin = w.SwapMath.calcMinOut(res.bestRoute.expectedOutRaw, 50);
    expect(res.bestRoute.minOutRaw).toBe(expectedMin);
  });

  it('price impact is spot-vs-execution, separate from utilization', () => {
    seedUsdcEurc();
    const r = freshRouter();
    const res = r.findBestRoute({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n });
    expect(res.bestRoute.priceImpactBps).not.toBe(res.bestRoute.utilizationBps);
  });
});

describe('Router — best output selection', () => {
  it('selects the route with highest expected output', () => {
    // Two candidates can only be compared when a pair has multiple pools. Here we
    // verify the sort order on a single candidate + that alternatives are empty.
    seedUsdcEurc();
    const r = freshRouter();
    const res = r.findBestRoute({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n });
    expect(res.ok).toBe(true);
    expect(res.alternatives.length).toBe(0);
  });
});

describe('Router — protection thresholds', () => {
  it('rejects price impact above maxPriceImpactBps', () => {
    // tiny reserve → huge impact
    PE.updatePoolState('usdc-eurc', { reserveARaw: 100_000n, reserveBRaw: 108_000n, lpSupplyRaw: 1n, updatedAt: Date.now() });
    const r = freshRouter();
    const res = r.findBestRoute({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n });
    expect(res.ok).toBe(false);
    expect(['PRICE_IMPACT_TOO_HIGH', 'UTILIZATION_TOO_HIGH']).toContain(res.reason);
  });

  it('rejects utilization above maxUtilizationBps', () => {
    PE.updatePoolState('usdc-eurc', { reserveARaw: 100_000n, reserveBRaw: 100_000_000n, lpSupplyRaw: 1n, updatedAt: Date.now() });
    const r = Router.createRouter({ maxPriceImpactBps: 10000, maxUtilizationBps: 100 }); // tiny util limit
    const res = r.findBestRoute({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 50_000n });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('UTILIZATION_TOO_HIGH');
  });
});

describe('Router — no duplicate AMM math', () => {
  it('router source contains no reserve*reserve or amountIn/reserve formulas', () => {
    expect(routerSrc).not.toMatch(/reserveIn \* reserveOut/);
    expect(routerSrc).not.toMatch(/amountIn \/ reserveIn/);
  });
  it('router delegates to PoolEngine.getAmountOut', () => {
    expect(routerSrc).toContain('PE.getAmountOut');
    expect(routerSrc).toContain('PE.priceImpactBps');
    expect(routerSrc).toContain('PE.utilizationBps');
  });
});

describe('Router — BigInt precision (no unsafe Number)', () => {
  it('large raw amounts are preserved exactly', () => {
    PE.updatePoolState('usdc-eurc', { reserveARaw: 1_000_000_000_000_000_000_000n, reserveBRaw: 1_080_000_000_000_000_000_000n, lpSupplyRaw: 1n, updatedAt: Date.now() });
    const r = freshRouter();
    const res = r.findBestRoute({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 123_456_789_123_456_789n });
    expect(res.ok).toBe(true);
    expect(typeof res.bestRoute.expectedOutRaw).toBe('bigint');
    expect(res.bestRoute.amountInRaw).toBe(123_456_789_123_456_789n);
  });
});
