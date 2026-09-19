/**
 * SWAP CORE — quote / minOut / slippage / decimals / price-impact tests
 * ═══════════════════════════════════════════════════════════════════════════
 * Verifies the pure AMM math (constant-product with fee) used by the swap core
 * (SwapMath module) and cross-checks the production `calcPoolOutput` extracted
 * from index.html produces the SAME result. No network calls.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'public', 'shared', 'swapMath.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function loadSwapMath() {
  const win = {};
  new Function('window', src)(win);
  return win.SwapMath;
}

function extractFunction(source, name) {
  const i = source.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('function not found: ' + name);
  const brace = source.indexOf('{', i);
  let depth = 0;
  for (let j = brace; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}') { depth--; if (depth === 0) return source.slice(i, j + 1); }
  }
  throw new Error('unbalanced: ' + name);
}

const SM = loadSwapMath();

describe('SwapMath — amount out (constant-product with fee)', () => {
  it('TEST 1 — USDC→EURC quote: expectedOut > 0 from real reserves', () => {
    // reserves mirroring the on-chain USDC-EURC pool (6 decimals)
    const reserveIn = SM.parseUnits('26508.21', 6);
    const reserveOut = SM.parseUnits('23994.22', 6);
    const amountIn = SM.parseUnits('100', 6);
    const out = SM.getAmountOut(amountIn, reserveIn, reserveOut, 10); // 0.1% fee
    expect(out).toBeGreaterThan(0n);
    const outHuman = SM.formatUnits(out, 6);
    expect(parseFloat(outHuman)).toBeGreaterThan(0);
  });

  it('constant-product formula is exact (no fee)', () => {
    // reserveIn=100, reserveOut=200, fee=0 → amountOut = 200*10/(100+10) = 18.1818...
    const out = SM.getAmountOut(10n, 100n, 200n, 0);
    expect(out).toBe((200n * 10n) / 110n);
  });

  it('fee reduces output (0.3% fee)', () => {
    const noFee = SM.getAmountOut(1000000n, 10000000n, 10000000n, 0);
    const withFee = SM.getAmountOut(1000000n, 10000000n, 10000000n, 30);
    expect(withFee).toBeLessThan(noFee);
  });

  it('TEST 6 — zero liquidity blocks quote (returns 0)', () => {
    expect(SM.getAmountOut(100n, 0n, 1000n, 10)).toBe(0n);
    expect(SM.getAmountOut(100n, 1000n, 0n, 10)).toBe(0n);
    expect(SM.getAmountOut(0n, 1000n, 1000n, 10)).toBe(0n);
  });
});

describe('SwapMath — minimum output & slippage', () => {
  it('TEST 2/5 — 0.5% slippage on 100 → 99.5', () => {
    const expectedOut = SM.parseUnits('100', 6);
    const min = SM.calcMinOut(expectedOut, 50); // 50 bps = 0.5%
    expect(SM.formatUnits(min, 6)).toBe('99.5');
  });

  it('minOut never exceeds expectedOut and is always positive for valid input', () => {
    const min = SM.calcMinOut(SM.parseUnits('100', 6), 100); // 1%
    expect(min).toBe(99000000n); // 99 USDC
    expect(SM.calcMinOut(0n, 50)).toBe(0n); // invalid input → 0 (must be blocked by caller)
  });

  it('TEST 3 — invalid slippage is rejected', () => {
    expect(SM.validateSlippage(0).ok).toBe(false);
    expect(SM.validateSlippage(-1).ok).toBe(false);
    expect(SM.validateSlippage(NaN).ok).toBe(false);
    expect(SM.validateSlippage(Infinity).ok).toBe(false);
    expect(SM.validateSlippage('abc').ok).toBe(false);
    expect(SM.validateSlippage(80).ok).toBe(false); // above 50% max
    expect(SM.validateSlippage(0.5).ok).toBe(true);
  });
});

describe('SwapMath — token decimals', () => {
  it('TEST 4 — 61.5 USDC (6 decimals) → 61500000', () => {
    expect(SM.parseUnits('61.5', 6)).toBe(61500000n);
  });

  it('round-trips without precision loss', () => {
    expect(SM.formatUnits(61500000n, 6)).toBe('61.5');
    expect(SM.formatUnits(SM.parseUnits('0.000001', 6), 6)).toBe('0.000001');
  });

  it('rejects malformed amounts (never silently rounds)', () => {
    expect(SM.parseUnits('61.5.1', 6)).toBeNull();
    expect(SM.parseUnits('abc', 6)).toBeNull();
    expect(SM.parseUnits('', 6)).toBeNull();
  });
});

describe('SwapMath — price impact', () => {
  it('TEST 15 — utilization-based price impact', () => {
    // amountIn=10, reserveIn=90 → impact = 10/(90+10) = 10%
    expect(SM.priceImpactBps(10n, 90n)).toBe(1000); // 1000 bps = 10%
  });

  it('zero reserve → 100% impact (block)', () => {
    expect(SM.priceImpactBps(10n, 0n)).toBe(10000);
  });
});

describe('production calcPoolOutput matches SwapMath (regression)', () => {
  it('TEST 16 — the deployed AMM formula is identical to the reference (via PoolEngine)', () => {
    // Load PoolEngine (canonical engine) and expose it to the extracted function.
    const peWin = {};
    new Function('window', fs.readFileSync(path.join(root, 'shared', 'swapMath.js'), 'utf8'))(peWin);
    new Function('window', fs.readFileSync(path.join(root, 'shared', 'poolEngine.js'), 'utf8'))(peWin);
    const PE = peWin.PoolEngine;

    const reserveA = SM.parseUnits('26508.21', 6);
    const reserveB = SM.parseUnits('23994.22', 6);
    PE.updatePoolState('usdc-eurc', { reserveARaw: reserveA, reserveBRaw: reserveB, lpSupplyRaw: 1n, updatedAt: Date.now() });

    globalThis._PE = PE;
    globalThis.SwapMath = SM;
    globalThis.poolData = { 'usdc-eurc': { loaded: true, reserveA: 26508.21, reserveB: 23994.22, _reserveARaw: reserveA, _reserveBRaw: reserveB } };
    globalThis.TOKEN_REGISTRY = { USDC: { decimals: 6 }, EURC: { decimals: 6 } };
    try {
      const fnRaw = extractFunction(html, 'calcPoolOutputRaw');
      const fn = extractFunction(html, 'calcPoolOutput');
      const win = {};
      new Function('window', fnRaw + '\n' + fn + '\nwindow.calcPoolOutput = calcPoolOutput;')(win);
      const poolCfg = { id: 'usdc-eurc', tokenA: 'USDC', tokenB: 'EURC', feeTier: null, fee: 10 };

      const productionOut = win.calcPoolOutput(100, poolCfg, 'USDC');

      const refOut = Number(SM.formatUnits(
        SM.getAmountOut(SM.parseUnits('100', 6), reserveA, reserveB, 10),
        6
      ));

      // Canonical path routes through PoolEngine/SwapMath → exact match.
      expect(productionOut).toBe(refOut);
    } finally {
      delete globalThis._PE;
      delete globalThis.SwapMath;
      delete globalThis.poolData;
      delete globalThis.TOKEN_REGISTRY;
    }
  });
});
