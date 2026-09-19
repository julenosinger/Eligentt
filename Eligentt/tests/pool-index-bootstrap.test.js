/**
 * LIVE INDEXER BOOTSTRAP & RECENT SWAP RELIABILITY — Phase 6.5.
 * ═══════════════════════════════════════════════════════════════════════════
 * Proves that a MemoryStore cold start indexes a RECENT window (never block 0),
 * that recent Swapped swaps are found, confirmation depth is respected, backfill
 * is bounded and dedup-safe, restart re-bootstraps the recent window, and the API
 * exposes INDEX_WARMING / BACKFILLING / COMPLETE (LIVE) states correctly.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { createPoolIndexHandler } from '../functions/api/pool-index/index.js';

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
const DEC = { token0Address: USDC, token1Address: EURC, token0Symbol: 'USDC', token1Symbol: 'EURC' };

function swappedLog(blockNumber, txHash, logIndex, amountIn, amountOut) {
  const frag = iface.getEvent('Swapped');
  const { topics, data } = iface.encodeEventLog(frag, [USER, USDC, BigInt(amountIn), BigInt(amountOut)]);
  return { address: POOL, topics, data, blockNumber, blockHash: '0x' + blockNumber.toString(16).padStart(64, '0'), transactionHash: txHash, logIndex, chainId: 5042002 };
}

function makeProvider({ logs = [], latest = 20000, tsMap = {}, failGetBlockNumber = false } = {}) {
  const ranges = [];
  return {
    ranges, failGetBlockNumber,
    async getLogs(f) {
      const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
      ranges.push({ from, to });
      return logs.filter(l => l.blockNumber >= from && l.blockNumber <= to);
    },
    async getBlockNumber() { if (failGetBlockNumber) throw new Error('RPC_DOWN'); return latest; },
    async getBlock(n) { return { timestamp: tsMap[n] != null ? tsMap[n] : 1700000000 + n }; },
  };
}

function makeIdx(provider, opts = {}) {
  return Idx.createIndexer({
    chainId: 5042002, poolAddress: POOL, provider,
    decode: Idx.createDecoder(iface, DEC),
    store: Idx.createMemoryStore(),
    confirmationDepth: opts.confirmationDepth != null ? opts.confirmationDepth : 10,
    chunkSize: opts.chunkSize || 2000,
    recentBootstrapBlocks: opts.recentBootstrapBlocks != null ? opts.recentBootstrapBlocks : 20000,
    backfillChunkBlocks: opts.backfillChunkBlocks != null ? opts.backfillChunkBlocks : 2000,
  });
}

/* ── 1/2/13 — cold start begins at the recent window, not block 0 ──── */
describe('Cold-start recent-window bootstrap', () => {
  it('does NOT begin at block 0 (begins at latestConfirmed - RECENT_BOOTSTRAP_BLOCKS)', async () => {
    const provider = makeProvider({ logs: [], latest: 20000 });
    const idx = makeIdx(provider, { recentBootstrapBlocks: 1000, confirmationDepth: 10 });
    await idx.init();
    await idx.ingestLatest();
    expect(provider.ranges.length).toBeGreaterThan(0);
    const firstFrom = provider.ranges[0].from;
    // latestConfirmed = 20000 - 10 = 19990; initialStart = 19990 - 1000 = 18990
    expect(firstFrom).toBe(18990);
    expect(firstFrom).not.toBe(0);
  });

  it('a fresh MemoryStore (restart) re-bootstraps the recent window, not block 0', async () => {
    const provider = makeProvider({ logs: [], latest: 20000 });
    // first "isolate"
    const a = makeIdx(provider, { recentBootstrapBlocks: 1000 });
    await a.init(); await a.ingestLatest();
    // "restart" — brand new indexer + fresh MemoryStore
    const b = makeIdx(provider, { recentBootstrapBlocks: 1000 });
    await b.init(); await b.ingestLatest();
    const last = provider.ranges[provider.ranges.length - 1];
    expect(last.from).toBe(18990);
    expect(last.from).not.toBe(0);
  });

  it('recent window finds a recent swap (within the window)', async () => {
    const provider = makeProvider({ logs: [swappedLog(19500, '0xtxRecent', 0, 1000000, 911053)], latest: 20000 });
    const idx = makeIdx(provider, { recentBootstrapBlocks: 1000 });
    await idx.init();
    await idx.ingestLatest();
    const events = idx.getEvents({ eventType: 'Swap' });
    expect(events.length).toBe(1);
    expect(events[0].transactionHash).toBe('0xtxRecent');
  });
});

/* ── 5/6/7 — confirmation depth ────────────────────────────────────── */
describe('confirmation depth is respected', () => {
  it('an event beyond latestConfirmed does not appear (unconfirmed)', async () => {
    const provider = makeProvider({ logs: [swappedLog(19995, '0xunconfirmed', 0, 1000000, 911053)], latest: 20000 });
    const idx = makeIdx(provider, { recentBootstrapBlocks: 1000, confirmationDepth: 10 });
    await idx.init();
    await idx.ingestLatest(); // boundary = 19990; block 19995 > 19990 → not indexed
    expect(idx.getEvents({ eventType: 'Swap' }).length).toBe(0);
  });

  it('a confirmed event (<= latestConfirmed) appears', async () => {
    const provider = makeProvider({ logs: [swappedLog(19990, '0xconfirmed', 0, 1000000, 911053)], latest: 20000 });
    const idx = makeIdx(provider, { recentBootstrapBlocks: 1000, confirmationDepth: 10 });
    await idx.init();
    await idx.ingestLatest();
    expect(idx.getEvents({ eventType: 'Swap' }).length).toBe(1);
  });
});

/* ── 12 — bootstrap + backfill dedup ───────────────────────────────── */
describe('Backfill is bounded and dedup-safe', () => {
  it('backfills older history in chunks without duplicating', async () => {
    // recent window [18990, 19990]; older swap at block 15000
    const provider = makeProvider({ logs: [swappedLog(15000, '0xtxOld', 0, 1000000, 911053)], latest: 20000 });
    const idx = makeIdx(provider, { recentBootstrapBlocks: 1000, confirmationDepth: 10, backfillChunkBlocks: 2000, chunkSize: 2000 });
    await idx.init();
    await idx.ingestLatest();
    // recent window only — old swap not yet indexed
    expect(idx.getEvents({ eventType: 'Swap' }).length).toBe(0);
    // backfill until complete
    let guard = 0;
    let r;
    do { r = await idx.ingestBackfill(); guard++; } while (!r.complete && guard < 100);
    expect(idx.getEvents({ eventType: 'Swap' }).length).toBe(1);
    // no duplicates on further backfill / ingest
    await idx.ingestBackfill();
    await idx.ingestLatest();
    expect(idx.getEvents({ eventType: 'Swap' }).length).toBe(1);
  });
});

/* ── 8 — real TX: 1 USDC → 0.911053 EURC ───────────────────────────── */
describe('Real USDC/EURC Swapped fixture (0xc82fb542...)', () => {
  const TX = '0xc82fb5421e8e89c37ad3bb58daec68ecf01f0b482a9c2a08111577748b1034dd';
  it('normalizes to eventType Swap / swapEventType swapped with exact raw amounts', () => {
    const decode = Idx.createDecoder(iface, DEC);
    const ev = decode(swappedLog(57336479, TX, 0, 1000000, 911053));
    expect(ev.eventType).toBe('Swap');
    expect(ev.tokenIn).toBe('USDC');
    expect(ev.tokenOut).toBe('EURC');
    expect(ev.amountInRaw).toBe(1000000n); // 1 USDC
    expect(ev.amountOutRaw).toBe(911053n); // 0.911053 EURC
    expect(typeof ev.amountInRaw).toBe('bigint');
    expect(ev.user.toLowerCase()).toBe(USER.toLowerCase());
  });

  it('the indexer finds and reports this swap (1 USDC → 0.911053 EURC)', async () => {
    const provider = makeProvider({ logs: [swappedLog(57336479, TX, 0, 1000000, 911053)], latest: 57336500, tsMap: { 57336479: 1700000000 } });
    const idx = makeIdx(provider, { recentBootstrapBlocks: 1000, confirmationDepth: 10 });
    await idx.init();
    await idx.ingestLatest();
    const events = idx.getEvents({ eventType: 'Swap' });
    expect(events.length).toBe(1);
    const ev = events[0];
    expect(ev.transactionHash).toBe(TX);
    expect(ev.tokenIn).toBe('USDC');
    expect(ev.tokenOut).toBe('EURC');
    expect(ev.amountInRaw).toBe(1000000n);
    expect(ev.amountOutRaw).toBe(911053n);
    expect(ev.timestamp).toBe(1700000000); // from block, not Date.now()
  });
});

/* ── 9/10 — timestamp from block, never Date.now ───────────────────── */
describe('Timestamps come from the block', () => {
  it('event timestamp equals provider.getBlock timestamp', async () => {
    const provider = makeProvider({ logs: [swappedLog(19500, '0xtxTs', 0, 1000000, 911053)], latest: 20000, tsMap: { 19500: 1710000000 } });
    const idx = makeIdx(provider, { recentBootstrapBlocks: 1000 });
    await idx.init();
    await idx.ingestLatest();
    expect(idx.getEvents({ eventType: 'Swap' })[0].timestamp).toBe(1710000000);
  });

  it('resolveTimestamps never falls back to Date.now', () => {
    const start = idxSrc.indexOf('async function resolveTimestamps');
    const end = idxSrc.indexOf('async function processChunk', start);
    const body = idxSrc.slice(start, end);
    expect(body).not.toContain('Date.now');
    expect(body).toContain('provider.getBlock');
  });
});

/* ── 14 — API states: INDEX_WARMING / BACKFILLING / COMPLETE (LIVE) ── */
describe('API exposes index states', () => {
  function makeHandler(provider, opts = {}) {
    let t = 1700000000000;
    const handler = createPoolIndexHandler({
      makeProvider: () => provider,
      makeStore: () => Idx.createMemoryStore(),
      now: () => t,
      recentBootstrapBlocks: opts.recentBootstrapBlocks,
      backfillChunkBlocks: opts.backfillChunkBlocks,
    });
    return handler;
  }
  const url = (params) => new URL('https://x/api/pool-index?pool=' + POOL + (params ? '&' + params : ''));

  it('returns BACKFILLING + indexMode live when recent window indexed but history pending', async () => {
    const provider = makeProvider({ logs: [swappedLog(19500, '0xtx1', 0, 1000000, 911053)], latest: 20000 });
    const handler = makeHandler(provider, { recentBootstrapBlocks: 1000, backfillChunkBlocks: 2000 });
    const body = await (await handler.handleGet(url('includeEvents=true'), {})).json();
    expect(body.status).toBe('BACKFILLING');
    expect(body.indexMode).toBe('live');
    expect(body.backfilling).toBe(true);
    expect(body.coverage.fromBlock).toBe(18990);
    expect(body.coverage.backfillRemaining).toBe(18990);
    expect(body.events).toHaveLength(1);
  });

  it('returns COMPLETE + indexMode complete when the window reaches block 0', async () => {
    const provider = makeProvider({ logs: [swappedLog(100, '0xtx2', 0, 1000000, 911053)], latest: 20000 });
    const handler = makeHandler(provider, { recentBootstrapBlocks: 30000, backfillChunkBlocks: 2000 });
    const body = await (await handler.handleGet(url(), {})).json();
    expect(body.status).toBe('COMPLETE');
    expect(body.indexMode).toBe('complete');
    expect(body.coverage.fromBlock).toBe(0);
    expect(body.coverage.backfillRemaining).toBe(0);
  });

  it('returns INDEX_WARMING when the index cannot rebuild', async () => {
    const provider = makeProvider({ logs: [], failGetBlockNumber: true });
    const handler = makeHandler(provider, { recentBootstrapBlocks: 1000 });
    const body = await (await handler.handleGet(url(), {})).json();
    expect(body.status).toBe('INDEX_WARMING');
    expect(body.analytics).toBeNull();
  });

  it('marks analytics coverage PARTIAL while backfilling (never 0 fabrication)', async () => {
    const provider = makeProvider({ logs: [swappedLog(19500, '0xtx3', 0, 1000000, 911053)], latest: 20000 });
    const handler = makeHandler(provider, { recentBootstrapBlocks: 1000 });
    const body = await (await handler.handleGet(url(), {})).json();
    expect(body.status).toBe('BACKFILLING');
    expect(body.analytics.coverage).toBe('PARTIAL');
    expect(body.analytics.volume30d.status).toBe('PARTIAL');
    expect(body.analytics.volume30d.usdVolume).toBeNull(); // no price → null, never 0
  });
});
