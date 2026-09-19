/**
 * UNIFIED AUTHORITATIVE SWAP HISTORY — Phase 6.4.
 * ═══════════════════════════════════════════════════════════════════════════
 * Proves Swap Trade History and Liquidity Recent Activity share ONE source of
 * truth (/api/pool-index?includeEvents=true), that the old DOM/session-based
 * swpAddHistory is no longer the history source, that timestamps come from the
 * block/event (never Date.now), that Swap/Swapped queryFilter is absent from the
 * frontend, and that refresh=true forces a server-side ingest without duplicates.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { createPoolIndexHandler, INGEST_COOLDOWN_MS } from '../functions/api/pool-index/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const idxSrc = fs.readFileSync(path.join(root, 'shared', 'poolIndexer.js'), 'utf8');

function loadIdx() { const w = {}; new Function('window', idxSrc)(w); return w.PoolIndexer; }
const Idx = loadIdx();

function fnBody(name, until) {
  const start = html.indexOf('function ' + name);
  if (start < 0) return '';
  const end = until ? html.indexOf(until, start) : (html.indexOf('function ', start + 1));
  return html.slice(start, end < 0 ? html.length : end);
}

const POOL = '0x18076d992005186aeb13ac5270cad6e27db95247';
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
function swappedLog(blockNumber, txHash, logIndex, amountIn, amountOut) {
  const frag = iface.getEvent('Swapped');
  const { topics, data } = iface.encodeEventLog(frag, [USER, USDC, BigInt(amountIn), BigInt(amountOut)]);
  return { address: POOL, topics, data, blockNumber, blockHash: '0x' + blockNumber.toString(16).padStart(64, '0'), transactionHash: txHash, logIndex, chainId: 5042002 };
}

/* ── Swap Trade History is authoritative ─────────────────────────── */
describe('Swap Trade History consumes /api/pool-index', () => {
  it('stRenderTradeHistory reads authoritative events, not the session DOM', () => {
    const body = fnBody('stRenderTradeHistory', 'function stRenderFunds');
    expect(body).toContain('getAuthoritativeAllSwaps');
    expect(body).not.toContain("getElementById('swap-history')");
    expect(body).not.toContain('.swp-hist-item');
  });

  it('renders columns from event fields (Pair/Amount/Total/TX/Time)', () => {
    const body = fnBody('stRenderTradeHistory', 'function stRenderFunds');
    expect(body).toContain('ev.amountInRaw');
    expect(body).toContain('ev.amountOutRaw');
    expect(body).toContain('ev.tokenIn');
    expect(body).toContain('ev.tokenOut');
    expect(body).toContain('ev.txHash');
    expect(body).toContain('formatActivityTime(ev.timestamp)');
  });

  it('uses on-chain timestamp, never Date.now / new Date', () => {
    const body = fnBody('stRenderTradeHistory', 'function stRenderFunds');
    expect(body).not.toContain('Date.now');
    expect(body).not.toContain('new Date');
    expect(body).toContain('formatActivityTime(ev.timestamp)');
  });
});

/* ── Liquidity Recent Activity shares the same source ─────────────── */
describe('Liquidity Recent Activity shares the source', () => {
  it('getRecentActivity pulls swaps from getAuthoritativeSwapHistory', () => {
    const body = fnBody('getRecentActivity', 'function formatActivityTime');
    expect(body).toContain('getAuthoritativeSwapHistory');
    expect(body).toContain('s.timestamp');
    expect(body).toContain('s.amountInRaw');
    expect(body).toContain('s.amountOutRaw');
    expect(body).toContain('s.txHash');
  });

  it('both surfaces derive from the same _authoritativeHistory store', () => {
    const all = fnBody('getAuthoritativeAllSwaps', 'async function refreshAuthoritativeSwapHistory');
    const hist = fnBody('getAuthoritativeSwapHistory', 'function getAuthoritativeAllSwaps');
    expect(all).toContain('_authoritativeHistory');
    expect(hist).toContain('_authoritativeHistory');
    // both read the same txHash / amountInRaw / amountOutRaw / timestamp fields
    expect(html).toContain('ev.txHash');
    expect(html).toContain('ev.amountInRaw');
    expect(html).toContain('ev.amountOutRaw');
    expect(html).toContain('ev.timestamp');
  });
});

/* ── swpAddHistory is transient-only, not a history source ────────── */
describe('swpAddHistory is no longer the history source', () => {
  it('does not write to the session DOM or invent timestamps', () => {
    const body = fnBody('swpAddHistory');
    expect(body).not.toContain("getElementById('swap-history')");
    expect(body).not.toContain('.swp-hist-item');
    expect(body).not.toContain('Date.now');
    expect(body).not.toContain('new Date');
  });

  it('only requests an authoritative refresh + re-render', () => {
    const body = fnBody('swpAddHistory');
    expect(body).toContain('refreshAuthoritativeSwapHistory(true)');
  });

  it('no code reads .swp-hist-item DOM for history anymore', () => {
    expect(html).not.toContain("querySelectorAll('.swp-hist-item')");
  });
});

/* ── Timestamps + decimals + no queryFilter ───────────────────────── */
describe('No invented timestamps, correct decimals, no queryFilter', () => {
  it('timestamp always comes from the event/block (no Date.now fallback in history)', () => {
    expect(html).toContain('formatActivityTime(ev.timestamp)');
    expect(html).toContain('formatActivityTime(a.ts)');
  });

  it('amounts respect real token decimals', () => {
    const f = fnBody('formatRawTokenAmount');
    expect(f).toContain('decimals');
    expect(f).toContain('Math.pow(10, dec)');
  });

  it('frontend has no Swap/Swapped queryFilter', () => {
    expect(html).not.toContain('filters.Swap(');
    expect(html).not.toContain('filters.Swapped(');
    expect(html).not.toContain('POOL_SWAPPED_EVENT_ABI');
  });

  it('USDC/EURC Swapped topic is still detected only by the indexer (not frontend)', () => {
    expect(idxSrc).toContain('SWAPPED_TOPIC');
    expect(idxSrc).toContain('detectSwapEventType');
  });
});

/* ── refresh=true forces server-side ingest (no duplicates) ───────── */
describe('refresh=true server-side ingest', () => {
  function makeProvider({ logs = [], latest = 20000 } = {}) {
    const calls = { getBlockNumber: 0, getLogs: 0 };
    return {
      calls,
      async getLogs(f) { calls.getLogs++; const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16); return logs.filter(l => l.blockNumber >= from && l.blockNumber <= to); },
      async getBlockNumber() { calls.getBlockNumber++; return latest; },
      async getBlock(n) { return { timestamp: 1700000000 + n }; },
    };
  }
  function makeHandler(provider, opts = {}) {
    let t = opts.t0 != null ? opts.t0 : 1700000000000;
    const inject = { makeProvider: () => provider, makeStore: () => Idx.createMemoryStore(), now: () => t };
    if (opts.cooldownMs != null) inject.cooldownMs = opts.cooldownMs;
    const handler = createPoolIndexHandler(inject);
    return { handler, setTime: (v) => { t = v; } };
  }
  function url(params) { return new URL('https://x/api/pool-index?pool=' + POOL + (params ? '&' + params : '')); }

  it('refresh=true bypasses cooldown and forces an ingest', async () => {
    const provider = makeProvider({ logs: [swappedLog(100, '0xtxR', 0, 1000000, 899200)] });
    const h = makeHandler(provider);

    await h.handler.handleGet(url(), {});            // ingest #1 (cold)
    expect(provider.calls.getBlockNumber).toBe(1);

    h.setTime(1700000000000 + 1000);                  // within cooldown
    await h.handler.handleGet(url(), {});            // no ingest
    expect(provider.calls.getBlockNumber).toBe(1);

    await h.handler.handleGet(url('refresh=true'), {}); // forced ingest
    expect(provider.calls.getBlockNumber).toBe(2);
  });

  it('refresh=true never duplicates events', async () => {
    const provider = makeProvider({ logs: [swappedLog(100, '0xtxD', 0, 1000000, 899200)] });
    const h = makeHandler(provider, { cooldownMs: 0 });
    await h.handler.handleGet(url(), {});
    const r1 = await (await h.handler.handleGet(url('refresh=true&includeEvents=true'), {})).json();
    const r2 = await (await h.handler.handleGet(url('refresh=true&includeEvents=true'), {})).json();
    expect(r1.eventCount).toBe(1);
    expect(r2.eventCount).toBe(1);
    expect(r1.events).toHaveLength(1);
    expect(r2.events).toHaveLength(1);
    expect(r1.events[0].txHash).toBe('0xtxD');
  });

  it('still respects confirmationDepth (does not ingest unconfirmed blocks)', async () => {
    // swap at block 19999, latest 20000, confirmationDepth 10 → boundary 19990
    const provider = makeProvider({ logs: [swappedLog(19999, '0xtxU', 0, 1000000, 899200)], latest: 20000 });
    const h = makeHandler(provider);
    const body = await (await h.handler.handleGet(url('refresh=true&includeEvents=true'), {})).json();
    // block 19999 is beyond the confirmed boundary → not indexed
    expect(body.eventCount).toBe(0);
  });
});

/* ── Real USDC/EURC fixture: 1 USDC → 0.9029 EURC ─────────────────── */
describe('Real validation fixture (1 USDC → 0.9029 EURC)', () => {
  it('normalizes Swapped to USDC→EURC with exact raw amounts', () => {
    const decode = Idx.createDecoder(iface, { token0Address: USDC, token1Address: EURC, token0Symbol: 'USDC', token1Symbol: 'EURC' });
    const ev = decode(swappedLog(57300180, '0x137ded2858430bb5dcf0d2e96d70d4ef073f3a9091e6ff7c8109d1f0306c657d', 0, 1000000, 902900));
    expect(ev.eventType).toBe('Swap');
    expect(ev.tokenIn).toBe('USDC');
    expect(ev.tokenOut).toBe('EURC');
    expect(ev.amountInRaw).toBe(1000000n); // 1 USDC (6 decimals)
    expect(ev.amountOutRaw).toBe(902900n); // 0.9029 EURC (6 decimals)
    expect(typeof ev.amountInRaw).toBe('bigint');
  });
});
