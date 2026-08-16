/**
 * Authoritative Pool Indexer — Cloudflare Pages Function (Phase 6.3 — MEMORY MODE).
 * =============================================================================
 * Server-side indexing entry point. Runs the trusted indexer (shared/poolIndexer.js)
 * over an IN-MEMORY store (createMemoryStore). No KV, no external database.
 *
 * State is held per-isolate and is intentionally NOT persisted: it is lost on a
 * Worker restart. This is a validation phase — restart re-warms the index and
 * clients receive INDEX_WARMING until the first incremental ingest completes.
 *
 *   GET  /api/pool-index?pool=<address>            → cursor + status + analytics
 *   GET  /api/pool-index?pool=<address>&includeEvents=true[&limit=][&offset=]
 *                                                  → + paginated, normalized events
 *   POST /api/pool-index?pool=<address>            → force ingest latest blocks
 *
 * AUTO-INGEST: every GET performs a lightweight incremental ingest ONLY when the
 * per-pool cooldown has elapsed. No timers, no loops, no background tasks. The
 * indexer's _inflight guard prevents concurrent duplicate ingestion.
 *
 * The indexer performs NO pool math and never fabricates events/analytics.
 */
import { ethers } from 'ethers';
import PoolIndexer from '../../../shared/poolIndexer.js';

const CHAIN_ID = 5042002;
const ARC_RPC_URL = 'https://arc-testnet.drpc.org';

// Auto-ingest cooldown (memory mode). Bounded 30–120s window; 60s chosen.
const INGEST_COOLDOWN_MS = 60_000;

// Event pagination bounds.
const DEFAULT_EVENT_LIMIT = 20;
const MAX_EVENT_LIMIT = 100;

const STATUS_WARMING = 'INDEX_WARMING';

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
  const allowed = ((env && env.ALLOWED_ORIGINS) || 'https://elligente.pages.dev').split(',').map((s) => s.trim());
  return { 'Access-Control-Allow-Origin': allowed[0] || '*' };
}

function json(body, status, env) {
  return new Response(JSON.stringify(body, function (k, v) { return typeof v === 'bigint' ? v.toString() : v; }), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}

/** Authoritative analytics derived from the in-memory index (server-side only). */
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

function strBig(v) {
  if (v == null) return null;
  if (typeof v === 'bigint') return v.toString();
  return String(v);
}

/**
 * Normalize a raw indexed event into the authoritative API shape. Swap and
 * Swapped are BOTH served as a single, consistent representation — the client
 * never sees raw blockchain inconsistencies (e.g. token0/1 argument ordering).
 */
function serializeEvent(ev, poolCfg) {
  const out = {
    txHash: ev.transactionHash,
    blockNumber: strBig(ev.blockNumber),
    timestamp: ev.timestamp,
    eventType: ev.eventType,
    swapEventType: ev.eventType === 'Swap' ? (poolCfg.swapEventType || null) : null,
    user: ev.user || ev.sender || ev.to || null,
  };
  if (ev.eventType === 'Swap') {
    out.tokenIn = ev.tokenIn || null;
    out.tokenOut = ev.tokenOut || null;
    out.amountInRaw = strBig(ev.amountInRaw != null ? ev.amountInRaw : 0n);
    out.amountOutRaw = strBig(ev.amountOutRaw != null ? ev.amountOutRaw : 0n);
  }
  return out;
}

/**
 * Dependency-injectable handler factory. The Pages Function wires real deps
 * (JsonRpcProvider + MemoryStore + real clock); tests inject fakes.
 */
export function createPoolIndexHandler(inject = {}) {
  const pools = inject.pools || DEPLOYED_POOLS;
  const cooldownMs = inject.cooldownMs != null ? inject.cooldownMs : INGEST_COOLDOWN_MS;
  const now = inject.now || (() => Date.now());
  const makeProvider = inject.makeProvider || (() => new ethers.JsonRpcProvider(ARC_RPC_URL));
  const makeStore = inject.makeStore || (() => PoolIndexer.createMemoryStore());
  const makeDecoder = inject.makeDecoder || ((poolCfg, iface) => PoolIndexer.createDecoder(iface, {
    token0Address: poolCfg.token0Address, token1Address: poolCfg.token1Address,
    token0Symbol: poolCfg.token0Symbol, token1Symbol: poolCfg.token1Symbol,
  }));

  // Per-isolate in-memory instances. Lost on restart by design (memory mode).
  const instances = {};

  function getInstance(poolAddress) {
    let inst = instances[poolAddress];
    if (!inst) {
      const poolCfg = pools[poolAddress];
      const iface = new ethers.Interface(EVENTS);
      const idx = PoolIndexer.createIndexer({
        chainId: CHAIN_ID,
        poolAddress,
        provider: makeProvider(poolAddress),
        decode: makeDecoder(poolCfg, iface),
        store: makeStore(poolAddress),
        confirmationDepth: 10,
        chunkSize: 2000,
      });
      inst = { idx, poolCfg, lastAutoIngest: 0 };
      instances[poolAddress] = inst;
    }
    return inst;
  }

  function parsePagination(url) {
    let limit = parseInt(url.searchParams.get('limit'), 10);
    let offset = parseInt(url.searchParams.get('offset'), 10);
    if (!Number.isFinite(limit)) limit = DEFAULT_EVENT_LIMIT;
    limit = Math.max(1, Math.min(MAX_EVENT_LIMIT, limit));
    if (!Number.isFinite(offset)) offset = 0;
    offset = Math.max(0, offset);
    return { limit, offset };
  }

  async function handleGet(url, env) {
    const pool = (url.searchParams.get('pool') || '').toLowerCase();
    if (!pools[pool]) return json({ ok: false, reason: 'UNKNOWN_POOL' }, 400, env);

    const inst = getInstance(pool);
    const idx = inst.idx;
    const includeEvents = url.searchParams.get('includeEvents') === 'true';
    const forceRefresh = url.searchParams.get('refresh') === 'true';
    const { limit, offset } = parsePagination(url);

    try {
      await idx.init();

      // AUTO-INGEST (memory mode): incremental, cooldown-gated, no timers.
      // `refresh=true` requests an immediate ingest (e.g. after a user swap),
      // still server-side, still guarded by _inflight/confirmationDepth/dedup.
      // A failed ingest must NOT fail the read path — analytics are served
      // from whatever the index already holds (possibly INDEX_WARMING).
      const t = now();
      if (forceRefresh || t - inst.lastAutoIngest >= cooldownMs) {
        inst.lastAutoIngest = t;
        try { await idx.ingestLatest(); } catch (e) { /* non-fatal */ }
      }

      const cursor = idx.getCursor();
      const allEvents = idx.getEvents();
      const warmed = cursor.lastIndexedBlock > 0 || allEvents.length > 0;
      const status = warmed
        ? (cursor.status && cursor.status !== 'IDLE' ? cursor.status : 'COMPLETE')
        : STATUS_WARMING;

      const body = {
        ok: true,
        pool: inst.poolCfg.id,
        poolAddress: pool,
        chainId: CHAIN_ID,
        lastIndexedBlock: cursor.lastIndexedBlock,
        status,
        eventCount: allEvents.length,
        analytics: warmed ? computeAnalytics(idx) : null,
      };

      if (includeEvents) {
        const slice = allEvents.slice(offset, offset + limit);
        body.events = slice.map((ev) => serializeEvent(ev, inst.poolCfg));
        body.pagination = { limit, offset, total: allEvents.length, returned: slice.length };
      }

      return json(body, 200, env);
    } catch (e) {
      return json({ ok: false, reason: 'INDEX_ERROR', detail: (e && e.message) || 'error' }, 503, env);
    }
  }

  async function handlePost(url, env) {
    const pool = (url.searchParams.get('pool') || '').toLowerCase();
    if (!pools[pool]) return json({ ok: false, reason: 'UNKNOWN_POOL' }, 400, env);

    const inst = getInstance(pool);
    if (inst.poolCfg.swapEventType === 'none') {
      return json({ ok: false, reason: 'NO_SWAP_EVENTS', detail: 'Contract does not emit Swap/Swapped events' }, 422, env);
    }

    try {
      await inst.idx.init();
      const summary = await inst.idx.ingestLatest();
      return json({ ok: summary.ok, summary, cursor: inst.idx.getCursor(), eventCount: inst.idx.getEvents().length }, 200, env);
    } catch (e) {
      return json({ ok: false, reason: 'INDEX_ERROR', detail: (e && e.message) || 'error' }, 500, env);
    }
  }

  return { handleGet, handlePost, getInstance };
}

const _defaultHandler = createPoolIndexHandler();

export async function onRequestGet({ request, env }) {
  return _defaultHandler.handleGet(new URL(request.url), env);
}

export async function onRequestPost({ request, env }) {
  return _defaultHandler.handlePost(new URL(request.url), env);
}

export { DEPLOYED_POOLS, CHAIN_ID, INGEST_COOLDOWN_MS, DEFAULT_EVENT_LIMIT, MAX_EVENT_LIMIT, STATUS_WARMING, computeAnalytics };
