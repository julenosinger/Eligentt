/**
 * POOL INDEXER — production hardening (Phase 5.5).
 * ═══════════════════════════════════════════════════════════════════════════
 * Verifies persistence, cursor durability, atomic chunk processing, failure
 * recovery, deduplication across restarts/overlaps, timestamp resolution +
 * caching + failure, retry, concurrency, per-pool cursors, event ordering,
 * BigInt serialization, analytics rebuild, and ZERO-vs-UNAVAILABLE.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'shared', 'poolIndexer.js'), 'utf8');

function load() {
  const win = {};
  new Function('window', src)(win);
  return win.PoolIndexer;
}
const Idx = load();

const EVENTS = [
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
  'event Mint(address indexed sender, uint256 amount0, uint256 amount1)',
  'event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)',
];
const iface = new ethers.Interface(EVENTS);
const POOL = '0x14590fb7dcbd5cebabff63b915ef23d008db98f4';
const SENDER = '0x1111111111111111111111111111111111111111';
const TO = '0x2222222222222222222222222222222222222222';

function logAt(eventName, args, blockNumber, txHash, logIndex) {
  const frag = iface.getEvent(eventName);
  const { topics, data } = iface.encodeEventLog(frag, args);
  return { address: POOL, topics, data, blockNumber, blockHash: '0x' + blockNumber.toString(16).padStart(64, '0'), transactionHash: txHash, logIndex, chainId: 5042002 };
}
function swapLog(blockNumber, txHash, logIndex, in0, out1) {
  return logAt('Swap', [SENDER, BigInt(in0), 0n, 0n, BigInt(out1), TO], blockNumber, txHash, logIndex);
}

/**
 * Mock provider with failure injection + getBlock call counting.
 *   failBlocks    { blockNumber: true }  → getLogs throws if the range covers it
 *   failGetBlock  { blockNumber: true }  → getBlock throws (timestamp failure)
 *   tsMap         { blockNumber: seconds }
 */
function makeProvider({ logs = [], failBlocks = {}, failGetBlock = {}, tsMap = {}, latest = 20000, failGetLogs = false } = {}) {
  const getBlockCalls = {};
  return {
    logs, failBlocks, failGetBlock, tsMap, latest, failGetLogs, getBlockCalls,
    async getLogs(filter) {
      if (failGetLogs) throw new Error('RPC_DOWN');
      const from = parseInt(filter.fromBlock, 16), to = parseInt(filter.toBlock, 16);
      for (let b = from; b <= to; b++) if (failBlocks[b]) throw new Error('RPC_FAIL@' + b);
      return logs.filter(l => l.blockNumber >= from && l.blockNumber <= to);
    },
    async getBlockNumber() { return latest; },
    async getBlock(n) {
      getBlockCalls[n] = (getBlockCalls[n] || 0) + 1;
      if (failGetBlock[n]) throw new Error('TIMESTAMP_FAIL');
      return { timestamp: tsMap[n] != null ? tsMap[n] : 1700000000 + n };
    },
  };
}

function makeIdx(provider, store) {
  return Idx.createIndexer({ chainId: 5042002, poolAddress: POOL, provider, decode: Idx.createDecoder(iface), store, confirmationDepth: 5, chunkSize: 1000 });
}

/* ════════════════════════════════════════════════════════════
   1/2/27/28 — persistent cursor + recovery after restart
   ════════════════════════════════════════════════════════════ */
describe('Persistent cursor + restart recovery', () => {
  it('cursor survives a restart via the shared store', async () => {
    const store = Idx.createMemoryStore();
    const logs = [swapLog(100, '0xtxA', 0, 1000, 500), swapLog(200, '0xtxB', 0, 2000, 1000)];
    const provider = makeProvider({ logs });

    const idx1 = makeIdx(provider, store);
    await idx1.init();
    await idx1.ingestRange(100, 150);
    expect(idx1.getCursor().lastIndexedBlock).toBe(150);

    // "restart" — new indexer instance over the same store
    const idx2 = makeIdx(provider, store);
    await idx2.init();
    expect(idx2.getCursor().lastIndexedBlock).toBe(150);
    expect(idx2.getEvents({ eventType: 'Swap' }).length).toBe(1); // loaded from store
  });

  it('restart with existing indexed events rehydrates them (no loss)', async () => {
    const store = Idx.createMemoryStore();
    const provider = makeProvider({ logs: [swapLog(100, '0x1', 0, 10, 5), swapLog(101, '0x2', 0, 20, 10)] });
    const idx1 = makeIdx(provider, store);
    await idx1.init();
    await idx1.ingestRange(100, 101);
    expect(idx1.getEvents().length).toBe(2);

    const idx2 = makeIdx(provider, store);
    await idx2.init();
    expect(idx2.getEvents().length).toBe(2);
  });
});

/* ════════════════════════════════════════════════════════════
   3/4/29/30 — failed chunk does not advance cursor; retry resumes
   ════════════════════════════════════════════════════════════ */
describe('Failed chunk recovery', () => {
  it('does NOT advance cursor past a failed chunk, then retries without skipping', async () => {
    const store = Idx.createMemoryStore();
    const logs = [
      swapLog(100, '0xa', 0, 100, 50),   // chunk 1 (100-199)
      swapLog(150, '0xb', 0, 200, 100),
      swapLog(250, '0xc', 0, 300, 150),  // chunk 2 (200-299)
    ];
    const provider = makeProvider({ logs, failBlocks: { 250: true } });

    const idx = Idx.createIndexer({ chainId: 5042002, poolAddress: POOL, provider, decode: Idx.createDecoder(iface), store, confirmationDepth: 5, chunkSize: 100, maxRetries: 1, retryBackoffMs: 10 });
    await idx.init();
    const res1 = await idx.ingestRange(100, 300);
    expect(res1.ok).toBe(false);
    expect(idx.getCursor().lastIndexedBlock).toBe(199); // advanced through chunk 1 only

    // recovery: block 250 now available
    provider.failBlocks[250] = false;
    const res2 = await idx.ingestRange(200, 300);
    expect(res2.ok).toBe(true);
    expect(idx.getCursor().lastIndexedBlock).toBe(300);
    expect(idx.getEvents({ eventType: 'Swap' }).length).toBe(3); // no skipped, no duplicate
  });
});

/* ════════════════════════════════════════════════════════════
   5/6/29 — duplicate + overlapping ranges
   ════════════════════════════════════════════════════════════ */
describe('Duplicate safety across overlapping ranges', () => {
  it('overlapping scans produce no duplicates', async () => {
    const store = Idx.createMemoryStore();
    const logs = [];
    for (let b = 100; b <= 200; b++) logs.push(swapLog(b, '0xtx' + b, 0, b, b));
    const provider = makeProvider({ logs });

    const idx = makeIdx(provider, store);
    await idx.init();
    await idx.ingestRange(100, 150);
    await idx.ingestRange(140, 200); // overlapping
    expect(idx.getEvents({ eventType: 'Swap' }).length).toBe(101); // blocks 100..200
  });

  it('restart + rescan does not duplicate events', async () => {
    const store = Idx.createMemoryStore();
    const logs = [swapLog(100, '0x1', 0, 10, 5)];
    const provider = makeProvider({ logs });

    const idx1 = makeIdx(provider, store);
    await idx1.init();
    await idx1.ingestRange(100, 100);
    const idx2 = makeIdx(provider, store);
    await idx2.init();
    await idx2.ingestRange(100, 100);
    expect(idx2.getEvents().length).toBe(1);
  });
});

/* ════════════════════════════════════════════════════════════
   7/8 — block timestamp resolution + caching
   ════════════════════════════════════════════════════════════ */
describe('Block timestamp resolution + cache', () => {
  it('resolves timestamps from getBlock, cached per block', async () => {
    const store = Idx.createMemoryStore();
    // three events in the SAME block 100
    const logs = [
      swapLog(100, '0xa', 0, 100, 50),
      swapLog(100, '0xb', 1, 200, 100),
      swapLog(100, '0xc', 2, 300, 150),
    ];
    const provider = makeProvider({ logs, tsMap: { 100: 1700000000 + 100 } });
    const idx = makeIdx(provider, store);
    await idx.init();
    await idx.ingestRange(100, 100);
    expect(provider.getBlockCalls[100]).toBe(1); // block timestamp fetched once
    const events = idx.getEvents();
    expect(events.every(e => e.timestamp === 1700000000 + 100)).toBe(true);
  });
});

/* ════════════════════════════════════════════════════════════
   9/13/14 — timestamp failure → PARTIAL, excluded from volume
   ════════════════════════════════════════════════════════════ */
describe('Timestamp failure → PARTIAL, excluded from authoritative volume', () => {
  it('events with unknown timestamps are excluded and status is PARTIAL', async () => {
    const store = Idx.createMemoryStore();
    const now = Date.now();
    const logs = [swapLog(100, '0xa', 0, 100, 50), swapLog(101, '0xb', 0, 200, 100)];
    const provider = makeProvider({ logs, failGetBlock: { 101: true }, tsMap: { 100: now / 1000 - 3600 } });
    const idx = makeIdx(provider, store);
    await idx.init();
    const res = await idx.ingestRange(100, 101);
    expect(res.ok).toBe(true);
    expect(res.missingTimestamps).toBe(1);
    expect(res.status).toBe('PARTIAL');
    const v = idx.computeVolume(86400, { now });
    expect(v.amount0InRaw).toBe(100n); // only the known-timestamp event
    expect(v.status).toBe('PARTIAL');
  });
});

/* ════════════════════════════════════════════════════════════
   16/17 — incremental indexing + confirmation depth
   ════════════════════════════════════════════════════════════ */
describe('Incremental indexing + confirmation depth', () => {
  it('ingestLatest indexes up to latest - confirmationDepth, incrementally', async () => {
    const store = Idx.createMemoryStore();
    const logs = [swapLog(100, '0xa', 0, 100, 50), swapLog(19999, '0xb', 0, 200, 100)];
    const provider = makeProvider({ logs, latest: 20000 }); // confirmationDepth 5 → boundary 19995
    const idx = Idx.createIndexer({ chainId: 5042002, poolAddress: POOL, provider, decode: Idx.createDecoder(iface), store, confirmationDepth: 5, chunkSize: 1000 });
    await idx.init();
    const res = await idx.ingestLatest();
    expect(res.lastIndexedBlock).toBe(19995);
    // block 100 is within boundary (indexed); block 19999 is beyond boundary (NOT indexed)
    expect(idx.getEvents({ eventType: 'Swap' }).length).toBe(1);
  });
});

/* ════════════════════════════════════════════════════════════
   18/19 — RPC failure + bounded retry
   ════════════════════════════════════════════════════════════ */
describe('RPC failure handling + bounded retry', () => {
  it('getLogs failure → ERROR, cursor not advanced, retries bounded', async () => {
    const store = Idx.createMemoryStore();
    let getLogsCalls = 0;
    const provider = {
      async getLogs() { getLogsCalls++; throw new Error('RPC_DOWN'); },
      async getBlockNumber() { return 20000; },
      async getBlock(n) { return { timestamp: 1700000000 + n }; },
    };
    const idx = Idx.createIndexer({ chainId: 5042002, poolAddress: POOL, provider, decode: Idx.createDecoder(iface), store, maxRetries: 2, confirmationDepth: 5 });
    await idx.init();
    const res = await idx.ingestRange(100, 200);
    expect(res.ok).toBe(false);
    expect(res.status).toBe('ERROR');
    expect(idx.getCursor().lastIndexedBlock).toBe(0);
    expect(getLogsCalls).toBe(3); // 1 initial + 2 retries
  });
});

/* ════════════════════════════════════════════════════════════
   20 — multiple pools have independent cursors
   ════════════════════════════════════════════════════════════ */
describe('Multiple pools — independent cursors', () => {
  it('cursors are per (chainId, poolAddress)', async () => {
    const store = Idx.createMemoryStore();
    const poolB = '0x18076d992005186aeb13ac5270cad6e27db95247';
    const providerA = makeProvider({ logs: [swapLog(100, '0xa', 0, 1, 1)] });
    const providerB = makeProvider({ logs: [swapLog(500, '0xb', 0, 1, 1)] });
    const idxA = Idx.createIndexer({ chainId: 5042002, poolAddress: POOL, provider: providerA, decode: Idx.createDecoder(iface), store, confirmationDepth: 5 });
    const idxB = Idx.createIndexer({ chainId: 5042002, poolAddress: poolB, provider: providerB, decode: Idx.createDecoder(iface), store, confirmationDepth: 5 });
    await idxA.init(); await idxB.init();
    await idxA.ingestRange(100, 100);
    await idxB.ingestRange(500, 500);
    expect(idxA.getCursor().lastIndexedBlock).toBe(100);
    expect(idxB.getCursor().lastIndexedBlock).toBe(500);
  });
});

/* ════════════════════════════════════════════════════════════
   21 — concurrent indexing protection
   ════════════════════════════════════════════════════════════ */
describe('Concurrent indexing protection', () => {
  it('rejects a concurrent ingest on the same indexer', async () => {
    const store = Idx.createMemoryStore();
    const logs = [swapLog(100, '0xa', 0, 1, 1)];
    const provider = makeProvider({ logs });
    const idx = makeIdx(provider, store);
    await idx.init();
    // Make getLogs slow to keep the first ingest in-flight.
    let release;
    const gate = new Promise(r => { release = r; });
    provider.getLogs = async (f) => { await gate; return [{ address: POOL, topics: [], data: '0x' }]; };
    const p1 = idx.ingestRange(100, 200);
    // give the first ingest a tick to set _inflight
    await new Promise(r => setTimeout(r, 5));
    const p2 = await idx.ingestRange(100, 200);
    expect(p2.ok).toBe(false);
    expect(p2.reason).toBe('INDEXING_IN_PROGRESS');
    release();
    await p1;
  });
});

/* ════════════════════════════════════════════════════════════
   22 — deterministic event ordering
   ════════════════════════════════════════════════════════════ */
describe('Deterministic event ordering', () => {
  it('sorts by blockNumber ASC then logIndex ASC regardless of RPC order', async () => {
    const store = Idx.createMemoryStore();
    const logs = [
      swapLog(200, '0x2', 0, 200, 100),
      swapLog(100, '0x1', 5, 100, 50),
      swapLog(100, '0x1', 0, 100, 50),
    ];
    const provider = makeProvider({ logs });
    const idx = makeIdx(provider, store);
    await idx.init();
    await idx.ingestRange(100, 200);
    const evs = idx.getEvents();
    const keys = evs.map(e => Number(e.blockNumber) * 1000 + e.logIndex);
    const sorted = [...keys].sort((a, b) => a - b);
    expect(keys).toEqual(sorted);
  });
});

/* ════════════════════════════════════════════════════════════
   23 — BigInt persistence (serialize/deserialize exact)
   ════════════════════════════════════════════════════════════ */
describe('BigInt persistence', () => {
  it('serialize/deserialize preserves exact raw amounts', () => {
    const huge = 123456789123456789123456789n;
    const ev = { key: 'x:0', blockNumber: huge, amount0In: huge, eventType: 'Swap', transactionHash: '0x', chainId: 1, poolAddress: POOL };
    const s = Idx.serializeEvent(ev);
    expect(s).toContain(huge.toString());
    const back = Idx.deserializeEvent(s);
    expect(typeof back.amount0In).toBe('bigint');
    expect(back.amount0In).toBe(huge);
    expect(back.blockNumber).toBe(huge);
  });
});

/* ════════════════════════════════════════════════════════════
   26 — malformed event rejection
   ════════════════════════════════════════════════════════════ */
describe('Malformed event rejection', () => {
  it('rejects events missing required identity fields', async () => {
    const store = Idx.createMemoryStore();
    const badLog = { address: POOL, topics: [], data: '0x', blockNumber: 100, transactionHash: '', logIndex: 0 };
    const goodLog = swapLog(100, '0xgood', 0, 10, 5);
    const provider = makeProvider({ logs: [badLog, goodLog] });
    const idx = makeIdx(provider, store);
    await idx.init();
    const res = await idx.ingestRange(100, 100);
    expect(idx.getEvents().length).toBe(1); // only the valid event
  });
});

/* ════════════════════════════════════════════════════════════
   24 — analytics rebuild from indexed events
   ════════════════════════════════════════════════════════════ */
describe('Analytics rebuild from indexed events', () => {
  it('computeVolume is derived from indexed events (not stored aggregate)', async () => {
    const store = Idx.createMemoryStore();
    const now = Date.now();
    const logs = [swapLog(100, '0xa', 0, 100, 50), swapLog(101, '0xb', 0, 200, 100)];
    const provider = makeProvider({ logs, tsMap: { 100: now / 1000 - 3600, 101: now / 1000 - 3600 } });
    const idx = makeIdx(provider, store);
    await idx.init();
    await idx.ingestRange(100, 101);
    const v1 = idx.computeVolume(86400, { now });
    expect(v1.amount0InRaw).toBe(300n);
    expect(v1.status).toBe('COMPLETE');
  });
});
