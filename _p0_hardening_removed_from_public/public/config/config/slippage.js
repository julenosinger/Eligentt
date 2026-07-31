/**
 * Elligente Slippage Configuration
 * ═══════════════════════════════════════════════════════
 * FASE 1 — Enabled for swap operations.
 *
 * Supported slippage tiers:
 *   0.50% — Low
 *   1.00% — Default
 *   2.00% — High
 */
const SlippageConfig = Object.freeze({
  ENABLED: true,
  DEFAULT_BPS: 100,
  LOW_BPS: 50,
  HIGH_BPS: 200,
  MAX_BPS: 300,
  DEADLINE_SECONDS: 300,
  SWAP_DEFAULT_DEADLINE: 300,
});

const SlippageHook = (() => {
  function computeMinAmountOut(amount, bps) {
    if (!amount || amount <= 0) return 0n;
    var rate = BigInt(bps || SlippageConfig.DEFAULT_BPS);
    var amtBig = typeof amount === 'bigint' ? amount : BigInt(Math.floor(Number(amount) * 1e6));
    var minOut = amtBig - (amtBig * rate) / 10000n;
    return minOut;
  }

  function checkDeadline(startTime) {
    var deadlineMs = (SlippageConfig.DEADLINE_SECONDS || 300) * 1000;
    return (Date.now() - startTime) < deadlineMs;
  }

  function validate(amount, minOut, actual) {
    if (minOut === 0n) return false;
    return actual >= minOut;
  }

  return { computeMinAmountOut, checkDeadline, validate };
})();

if (typeof window !== 'undefined') {
  window.SlippageConfig = SlippageConfig;
  window.SlippageHook = SlippageHook;
}
