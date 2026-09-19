/**
 * POOL INDEXER PERSISTENCE / RESTART — Phase 6.6 (NO KV).
 * ═══════════════════════════════════════════════════════════════════════════
 * Behavioral persistence test: proves a MemoryStore isolate that dies (A) can be
 * replaced by a fresh isolate (B) which re-bootstraps the recent window and
 * recovers the SAME real on-chain swap — with no duplication, block-derived
 * timestamps, and no fabricated analytics. Uses the real Arc Testnet swap
 * 0xc82fb542… (block 57336479, 1 USDC → 0.911053 EURC) as the fixture; its values
 * were validated on-chain (Swapped: amountIn=1000000, amountOut=911053).
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
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function loadIdx() { const w = {}; new Function('window', idxSrc)(w); return w.PoolIndexer; }
const Idx = loadIdx();

const POOL = '0x18076d992005186aeb13ac5270cad6e27db95247'; // usdc-eurc (Swapped)
const USDC = '0x3600000000000000000000000000000000000000';
const EURC = '0x89b50855aa3be2f677cd6303cec089b5f319d72a';
const USER = '0x01dE545e8Fea5EcAAb78eC2C09E6D98117f7687d';

// REAL Arc Testnet fixture (validated on-chain — see Phase 6.5 real test).
const TX = '0xc82fb5421e8e89c37ad3bb58daec68ecf01f0b482a9c2a08111577748b1034dd';
const TX_BLOCK = 57336479;
const TX_AMOUNT_IN = 1000000n;  // 1 USDC
const TX_AMOUNT_OUT = 911053n;  // 0.911053 EURC
const TX_TS = 1786907989;       // real block timestamp

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
const realLog = () => swappedLog(TX_BLOCK, TX, 0, TX_AMOUNT_IN, TX_AMOUNT_OUT);

function makeProvider({ logs = [], latest = 20000, tsMap = {} } = {}) {
  const ranges = [];
  return {
    ranges,
    async getLogs(f) {
      const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
      ranges.push({ from, to });
      return logs.filter(l => l.blockNumber >= from && l.blockNumber <= to);
    },
    async getBlockNumber() { return latest; },
    async getBlock(n) { return { timestamp: tsMap[n] != null ? tsMap[n] : TX_TS }; },
  };
}

function makeIdx(provider, opts = {}) {
  return Idx.createIndexer({
    chainId: 5042002, poolAddress: POOL, provider,
    decode: Idx.createDecoder(iface, DEC),
    store: Idx.createMemoryStore(), // fresh store per call → simulates isolate restart
    confirmationDepth: opts.confirmationDepth != null ? opts.confirmationDepth : 10,
    chunkSize: opts.chunkSize || 2000,
    recentBootstrapBlocks: opts.recentBootstrapBlocks != null ? opts.recentBootstrapBlocks : 20000,
    backfillChunkBlocks: opts.backfillChunkBlocks != null ? opts.backfillChunkBlocks : 2000,
  });
}

/* ── 1/2/3/4/5/6 — INSTANCE A → INSTANCE B restart recovery ───────── */
describe('MemoryStore restart (INSTANCE A → INSTANCE B)', () => {
  it('fresh MemoryStore starts empty (warming)', async () => {
    const idx = makeIdx(makeProvider({ logs: [] }));
    await idx.init();
    expect(idx.getIndexState().mode).toBe('warming');
    expect(idx.getEvents().length).toBe(0);
  });

  it('INSTANCE A indexes the real swap; INSTANCE B (fresh store) recovers the same event', async () => {
    const providerA = makeProvider({ logs: [realLog()], latest: 57336500, tsMap: { [TX_BLOCK]: TX_TS } });
    const idxA = makeIdx(providerA, { recentBootstrapBlocks: 1000 });
    await idxA.init();
    await idxA.ingestLatest();

    const evA = idxA.getEvents({ eventType: 'Swap' });
    expect(evA.length).toBe(1);
    const captured = {
      txHash: evA[0].transactionHash,
      blockNumber: evA[0].blockNumber,
      timestamp: evA[0].timestamp,
      tokenIn: evA[0].tokenIn,
      tokenOut: evA[0].tokenOut,
      amountInRaw: evA[0].amountInRaw,
      amountOutRaw: evA[0].amountOutRaw,
    };
    expect(captured.txHash).toBe(TX);

    // INSTANCE B — brand-new MemoryStore (isolate A's memory was destroyed).
    const providerB = makeProvider({ logs: [realLog()], latest: 57336500, tsMap: { [TX_BLOCK]: TX_TS } });
    const idxB = makeIdx(providerB, { recentBootstrapBlocks: 1000 });
    await idxB.init();
    expect(idxB.getIndexState().mode).toBe('warming'); // nothing yet in fresh store

    // Same real bootstrap flow the API uses (cold-start recent window).
    await idxB.ingestLatest();
    expect(idxB.getIndexState().mode).not.toBe('warming');

    const evB = idxB.getEvents({ eventType: 'Swap' });
    expect(evB.length).toBe(1);
    expect(evB[0].transactionHash).toBe(captured.txHash);
    expect(evB[0].blockNumber).toBe(captured.blockNumber);
    expect(evB[0].timestamp).toBe(captured.timestamp);
    expect(evB[0].tokenIn).toBe(captured.tokenIn);
    expect(evB[0].tokenOut).toBe(captured.tokenOut);
    expect(evB[0].amountInRaw).toBe(captured.amountInRaw);
    expect(evB[0].amountOutRaw).toBe(captured.amountOutRaw);
  });
});

/* ── 7 — dedup across restart + repeated ingest ───────────────────── */
describe('Deduplication across restart', () => {
  it('A(ingest×2) → restart → B(bootstrap+ingest) = 1 event, not 2/3/4', async () => {
    const idxA = makeIdx(makeProvider({ logs: [realLog()], latest: 57336500 }), { recentBootstrapBlocks: 1000 });
    await idxA.init();
    await idxA.ingestLatest();
    await idxA.ingestLatest();
    expect(idxA.getEvents().length).toBe(1);

    const idxB = makeIdx(makeProvider({ logs: [realLog()], latest: 57336500 }), { recentBootstrapBlocks: 1000 });
    await idxB.init();
    await idxB.ingestLatest();
    await idxB.ingestLatest();
    expect(idxB.getEvents().length).toBe(1);
  });

  it('bootstrap + backfill do not duplicate the same event', async () => {
    const idx = makeIdx(makeProvider({ logs: [realLog()], latest: 57336500 }), { recentBootstrapBlocks: 1000, backfillChunkBlocks: 2000 });
    await idx.init();
    await idx.ingestLatest();
    let r, guard = 0;
    do { r = await idx.ingestBackfill(); guard++; } while (!r.complete && guard < 100);
    expect(idx.getEvents({ eventType: 'Swap' }).length).toBe(1);
  });
});

/* ── 8/9 — confirmation depth + incremental ingest ────────────────── */
describe('confirmationDepth + incremental ingest', () => {
  it('unconfirmed block (within confirmationDepth) is not indexed', async () => {
    const idx = makeIdx(makeProvider({ logs: [swappedLog(57336505, '0xunconfirmed', 0, 1000000, 911053)], latest: 57336500 }), { recentBootstrapBlocks: 1000, confirmationDepth: 10 });
    await idx.init();
    await idx.ingestLatest(); // boundary = 57336490; 57336505 > boundary
    expect(idx.getEvents().length).toBe(0);
  });

  it('confirmed block appears; second ingestLatest does not rescan the recent window', async () => {
    const provider = makeProvider({ logs: [realLog()], latest: 57336500 });
    const idx = makeIdx(provider, { recentBootstrapBlocks: 1000 });
    await idx.init();
    await idx.ingestLatest();
    expect(idx.getEvents().length).toBe(1);
    const initialStart = 57336490 - 1000; // 57335490 (cold-start window start)
    expect(provider.ranges.filter(r => r.from === initialStart).length).toBe(1);
    await idx.ingestLatest(); // warm: forward (nothing) + backfill — must NOT rescan recent window
    expect(provider.ranges.filter(r => r.from === initialStart).length).toBe(1);
    expect(idx.getEvents().length).toBe(1);
  });
});

/* ── 10 — no fake timestamp ───────────────────────────────────────── */
describe('Timestamp comes from the block (no Date.now)', () => {
  it('event.timestamp === block.timestamp after restart', async () => {
    const idx = makeIdx(makeProvider({ logs: [realLog()], latest: 57336500, tsMap: { [TX_BLOCK]: TX_TS } }), { recentBootstrapBlocks: 1000 });
    await idx.init();
    await idx.ingestLatest();
    expect(idx.getEvents()[0].timestamp).toBe(TX_TS);
  });

  it('resolveTimestamps uses provider.getBlock, never Date.now', () => {
    const start = idxSrc.indexOf('async function resolveTimestamps');
    const end = idxSrc.indexOf('async function processChunk', start);
    const body = idxSrc.slice(start, end);
    expect(body).not.toContain('Date.now');
    expect(body).toContain('provider.getBlock');
  });
});

/* ── 11 — no fabricated analytics ─────────────────────────────────── */
describe('No fabricated analytics', () => {
  it('usdVolume is null without a price; analytics null while warming', async () => {
    const idx = makeIdx(makeProvider({ logs: [realLog()], latest: 57336500, tsMap: { [TX_BLOCK]: TX_TS } }), { recentBootstrapBlocks: 1000 });
    await idx.init();
    await idx.ingestLatest();
    const v = idx.computeVolume(86400, { now: Date.now(), priceFn: () => null });
    expect(v.usdVolume).toBeNull();
  });

  it('API returns null analytics when INDEX_WARMING (never 0)', async () => {
    const provider = { async getLogs() { return []; }, async getBlockNumber() { throw new Error('RPC_DOWN'); }, async getBlock() { return { timestamp: TX_TS }; } };
    const handler = createPoolIndexHandler({ makeProvider: () => provider, makeStore: () => Idx.createMemoryStore(), now: () => 1700000000000 });
    const body = await (await handler.handleGet(new URL('https://x/api/pool-index?pool=' + POOL), {})).json();
    expect(body.status).toBe('INDEX_WARMING');
    expect(body.analytics).toBeNull();
  });
});

/* ── 12 — API states ──────────────────────────────────────────────── */
describe('API states (INDEX_WARMING / BACKFILLING / COMPLETE)', () => {
  function handlerFor(provider, opts = {}) {
    return createPoolIndexHandler({ makeProvider: () => provider, makeStore: () => Idx.createMemoryStore(), now: () => 1700000000000, recentBootstrapBlocks: opts.recentBootstrapBlocks, backfillChunkBlocks: opts.backfillChunkBlocks });
  }
  it('BACKFILLING when recent window live + history pending', async () => {
    const provider = makeProvider({ logs: [realLog()], latest: 57336500 });
    const body = await (await handlerFor(provider, { recentBootstrapBlocks: 1000 }).handleGet(new URL('https://x/api/pool-index?pool=' + POOL + '&includeEvents=true'), {})).json();
    expect(body.status).toBe('BACKFILLING');
    expect(body.indexMode).toBe('live');
    expect(body.events).toHaveLength(1);
    expect(body.events[0].txHash).toBe(TX);
  });
  it('COMPLETE when window reaches block 0', async () => {
    const provider = makeProvider({ logs: [realLog()], latest: 57336500 });
    const body = await (await handlerFor(provider, { recentBootstrapBlocks: 99999999 }).handleGet(new URL('https://x/api/pool-index?pool=' + POOL), {})).json();
    expect(body.status).toBe('COMPLETE');
    expect(body.indexMode).toBe('complete');
  });
});

/* ── 13 — Swap + Swapped normalization (real TX) ──────────────────── */
describe('Swap + Swapped normalization', () => {
  it('real Swapped → eventType Swap / swapEventType swapped (USDC→EURC)', () => {
    const decode = Idx.createDecoder(iface, DEC);
    const ev = decode(realLog());
    expect(ev.eventType).toBe('Swap');
    expect(ev.tokenIn).toBe('USDC');
    expect(ev.tokenOut).toBe('EURC');
    expect(ev.amountInRaw).toBe(1000000n);
    expect(ev.amountOutRaw).toBe(911053n);
    expect(ev.user.toLowerCase()).toBe(USER.toLowerCase());
  });

  it('standard Swap also normalizes (usdc-cirbtc shape)', () => {
    const decode = Idx.createDecoder(iface, { token0Address: USDC, token1Address: '0xf0c4a4ce82a5746abaad9425360ab04fbba432bf', token0Symbol: 'USDC', token1Symbol: 'cirBTC' });
    const frag = iface.getEvent('Swap');
    const sender = '0x1111111111111111111111111111111111111111';
    const { topics, data } = iface.encodeEventLog(frag, [sender, 1000n, 0n, 0n, 500n, USER]);
    const ev = decode({ address: POOL, topics, data, blockNumber: 1, blockHash: '0x', transactionHash: '0xtx', logIndex: 0, chainId: 5042002 });
    expect(ev.eventType).toBe('Swap');
    expect(ev.amountInRaw).toBe(1000n);
    expect(ev.amountOutRaw).toBe(500n);
  });
});

/* ── 14/15 — frontend authoritative history (static) ──────────────── */
describe('Frontend authoritative history', () => {
  it('Swap Trade History uses /api/pool-index, not DOM/queryFilter', () => {
    const s = html.indexOf('function stRenderTradeHistory');
    const body = html.slice(s, html.indexOf('function stRenderFunds', s));
    expect(body).toContain('getAuthoritativeAllSwaps');
    expect(body).not.toContain('getElementById(\'swap-history\')');
    expect(html).not.toContain('filters.Swap(');
    expect(html).not.toContain('filters.Swapped(');
  });

  it('Liquidity Recent Activity uses the same authoritative source', () => {
    const s = html.indexOf('function getRecentActivity');
    const body = html.slice(s, html.indexOf('function formatActivityTime', s));
    expect(body).toContain('getAuthoritativeSwapHistory');
    // same event fields shared by both surfaces
    expect(html).toContain('getAuthoritativeAllSwaps');
    expect(html).toContain('getAuthoritativeSwapHistory');
  });
});
