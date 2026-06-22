/**
 * Elligente Relayer Shared Config — Server-side source of truth
 * Used by Cloudflare Pages Functions (relayer.js, mint.js, payment-links.js)
 * Values MUST match config/system.js (browser-side source of truth)
 */
export const RELAYER_CONFIG = {
  TREASURY_VAULT:  '0xbfC9E8F79bd30b912081ae88F9ad0A515F08c2F1',
  MESSAGE_TRANSMITTER: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
  MEMO_CONTRACT:   '0x5294E9927c3306DcBaDb03fe70b92e01cCede505',
  ARC_CHAIN_ID:    5042002,
  ARC_RPC_URL:     'https://rpc.testnet.arc.network',
  ALLOWED_ORIGINS: 'https://elligente.pages.dev',
  PAYLINK_FEE_BPS: 200,
  INVOICE_FEE_BPS: 200,
  SEND_ASSETS_FEE_BPS: 20,
  MULTISEND_FEE_BPS: 20,

  ASSETS: {
    usdc:   '0x3600000000000000000000000000000000000000',
    eurc:   '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
    cirbtc: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF',
  },

  // SECURITY: custodial signer (/api/auth/sign) may only target official
  // Elligentt contracts. Recipients live inside ERC-20 calldata, so normal
  // payments still work; raw value transfers to arbitrary addresses are blocked.
  // Addresses mirror public/config/system.js + contracts.js (lowercased).
  SIGN_ALLOWLIST: [
    '0x3600000000000000000000000000000000000000', // USDC
    '0x89b50855aa3be2f677cd6303cec089b5f319d72a', // EURC
    '0xf0c4a4ce82a5746abaad9425360ab04fbba432bf', // CIRBTC
    '0xbfc9e8f79bd30b912081ae88f9ad0a515f08c2f1', // TreasuryVault
    '0x18076d992005186aeb13ac5270cad6e27db95247', // Pool
    '0x17cfb1aacbc64d0f0c247ed261b66c3d56e3eb16', // CrosschainBatch
    '0xca11bde05977b3631167028862be2a173976ca11', // Multicall3
    '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa', // CCTP TokenMessenger
    '0xe737e5cebeeba77efe34d4aa090756590b1ce275', // CCTP MessageTransmitter
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
