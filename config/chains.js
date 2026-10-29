/**
 * Elligente Chain Configuration
 * SINGLE SOURCE OF TRUTH for all chain-related values.
 * Mainnet only.
 */
const ElligenteChains = Object.freeze({
  ARC_CHAIN_ID:         5042,
  ARC_CHAIN_HEX:        '0x13b2',
  ARC_RPC_URL:          'https://rpc.mainnet.arc.io',
  ARC_EXPLORER_URL:     'https://explorer.arc.io',
  ARC_NATIVE_NAME:      'USDC',
  ARC_NATIVE_SYMBOL:    'USDC',
  ARC_NATIVE_DECIMALS:  18,

  CHAIN_REGISTRY: {
    5042:  { id:'Arc_Mainnet', name:'Arc Mainnet', shortName:'Arc',      chainId:5042,  chainHex:'0x13b2',  rpc:'https://rpc.mainnet.arc.io',       explorer:'https://explorer.arc.io',              domain:26, nativeCurrency:{name:'USDC',symbol:'USDC',decimals:18}, tokens:{ USDC:{address:'0x3600000000000000000000000000000000000000',decimals:6}, EURC:{address:'0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1',decimals:6}, cirBTC:{address:'0x171A4217b86A807A64eB94757Db6849fb4bDbAA0',decimals:8} } },
    1:     { id:'Ethereum',    name:'Ethereum',    shortName:'Ethereum', chainId:1,     chainHex:'0x1',     rpc:'https://cloudflare-eth.com',        explorer:'https://etherscan.io',                 domain:0,  nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},  tokens:{ USDC:{address:'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',decimals:6}, cirBTC:{address:'0x72DFB2E44f59C5AD2bAFE84314E5b99a7cd5075E',decimals:8} } },
    8453:  { id:'Base',        name:'Base',        shortName:'Base',     chainId:8453,  chainHex:'0x2105',  rpc:'https://mainnet.base.org',          explorer:'https://basescan.org',                 domain:6,  nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},  tokens:{ USDC:{address:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',decimals:6}, EURC:{address:'0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42',decimals:6} } },
    42161: { id:'Arbitrum',    name:'Arbitrum',    shortName:'Arbitrum', chainId:42161, chainHex:'0xa4b1',  rpc:'https://arb1.arbitrum.io/rpc',      explorer:'https://arbiscan.io',                  domain:3,  nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},  tokens:{ USDC:{address:'0xaf88d065e77c8cC2239327C5EDb3A432268e5831',decimals:6} } },
    10:    { id:'Optimism',    name:'Optimism',    shortName:'Optimism', chainId:10,    chainHex:'0xa',     rpc:'https://mainnet.optimism.io',       explorer:'https://optimistic.etherscan.io',      domain:2,  nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},  tokens:{ USDC:{address:'0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',decimals:6} } },
    137:   { id:'Polygon',     name:'Polygon',     shortName:'Polygon',  chainId:137,   chainHex:'0x89',    rpc:'https://polygon-rpc.com',           explorer:'https://polygonscan.com',              domain:7,  nativeCurrency:{name:'MATIC',symbol:'MATIC',decimals:18}, tokens:{ USDC:{address:'0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',decimals:6} } }
  },

  CHAINS_ORDER: ['Arc_Mainnet','Ethereum','Base','Arbitrum','Optimism','Polygon'],
  RPC_FALLBACK_URL: 'https://cloudflare-eth.com',
  ACTIVE_CHAIN_ID: 5042,
});

if (typeof window !== 'undefined') window.ElligenteChains = ElligenteChains;
