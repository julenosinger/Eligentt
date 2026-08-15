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

// Verified deployed pools (Phase 3 on-chain verification). Only these are indexable.
const DEPLOYED_POOLS = {
  '0x18076d992005186aeb13ac5270cad6e27db95247': { id: 'usdc-eurc', hasSwapEvents: false },
  '0x14590fb7dcbd5cebabff63b915ef23d008db98f4': { id: 'usdc-cirbtc', hasSwapEvents: true },
};

const EVENTS = [
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
  'event Mint(address indexed sender, uint256 amount0, uint256 amount1)',
  'event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)',
];

function corsHeaders(env) {
  const allowed = (env.ALLOWED_ORIGINS || 'https://elligente.pages.dev').split(',').map((s) => s.trim());
  return { 'Access-Control-Allow-Origin': allowed[0] || '*' };
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders({}) },
  });
}

function getIndexer(env, poolAddress) {
  if (!env.POOL_INDEX_KV) return { error: 'POOL_INDEX_KV binding not configured' };
  const provider = new ethers.JsonRpcProvider(ARC_RPC_URL);
  const iface = new ethers.Interface(EVENTS);
  return {
    idx: PoolIndexer.createIndexer({
      chainId: CHAIN_ID,
      poolAddress,
      provider,
      decode: PoolIndexer.createDecoder(iface),
      store: PoolIndexer.createKVStore(env.POOL_INDEX_KV, 'pool-index'),
      confirmationDepth: 10,
      chunkSize: 2000,
    }),
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
    return json({
      ok: true,
      pool: DEPLOYED_POOLS[pool].id,
      cursor: setup.idx.getCursor(),
      events: setup.idx.getEvents().length,
      status: setup.idx.getStatus(),
    });
  } catch (e) {
    return json({ ok: false, reason: 'INDEX_UNAVAILABLE', detail: (e && e.message) || 'error' }, 503);
  }
}

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  const pool = (url.searchParams.get('pool') || '').toLowerCase();
  if (!DEPLOYED_POOLS[pool]) return json({ ok: false, reason: 'UNKNOWN_POOL' }, 400);
  if (!DEPLOYED_POOLS[pool].hasSwapEvents) return json({ ok: false, reason: 'NO_SWAP_EVENTS', detail: 'Contract does not emit Swap/Mint/Burn events' }, 422);

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
