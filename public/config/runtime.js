/**
 * Elligente Runtime Configuration
 * ═══════════════════════════════════════════════════════════
 * CENTRAL SOURCE OF TRUTH for all configurable values.
 * Values MUST match TREASURY_BASELINE.md exactly.
 * DO NOT modify values here without updating the baseline.
 *
 * Sources (priority order):
 *   1. Cloudflare Function env vars (injected at runtime)
 *   2. This file (hardcoded defaults for Arc Testnet)
 */

const RT = Object.freeze({
  // ── Chain: Arc Testnet ──────────────────────────────────
  ARC_CHAIN_ID:       5042002,
  ARC_CHAIN_HEX:      '0x4cef52',
  ARC_RPC_URL:        'https://rpc.testnet.arc.network',
  ARC_EXPLORER_URL:   'https://testnet.arcscan.app',
  ARC_NATIVE_NAME:    'USDC',
  ARC_NATIVE_SYMBOL:  'USDC',
  ARC_NATIVE_DECIMALS: 18,

  // ── Token Addresses (Arc Testnet) ────────────────────────
  USDC_ADDRESS:       '0x3600000000000000000000000000000000000000',
  EURC_ADDRESS:       '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
  CIRBTC_ADDRESS:     '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF',
  USDC_DECIMALS:      6,
  EURC_DECIMALS:      6,
  CIRBTC_DECIMALS:    8,

  // ── Contract Addresses ──────────────────────────────────
  OWNER_WALLET:               '0xc2be29e58f05ba8279bd800b8b6a3790233f2426',
  TREASURY_OWNER_ADDRESS:     '0xA43ABD9Dc38840376d3C469bFBf5951912936c9f',
  TREASURY_VAULT_ADDRESS:     '0xbfC9E8F79bd30b912081ae88F9ad0A515F08c2F1',
  POOL_CONTRACT_ADDRESS:      '0x18076d992005186AeB13AC5270CaD6E27DB95247',
  SWAP_ROUTER_ADDRESS:        '0x0000000000000000000000000000000000000001',
  MULTICALL3_ADDRESS:         '0xcA11bde05977b3631167028862bE2a173976CA11',

  // ── CCTP Configuration ──────────────────────────────────
  CCTP_TOKEN_MESSENGER:       '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
  CCTP_MESSAGE_TRANSMITTER:   '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
  CCTP_ARC_DOMAIN:            26,
  CCTP_ATTEST_URL:            'https://iris-api-sandbox.circle.com/attestations/',
  CCTP_IRIS_V2_URL:           'https://iris-api-sandbox.circle.com/v2/messages/',

  // ── Fee Configuration (basis points) ────────────────────
  PLATFORM_FEE_BPS:   100,    // 1.00% Multisend platform fee → OWNER_WALLET
  TURBO_FEE_BPS:      100,    // 1.00% Turbo Bridge liquidity fee → Treasury
  SETTLE_FEE_BPS:      5,     // 0.05% Settlement rebate → Treasury

  // ── Price References ────────────────────────────────────
  BTC_USD_PRICE:       67000,
  EURC_USD_RATE:       1.08,

  // ── Treasury Whitelists ─────────────────────────────────
  TREASURY_DEPOSIT_WHITELIST: [
    '0xA43ABD9Dc38840376d3C469bFBf5951912936c9f',
    '0x01dE545e8Fea5EcAAb78eC2C09E6D98117f7687d',
    '0xBBE4Bf2D53A4A752c0eF21573FA0162BddafCD12'
  ],

  // ── Turbo Bridge Operators ──────────────────────────────
  TURBO_OPERATORS: [
    '0xA43ABD9Dc38840376d3C469bFBf5951912936c9f',
    '0x01dE545e8Fea5EcAAb78eC2C09E6D98117f7687d',
    '0xBBE4Bf2D53A4A752c0eF21573FA0162BddafCD12'
  ],

  // ── Rebalancing Defaults ────────────────────────────────
  REBAL_MIN:          10000,
  REBAL_TARGET:        50000,
  REBAL_EMERGENCY:      5000,

  // ── Polling & Timeouts (ms) ─────────────────────────────
  PROVIDER_CACHE_TTL:     300000,   // 5 minutes
  SETTLEMENT_POLL_MAX:        180,   // ~18 min
  SETTLEMENT_POLL_INTERVAL:  6000,
  OPERATOR_POLL_MAX:          300,  // ~30 min
  OPERATOR_POLL_INTERVAL:    6000,
  BRIDGE_POLL_INTERVAL:      5000,  // 5s
  CHAIN_SWITCH_POLL_INTERVAL: 300,  // 300ms
  CHAIN_SWITCH_TIMEOUT:      30000, // 30s

  // ── External URLs ───────────────────────────────────────
  CIRCLE_FAUCET_URL:  'https://faucet.circle.com',
  CIRCLE_CONSOLE_URL: 'https://console.circle.com',
  CIRCLE_WEBSITE_URL: 'https://circle.com',
  CLOUDFLARE_ETH_RPC: 'https://cloudflare-eth.com',

  // ── App Info ────────────────────────────────────────────
  APP_NAME:           'Elligente',
  APP_URL:            'https://elligente.pages.dev',
  VAULT_VERSION:      'vault_v2_real',
  VAULT_STORE_KEY:    'elligente_vault_v2',
});
