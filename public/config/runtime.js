/**
 * Elligente Runtime Configuration
 * ═══════════════════════════════════════════════════════════
 * CENTRAL SOURCE OF TRUTH for all configurable values.
 * Values MUST match TREASURY_BASELINE.md exactly.
 * DO NOT modify values here without updating the baseline.
 *
 * Sources (priority order):
 *   1. Cloudflare Function env vars (injected at runtime)
 *   2. This file (hardcoded defaults for Arc Mainnet)
 */

const RT = Object.freeze({
  // ── Chain: Arc Mainnet ──────────────────────────────────
  ARC_CHAIN_ID:       5042,
  ARC_CHAIN_HEX:      '0x13b2',
  ARC_RPC_URL:        'https://rpc.mainnet.arc.io',
  ARC_EXPLORER_URL:   'https://explorer.arc.io',
  ARC_NATIVE_NAME:    'USDC',
  ARC_NATIVE_SYMBOL:  'USDC',
  ARC_NATIVE_DECIMALS: 18,

  // ── Token Addresses (Arc Mainnet) ────────────────────────
  USDC_ADDRESS:       '0x3600000000000000000000000000000000000000',
  EURC_ADDRESS:       '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1',
  CIRBTC_ADDRESS:     '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0',
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
  CCTP_TOKEN_MESSENGER:       '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
  CCTP_MESSAGE_TRANSMITTER:   '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
  CCTP_TOKEN_MINTER:          '0xfd78EE919681417d192449715b2594ab58f5D002',
  CCTP_ARC_DOMAIN:            26,
  CCTP_ATTEST_URL:            'https://iris-api.circle.com/attestations/',
  CCTP_IRIS_V2_URL:           'https://iris-api.circle.com/v2/messages/',

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
    '0xBBE4Bf2D53A4A752c0eF21573FA0162BddafCD12',
    '0xC77F058339Bb0ff06554b2D0Efcb0E2FD4852cb0'
  ],

  // ── Turbo Bridge Operators ──────────────────────────────
  TURBO_OPERATORS: [
    '0xA43ABD9Dc38840376d3C469bFBf5951912936c9f',
    '0x01dE545e8Fea5EcAAb78eC2C09E6D98117f7687d',
    '0xBBE4Bf2D53A4A752c0eF21573FA0162BddafCD12',
    '0xC77F058339Bb0ff06554b2D0Efcb0E2FD4852cb0'
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

  // ── Turbo Relayer ────────────────────────────────────────
  RELAYER_ENDPOINT:    '/api/relayer',   // Cloudflare Function endpoint for operator fulfillment
  RELAYER_ENABLED:     true,             // Set to false to disable backend relayer calls

  // ── App Info ────────────────────────────────────────────
  APP_NAME:           'Elligentt',
  APP_URL:            'https://elligente.pages.dev',
  VAULT_VERSION:      'vault_v2_real',
  VAULT_STORE_KEY:    'elligente_vault_v2',
});
