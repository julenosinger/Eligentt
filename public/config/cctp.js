/**
 * Elligente CCTP Configuration
 * SINGLE SOURCE OF TRUTH for all CCTP-related parameters.
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

  CCTP_CONFIG: {
    5042002:  { domain:26, usdc:'0x3600000000000000000000000000000000000000', eurc:'0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a', tokenMessenger:'0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA', messageTransmitter:'0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275', rpc:'https://rpc.testnet.arc.network', explorer:'https://testnet.arcscan.app' },
    11155111: { domain:0,  usdc:'0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', eurc:null, tokenMessenger:'0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA', messageTransmitter:'0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275', rpc:'https://ethereum-sepolia-rpc.publicnode.com', explorer:'https://sepolia.etherscan.io' },
    84532:    { domain:6,  usdc:'0x036CbD53842c5426634e7929541eC2318f3dCF7e', eurc:null, tokenMessenger:'0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA', messageTransmitter:'0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275', rpc:'https://sepolia.base.org', explorer:'https://sepolia.basescan.org' },
    421614:   { domain:3,  usdc:'0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', eurc:null, tokenMessenger:'0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA', messageTransmitter:'0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275', rpc:'https://sepolia-rollup.arbitrum.io/rpc', explorer:'https://sepolia.arbiscan.io' },
    11155420: { domain:2,  usdc:'0x5fd84259d66Cd46123540766Be93DFE6D43130D7', eurc:null, tokenMessenger:'0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA', messageTransmitter:'0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275', rpc:'https://sepolia.optimism.io', explorer:'https://sepolia-optimism.etherscan.io' },
    80002:    { domain:7,  usdc:'0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582', eurc:null, tokenMessenger:'0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA', messageTransmitter:'0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275', rpc:'https://rpc-amoy.polygon.technology', explorer:'https://amoy.polygonscan.com' },
    4663:     { domain:null, usdc:null, eurc:null, tokenMessenger:null, messageTransmitter:null, rpc:'https://rpc.mainnet.chain.robinhood.com', explorer:'https://robinhoodchain.blockscout.com' },
    46630:    { domain:null, usdc:null, eurc:null, tokenMessenger:null, messageTransmitter:null, rpc:'https://rpc.testnet.chain.robinhood.com', explorer:'https://explorer.testnet.chain.robinhood.com' }
  }
});

if (typeof window !== 'undefined') window.ElligenteCCTP = ElligenteCCTP;
