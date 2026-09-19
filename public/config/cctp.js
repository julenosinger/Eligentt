/**
 * Elligente CCTP Configuration
 * SINGLE SOURCE OF TRUTH for all CCTP-related parameters.
 * Mainnet only. Iris production endpoint.
 */
const ElligenteCCTP = Object.freeze({
  ARC_DOMAIN:            26,

  ATTEST_URL:            'https://iris-api.circle.com/attestations/',
  IRIS_V2_URL:           'https://iris-api.circle.com/v2/messages/',

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

  getAttestUrl: function() { return this.ATTEST_URL; },
  getIrisV2Url: function() { return this.IRIS_V2_URL; },

  CCTP_CONFIG: {
    5042:  { domain:26, usdc:'0x3600000000000000000000000000000000000000', eurc:'0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1', tokenMessenger:'0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d', messageTransmitter:'0x81D40F21F12A8F0E3252Bccb954D722d4c464B64', tokenMinter:'0xfd78EE919681417d192449715b2594ab58f5D002', rpc:'https://rpc.mainnet.arc.io', explorer:'https://explorer.arc.io' },
    1:     { domain:0,  usdc:'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', eurc:null, tokenMessenger:'0xBd3fa81B58Ba92a82136038B25aDec7066af3155', messageTransmitter:'0x0a992d191DEeC32aFE36203Ad87D7d289a738F81', rpc:'https://cloudflare-eth.com', explorer:'https://etherscan.io' },
    8453:  { domain:6,  usdc:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', eurc:null, tokenMessenger:'0x1682Ae6375C4E4A97e4B583BC394c861A46D8962', messageTransmitter:'0xAD09780d193884d503182aD4588450C416D6F9D4', rpc:'https://mainnet.base.org', explorer:'https://basescan.org' },
    42161: { domain:3,  usdc:'0xaf88d065e77c8cC2239327C5EDb3A432268e5831', eurc:null, tokenMessenger:'0x19330d10D9Cc8751218eaf51E8885D058642E08A', messageTransmitter:'0xC30362313FBBA5cf9163F0bb16a0e01f01A896ca', rpc:'https://arb1.arbitrum.io/rpc', explorer:'https://arbiscan.io' },
    10:    { domain:2,  usdc:'0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', eurc:null, tokenMessenger:'0x2B4069517957735bE00ceE0fadAE88a26365528f', messageTransmitter:'0x4D41f22c5a0e5c74090899E5a8Fb597a8842b3e8', rpc:'https://mainnet.optimism.io', explorer:'https://optimistic.etherscan.io' },
    137:   { domain:7,  usdc:'0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', eurc:null, tokenMessenger:'0x9daF8c91AEFAE50b9c0E69629D3F6Ca40cA3B3FE', messageTransmitter:'0xF3be9355363857F3e001be68856A2f96b4C39Ba9', rpc:'https://polygon-rpc.com', explorer:'https://polygonscan.com' }
  }
});

if (typeof window !== 'undefined') window.ElligenteCCTP = ElligenteCCTP;
