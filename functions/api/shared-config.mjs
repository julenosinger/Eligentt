/**
 * Elligente Relayer Shared Config — Server-side source of truth
 * Used by Cloudflare Pages Functions (relayer.js, mint.js, payment-links.js)
 * Values MUST match config/system.js (browser-side source of truth)
 */
export const RELAYER_CONFIG = {
  TREASURY_VAULT:  '0xbfC9E8F79bd30b912081ae88F9ad0A515F08c2F1',
  MESSAGE_TRANSMITTER: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
  MEMO_CONTRACT:   '0x5294E9927c3306DcBaDb03fe70b92e01cCede505',
  ARC_CHAIN_ID:    5042,
  ARC_RPC_URL:     'https://rpc.mainnet.arc.io',
  ALLOWED_ORIGINS: 'https://elligente.pages.dev',
  PAYLINK_FEE_BPS: 200,
  INVOICE_FEE_BPS: 200,
  SEND_ASSETS_FEE_BPS: 20,
  MULTISEND_FEE_BPS: 20,

  // ── Bridge fee references (Phase 2 Quote engine — mirror public/config/fees.js).
  // Additive only: no existing consumer reads these; they give the Treasury Core
  // Quote endpoint a single server-side source of truth instead of duplicating
  // financial logic.
  TURBO_FEE_BPS:            100,     // 1.00% Turbo Bridge liquidity fee → Treasury
  SETTLE_FEE_BPS:           5,       // 0.05% settlement rebate → Treasury
  STANDARD_BRIDGE_FEE_RATE: 0.0005,  // 0.05% standard CCTP bridge
  XC_STANDARD_FEE_RATE:     0.001,   // 0.10% cross-chain standard

  // CCTP chain/domain map (mirror of public/config/cctp.js CCTP_CONFIG). Used by
  // the Quote engine to describe routes; NOT used to move funds.
  CCTP_DOMAINS: {
    '5042':  { domain: 26, name: 'Arc_Mainnet',  explorer: 'https://explorer.arc.io' },
    '1':     { domain: 0,  name: 'Ethereum',     explorer: 'https://etherscan.io' },
    '8453':  { domain: 6,  name: 'Base',         explorer: 'https://basescan.org' },
    '42161': { domain: 3,  name: 'Arbitrum',     explorer: 'https://arbiscan.io' },
    '10':    { domain: 2,  name: 'Optimism',     explorer: 'https://optimistic.etherscan.io' },
    '137':   { domain: 7,  name: 'Polygon',      explorer: 'https://polygonscan.com' },
  },

  // ── Multi-Application Core (Phase 1) ─────────────────────────────────
  // The Elligentt infrastructure operates as a shared Liquidity Core that
  // serves multiple consumer applications (ELLIGENT today, EXECDAAT next)
  // over the SAME Vault + Treasury. Liquidity stays centralized; only the
  // accounting/attribution is segregated per Application + Client.
  // These are DEFAULTS ONLY — every field is optional on the wire so that
  // every existing integration keeps working unchanged.
  APPLICATION: {
    MODE:                'CORE',        // Elligentt is the central infrastructure
    DEFAULT_APP:         'ELLIGENT',    // application identifier fallback
    DEFAULT_CLIENT:      'default',     // client identifier fallback
    DEFAULT_VERSION:     '1',           // API/intent version fallback
    DEFAULT_ENVIRONMENT: 'production',  // environment fallback
    KNOWN_APPS:          ['ELLIGENT', 'EXECDAAT', 'FUTURE_APP'],
    MAX_FIELD_LEN:       32,            // memo-safe token length cap
  },

  ASSETS: {
    usdc:   '0x3600000000000000000000000000000000000000',
    eurc:   '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1',
    cirbtc: '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0',
  },

  // SECURITY: custodial signer (/api/auth/sign) may only target official
  // Elligentt contracts. Recipients live inside ERC-20 calldata, so normal
  // payments still work; raw value transfers to arbitrary addresses are blocked.
  // Addresses mirror public/config/system.js + contracts.js (lowercased).
  SIGN_ALLOWLIST: [
    '0x3600000000000000000000000000000000000000', // USDC
    '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1', // EURC
    '0x171a4217b86a807a64eb94757db6849fb4bdbaa0', // CIRBTC
    '0xbfc9e8f79bd30b912081ae88f9ad0a515f08c2f1', // TreasuryVault
    '0x18076d992005186aeb13ac5270cad6e27db95247', // Pool
    '0x17cfb1aacbc64d0f0c247ed261b66c3d56e3eb16', // CrosschainBatch
    '0xca11bde05977b3631167028862be2a173976ca11', // Multicall3
    '0x28b5a0e9c621a5badaa536219b3a228c8168cf5d', // CCTP TokenMessenger
    '0x81d40f21f12a8f0e3252bccb954d722d4c464b64', // CCTP MessageTransmitter
    '0xfd78ee919681417d192449715b2594ab58f5d002', // CCTP TokenMinter
    '0x5294e9927c3306dcbadb03fe70b92e01ccede505', // Memo
    '0x0000000000000000000000000000000000000001', // SwapRouter
  ],

  VAULT_ABI: [
    'function fulfillAndPayWithFee(address asset, uint256 grossAmount, uint256 feeAmount, bytes32 intentId, address recipient)',
    'function intentState(bytes32) view returns (uint8)',
    'function isOperator(address) view returns (bool)',
  ],

  MT_ABI: [
    'function receiveMessage(bytes message, bytes attestation) returns (bool)',
    'function usedNonces(bytes32) view returns (uint256)',
  ],

  MEMO_ABI: [
    'function memo(address target, bytes calldata data, bytes32 memoId, bytes calldata memoData) external',
  ],
};
