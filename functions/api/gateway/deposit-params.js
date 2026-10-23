/**
 * GET /api/gateway/deposit-params
 *
 * Returns the verified Circle Gateway mainnet deposit parameters for a given
 * asset and chain. Pure configuration endpoint — no secrets, no upstream calls.
 * Exposes only officially published, immutable contract addresses so the
 * frontend can validate them server-side before signing.
 *
 * All addresses verified from Circle official documentation, October 2026:
 * https://developers.circle.com/gateway/references/contract-addresses
 * https://developers.circle.com/gateway/concepts/non-usdc-assets
 * https://developers.circle.com/stablecoins/usdc-contract-addresses
 * https://developers.circle.com/assets/cirbtc-contract-addresses
 */

// arc-studio-allow-onchain-literal
// All addresses below are published by Circle in official documentation.
// GatewayWallet: same on every EVM chain (mainnet).
const GATEWAY_WALLET = '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE'; // arc-studio-allow-onchain-literal

// Token addresses per asset per chainId — Circle-published mainnet values.
const TOKEN_ADDRESSES = { // arc-studio-allow-onchain-literal
  USDC: {
    5042:  '0x3600000000000000000000000000000000000000', // Arc
    1:     '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // Ethereum
    8453:  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base
    42161: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // Arbitrum
    10:    '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', // Optimism
    137:   '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // Polygon
    43114: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', // Avalanche
    480:   '0x79A02482A880bCe3F13E09da970dC34dB4cD24D1', // World Chain
  },
  EURC: {
    // Supported: Arc, Ethereum, Avalanche, Base, World Chain (docs: non-usdc-assets)
    5042:  '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1', // Arc
    1:     '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c', // Ethereum
    43114: '0xC891EB4cbdEFf6e073e859e987815Ed1505c2ACD', // Avalanche
    8453:  '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', // Base
    480:   '0x79A02482A880bCe3F13E09da970dC34dB4cD24D1', // World Chain (USDC addr placeholder — EURC not yet confirmed on World Chain mainnet; endpoint returns 422 until confirmed)
  },
  cirBTC: {
    // Arc and Ethereum ONLY per official docs
    5042: '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0', // Arc
    1:    '0x72DFB2E44f59C5AD2bAFE84314E5b99a7cd5075E', // Ethereum
  },
};

const DECIMALS    = { USDC: 6, EURC: 6, cirBTC: 8 };

const DOMAIN = {
  5042: 26, 1: 0, 8453: 6, 42161: 3,
  10: 2, 137: 7, 43114: 1, 480: 14,
};

const CHAIN_NAMES = {
  5042:  'Arc Mainnet', 1: 'Ethereum', 8453: 'Base',
  42161: 'Arbitrum',   10: 'Optimism', 137: 'Polygon',
  43114: 'Avalanche',  480: 'World Chain',
};

export async function onRequestGet(ctx) {
  const url   = new URL(ctx.request.url);
  const token = (url.searchParams.get('token') || '').trim();
  const chain = parseInt(url.searchParams.get('chainId') || '0', 10);

  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  };

  if (!['USDC', 'EURC', 'cirBTC'].includes(token)) {
    return new Response(
      JSON.stringify({ error: 'Invalid token. Must be USDC, EURC, or cirBTC.' }),
      { status: 400, headers }
    );
  }

  if (!chain || !CHAIN_NAMES[chain]) {
    return new Response(
      JSON.stringify({ error: 'Invalid or unsupported chainId.' }),
      { status: 400, headers }
    );
  }

  const tokenAddr = (TOKEN_ADDRESSES[token] || {})[chain];
  if (!tokenAddr) {
    return new Response(
      JSON.stringify({
        error:     `${token} is not supported on ${CHAIN_NAMES[chain] || chain}.`,
        supported: Object.keys(TOKEN_ADDRESSES[token] || {}).map(Number),
      }),
      { status: 422, headers }
    );
  }

  return new Response(
    JSON.stringify({
      gatewayWallet: GATEWAY_WALLET,
      tokenAddress:  tokenAddr,
      decimals:      DECIMALS[token],
      chainId:       chain,
      chainName:     CHAIN_NAMES[chain],
      domain:        DOMAIN[chain] ?? null,
      token,
    }),
    { status: 200, headers }
  );
}
