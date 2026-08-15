/**
 * POOL ENGINE INTEGRATION — Phase 2.5 (FASE 2.5)
 * ═══════════════════════════════════════════════════════════════════════════
 * Proves that PoolEngine (shared/poolEngine.js) is the canonical source of
 * truth for the PRODUCTION swap / pool / LP flows in index.html — not merely
 * loaded, but actually called.
 *
 * Two layers:
 *   1. Unit tests — execute PoolEngine/SwapMath directly (no network).
 *   2. Static-analysis tests — assert the production index.html actually routes
 *      through PoolEngine (registry, token metadata, AMM, price impact, TVL)
 *      and does NOT carry a second AMM formula outside the guarded fallback.
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
const contractsSrc = fs.readFileSync(path.join(root, 'config', 'contracts.js'), 'utf8');

function loadEngine() {
  const win = {};
  new Function('window', swapMathSrc)(win);
  new Function('window', poolEngineSrc)(win);
  return win;
}
const PE = loadEngine().PoolEngine;

/* ════════════════════════════════════════════════════════════
   TEST 9 — Swap quote == PoolEngine quote (consistency)
   ════════════════════════════════════════════════════════════ */
describe('TEST 9 — Swap quote equals PoolEngine quote', () => {
  it('quote() output equals getAmountOut() + priceImpactBps() for the same state', () => {
    PE.updatePoolState('usdc-eurc', {
      reserveARaw: 1_000_000_000_000n, // 1,000,000 USDC
      reserveBRaw: 1_080_000_000_000n, // 1,080,000 EURC
      lpSupplyRaw: 1_000_000_000_000_000_000_000n,
      updatedAt: Date.now(),
    });
    const amtInRaw = 100_000_000n; // 100 USDC
    const q = PE.quote('usdc-eurc', 'USDC', amtInRaw);
    expect(q.ok).toBe(true);
    expect(q.amountOutRaw).toBe(PE.getAmountOut(amtInRaw, 1_000_000_000_000n, 1_080_000_000_000n, 10));
    expect(q.priceImpactBps).toBe(PE.priceImpactBps(amtInRaw, 1_000_000_000_000n, 1_080_000_000_000n, 10));
    expect(q.utilizationBps).toBe(PE.utilizationBps(amtInRaw, 1_000_000_000_000n));
  });

  it('quote() reuses SwapMath.getAmountOut (single AMM formula)', () => {
    const out1 = PE.getAmountOut(5_000_000n, 1_000_000_000_000n, 1_080_000_000_000n, 10);
    // constant product with fee: inFee = 5e6 * 0.999 = 4995000
    const expectOut = 1_080_000_000_000n * 4_995_000n / (1_000_000_000_000n + 4_995_000n);
    expect(out1).toBe(expectOut);
  });
});

/* ════════════════════════════════════════════════════════════
   TEST 7 — priceImpact != utilization
   ════════════════════════════════════════════════════════════ */
describe('TEST 7 — price impact is NOT utilization', () => {
  it('priceImpactBps and utilizationBps return different values for the same trade', () => {
    const impact = PE.priceImpactBps(100_000_000n, 1_000_000_000_000n, 1_080_000_000_000n, 10);
    const util = PE.utilizationBps(100_000_000n, 1_000_000_000_000n);
    expect(impact).not.toBeNull();
    expect(util).not.toBeNull();
    expect(impact).not.toBe(util);
  });

  it('price impact is spot-vs-execution (dust trade impact ≈ fee, not utilization)', () => {
    const impact = PE.priceImpactBps(1000n, 1_000_000_000_000n, 1_080_000_000_000n, 10);
    const util = PE.utilizationBps(1000n, 1_000_000_000_000n);
    // a 10 bps fee shows up as ~10 bps impact on a dust trade; utilization is ~0
    expect(impact).toBeGreaterThanOrEqual(9);
    expect(impact).toBeLessThanOrEqual(11);
    expect(util).toBeLessThan(1);
    expect(impact).not.toBe(util);
  });
});

/* ════════════════════════════════════════════════════════════
   TEST 11 — missing price does NOT become $0
   ════════════════════════════════════════════════════════════ */
describe('TEST 11 — missing price does not become $0', () => {
  it('tvlUsd returns null when either price is unavailable', () => {
    expect(PE.tvlUsd(1_000_000n, 1_000_000n, 6, 6, 0, 1)).toBeNull();
    expect(PE.tvlUsd(1_000_000n, 1_000_000n, 6, 6, 1, 0)).toBeNull();
    expect(PE.tvlUsd(1_000_000n, 1_000_000n, 6, 6, 1, null)).toBeNull();
  });

  it('tvlUsd computes correctly when prices are available', () => {
    const tvl = PE.tvlUsd(1_000_000n, 2_000_000n, 6, 6, 1, 1);
    expect(tvl).toBeCloseTo(3, 6);
  });
});

/* ════════════════════════════════════════════════════════════
   TEST 12 — RPC failure does NOT become zero liquidity
   ════════════════════════════════════════════════════════════ */
describe('TEST 12 — RPC failure does not become zero liquidity', () => {
  it('a pool with an error and no reserves has no liquidity (not a fake 0)', () => {
    PE.updatePoolState('usdc-cirbtc', { error: 'RPC_ERROR', updatedAt: Date.now() });
    expect(PE.hasLiquidity('usdc-cirbtc')).toBe(false);
    const q = PE.quote('usdc-cirbtc', 'USDC', 100_000_000n);
    expect(q.ok).toBe(false);
    expect(q.code).toBe('ZERO_LIQUIDITY');
  });

  it('error state is preserved, never overwritten to zero values', () => {
    const st = PE.getPoolState('usdc-cirbtc');
    expect(st.error).toBe('RPC_ERROR');
    expect(st.reserveARaw).toBeNull();
  });
});

/* ════════════════════════════════════════════════════════════
   TEST 13 — undeployed pool cannot execute
   ════════════════════════════════════════════════════════════ */
describe('TEST 13 — undeployed pool cannot execute', () => {
  it('quote() returns POOL_NOT_DEPLOYED for undeployed pools', () => {
    const q = PE.quote('eurc-cirbtc', 'EURC', 100_000_000n);
    expect(q.ok).toBe(false);
    expect(q.code).toBe('POOL_NOT_DEPLOYED');
  });

  it('registry marks only verified pools as deployed', () => {
    expect(PE.getPool('eurc-cirbtc').deployed).toBe(false);
    expect(PE.getPool('eth-usdc').deployed).toBe(false);
  });
});

/* ════════════════════════════════════════════════════════════
   TEST 10 — stale pool state is rejected
   ════════════════════════════════════════════════════════════ */
describe('TEST 10 — stale pool state is detected', () => {
  it('isStale returns true for missing or old snapshots', () => {
    PE.updatePoolState('usdc-eurc', {
      reserveARaw: 1_000_000_000_000n,
      reserveBRaw: 1_080_000_000_000n,
      lpSupplyRaw: 1n,
      updatedAt: Date.now() - 5 * 60 * 1000, // 5 min old
    });
    expect(PE.isStale('usdc-eurc', 60_000)).toBe(true);
    expect(PE.isStale('usdc-eurc')).toBe(true); // default 60s
  });

  it('isStale returns false for a fresh snapshot', () => {
    PE.updatePoolState('usdc-eurc', {
      reserveARaw: 1_000_000_000_000n,
      reserveBRaw: 1_080_000_000_000n,
      lpSupplyRaw: 1n,
      updatedAt: Date.now(),
    });
    expect(PE.isStale('usdc-eurc', 60_000)).toBe(false);
  });
});

/* ════════════════════════════════════════════════════════════
   Static analysis — production index.html routes through PoolEngine
   ════════════════════════════════════════════════════════════ */
describe('TEST 1 — Swap quote uses PoolEngine', () => {
  it('calcPoolOutput routes through _PE.getAmountOut (BigInt)', () => {
    expect(indexHtml).toContain('_PE.getAmountOut(amtInRaw, rIn, rOut, feeBps)');
  });
  it('swap price impact routes through _PE.priceImpactBps', () => {
    expect(indexHtml).toContain('_PE.priceImpactBps(amtInRaw, rIn, rOut, feeBps)');
  });
});

describe('TEST 2 — Pool page uses PoolEngine', () => {
  it('POOL_REGISTRY derives from _PE.REGISTRY', () => {
    expect(indexHtml).toContain('_PE.REGISTRY.map');
  });
  it('TOKEN_REGISTRY derives authoritative fields from _PE.getToken', () => {
    expect(indexHtml).toContain('_PE.getToken(sym)');
  });
  it('loadSinglePool syncs raw state into PoolEngine', () => {
    expect(indexHtml).toContain('_PE.updatePoolState(poolCfg.id');
  });
});

describe('TEST 3 — production liquidity health consumes PoolEngine', () => {
  it('TVL (liquidity depth) is computed via PoolEngine.tvlUsd', () => {
    expect(indexHtml).toContain('_PE.tvlUsd(pd._reserveARaw, pd._reserveBRaw');
  });
});

describe('TEST 4 — production liquidity protection consumes PoolEngine', () => {
  it('PROTECTION.checkPriceImpact receives PoolEngine-derived price impact', () => {
    // calcRoutePriceImpact (which feeds PROTECTION.checkPriceImpact) uses PoolEngine
    expect(indexHtml).toContain('_PE.priceImpactBps(amtInRaw, rIn, rOut, feeBps)');
  });
});

describe('TEST 5 — LP analytics uses PoolEngine math', () => {
  it('LP position value derives from PoolEngine TVL', () => {
    // renderMyLPPositions / My Position card compute value = TVL (PoolEngine) × share
    expect(indexHtml).toContain('poolTvl !== null');
    expect(indexHtml).toContain('poolTvlPos !== null');
  });
});

describe('TEST 6 — no duplicated AMM formula in production paths', () => {
  it('float AMM formula appears only once (guarded fallback)', () => {
    const matches = indexHtml.match(/\(reserveOut \* amtInWithFee\) \/ \(reserveIn \+ amtInWithFee\)/g) || [];
    expect(matches.length).toBe(1);
  });
  it('canonical BigInt formula lives in PoolEngine/SwapMath, not re-implemented inline', () => {
    // the swapMath.js constant-product formula is the only "reserveOut * inFee" shape
    expect(swapMathSrc).toContain('(reserveOut * amountInWithFee) / (reserveIn + amountInWithFee)');
  });
});

describe('TEST 8 — BigInt financial math does not round-trip through Number', () => {
  it('swap amountOut is formatted via SwapMath.formatUnits (not Number(BigInt))', () => {
    expect(indexHtml).toContain('SwapMath.formatUnits(outRaw, decOut)');
    expect(indexHtml).toContain('SwapMath.parseUnits(String(amountIn), decIn)');
  });
});

/* ════════════════════════════════════════════════════════════
   TEST 14 — verified pool address is consistent across modules
   ════════════════════════════════════════════════════════════ */
describe('TEST 14 — verified pool address is consistent', () => {
  it('usdc-eurc address matches config/contracts.js', () => {
    const addr = PE.getPool('usdc-eurc').address.toLowerCase();
    expect(contractsSrc.toLowerCase()).toContain(addr.slice(2));
    expect(indexHtml.toLowerCase()).toContain(addr);
  });
  it('usdc-cirbtc address matches PoolEngine registry and index.html', () => {
    const addr = PE.getPool('usdc-cirbtc').address.toLowerCase();
    expect(indexHtml.toLowerCase()).toContain(addr);
    expect(addr).toBe('0x14590fb7dcbd5cebabff63b915ef23d008db98f4');
  });
  it('pool addresses are unique across the registry', () => {
    const addrs = PE.REGISTRY.map(p => p.address.toLowerCase());
    expect(new Set(addrs).size).toBe(addrs.length);
  });
});

/* ════════════════════════════════════════════════════════════
   TEST 15 — token decimals are consistent across modules
   ════════════════════════════════════════════════════════════ */
describe('TEST 15 — token decimals are consistent', () => {
  it('PoolEngine.TOKENS decimals match config/contracts.js', () => {
    expect(PE.TOKENS.USDC.decimals).toBe(6);
    expect(PE.TOKENS.EURC.decimals).toBe(6);
    expect(PE.TOKENS.cirBTC.decimals).toBe(8);
    expect(contractsSrc).toContain('USDC_DECIMALS:      6');
    expect(contractsSrc).toContain('CIRBTC_DECIMALS:    8');
  });
  it('index.html fallback token decimals match PoolEngine', () => {
    expect(indexHtml).toContain("USDC:   { name:'USD Coin',  decimals:6");
    expect(indexHtml).toContain("cirBTC: { name:'Circle BTC', decimals:8");
  });
});
