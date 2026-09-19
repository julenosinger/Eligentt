/**
 * POOL ENGINE — canonical liquidity pool math + registry (Phase 2).
 * ═══════════════════════════════════════════════════════════════════════════
 * Verifies the PoolEngine module (shared/poolEngine.js): real reserves math,
 * correct spot price with decimals, utilization vs price impact separation,
 * reserve imbalance, TVL, LP share/position value, impermanent loss, add/remove
 * liquidity validation, error states, and the canonical (verified) registry.
 * No network calls.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const swapMathSrc = fs.readFileSync(path.join(root, 'shared', 'swapMath.js'), 'utf8');
const poolEngineSrc = fs.readFileSync(path.join(root, 'shared', 'poolEngine.js'), 'utf8');

function loadEngine() {
  const win = {};
  new Function('window', swapMathSrc)(win);
  new Function('window', poolEngineSrc)(win);
  return win.PoolEngine;
}

const PE = loadEngine();
const SM = (() => { const w = {}; new Function('window', swapMathSrc)(w); return w.SwapMath; })();

/* ════════════════════════════════════════════════════════════
   Registry — canonical, verified on-chain
   ════════════════════════════════════════════════════════════ */
describe('PoolEngine — canonical registry', () => {
  it('REGISTRY exists and is exposed as window.PoolEngine', () => {
    expect(PE).toBeTruthy();
    expect(Array.isArray(PE.REGISTRY)).toBe(true);
    expect(PE.REGISTRY.length).toBe(4);
  });

  it('only VERIFIED pools are deployed (2 deployed, 2 not)', () => {
    const deployed = PE.getDeployedPools();
    expect(deployed.length).toBe(2);
    expect(deployed.map(p => p.id).sort()).toEqual(['usdc-cirbtc', 'usdc-eurc']);
    const undeployed = PE.REGISTRY.filter(p => !p.deployed).map(p => p.id);
    expect(undeployed).toContain('eurc-cirbtc');
    expect(undeployed).toContain('eth-usdc');
  });

  it('verified token addresses are correct', () => {
    const usdcEurc = PE.getPool('usdc-eurc');
    expect(usdcEurc.tokenAAddress.toLowerCase()).toBe('0x3600000000000000000000000000000000000000');
    expect(usdcEurc.tokenBAddress.toLowerCase()).toBe('0x89b50855aa3be2f677cd6303cec089b5f319d72a');
    const usdcBt = PE.getPool('usdc-cirbtc');
    expect(usdcBt.tokenBAddress.toLowerCase()).toBe('0xf0c4a4ce82a5746abaad9425360ab04fbba432bf');
  });

  it('token decimals are correct (USDC=6, EURC=6, cirBTC=8)', () => {
    const p = PE.getPool('usdc-cirbtc');
    expect(p.tokenADecimals).toBe(6);
    expect(p.tokenBDecimals).toBe(8);
    const e = PE.getPool('usdc-eurc');
    expect(e.tokenADecimals).toBe(6);
    expect(e.tokenBDecimals).toBe(6);
  });

  it('fee tiers match verified on-chain values', () => {
    expect(PE.getPool('usdc-eurc').feeBps).toBe(10);
    expect(PE.getPool('usdc-cirbtc').feeBps).toBe(30);
  });

  it('getPool returns null for unknown id', () => {
    expect(PE.getPool('nope')).toBeNull();
  });

  it('error codes exist for unavailable metrics (no fake zeros)', () => {
    expect(PE.ERR.POOL_NOT_DEPLOYED).toBe('POOL_NOT_DEPLOYED');
    expect(PE.ERR.ZERO_LIQUIDITY).toBe('ZERO_LIQUIDITY');
    expect(PE.ERR.ANALYTICS_UNAVAILABLE).toBe('ANALYTICS_UNAVAILABLE');
    expect(PE.ERR.STALE_DATA).toBe('STALE_DATA');
  });
});

/* ════════════════════════════════════════════════════════════
   Spot price — decimals-correct
   ════════════════════════════════════════════════════════════ */
describe('PoolEngine — spot price (decimal-correct)', () => {
  it('spot price normalizes decimals (USDC-EURC real reserves)', () => {
    const p = PE.getPool('usdc-eurc');
    const rA = 26508217603n, rB = 23994233219n;
    const spot = PE.spotPrice(rA, rB, p.tokenADecimals, p.tokenBDecimals);
    const expected = 23994.233219 / 26508.217603;
    expect(spot).toBeCloseTo(expected, 6);
  });

  it('spotPriceScaled returns 1e18 fixed-point', () => {
    // equal reserves, equal decimals → 1.0 (1e18 scaled)
    const s = PE.spotPriceScaled(100n, 100n, 0, 0);
    expect(s).toBe(10n ** 18n);
  });

  it('spot price is null for zero reserves (no fake value)', () => {
    expect(PE.spotPrice(0n, 100n, 6, 6)).toBeNull();
    expect(PE.spotPrice(100n, 0n, 6, 6)).toBeNull();
  });
});

/* ════════════════════════════════════════════════════════════
   Amount out — reuses SwapMath (single AMM implementation)
   ════════════════════════════════════════════════════════════ */
describe('PoolEngine — amount out (SwapMath reuse)', () => {
  it('getAmountOut is identical to SwapMath.getAmountOut', () => {
    const cases = [
      [10n, 100n, 200n, 0],
      [1000000n, 10000000n, 10000000n, 30],
      [61500000n, 26508217603n, 23994233219n, 10],
    ];
    for (const [ai, ri, ro, f] of cases) {
      expect(PE.getAmountOut(ai, ri, ro, f)).toBe(SM.getAmountOut(ai, ri, ro, f));
    }
  });

  it('zero liquidity blocks output (returns 0n)', () => {
    expect(PE.getAmountOut(100n, 0n, 1000n, 10)).toBe(0n);
    expect(PE.getAmountOut(100n, 1000n, 0n, 10)).toBe(0n);
  });
});

/* ════════════════════════════════════════════════════════════
   Utilization vs Price impact — SEPARATE metrics
   ════════════════════════════════════════════════════════════ */
describe('PoolEngine — utilization vs price impact (separated)', () => {
  it('utilization = amountIn / reserveIn', () => {
    // 10 / 90 = 11.11% → 1111 bps
    expect(PE.utilizationBps(10n, 90n)).toBe(1111);
  });

  it('price impact (no fee) = amountIn / (reserveIn + amountIn)', () => {
    // 10 / (90 + 10) = 10% → 1000 bps
    expect(PE.priceImpactBps(10n, 90n, 100n, 0)).toBe(1000);
  });

  it('utilization and price impact are DIFFERENT for the same input', () => {
    const util = PE.utilizationBps(10n, 90n);
    const impact = PE.priceImpactBps(10n, 90n, 100n, 0);
    expect(util).not.toBe(impact);
  });

  it('price impact accounts for the fee (spot vs execution)', () => {
    // With a fee, execution price is lower → higher impact than no-fee.
    const noFee = PE.priceImpactBps(1000000n, 10000000n, 10000000n, 0);
    const withFee = PE.priceImpactBps(1000000n, 10000000n, 10000000n, 30);
    expect(withFee).toBeGreaterThan(noFee);
  });

  it('price impact is null for zero reserves', () => {
    expect(PE.priceImpactBps(10n, 0n, 100n, 0)).toBeNull();
  });
});

/* ════════════════════════════════════════════════════════════
   Reserve imbalance
   ════════════════════════════════════════════════════════════ */
describe('PoolEngine — reserve imbalance', () => {
  it('balanced reserves → ~0% imbalance', () => {
    const r = PE.reserveImbalance(1000000n, 1000000n, 6, 6, 1, 1);
    expect(r.imbalancePct).toBeCloseTo(0, 5);
    expect(r.warning).toBeNull();
  });

  it('imbalanced reserves → warning', () => {
    const r = PE.reserveImbalance(1000000n, 100000n, 6, 6, 1, 1);
    expect(r.imbalancePct).toBeGreaterThan(50);
    expect(r.warning).toBeTruthy();
    expect(r.dominantReserve).toBe('A');
  });

  it('null when token prices unavailable (no fake data)', () => {
    expect(PE.reserveImbalance(1000n, 1000n, 6, 6, null, null)).toBeNull();
  });
});

/* ════════════════════════════════════════════════════════════
   TVL — real reserves × verified prices
   ════════════════════════════════════════════════════════════ */
describe('PoolEngine — TVL', () => {
  it('TVL = reserveA·priceA + reserveB·priceB', () => {
    const tvl = PE.tvlUsd(26508217603n, 23994233219n, 6, 6, 1, 1);
    expect(tvl).toBeCloseTo(26508.217603 + 23994.233219, 6);
  });

  it('null when a price is missing (never fabricates TVL)', () => {
    expect(PE.tvlUsd(1000000n, 1000000n, 6, 6, 1, null)).toBeNull();
    expect(PE.tvlUsd(1000000n, 1000000n, 6, 6, null, 1)).toBeNull();
  });
});

/* ════════════════════════════════════════════════════════════
   LP share + position value
   ════════════════════════════════════════════════════════════ */
describe('PoolEngine — LP share & position value', () => {
  it('lpShareBps = balance / supply', () => {
    expect(PE.lpShareBps(25n, 100n)).toBe(2500); // 25%
  });

  it('lpShareBps null when supply is zero', () => {
    expect(PE.lpShareBps(25n, 0n)).toBeNull();
  });

  it('position value = share × TVL', () => {
    const val = PE.positionValueUsd(2500, 26508217603n, 23994233219n, 6, 6, 1, 1);
    const tvl = PE.tvlUsd(26508217603n, 23994233219n, 6, 6, 1, 1);
    expect(val).toBeCloseTo(tvl * 0.25, 6);
  });
});

/* ════════════════════════════════════════════════════════════
   Impermanent loss
   ════════════════════════════════════════════════════════════ */
describe('PoolEngine — impermanent loss', () => {
  it('no IL at price ratio 1', () => {
    expect(PE.impermanentLossBps(1)).toBe(0);
  });

  it('~5.72% IL at 2× price ratio', () => {
    expect(PE.impermanentLossBps(2)).toBe(-572);
  });

  it('null for invalid ratio', () => {
    expect(PE.impermanentLossBps(0)).toBeNull();
    expect(PE.impermanentLossBps(-1)).toBeNull();
  });
});

/* ════════════════════════════════════════════════════════════
   Depth (standardized trade sizes)
   ════════════════════════════════════════════════════════════ */
describe('PoolEngine — depth', () => {
  it('returns execution price + impact + utilization', () => {
    const d = PE.depth(26508217603n, 23994233219n, 6, 6, 1, 10, 1000);
    expect(d).toBeTruthy();
    expect(d.amountOutRaw).toBeGreaterThan(0n);
    expect(d.executionPrice).toBeGreaterThan(0);
    expect(d.priceImpactBps).toBeGreaterThanOrEqual(0);
    expect(d.utilizationBps).toBeGreaterThan(0);
  });

  it('null when price unavailable', () => {
    expect(PE.depth(1000000n, 1000000n, 6, 6, null, 10, 100)).toBeNull();
  });
});

/* ════════════════════════════════════════════════════════════
   Add / remove liquidity validation
   ════════════════════════════════════════════════════════════ */
describe('PoolEngine — add/remove liquidity', () => {
  it('addLiquidityOptimalB matches current ratio', () => {
    const r = PE.addLiquidityOptimalB(100000000n, 100000000n, 100000000n, 6, 6);
    expect(r.amountBRaw).toBe(100000000n);
  });

  it('removeLiquidityAmounts is proportional to share', () => {
    const r = PE.removeLiquidityAmounts(25n, 100n, 1000n, 2000n);
    expect(r.amountARaw).toBe(250n);
    expect(r.amountBRaw).toBe(500n);
    expect(r.shareBps).toBe(2500);
  });

  it('removeLiquidityAmounts null when LP exceeds supply', () => {
    expect(PE.removeLiquidityAmounts(101n, 100n, 1000n, 2000n)).toBeNull();
  });
});
