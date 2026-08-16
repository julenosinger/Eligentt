/**
 * Authoritative Pool Indexer — Cloudflare Pages Function (Phase 5.5).
 * =============================================================================
 * Server-side indexing entry point. Runs the trusted indexer (shared/poolIndexer.js)
 * over Cloudflare KV so historical pool analytics are persistent and authoritative.
 *
 *   GET  /api/pool-index?pool=<address>   → cursor + status + event count
 *   POST /api/pool-index?pool=<address>   → ingest latest blocks (incremental)
 *
 * Requires a KV binding named POOL_INDEX_KV (see wrangler.jsonc / dashboard).
 * If the binding is missing, endpoints return 503 UNAVAILABLE — never fake data.
 *
 * The indexer performs NO pool math and never fabricates events/analytics.
 */
import { ethers } from 'ethers';
import PoolIndexer from '../../../shared/poolIndexer.js';

const CHAIN_ID = 5042002;
const ARC_RPC_URL = 'https://arc-testnet.drpc.org';

// Verified deployed pools (Phase 3 + Phase 6.2). Only these are indexable.
// swapEventType: 'standard' (Swap event) | 'swapped' (Swapped event) | 'none'.
const DEPLOYED_POOLS = {
  '0x18076d992005186aeb13ac5270cad6e27db95247': {
    id: 'usdc-eurc', swapEventType: 'swapped',
    token0Address: '0x3600000000000000000000000000000000000000', token0Symbol: 'USDC',
    token1Address: '0x89b50855aa3be2f677cd6303cec089b5f319d72a', token1Symbol: 'EURC',
  },
  '0x14590fb7dcbd5cebabff63b915ef23d008db98f4': {
    id: 'usdc-cirbtc', swapEventType: 'standard',
    token0Address: '0x3600000000000000000000000000000000000000', token0Symbol: 'USDC',
    token1Address: '0xf0c4a4ce82a5746abaad9425360ab04fbba432bf', token1Symbol: 'cirBTC',
  },
};

const EVENTS = [
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
  'event Swapped(address indexed user, address tokenIn, uint256 amountIn, uint256 amountOut)',
  'event Mint(address indexed sender, uint256 amount0, uint256 amount1)',
  'event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)',
];

function corsHeaders(env) {
  const allowed = (env.ALLOWED_ORIGINS || 'https://elligente.pages.dev').split(',').map((s) => s.trim());
  return { 'Access-Control-Allow-Origin': allowed[0] || '*' };
}

function json(body, status) {
  return new Response(JSON.stringify(body, function (k, v) { return typeof v === 'bigint' ? v.toString() : v; }), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders({}) },
  });
}

function getIndexer(env, poolAddress) {
  if (!env.POOL_INDEX_KV) return { error: 'POOL_INDEX_KV binding not configured' };
  const poolCfg = DEPLOYED_POOLS[poolAddress];
  const provider = new ethers.JsonRpcProvider(ARC_RPC_URL);
  const iface = new ethers.Interface(EVENTS);
  return {
    poolCfg,
    idx: PoolIndexer.createIndexer({
      chainId: CHAIN_ID,
      poolAddress,
      provider,
      decode: PoolIndexer.createDecoder(iface, {
        token0Address: poolCfg.token0Address, token1Address: poolCfg.token1Address,
        token0Symbol: poolCfg.token0Symbol, token1Symbol: poolCfg.token1Symbol,
      }),
      store: PoolIndexer.createKVStore(env.POOL_INDEX_KV, 'pool-index'),
      confirmationDepth: 10,
      chunkSize: 2000,
    }),
  };
}

/** Authoritative analytics derived from the persistent index (server-side only). */
function computeAnalytics(idx) {
  const now = Date.now();
  const v24 = idx.computeVolume(86400, { now });
  const v7 = idx.computeVolume(7 * 86400, { now });
  const v30 = idx.computeVolume(30 * 86400, { now });
  const swaps = idx.getEvents({ eventType: 'Swap' });
  return {
    swapCount: swaps.length,
    volume24h: { amount0InRaw: v24.amount0InRaw, amount1InRaw: v24.amount1InRaw, usdVolume: v24.usdVolume, status: v24.status },
    volume7d:  { amount0InRaw: v7.amount0InRaw, amount1InRaw: v7.amount1InRaw, usdVolume: v7.usdVolume, status: v7.status },
    volume30d: { amount0InRaw: v30.amount0InRaw, amount1InRaw: v30.amount1InRaw, usdVolume: v30.usdVolume, status: v30.status },
  };
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const pool = (url.searchParams.get('pool') || '').toLowerCase();
  if (!DEPLOYED_POOLS[pool]) return json({ ok: false, reason: 'UNKNOWN_POOL' }, 400);

  const setup = getIndexer(env, pool);
  if (setup.error) return json({ ok: false, reason: 'INDEX_UNAVAILABLE', detail: setup.error }, 503);

  try {
    await setup.idx.init();
    const cursor = setup.idx.getCursor();
    return json({
      ok: true,
      pool: DEPLOYED_POOLS[pool].id,
      poolAddress: pool,
      chainId: CHAIN_ID,
      lastIndexedBlock: cursor.lastIndexedBlock,
      status: cursor.status,
      analytics: computeAnalytics(setup.idx),
      events: setup.idx.getEvents().length,
    });
  } catch (e) {
    return json({ ok: false, reason: 'INDEX_UNAVAILABLE', detail: (e && e.message) || 'error' }, 503);
  }
}

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  const pool = (url.searchParams.get('pool') || '').toLowerCase();
  if (!DEPLOYED_POOLS[pool]) return json({ ok: false, reason: 'UNKNOWN_POOL' }, 400);
  if (DEPLOYED_POOLS[pool].swapEventType === 'none') return json({ ok: false, reason: 'NO_SWAP_EVENTS', detail: 'Contract does not emit Swap/Swapped events' }, 422);

  const setup = getIndexer(env, pool);
  if (setup.error) return json({ ok: false, reason: 'INDEX_UNAVAILABLE', detail: setup.error }, 503);

  try {
    await setup.idx.init();
    const summary = await setup.idx.ingestLatest();
    return json({ ok: summary.ok, summary, cursor: setup.idx.getCursor(), events: setup.idx.getEvents().length });
  } catch (e) {
    return json({ ok: false, reason: 'INDEX_ERROR', detail: (e && e.message) || 'error' }, 500);
  }
}
