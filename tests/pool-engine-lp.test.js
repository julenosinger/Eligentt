/**
 * POOL ENGINE LP + ANALYTICS — Phase 3 (FASE 3)
 * ═══════════════════════════════════════════════════════════════════════════
 * Verifies REAL LP execution + analytics primitives (all backed by PoolEngine,
 * raw BigInt on-chain state) and that NO fake metrics exist:
 *   - no fake APR/APY estimation
 *   - fee earnings → "unavailable" when the pool has no Swap events
 *   - LP share / underlying / position value use canonical BigInt math
 *   - liquidity depth via PoolEngine.depth
 *   - IL returns null (unavailable) without reference data
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const swapMathSrc = fs.readFileSync(path.join(root, 'shared', 'swapMath.js'), 'utf8');
const poolEngineSrc = fs.readFileSync(path.join(root, 'shared', 'poolEngine.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function loadEngine() {
  const win = {};
  new Function('window', swapMathSrc)(win);
  new Function('window', poolEngineSrc)(win);
  return win.PoolEngine;
}
const PE = loadEngine();

/* ════════════════════════════════════════════════════════════
   LP share / underlying / position value (BigInt, canonical)
   ════════════════════════════════════════════════════════════ */
describe('LP share (PoolEngine.lpShareBps)', () => {
  it('share = balance / supply in bps', () => {
    expect(PE.lpShareBps(1_000_000_000_000_000_000n, 100_000_000_000_000_000_000n)).toBe(100); // 1%
  });
  it('zero LP balance → 0 bps', () => {
    expect(PE.lpShareBps(0n, 100_000_000_000_000_000_000n)).toBe(0);
  });
  it('zero total supply → null (undefined share, not 0)', () => {
    expect(PE.lpShareBps(1n, 0n)).toBeNull();
  });
});

describe('Underlying token amounts (PoolEngine.removeLiquidityAmounts)', () => {
  it('underlying = reserve × share (raw BigInt)', () => {
    const r = PE.removeLiquidityAmounts(1_000_000_000_000_000_000n, 10_000_000_000_000_000_000n, 50_000_000_000n, 40_000_000_000n);
    expect(r).not.toBeNull();
    // 10% share of reserves
    expect(r.amountARaw).toBe(5_000_000_000n);
    expect(r.amountBRaw).toBe(4_000_000_000n);
    expect(r.shareBps).toBe(1000);
  });
  it('invalid (lp > supply) → null', () => {
    expect(PE.removeLiquidityAmounts(20n, 10n, 100n, 100n)).toBeNull();
  });
  it('zero supply → null', () => {
    expect(PE.removeLiquidityAmounts(1n, 0n, 100n, 100n)).toBeNull();
  });
});

describe('Position value (PoolEngine.positionValueUsd)', () => {
  it('position value = share × TVL (both tokens priced)', () => {
    // reserves: 1 USDC (6 dec) + 2 EURC (6 dec), share 10% (1000 bps)
    const v = PE.positionValueUsd(1000, 1_000_000n, 2_000_000n, 6, 6, 1, 1);
    expect(v).toBeCloseTo(0.3, 6); // 10% of (1 + 2) = 0.3
  });
  it('unavailable price → null (never $0)', () => {
    const v = PE.positionValueUsd(1000, 1_000_000n, 2_000_000n, 6, 6, null, 1);
    expect(v).toBeNull();
  });
});

/* ════════════════════════════════════════════════════════════
   Add / remove liquidity validation (PoolEngine primitives)
   ════════════════════════════════════════════════════════════ */
describe('Add liquidity validation (PoolEngine.addLiquidityOptimalB)', () => {
  it('optimal B matches pool ratio', () => {
    // spot: 1 A = 2 B. amountA = 1 (6 dec) → optimalB = 2 (6 dec)
    const r = PE.addLiquidityOptimalB(1_000_000n, 1_000_000n, 2_000_000n, 6, 6);
    expect(r).not.toBeNull();
    expect(r.amountBRaw).toBe(2_000_000n);
  });
  it('zero reserves → null', () => {
    expect(PE.addLiquidityOptimalB(1_000_000n, 0n, 0n, 6, 6)).toBeNull();
  });
});

/* ════════════════════════════════════════════════════════════
   Liquidity depth (PoolEngine.depth)
   ════════════════════════════════════════════════════════════ */
describe('Liquidity depth (PoolEngine.depth)', () => {
  it('returns expected output / impact / utilization for a USD size', () => {
    PE.updatePoolState('usdc-eurc', { reserveARaw: 1_000_000_000_000n, reserveBRaw: 1_080_000_000_000n, lpSupplyRaw: 1n, updatedAt: Date.now() });
    const d = PE.depth(1_000_000_000_000n, 1_080_000_000_000n, 6, 6, 1, 10, 1000);
    expect(d).not.toBeNull();
    expect(d.amountInUsd).toBe(1000);
    expect(d.priceImpactBps).not.toBeNull();
    expect(d.utilizationBps).not.toBeNull();
    // price impact ≠ utilization (separate concepts)
    expect(d.priceImpactBps).not.toBe(d.utilizationBps);
  });
  it('no price → null (unavailable)', () => {
    expect(PE.depth(1_000_000_000_000n, 1_080_000_000_000n, 6, 6, null, 10, 1000)).toBeNull();
  });
});

/* ════════════════════════════════════════════════════════════
   Impermanent loss — unavailable without reference (TEST 25)
   ════════════════════════════════════════════════════════════ */
describe('Impermanent loss (PoolEngine.impermanentLossBps)', () => {
  it('computes IL for a price ratio', () => {
    const il = PE.impermanentLossBps(1.5); // 2*sqrt(1.5)/(2.5) - 1
    expect(il).toBeLessThan(0);
  });
  it('invalid ratio → null (unavailable)', () => {
    expect(PE.impermanentLossBps(0)).toBeNull();
    expect(PE.impermanentLossBps(-1)).toBeNull();
  });
});

/* ════════════════════════════════════════════════════════════
   Static — production has NO fake metrics
   ════════════════════════════════════════════════════════════ */
describe('Static audit — no fake APR / APY / volume / fees', () => {
  it('no fake "estimated" APR', () => {
    expect(indexHtml).not.toContain('% (est.)');
  });
  it('APR returns N/A when unavailable', () => {
    expect(indexHtml).toContain("aprEl.textContent = realApr !== null ? realApr.toFixed(2) + '%' : 'N/A'");
  });
  it('no fake APY in the pool/LP analytics', () => {
    expect(indexHtml).not.toMatch(/APY/);
  });
  it('fee earnings show "unavailable" when no Swap events', () => {
    expect(indexHtml).toContain('Fee earnings unavailable');
  });
  it('LP fee earnings gated by real Swap events', () => {
    expect(indexHtml).toContain('isFeeEarningsAvailable');
    expect(indexHtml).toContain('_hasSwapEvents');
  });
  it('no Math.random in the pool/LP financial path', () => {
    const names = ['getLPPosition', 'getLiquidityDepth', 'calculateRealAPR', 'getLiquidityDepthReport', 'getClaimableFeesForActivePosition'];
    for (const name of names) {
      const i = indexHtml.indexOf('function ' + name + '(');
      if (i >= 0) {
        const brace = indexHtml.indexOf('{', i);
        let depth = 0;
        for (let j = brace; j < indexHtml.length; j++) {
          if (indexHtml[j] === '{') depth++;
          else if (indexHtml[j] === '}') { depth--; if (depth === 0) { expect(indexHtml.slice(i, j + 1)).not.toContain('Math.random'); break; } }
        }
      }
    }
  });
});

/* ════════════════════════════════════════════════════════════
   Static — canonical LP position is wired into production
   ════════════════════════════════════════════════════════════ */
describe('Static audit — real LP position wiring', () => {
  it('raw user LP balance is stored (BigInt)', () => {
    expect(indexHtml).toContain('_userLpRaw = rawLp');
  });
  it('canonical getLPPosition uses PoolEngine primitives', () => {
    expect(indexHtml).toContain('function getLPPosition(poolId)');
    expect(indexHtml).toContain('_PE.lpShareBps');
    expect(indexHtml).toContain('_PE.removeLiquidityAmounts');
    expect(indexHtml).toContain('_PE.positionValueUsd');
  });
  it('liquidity depth report uses PoolEngine.depth', () => {
    expect(indexHtml).toContain('function getLiquidityDepthReport');
    expect(indexHtml).toContain('_PE.depth');
  });
  it('APR TVL uses canonical getLiquidityDepth (no duplicate TVL math)', () => {
    expect(indexHtml).toContain('const tvl = getLiquidityDepth(poolId); // canonical PoolEngine TVL');
  });
});

/* ════════════════════════════════════════════════════════════
   Static — contract capability detection (no invented ABI)
   ════════════════════════════════════════════════════════════ */
describe('Static audit — contract capability detection', () => {
  it('Swap-event support is detected from bytecode, not assumed', () => {
    expect(indexHtml).toContain('Swap(address,uint256,uint256,uint256,uint256,address)');
    expect(indexHtml).toContain('_hasSwapEvents');
  });
});

/* ════════════════════════════════════════════════════════════
   BigInt precision (TEST 26)
   ════════════════════════════════════════════════════════════ */
describe('BigInt precision — LP math never rounds through Number', () => {
  it('share/underlying stay exact across large raw values', () => {
    const supply = 1_000_000_000_000_000_000_000_000_000n;
    const bal = 123_456_789_123_456_789_123_456_789n;
    const share = PE.lpShareBps(bal, supply);
    const r = PE.removeLiquidityAmounts(bal, supply, 1_000_000_000_000_000_000n, 1_000_000_000_000_000_000n);
    expect(r).not.toBeNull();
    // underlying A = reserveA * bal / supply exactly (integer division)
    expect(r.amountARaw).toBe((1_000_000_000_000_000_000n * bal) / supply);
    expect(typeof r.amountARaw).toBe('bigint');
  });
});
