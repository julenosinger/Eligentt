/**
 * Elligente Fee Configuration
 * SINGLE SOURCE OF TRUTH for all fee parameters.
 */
const ElligenteFees = Object.freeze({
  PLATFORM_FEE_BPS:   100,
  TURBO_FEE_BPS:      100,
  SETTLE_FEE_BPS:      5,
  STANDARD_BRIDGE_FEE_RATE: 0.0005,
  XC_STANDARD_FEE_RATE: 0.001,
  SINGLE_SEND_FEE:     0.005,

  BTC_USD_PRICE:       67000,
  EURC_USD_RATE:       1.08,

  REBAL_MIN:           10000,
  REBAL_TARGET:        50000,
  REBAL_EMERGENCY:      5000,

  PROVIDER_CACHE_TTL:      300000,
  CHAIN_SWITCH_POLL_INTERVAL: 300,
  CHAIN_SWITCH_TIMEOUT:      30000,
});

if (typeof window !== 'undefined') window.ElligenteFees = ElligenteFees;
