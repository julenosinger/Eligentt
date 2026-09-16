/**
 * Elligente Chain Configuration
 * SINGLE SOURCE OF TRUTH for all chain-related values.
 * DO NOT duplicate chainIds, RPCs, or network config elsewhere.
 */
const ElligenteChains = Object.freeze({
  ARC_CHAIN_ID:       5042002,
  ARC_MAINNET_CHAIN_ID: 5042,
  ARC_CHAIN_HEX:      '0x4cef52',
  ARC_MAINNET_HEX:    '0x13b2',
  ARC_RPC_URL:        'https://rpc.testnet.arc.io',
  ARC_MAINNET_RPC_URL:'https://rpc.mainnet.arc.io',
  ARC_EXPLORER_URL:   'https://testnet.arcscan.app',
  ARC_MAINNET_EXPLORER_URL: 'https://explorer.arc.io',
  ARC_NATIVE_NAME:    'USDC',
  ARC_NATIVE_SYMBOL:  'USDC',
  ARC_NATIVE_DECIMALS: 18,

  CHAIN_REGISTRY: {
    5042:      { id:'Arc_Mainnet',      name:'Arc Mainnet',      shortName:'Arc',      chainId:5042,      chainHex:'0x13b2',  rpc:'https://rpc.mainnet.arc.io',              explorer:'https://explorer.arc.io',                 domain:26, nativeCurrency:{name:'USDC',symbol:'USDC',decimals:18} },
    1:         { id:'Ethereum',         name:'Ethereum',         shortName:'Ethereum', chainId:1,         chainHex:'0x1',     rpc:'https://cloudflare-eth.com',               explorer:'https://etherscan.io',                    domain:0,  nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18} },
    8453:      { id:'Base',             name:'Base',             shortName:'Base',     chainId:8453,      chainHex:'0x2105',  rpc:'https://mainnet.base.org',                 explorer:'https://basescan.org',                    domain:6,  nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18} },
    42161:     { id:'Arbitrum',         name:'Arbitrum',         shortName:'Arbitrum', chainId:42161,     chainHex:'0xa4b1',  rpc:'https://arb1.arbitrum.io/rpc',             explorer:'https://arbiscan.io',                     domain:3,  nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18} },
    5042002:   { id:'Arc_Testnet',      name:'Arc Testnet',      shortName:'ARC',      chainId:5042002,   chainHex:'0x4cef52', rpc:'https://rpc.testnet.arc.io',               explorer:'https://testnet.arcscan.app',             domain:26, nativeCurrency:{name:'USDC',symbol:'USDC',decimals:18} },
    11155111:  { id:'Ethereum_Sepolia', name:'Ethereum Sepolia', shortName:'Ethereum', chainId:11155111,  chainHex:'0xaa36a7', rpc:'https://ethereum-sepolia-rpc.publicnode.com', explorer:'https://sepolia.etherscan.io',         domain:0,  nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18} },
    84532:     { id:'Base_Sepolia',     name:'Base Sepolia',     shortName:'Base',     chainId:84532,     chainHex:'0x14a34',  rpc:'https://sepolia.base.org',                   explorer:'https://sepolia.basescan.org',           domain:6,  nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18} },
    421614:    { id:'Arbitrum_Sepolia', name:'Arbitrum Sepolia', shortName:'Arbitrum', chainId:421614,    chainHex:'0x66eee',  rpc:'https://sepolia-rollup.arbitrum.io/rpc',      explorer:'https://sepolia.arbiscan.io',            domain:3,  nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18} },
    11155420:  { id:'Optimism_Sepolia', name:'Optimism Sepolia', shortName:'Optimism', chainId:11155420,  chainHex:'0xaa37dc', rpc:'https://sepolia.optimism.io',                 explorer:'https://sepolia-optimism.etherscan.io',  domain:2,  nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18} },
    80002:     { id:'Polygon_Amoy',     name:'Polygon Amoy',     shortName:'Polygon',  chainId:80002,     chainHex:'0x13882',  rpc:'https://rpc-amoy.polygon.technology',         explorer:'https://amoy.polygonscan.com',           domain:7,  nativeCurrency:{name:'MATIC',symbol:'MATIC',decimals:18} }
  },

  CHAINS_ORDER: ['Arc_Mainnet','Ethereum','Base','Arbitrum','Arc_Testnet','Ethereum_Sepolia','Base_Sepolia','Arbitrum_Sepolia','Optimism_Sepolia','Polygon_Amoy'],
  RPC_FALLBACK_URL: 'https://cloudflare-eth.com',
  ACTIVE_CHAIN_ID: 5042002,
});

if (typeof window !== 'undefined') window.ElligenteChains = ElligenteChains;
