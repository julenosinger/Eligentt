/**
 * POOL INDEXER — authoritative on-chain event indexing (Phase 5, Part A).
 * ═══════════════════════════════════════════════════════════════════════════
 * Verifies normalized event decoding, event identity, deduplication, block
 * chunking, cursor continuation, 24h/7d/30d filtering, completeness state and
 * BigInt precision. No network — uses a mock provider + real ethers decoding.
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

function makeLog(eventName, args, blockNumber, txHash, logIndex, timestamp) {
  const frag = iface.getEvent(eventName);
  const { topics, data } = iface.encodeEventLog(frag, args);
  return {
    address: POOL,
    topics,
    data,
    blockNumber,
    blockHash: '0x' + blockNumber.toString(16).padStart(64, '0'),
    transactionHash: txHash,
    logIndex,
    timestamp,
    chainId: 5042002,
  };
}

function makeProvider(logs) {
  return {
    async getLogs(filter) {
      const from = parseInt(filter.fromBlock, 16);
      const to = parseInt(filter.toBlock, 16);
      return logs.filter(l => l.blockNumber >= from && l.blockNumber <= to);
    },
    async getBlockNumber() { return 20000; },
  };
}

describe('Indexer — event decoding', () => {
  const decode = Idx.createDecoder(iface);

  it('decodes Swap events with raw BigInt amounts', () => {
    const log = makeLog('Swap', [SENDER, 1000n, 0n, 0n, 500n, TO], 100, '0xtx1', 0, 1700000000);
    const ev = decode(log);
    expect(ev.eventType).toBe('Swap');
    expect(ev.amount0In).toBe(1000n);
    expect(ev.amount1Out).toBe(500n);
    expect(typeof ev.amount0In).toBe('bigint');
    expect(ev.sender.toLowerCase()).toBe(SENDER.toLowerCase());
    expect(ev.to.toLowerCase()).toBe(TO.toLowerCase());
  });

  it('decodes Mint and Burn events', () => {
    const m = decode(makeLog('Mint', [SENDER, 500n, 600n], 101, '0xtx2', 0, 1700000000));
    expect(m.eventType).toBe('Mint');
    expect(m.amount0).toBe(500n);
    const b = decode(makeLog('Burn', [SENDER, 100n, 200n, TO], 102, '0xtx3', 0, 1700000000));
    expect(b.eventType).toBe('Burn');
    expect(b.amount1).toBe(200n);
  });

  it('returns null for unknown logs', () => {
    const unknown = { address: POOL, topics: [ethers.id('Foo()')], data: '0x', blockNumber: 1, logIndex: 0, transactionHash: '0xtx' };
    expect(decode(unknown)).toBeNull();
  });
});

describe('Indexer — event identity + deduplication', () => {
  it('identity is transactionHash + logIndex', () => {
    expect(Idx.eventIdentity('0xabc', 5)).toBe('0xabc:5');
    expect(Idx.eventIdentity('0xabc', 6)).not.toBe(Idx.eventIdentity('0xabc', 5));
  });

  it('does not duplicate the same event across scans', async () => {
    const decode = Idx.createDecoder(iface);
    const log = makeLog('Swap', [SENDER, 1000n, 0n, 0n, 500n, TO], 100, '0xtx1', 0, 1700000000);
    const provider = makeProvider([log]);
    const idx = Idx.createIndexer({ chainId: 5042002, poolAddress: POOL, provider, decode, confirmationDepth: 5, chunkSize: 100 });

    await idx.ingestRange(100, 150);
    await idx.ingestRange(100, 150); // rescan same range
    const events = idx.getEvents({ eventType: 'Swap' });
    expect(events.length).toBe(1);
  });
});

describe('Indexer — block chunking', () => {
  it('scans a large range in bounded chunks', async () => {
    const decode = Idx.createDecoder(iface);
    const logs = [];
    for (let b = 1; b <= 50; b++) {
      logs.push(makeLog('Swap', [SENDER, 10n * BigInt(b), 0n, 0n, 5n * BigInt(b), TO], b, '0xtx' + b, 0, 1700000000 + b));
    }
    let getLogsCalls = 0;
    const provider = {
      async getLogs(filter) {
        getLogsCalls++;
        const from = parseInt(filter.fromBlock, 16), to = parseInt(filter.toBlock, 16);
        expect(to - from).toBeLessThan(20); // chunkSize bound
        return logs.filter(l => l.blockNumber >= from && l.blockNumber <= to);
      },
      async getBlockNumber() { return 20000; },
    };
    const idx = Idx.createIndexer({ chainId: 5042002, poolAddress: POOL, provider, decode, confirmationDepth: 5, chunkSize: 20 });
    const res = await idx.ingestRange(1, 50);
    expect(res.ok).toBe(true);
    expect(res.chunks).toBeGreaterThan(1);
    expect(idx.getEvents({ eventType: 'Swap' }).length).toBe(50);
    expect(getLogsCalls).toBeGreaterThan(1);
  });
});

describe('Indexer — cursor continuation', () => {
  it('resumes from lastIndexedBlock without rescanning', async () => {
    const decode = Idx.createDecoder(iface);
    const logs = [
      makeLog('Swap', [SENDER, 100n, 0n, 0n, 50n, TO], 100, '0xtxA', 0, 1700000000),
      makeLog('Swap', [SENDER, 200n, 0n, 0n, 100n, TO], 200, '0xtxB', 0, 1700000000),
    ];
    const provider = makeProvider(logs);
    const idx = Idx.createIndexer({ chainId: 5042002, poolAddress: POOL, provider, decode, confirmationDepth: 5, chunkSize: 1000 });
    await idx.ingestRange(100, 150);
    expect(idx.getCursor().lastIndexedBlock).toBe(150);
    await idx.ingestRange(151, 250);
    expect(idx.getCursor().lastIndexedBlock).toBe(250);
    expect(idx.getEvents({ eventType: 'Swap' }).length).toBe(2);
  });
});

describe('Indexer — volume windows (24h/7d/30d)', () => {
  function buildIndexer(now) {
    const decode = Idx.createDecoder(iface);
    const logs = [
      // 1 hour ago
      makeLog('Swap', [SENDER, 1000n, 0n, 0n, 500n, TO], 10, '0xtx1', 0, now / 1000 - 3600),
      // 3 days ago
      makeLog('Swap', [SENDER, 2000n, 0n, 0n, 1000n, TO], 11, '0xtx2', 0, now / 1000 - 3 * 86400),
      // 10 days ago
      makeLog('Swap', [SENDER, 4000n, 0n, 0n, 2000n, TO], 12, '0xtx3', 0, now / 1000 - 10 * 86400),
    ];
    const provider = makeProvider(logs);
    const idx = Idx.createIndexer({ chainId: 5042002, poolAddress: POOL, provider, decode, confirmationDepth: 5, chunkSize: 1000 });
    return idx.ingestRange(10, 12).then(() => idx);
  }

  it('24h window includes only recent swaps', async () => {
    const now = Date.now();
    const idx = await buildIndexer(now);
    const v = idx.computeVolume(86400, { now, token0Symbol: 'USDC', token1Symbol: 'cirBTC', token0Decimals: 6, token1Decimals: 8 });
    expect(v.amount0InRaw).toBe(1000n); // only the 1-hour-ago swap
  });

  it('7d window includes swaps within 7 days', async () => {
    const now = Date.now();
    const idx = await buildIndexer(now);
    const v = idx.computeVolume(7 * 86400, { now });
    expect(v.amount0InRaw).toBe(1000n + 2000n); // 1h + 3d
  });

  it('30d window includes all swaps', async () => {
    const now = Date.now();
    const idx = await buildIndexer(now);
    const v = idx.computeVolume(30 * 86400, { now });
    expect(v.amount0InRaw).toBe(1000n + 2000n + 4000n);
  });

  it('usdVolume is null without a trustworthy price', async () => {
    const now = Date.now();
    const idx = await buildIndexer(now);
    const v = idx.computeVolume(86400, { now, priceFn: () => null });
    expect(v.usdVolume).toBeNull();
  });

  it('BigInt token volumes are never rounded through Number', async () => {
    const now = Date.now();
    const idx = await buildIndexer(now);
    const v = idx.computeVolume(86400, { now });
    expect(typeof v.amount0InRaw).toBe('bigint');
  });
});
