/**
 * POOL INDEX — LIVE INDEXER + SWAP HISTORY API (MEMORY MODE) — Phase 6.3.
 * ═══════════════════════════════════════════════════════════════════════════
 * Verifies the memory-mode /api/pool-index handler: auto-ingest cooldown,
 * no duplicate ingestion, includeEvents + pagination, Swapped normalization,
 * INDEX_WARMING fallback, restart recovery (memory reset → re-warm), dedup, and
 * the frontend cutover to authoritative swap history (no queryFilter swap).
 * No network — injected mock provider + real ethers decoding.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  createPoolIndexHandler,
  INGEST_COOLDOWN_MS,
  DEFAULT_EVENT_LIMIT,
  MAX_EVENT_LIMIT,
  DEPLOYED_POOLS,
} from '../functions/api/pool-index/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const idxSrc = fs.readFileSync(path.join(root, 'shared', 'poolIndexer.js'), 'utf8');

function loadIdx() { const w = {}; new Function('window', idxSrc)(w); return w.PoolIndexer; }
const Idx = loadIdx();

const POOL = '0x18076d992005186aeb13ac5270cad6e27db95247'; // usdc-eurc (Swapped)
const USDC = '0x3600000000000000000000000000000000000000';
const EURC = '0x89b50855aa3be2f677cd6303cec089b5f319d72a';
const USER = '0x01dE545e8Fea5EcAAb78eC2C09E6D98117f7687d';

const EVENTS = [
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
  'event Swapped(address indexed user, address tokenIn, uint256 amountIn, uint256 amountOut)',
  'event Mint(address indexed sender, uint256 amount0, uint256 amount1)',
  'event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)',
];
const iface = new ethers.Interface(EVENTS);

function makeLog(eventName, args, blockNumber, txHash, logIndex) {
  const frag = iface.getEvent(eventName);
  const { topics, data } = iface.encodeEventLog(frag, args);
  return { address: POOL, topics, data, blockNumber, blockHash: '0x' + blockNumber.toString(16).padStart(64, '0'), transactionHash: txHash, logIndex, chainId: 5042002 };
}

function swappedLog(blockNumber, txHash, logIndex, amountIn, amountOut) {
  return makeLog('Swapped', [USER, USDC, BigInt(amountIn), BigInt(amountOut)], blockNumber, txHash, logIndex);
}

function makeProvider({ logs = [], latest = 20000, tsMap = {}, failGetBlockNumber = false } = {}) {
  const calls = { getBlockNumber: 0, getLogs: 0 };
  return {
    calls, failGetBlockNumber,
    async getLogs(filter) {
      calls.getLogs++;
      const from = parseInt(filter.fromBlock, 16), to = parseInt(filter.toBlock, 16);
      return logs.filter(l => l.blockNumber >= from && l.blockNumber <= to);
    },
    async getBlockNumber() {
      calls.getBlockNumber++;
      if (failGetBlockNumber) throw new Error('RPC_DOWN');
      return latest;
    },
    async getBlock(n) { return { timestamp: tsMap[n] != null ? tsMap[n] : 1700000000 + n }; },
  };
}

function makeHandler(provider, opts = {}) {
  let t = opts.t0 != null ? opts.t0 : 1700000000000;
  const inject = {
    makeProvider: () => provider,
    makeStore: opts.makeStore || (() => Idx.createMemoryStore()),
    now: () => t,
  };
  if (opts.cooldownMs != null) inject.cooldownMs = opts.cooldownMs;
  const handler = createPoolIndexHandler(inject);
  return { handler, time: () => t, setTime: (v) => { t = v; } };
}

function url(params) {
  return new URL('https://x/api/pool-index?pool=' + POOL + (params ? '&' + params : ''));
}

/* ── 1/2 — auto ingest cooldown + no duplicate ingest ──────────────── */
describe('Auto-ingest (memory mode)', () => {
  it('ingests on first request, skips within cooldown, re-ingests after cooldown', async () => {
    const provider = makeProvider({ logs: [swappedLog(100, '0xtxA', 0, 1000000, 899200)], latest: 20000 });
    const h = makeHandler(provider);

    let res = await h.handler.handleGet(url(), {});
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.status).toBe('COMPLETE');
    expect(provider.calls.getBlockNumber).toBe(1); // first auto-ingest

    // Within cooldown → no re-ingest.
    h.setTime(1700000000000 + 10_000);
    res = await h.handler.handleGet(url(), {});
    body = await res.json();
    expect(provider.calls.getBlockNumber).toBe(1); // unchanged

    // After cooldown → re-ingest (but dedup keeps eventCount stable).
    h.setTime(1700000000000 + INGEST_COOLDOWN_MS + 1);
    res = await h.handler.handleGet(url('includeEvents=true'), {});
    body = await res.json();
    expect(provider.calls.getBlockNumber).toBe(2);
    expect(body.eventCount).toBe(1); // no duplicate events
  });

  it('never produces duplicate events across repeated auto-ingests', async () => {
    const provider = makeProvider({ logs: [swappedLog(100, '0xtxB', 0, 1000000, 899200)], latest: 20000 });
    const h = makeHandler(provider, { cooldownMs: 0 });
    await h.handler.handleGet(url(), {});
    h.setTime(1700000000000 + 1);
    const res = await h.handler.handleGet(url('includeEvents=true'), {});
    const body = await res.json();
    expect(body.eventCount).toBe(1);
    expect(body.events).toHaveLength(1);
  });
});

/* ── 3/4/5 — includeEvents + pagination + Swapped normalization ────── */
describe('Swap history event API', () => {
  it('includeEvents=true returns normalized Swap/Swapped events', async () => {
    const provider = makeProvider({ logs: [swappedLog(100, '0xtx1', 0, 1000000, 899200)], latest: 20000 });
    const { handler } = makeHandler(provider);
    const res = await handler.handleGet(url('includeEvents=true'), {});
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    const ev = body.events[0];
    expect(ev.txHash).toBe('0xtx1');
    expect(ev.blockNumber).toBe('100');
    expect(ev.eventType).toBe('Swap');
    expect(ev.swapEventType).toBe('swapped');
    expect(ev.user.toLowerCase()).toBe(USER.toLowerCase());
    expect(ev.tokenIn).toBe('USDC');
    expect(ev.tokenOut).toBe('EURC');
    expect(ev.amountInRaw).toBe('1000000');
    expect(ev.amountOutRaw).toBe('899200');
    expect(typeof ev.amountInRaw).toBe('string'); // BigInt → exact string
  });

  it('does NOT expose events unless requested', async () => {
    const provider = makeProvider({ logs: [swappedLog(100, '0xtx1', 0, 1000000, 899200)], latest: 20000 });
    const { handler } = makeHandler(provider);
    const res = await handler.handleGet(url(), {});
    const body = await res.json();
    expect(body.events).toBeUndefined();
    expect(body.eventCount).toBe(1);
  });

  it('paginates events (limit/offset, default 20, max 100)', async () => {
    const logs = [];
    for (let b = 100; b <= 104; b++) logs.push(swappedLog(b, '0xtx' + b, 0, 1000000, 899200));
    const provider = makeProvider({ logs, latest: 20000 });
    const { handler } = makeHandler(provider);

    // limit=2, offset=0
    let body = await (await handler.handleGet(url('includeEvents=true&limit=2&offset=0'), {})).json();
    expect(body.events).toHaveLength(2);
    expect(body.pagination).toEqual({ limit: 2, offset: 0, total: 5, returned: 2 });

    // offset=2
    body = await (await handler.handleGet(url('includeEvents=true&limit=2&offset=2'), {})).json();
    expect(body.events).toHaveLength(2);
    expect(body.pagination.offset).toBe(2);

    // limit capped at MAX
    body = await (await handler.handleGet(url('includeEvents=true&limit=9999'), {})).json();
    expect(body.pagination.limit).toBe(MAX_EVENT_LIMIT);

    // default limit when omitted
    body = await (await handler.handleGet(url('includeEvents=true'), {})).json();
    expect(body.pagination.limit).toBe(DEFAULT_EVENT_LIMIT);
  });
});

/* ── 6/8 — INDEX_WARMING fallback (no fake data) ────────────────────── */
describe('INDEX_WARMING fallback', () => {
  it('returns INDEX_WARMING + null analytics when the index cannot rebuild', async () => {
    const provider = makeProvider({ logs: [], failGetBlockNumber: true });
    const { handler } = makeHandler(provider);
    const res = await handler.handleGet(url(), {});
    const body = await res.json();
    expect(body.status).toBe('INDEX_WARMING');
    expect(body.analytics).toBeNull();
    expect(body.eventCount).toBe(0);
    expect(body.ok).toBe(true);
  });

  it('returns INDEX_WARMING when chain head is unavailable (block 0)', async () => {
    const provider = makeProvider({ logs: [], latest: 0 });
    const { handler } = makeHandler(provider);
    const res = await handler.handleGet(url(), {});
    const body = await res.json();
    expect(body.status).toBe('INDEX_WARMING');
    expect(body.analytics).toBeNull();
  });
});

/* ── 9/10 — restart recovery (memory reset) + dedup ─────────────────── */
describe('Restart recovery (memory mode)', () => {
  it('a fresh isolate starts warming, then rebuilds to COMPLETE', async () => {
    const provider = makeProvider({ logs: [swappedLog(100, '0xtxR', 0, 1000000, 899200)], latest: 20000 });

    // Isolate 1 (warm).
    const a = makeHandler(provider);
    let body = await (await a.handler.handleGet(url(), {})).json();
    expect(body.status).toBe('COMPLETE');

    // Isolate 2 — brand-new MemoryStore (simulated restart) → warming until re-warm.
    const b = makeHandler(provider);
    body = await (await b.handler.handleGet(url(), {})).json();
    expect(body.status).toBe('COMPLETE');
    expect(body.eventCount).toBe(1); // re-indexed from scratch, no duplicates within its own store
  });

  it('shared store rehydrates without re-ingesting duplicates (dedup)', async () => {
    const sharedStore = Idx.createMemoryStore();
    const provider = makeProvider({ logs: [swappedLog(100, '0xtxS', 0, 1000000, 899200)], latest: 20000 });

    const a = makeHandler(provider, { makeStore: () => sharedStore });
    await a.handler.handleGet(url(), {});

    // New handler over the SAME store rehydrates (no duplicate re-index).
    const b = makeHandler(provider, { makeStore: () => sharedStore });
    const body = await (await b.handler.handleGet(url('includeEvents=true'), {})).json();
    expect(body.eventCount).toBe(1);
    expect(body.events).toHaveLength(1);
  });
});

/* ── Memory mode: NO KV ──────────────────────────────────────────────── */
describe('Memory mode — no KV', () => {
  it('handler source never references KV bindings or namespaces', () => {
    const src = fs.readFileSync(path.join(root, 'functions', 'api', 'pool-index', 'index.js'), 'utf8');
    expect(src).not.toContain('POOL_INDEX_KV');
    expect(src).not.toContain('createKVStore');
    expect(src).not.toContain('kv_namespaces');
    expect(src).toContain('createMemoryStore');
  });
});

/* ── Frontend cutover — no queryFilter swap history ──────────────────── */
describe('Frontend uses authoritative swap history (no queryFilter)', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

  it('no filters.Swap / filters.Swapped / POOL_SWAPPED_EVENT_ABI in index.html', () => {
    expect(html).not.toContain('filters.Swap(');
    expect(html).not.toContain('filters.Swapped(');
    expect(html).not.toContain('POOL_SWAPPED_EVENT_ABI');
  });

  it('frontend fetches swap history from /api/pool-index (includeEvents=true)', () => {
    expect(html).toContain('includeEvents=true');
    expect(html).toContain('fetchPoolSwapHistory');
    expect(html).toContain('getAuthoritativeSwapHistory');
  });

  it('renders the authoritative swap format (tokenIn → tokenOut)', () => {
    expect(html).toContain('formatRawTokenAmount');
    expect(html).toContain('→');
  });

  it('shows the warming state when analytics are unavailable', () => {
    expect(html).toContain("Analytics warming up");
  });
});
