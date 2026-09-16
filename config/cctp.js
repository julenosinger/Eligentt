/**
 * Elligente CCTP Configuration
 * SINGLE SOURCE OF TRUTH for all CCTP-related parameters.
 * Iris endpoints are environment-aware: Mainnet chains use iris-api.circle.com,
 * Testnet chains use the sandbox endpoint.
 */
const ElligenteCCTP = Object.freeze({
  ARC_DOMAIN:            26,

  ATTEST_URL:            'https://iris-api-sandbox.circle.com/attestations/',
  IRIS_V2_URL:           'https://iris-api-sandbox.circle.com/v2/messages/',

  CIRCLE_FAUCET_URL:     'https://faucet.circle.com',
  CIRCLE_CONSOLE_URL:    'https://console.circle.com',

  FINALITY_FAST:         1000,
  FINALITY_STANDARD:     2000,
  MAX_FEE_USDC:          '0.5',

  SETTLEMENT_POLL_MAX:        180,
  SETTLEMENT_POLL_INTERVAL:   6000,
  OPERATOR_POLL_MAX:          300,
  OPERATOR_POLL_INTERVAL:     6000,
  BRIDGE_POLL_INTERVAL:       5000,

  ATTEST_POLL_MAX:      120,
  ATTEST_POLL_INTERVAL: 5000,
  ATTEST_FALLBACK_MAX:   60,

  // Environment-aware Iris base URL (production for Mainnet, sandbox for Testnet).
  _irisBase: function(chainId) {
    var id = Number(chainId);
    var mainnet = (id === 5042 || id === 1 || id === 8453 || id === 42161);
    return mainnet ? 'https://iris-api.circle.com' : 'https://iris-api-sandbox.circle.com';
  },
  getAttestUrl: function(chainId) { return this._irisBase(chainId) + '/attestations/'; },
  getIrisV2Url: function(chainId) { return this._irisBase(chainId) + '/v2/messages/'; },

  CCTP_CONFIG: {
    5042:   { domain:26, usdc:'0x3600000000000000000000000000000000000000', eurc:'0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1', tokenMessenger:'0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d', messageTransmitter:'0x81D40F21F12A8F0E3252Bccb954D722d4c464B64', tokenMinter:'0xfd78EE919681417d192449715b2594ab58f5D002', rpc:'https://rpc.mainnet.arc.io', explorer:'https://explorer.arc.io' },
    5042002: { domain:26, usdc:'0x3600000000000000000000000000000000000000', eurc:'0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a', tokenMessenger:'0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA', messageTransmitter:'0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275', rpc:'https://rpc.testnet.arc.io', explorer:'https://testnet.arcscan.app' },
    11155111: { domain:0,  usdc:'0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', eurc:null, tokenMessenger:'0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA', messageTransmitter:'0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275', rpc:'https://ethereum-sepolia-rpc.publicnode.com', explorer:'https://sepolia.etherscan.io' },
    84532:    { domain:6,  usdc:'0x036CbD53842c5426634e7929541eC2318f3dCF7e', eurc:null, tokenMessenger:'0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA', messageTransmitter:'0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275', rpc:'https://sepolia.base.org', explorer:'https://sepolia.basescan.org' },
    421614:   { domain:3,  usdc:'0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', eurc:null, tokenMessenger:'0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA', messageTransmitter:'0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275', rpc:'https://sepolia-rollup.arbitrum.io/rpc', explorer:'https://sepolia.arbiscan.io' },
    11155420: { domain:2,  usdc:'0x5fd84259d66Cd46123540766Be93DFE6D43130D7', eurc:null, tokenMessenger:'0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA', messageTransmitter:'0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275', rpc:'https://sepolia.optimism.io', explorer:'https://sepolia-optimism.etherscan.io' },
    80002:    { domain:7,  usdc:'0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582', eurc:null, tokenMessenger:'0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA', messageTransmitter:'0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275', rpc:'https://rpc-amoy.polygon.technology', explorer:'https://amoy.polygonscan.com' }
  }
});

if (typeof window !== 'undefined') window.ElligenteCCTP = ElligenteCCTP;
