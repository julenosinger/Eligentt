/**
 * Elligentt Swap Math — pure, safe AMM helpers (constant-product with fee).
 * =============================================================================
 * BigInt-based, no floating point for transaction amounts. Used by the swap
 * core for quote/minOut/slippage/price-impact correctness and exposed for
 * unit testing. Attached to window.SwapMath.
 */
(function () {
  'use strict';

  function toBig(v) {
    if (typeof v === 'bigint') return v;
    if (v == null) return 0n;
    var s = String(v).trim();
    if (/^\d+$/.test(s)) return BigInt(s);
    return 0n;
  }

  /**
   * Constant-product output with a fee in basis points (1 = 0.01%).
   *   amountInWithFee = amountIn * (10000 - feeBps) / 10000
   *   amountOut       = reserveOut * amountInWithFee / (reserveIn + amountInWithFee)
   * Returns 0n for zero liquidity or zero/negative input (never throws).
   */
  function getAmountOut(amountInRaw, reserveInRaw, reserveOutRaw, feeBps) {
    var amountIn = toBig(amountInRaw);
    var reserveIn = toBig(reserveInRaw);
    var reserveOut = toBig(reserveOutRaw);
    if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
    var fee = BigInt(Math.floor(Number(feeBps) || 0));
    if (fee < 0n || fee >= 10000n) return 0n;
    var amountInWithFee = (amountIn * (10000n - fee)) / 10000n;
    if (amountInWithFee <= 0n) return 0n;
    return (reserveOut * amountInWithFee) / (reserveIn + amountInWithFee);
  }

  /**
   * Minimum output given an expected output and slippage in basis points.
   *   minOut = expectedOut * (10000 - slippageBps) / 10000
   * Returns 0n when expectedOut <= 0 (caller must treat 0 as invalid).
   */
  function calcMinOut(expectedOutRaw, slippageBps) {
    var expectedOut = toBig(expectedOutRaw);
    if (expectedOut <= 0n) return 0n;
    var slip = BigInt(Math.floor(Number(slippageBps) || 0));
    if (slip < 0n || slip >= 10000n) return 0n;
    return (expectedOut * (10000n - slip)) / 10000n;
  }

  /**
   * Validate a slippage percentage (human-readable, e.g. 0.5 = 0.5%).
   * maxPct is the configured ceiling (default 50%).
   */
  function validateSlippage(slippagePct, maxPct) {
    var n = Number(slippagePct);
    var max = maxPct != null ? Number(maxPct) : 50;
    if (!isFinite(n) || n <= 0) return { ok: false, reason: 'SLIPPAGE_INVALID' };
    if (n > max) return { ok: false, reason: 'SLIPPAGE_TOO_HIGH' };
    return { ok: true, pct: n, bps: Math.round(n * 100) };
  }

  /**
   * Utilization-based price impact in basis points (1 = 0.01%):
   *   impact = amountIn / (reserveIn + amountIn)
   * 10000 bps (100%) when there is no reserve.
   */
  function priceImpactBps(amountInRaw, reserveInRaw) {
    var amountIn = toBig(amountInRaw);
    var reserveIn = toBig(reserveInRaw);
    if (amountIn <= 0n) return 0;
    if (reserveIn <= 0n) return 10000;
    return Number((amountIn * 10000n) / (reserveIn + amountIn));
  }

  /**
   * Safe human-readable → on-chain integer conversion (no float loss).
   *   61.5 with 6 decimals → 61500000n
   * Returns null for malformed input (never throws, never rounds silently).
   */
  function parseUnits(amount, decimals) {
    var d = Math.floor(Number(decimals) || 0);
    if (d < 0) return null;
    var s = String(amount).trim();
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    var parts = s.split('.');
    var intPart = parts[0] || '0';
    var fracPart = (parts[1] || '').padEnd(d, '0').slice(0, d);
    return BigInt(intPart + fracPart);
  }

  /** Safe on-chain integer → human-readable (no precision loss). */
  function formatUnits(raw, decimals) {
    var d = Math.floor(Number(decimals) || 0);
    if (d < 0) return null;
    var s = toBig(raw).toString().padStart(d + 1, '0');
    var intPart = s.slice(0, s.length - d) || '0';
    var fracPart = s.slice(s.length - d).replace(/0+$/, '');
    if (fracPart) return intPart + '.' + fracPart;
    return intPart;
  }

  window.SwapMath = {
    getAmountOut: getAmountOut,
    calcMinOut: calcMinOut,
    validateSlippage: validateSlippage,
    priceImpactBps: priceImpactBps,
    parseUnits: parseUnits,
    formatUnits: formatUnits,
    toBig: toBig
  };
})();
