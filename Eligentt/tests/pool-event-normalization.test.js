/**
 * POOL EVENT NORMALIZATION — standard Swap + USDC/EURC Swapped (Phase 6.2).
 * ═══════════════════════════════════════════════════════════════════════════
 * Verifies both swap-event shapes normalize into ONE representation consumed by
 * the indexer + post-swap verification. Uses the REAL USDC/EURC Swapped fixture.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const idxSrc = fs.readFileSync(path.join(root, 'shared', 'poolIndexer.js'), 'utf8');
const execSrc = fs.readFileSync(path.join(root, 'shared', 'poolExecutor.js'), 'utf8');

function loadIdx() { const w = {}; new Function('window', idxSrc)(w); return w.PoolIndexer; }
function loadExec() {
  const w = {};
  new Function('window', idxSrc)(w);
  new Function('window', fs.readFileSync(path.join(root, 'shared', 'poolEngine.js'), 'utf8'))(w);
  new Function('window', fs.readFileSync(path.join(root, 'shared', 'swapMath.js'), 'utf8'))(w);
  new Function('window', fs.readFileSync(path.join(root, 'shared', 'poolRouter.js'), 'utf8'))(w);
  new Function('window', execSrc)(w);
  return w.PoolExecutor;
}
const Idx = loadIdx();

// REAL USDC/EURC fixture (Arc Testnet).
const POOL = '0x18076d992005186aeb13ac5270cad6e27db95247';
const USER = '0x01dE545e8Fea5EcAAb78eC2C09E6D98117f7687d';
const USDC = '0x3600000000000000000000000000000000000000';
const EURC = '0x89b50855aa3be2f677cd6303cec089b5f319d72a';
const SWAPPED_TOPIC = '0xa078c4190abe07940190effc1846be0ccf03ad6007bc9e93f9697d0b460befbb';
const SWAP_TOPIC = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';

const EVENTS = [
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
  'event Swapped(address indexed user, address tokenIn, uint256 amountIn, uint256 amountOut)',
  'event Mint(address indexed sender, uint256 amount0, uint256 amount1)',
  'event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)',
];
const iface = new ethers.Interface(EVENTS);

const DEC = { token0Address: USDC, token1Address: EURC, token0Symbol: 'USDC', token1Symbol: 'EURC' };

function makeLog(eventName, args, blockNumber, txHash, logIndex) {
  const frag = iface.getEvent(eventName);
  const { topics, data } = iface.encodeEventLog(frag, args);
  return { address: POOL, topics, data, blockNumber, blockHash: '0x' + blockNumber.toString(16).padStart(64, '0'), transactionHash: txHash, logIndex, chainId: 5042002 };
}

/* ── Topic detection (Phase 5) ───────────────────────────────── */
describe('Swap event capability detection', () => {
  it('detects standard Swap topic', () => {
    expect(Idx.detectSwapEventType('0x' + SWAP_TOPIC.slice(2))).toBe('standard');
  });
  it('detects USDC/EURC Swapped topic', () => {
    expect(Idx.detectSwapEventType('0x' + SWAPPED_TOPIC.slice(2))).toBe('swapped');
  });
  it('detects no swap event', () => {
    expect(Idx.detectSwapEventType('0x123456')).toBe('none');
    expect(Idx.detectSwapEventType('0x')).toBe('none');
  });
  it('exposes the verified topics', () => {
    expect(Idx.SWAPPED_TOPIC).toBe(SWAPPED_TOPIC);
  });
});

/* ── Normalization (Phases 2/3/4) ────────────────────────────── */
describe('Swap event normalization', () => {
  it('normalizes standard Swap (usdc-cirbtc shape)', () => {
    const decode = Idx.createDecoder(iface, { token0Address: USDC, token1Address: '0xf0c4a4ce82a5746abaad9425360ab04fbba432bf', token0Symbol: 'USDC', token1Symbol: 'cirBTC' });
    const sender = '0x1111111111111111111111111111111111111111';
    const ev = decode(makeLog('Swap', [sender, 1000n, 0n, 0n, 500n, USER], 100, '0xtx', 0));
    expect(ev.eventType).toBe('Swap');
    expect(ev.amountInRaw).toBe(1000n);
    expect(ev.amountOutRaw).toBe(500n);
    expect(ev.tokenIn).toBe('USDC');
    expect(ev.tokenOut).toBe('cirBTC');
    expect(ev.amount0In).toBe(1000n);
    expect(ev.amount1Out).toBe(500n);
  });

  it('normalizes the REAL USDC/EURC Swapped event (regression fixture)', () => {
    const decode = Idx.createDecoder(iface, DEC);
    const ev = decode(makeLog('Swapped', [USER, USDC, 1000000n, 899200n], 100, '0xtx', 0));
    expect(ev).not.toBeNull();
    expect(ev.eventType).toBe('Swap');
    expect(ev.user.toLowerCase()).toBe(USER.toLowerCase());
    expect(ev.tokenIn).toBe('USDC');
    expect(ev.tokenOut).toBe('EURC');
    expect(ev.amountInRaw).toBe(1000000n);
    expect(ev.amountOutRaw).toBe(899200n);
    // mapped to token0/token1 buckets (USDC in, EURC out)
    expect(ev.amount0In).toBe(1000000n);
    expect(ev.amount1Out).toBe(899200n);
    expect(typeof ev.amountInRaw).toBe('bigint');
  });

  it('normalizes Swapped in the reverse direction (EURC→USDC)', () => {
    const decode = Idx.createDecoder(iface, DEC);
    const ev = decode(makeLog('Swapped', [USER, EURC, 900000n, 999000n], 100, '0xtx2', 0));
    expect(ev.tokenIn).toBe('EURC');
    expect(ev.tokenOut).toBe('USDC');
    expect(ev.amount1In).toBe(900000n);
    expect(ev.amount0Out).toBe(999000n);
  });

  it('rejects Swapped with unknown tokenIn (invalid token order)', () => {
    const decode = Idx.createDecoder(iface, DEC);
    const ev = decode(makeLog('Swapped', [USER, '0xdead00000000000000000000000000000000dead', 1n, 1n], 100, '0xtx3', 0));
    expect(ev).toBeNull();
  });

  it('rejects unknown events', () => {
    const decode = Idx.createDecoder(iface, DEC);
    const unknown = { address: POOL, topics: [ethers.id('Foo()')], data: '0x', blockNumber: 1, logIndex: 0, transactionHash: '0xtx' };
    expect(decode(unknown)).toBeNull();
  });
});

/* ── BigInt serialization (Phase 2 / tests 11) ───────────────── */
describe('BigInt serialization preserves exact values', () => {
  it('round-trips amountInRaw/amountOutRaw exactly', () => {
    const ev = { key: 'x:0', blockNumber: 1n, amountInRaw: 1000000n, amountOutRaw: 899200n, eventType: 'Swap', transactionHash: '0x', chainId: 1, poolAddress: POOL };
    const s = Idx.serializeEvent(ev);
    const back = Idx.deserializeEvent(s);
    expect(back.amountInRaw).toBe(1000000n);
    expect(back.amountOutRaw).toBe(899200n);
    expect(typeof back.amountInRaw).toBe('bigint');
  });
});

/* ── Indexer integration: dedup, timestamps, volume (Phase 6/7) ─ */
function makeProvider(logs, tsMap = {}, opts = {}) {
  return {
    async getLogs(filter) {
      if (opts.fail) throw new Error('RPC_DOWN');
      const from = parseInt(filter.fromBlock, 16), to = parseInt(filter.toBlock, 16);
      return logs.filter(l => l.blockNumber >= from && l.blockNumber <= to);
    },
    async getBlockNumber() { return 20000; },
    async getBlock(n) { if (opts.failBlock === n) throw new Error('TS_FAIL'); return { timestamp: tsMap[n] != null ? tsMap[n] : 1700000000 + n }; },
  };
}

describe('Indexer integration with normalized Swapped', () => {
  it('deduplicates by txHash + logIndex across rescans', async () => {
    const store = Idx.createMemoryStore();
    const log = makeLog('Swapped', [USER, USDC, 1000000n, 899200n], 100, '0xtxA', 0);
    const provider = makeProvider([log]);
    const idx = Idx.createIndexer({ chainId: 5042002, poolAddress: POOL, provider, decode: Idx.createDecoder(iface, DEC), store, confirmationDepth: 5 });
    await idx.ingestRange(100, 100);
    await idx.ingestRange(100, 100);
    expect(idx.getEvents({ eventType: 'Swap' }).length).toBe(1);
  });

  it('resolves block timestamps (not Date.now())', async () => {
    const store = Idx.createMemoryStore();
    const log = makeLog('Swapped', [USER, USDC, 1000000n, 899200n], 100, '0xtxB', 0);
    const provider = makeProvider([log], { 100: 1700000000 + 100 });
    const idx = Idx.createIndexer({ chainId: 5042002, poolAddress: POOL, provider, decode: Idx.createDecoder(iface, DEC), store, confirmationDepth: 5 });
    await idx.ingestRange(100, 100);
    expect(idx.getEvents()[0].timestamp).toBe(1700000000 + 100);
  });

  it('timestamp failure → PARTIAL, event excluded from windowed volume', async () => {
    const store = Idx.createMemoryStore();
    const now = Date.now();
    const log = makeLog('Swapped', [USER, USDC, 1000000n, 899200n], 100, '0xtxC', 0);
    const provider = makeProvider([log], { 100: now / 1000 - 3600 }, { failBlock: 100 });
    const idx = Idx.createIndexer({ chainId: 5042002, poolAddress: POOL, provider, decode: Idx.createDecoder(iface, DEC), store, confirmationDepth: 5 });
    const res = await idx.ingestRange(100, 100);
    expect(res.missingTimestamps).toBe(1);
    expect(res.status).toBe('PARTIAL');
    const v = idx.computeVolume(86400, { now });
    expect(v.amount0InRaw).toBe(0n); // excluded (unknown timestamp)
    expect(v.status).toBe('PARTIAL');
  });

  it('computes USDC/EURC token-denominated volume from Swapped events', async () => {
    const store = Idx.createMemoryStore();
    const now = Date.now();
    const logs = [
      makeLog('Swapped', [USER, USDC, 1000000n, 899200n], 100, '0xtx1', 0), // 1 USDC in
      makeLog('Swapped', [USER, USDC, 500000n, 449000n], 101, '0xtx2', 0),  // 0.5 USDC in
    ];
    const provider = makeProvider(logs, { 100: now / 1000 - 3600, 101: now / 1000 - 3600 });
    const idx = Idx.createIndexer({ chainId: 5042002, poolAddress: POOL, provider, decode: Idx.createDecoder(iface, DEC), store, confirmationDepth: 5 });
    await idx.ingestRange(100, 101);
    const v = idx.computeVolume(86400, { now });
    expect(v.amount0InRaw).toBe(1500000n); // 1 + 0.5 USDC raw input
    expect(v.status).toBe('COMPLETE');
  });

  it('does NOT fabricate USD volume without a price', async () => {
    const store = Idx.createMemoryStore();
    const now = Date.now();
    const log = makeLog('Swapped', [USER, USDC, 1000000n, 899200n], 100, '0xtxD', 0);
    const provider = makeProvider([log], { 100: now / 1000 - 3600 });
    const idx = Idx.createIndexer({ chainId: 5042002, poolAddress: POOL, provider, decode: Idx.createDecoder(iface, DEC), store, confirmationDepth: 5 });
    await idx.ingestRange(100, 100);
    const v = idx.computeVolume(86400, { now, priceFn: () => null });
    expect(v.usdVolume).toBeNull();
  });

  it('restart/recovery reloads normalized events from store', async () => {
    const store = Idx.createMemoryStore();
    const log = makeLog('Swapped', [USER, USDC, 1000000n, 899200n], 100, '0xtxE', 0);
    const provider = makeProvider([log]);
    const idx1 = Idx.createIndexer({ chainId: 5042002, poolAddress: POOL, provider, decode: Idx.createDecoder(iface, DEC), store, confirmationDepth: 5 });
    await idx1.init();
    await idx1.ingestRange(100, 100);
    const idx2 = Idx.createIndexer({ chainId: 5042002, poolAddress: POOL, provider, decode: Idx.createDecoder(iface, DEC), store, confirmationDepth: 5 });
    await idx2.init();
    const events = idx2.getEvents({ eventType: 'Swap' });
    expect(events.length).toBe(1);
    expect(events[0].tokenOut).toBe('EURC');
  });
});

/* ── Post-swap result extraction (Phase 8 / tests 19/20) ────── */
describe('Post-swap result extraction (PoolExecutor)', () => {
  it('extracts the real Swapped event from a receipt', () => {
    const Executor = loadExec();
    const ex = Executor.createExecutor({ ethers });
    const swappedIface = new ethers.Interface(['event Swapped(address indexed user, address tokenIn, uint256 amountIn, uint256 amountOut)']);
    const { topics, data } = swappedIface.encodeEventLog(swappedIface.getEvent('Swapped'), [USER, USDC, 1000000n, 899200n]);
    const receipt = { logs: [{ address: POOL, topics, data }] };
    const ev = ex.extractSwapEvent(receipt, new ethers.Interface(['event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)']), swappedIface);
    expect(ev.eventType).toBe('Swapped');
    expect(ev.amountInRaw).toBe(1000000n);
    expect(ev.amountOutRaw).toBe(899200n);
    expect(ev.user.toLowerCase()).toBe(USER.toLowerCase());
  });

  it('standard Swap extraction still works (existing pools)', () => {
    const Executor = loadExec();
    const ex = Executor.createExecutor({ ethers });
    const swapIface = new ethers.Interface(['event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)']);
    const sender = '0x1111111111111111111111111111111111111111';
    const { topics, data } = swapIface.encodeEventLog(swapIface.getEvent('Swap'), [sender, 1000n, 0n, 0n, 500n, USER]);
    const receipt = { logs: [{ address: POOL, topics, data }] };
    const ev = ex.extractSwapEvent(receipt, swapIface);
    expect(ev.eventType).toBe('Swap');
    expect(ev.amountInRaw).toBe(1000n);
    expect(ev.amountOutRaw).toBe(500n);
  });
});

/* ── No regression: existing standard Swap pools remain functional ── */
describe('Standard Swap pools remain functional', () => {
  it('existing decoder still produces amount0In/amount1In for computeVolume', () => {
    const decode = Idx.createDecoder(iface); // no pool config → still works for Swap
    const sender = '0x1111111111111111111111111111111111111111';
    const ev = decode(makeLog('Swap', [sender, 1000n, 0n, 0n, 500n, USER], 100, '0xtx', 0));
    expect(ev.eventType).toBe('Swap');
    expect(ev.amount0In).toBe(1000n);
    expect(ev.amount1In).toBe(0n);
  });
});
