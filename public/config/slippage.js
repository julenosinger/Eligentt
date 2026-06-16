/**
 * Elligente Slippage Configuration (FUTURE USE)
 * ═══════════════════════════════════════════════════════
 * INTERNAL ONLY — not enforced in bridge operations yet.
 * Prepared for future mainnet activation:
 *   - set SLIPPAGE_ENABLED = true to activate
 *   - adjust SLIPPAGE_BPS default as needed
 *
 * When active, bridge operations will:
 *   1. Simulate quote before burn
 *   2. Compare received amount against minAmountOut
 *   3. Revert if slippage exceeds threshold
 */
const SlippageConfig = Object.freeze({
  ENABLED: false,
  DEFAULT_BPS: 50,
  MAX_BPS: 300,
  DEADLINE_SECONDS: 1200,
});

const SlippageHook = (() => {
  function computeMinAmountOut(amount, bps) {
    if (!SlippageConfig.ENABLED) return 0n;
    const rate = BigInt(bps || SlippageConfig.DEFAULT_BPS);
    const amtBig = typeof amount === 'bigint' ? amount : BigInt(Math.floor(amount * 1e6));
    return amtBig - (amtBig * rate) / 10000n;
  }

  function checkDeadline(startTime) {
    if (!SlippageConfig.ENABLED) return true;
    return (Date.now() - startTime) < (SlippageConfig.DEADLINE_SECONDS * 1000);
  }

  function validate(amount, minOut, actual) {
    if (!SlippageConfig.ENABLED) return true;
    if (minOut === 0n) return true;
    return actual >= minOut;
  }

  return { computeMinAmountOut, checkDeadline, validate };
})();

if (typeof window !== 'undefined') {
  window.SlippageConfig = SlippageConfig;
  window.SlippageHook = SlippageHook;
}
