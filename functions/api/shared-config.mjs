/**
 * Elligente Relayer Shared Config
 * Used by Cloudflare Pages Functions (relayer.js, mint.js)
 * Must match browser-side config files exactly.
 */
export const RELAYER_CONFIG = {
  TREASURY_VAULT:  '0xbfC9E8F79bd30b912081ae88F9ad0A515F08c2F1',
  MESSAGE_TRANSMITTER: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
  ARC_CHAIN_ID:    5042002,
  ARC_RPC_URL:     'https://rpc.testnet.arc.network',
  ALLOWED_ORIGINS: 'https://elligente.pages.dev',

  ASSETS: {
    usdc:   '0x3600000000000000000000000000000000000000',
    eurc:   '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
    cirbtc: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF',
  },

  VAULT_ABI: [
    'function fulfillAndPayWithFee(address asset, uint256 grossAmount, uint256 feeAmount, bytes32 intentId, address recipient)',
    'function intentState(bytes32) view returns (uint8)',
    'function isOperator(address) view returns (bool)',
  ],

  MT_ABI: [
    'function receiveMessage(bytes message, bytes attestation) returns (bool)',
    'function usedNonces(bytes32) view returns (uint256)',
  ],
};
