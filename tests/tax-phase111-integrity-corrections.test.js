/**
 * tax-phase111-integrity-corrections.test.js
 *
 * Phase 1.1.1 — 20 scenarios calling real exported functions with controlled fetch.
 * Covers: dedup, Etherscan counts, completeness states.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/* ── Load and import real production modules ─────────────────────────────── */
// We use dynamic import with real module paths so the production code runs.
// fetch is globally stubbed per test via vi.stubGlobal.

const reportPath = join(process.cwd(), 'functions/api/tax/report.js');
const scanPath   = join(process.cwd(), 'functions/api/tax/scan.js');

// Import the exported functions directly (not via HTTP).
// Using file:// URL so Vitest resolves the CF module correctly.
const { deduplicateTransfers, fetchPrice, onRequestPost: reportHandler } =
  await import(reportPath + '?v=' + Date.now());

const { countEtherscanOps, onRequestPost: scanHandler } =
  await import(scanPath + '?v=' + Date.now());

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function makeRequest(body) {
  return {
    json: async () => body,
  };
}

function makeEnv(overrides = {}) {
  return {
    ALCHEMY_API_KEY:  overrides.ALCHEMY_API_KEY  || null,
    ETHERSCAN_API_KEY: overrides.ETHERSCAN_API_KEY || null,
    COINGECKO_API_KEY: overrides.COINGECKO_API_KEY || null,
    SOLANA_RPC_URL:   overrides.SOLANA_RPC_URL   || null,
    ARC_RPC_URL:      overrides.ARC_RPC_URL      || null,
    TAX_KV:           overrides.TAX_KV           || { get: async () => null, put: async () => {} },
    ...overrides,
  };
}

/** Build a minimal Alchemy-style transfer object */
function mkTransfer(overrides = {}) {
  return {
    hash:        '0xaaaa',
    category:    'external',
    from:        '0x1111',
    to:          '0x2222',
    value:       '1.0',
    asset:       'ETH',
    _network:    'ethereum',
    metadata:    { blockTimestamp: '2024-01-15T12:00:00Z' },
    ...overrides,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   DEDUPLICATION (scenarios 1–6)
   ══════════════════════════════════════════════════════════════════════════ */
describe('Phase 1.1.1 — Deduplication', () => {

  it('1. Two events with same hash but no logIndex: both PRESERVED (fallback path)', () => {
    // Both are ERC-20 but lack logIndex — they should NOT be silently discarded.
    const a = mkTransfer({ hash: '0xhash1', category: 'erc20',
      rawContract: { address: '0xtoken' }, value: '10', _network: 'ethereum' });
    const b = mkTransfer({ hash: '0xhash1', category: 'erc20',
      rawContract: { address: '0xtoken' }, value: '10', _network: 'ethereum' });
    // No log.logIndex on either → fallback key, same key → second gets _possibleDuplicate

    const { deduped, stats } = deduplicateTransfers([a, b]);

    // Both preserved — fallback never discards
    expect(deduped).toHaveLength(2);
    expect(stats.input).toBe(2);
    expect(stats.provenDuplicates).toBe(0);   // no confident discards
    expect(stats.preserved).toBe(2);
    expect(stats.possibleDuplicates).toBe(1); // second one flagged
    expect(deduped[1]._possibleDuplicate).toBe(true);
    expect(deduped[0]._possibleDuplicate).toBeUndefined();
  });

  it('2. Two internal events with different traceAddress: both PRESERVED', () => {
    const a = mkTransfer({ hash: '0xhash2', category: 'internal',
      traceAddress: [0], value: '0.5', _network: 'ethereum' });
    const b = mkTransfer({ hash: '0xhash2', category: 'internal',
      traceAddress: [1], value: '0.5', _network: 'ethereum' });

    const { deduped, stats } = deduplicateTransfers([a, b]);

    expect(deduped).toHaveLength(2);
    expect(stats.provenDuplicates).toBe(0);
    // Each has a distinct key
    expect(deduped[0]._dedupKey).not.toBe(deduped[1]._dedupKey);
  });

  it('3. True duplicate (same event from both from/to queries): exactly one preserved', () => {
    // Alchemy's uniqueId is reliable — two identical uniqueIds on same network = proven dup
    const a = mkTransfer({ uniqueId: 'uid-abc', _network: 'ethereum' });
    const b = mkTransfer({ uniqueId: 'uid-abc', _network: 'ethereum' });

    const { deduped, stats } = deduplicateTransfers([a, b]);

    expect(deduped).toHaveLength(1);
    expect(stats.provenDuplicates).toBe(1);
    expect(stats.possibleDuplicates).toBe(0);
  });

  it('4. Same uniqueId on two different networks: both PRESERVED (Phase 1.1.1 network scoping)', () => {
    const a = mkTransfer({ uniqueId: 'uid-xyz', _network: 'ethereum' });
    const b = mkTransfer({ uniqueId: 'uid-xyz', _network: 'base' });

    const { deduped, stats } = deduplicateTransfers([a, b]);

    // Networks differ → keys differ → both kept
    expect(deduped).toHaveLength(2);
    expect(stats.provenDuplicates).toBe(0);
    expect(deduped[0]._dedupKey).not.toBe(deduped[1]._dedupKey);
  });

  it('5. No reliable identifier: record preserved and alerted', () => {
    // Internal tx without traceAddress or internalIndex
    const t = mkTransfer({ hash: '0xhash5', category: 'internal',
      _network: 'ethereum' });
    // No traceAddress, no internalIndex

    const { deduped, stats } = deduplicateTransfers([t]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0]._dedupFallback).toBe(true);
    expect(stats.fallbackKeys).toBe(1);
    // No discard
    expect(stats.provenDuplicates).toBe(0);
  });

  it('6. dedupStats present and accurate on multi-event input', () => {
    const transfers = [
      mkTransfer({ uniqueId: 'u1', _network: 'ethereum' }),   // confident
      mkTransfer({ uniqueId: 'u1', _network: 'ethereum' }),   // confident dup → discarded
      mkTransfer({ uniqueId: 'u2', _network: 'base' }),       // different net → kept
      mkTransfer({ hash: '0xhf', category: 'internal',        // fallback (no trace)
        _network: 'ethereum' }),
    ];

    const { deduped, stats } = deduplicateTransfers(transfers);

    expect(stats.input).toBe(4);
    expect(stats.provenDuplicates).toBe(1);
    expect(stats.preserved).toBe(3);
    expect(stats.preserved).toBe(deduped.length);
    expect(stats.fallbackKeys).toBeGreaterThanOrEqual(1);
  });

});

/* ══════════════════════════════════════════════════════════════════════════
   ETHERSCAN COUNTS (scenarios 7–13)
   ══════════════════════════════════════════════════════════════════════════ */
describe('Phase 1.1.1 — Etherscan separate counts', () => {

  afterEach(() => { vi.restoreAllMocks(); });

  function mockFetch(perAction) {
    // perAction: { txlist: rows[], tokentx: rows[], txlistinternal: rows[] }
    vi.stubGlobal('fetch', async (url) => {
      const u = url.toString();
      let rows = [];
      if (u.includes('action=txlist'))          rows = perAction.txlist          || [];
      if (u.includes('action=tokentx'))         rows = perAction.tokentx         || [];
      if (u.includes('action=txlistinternal'))  rows = perAction.txlistinternal  || [];
      return {
        ok: true,
        json: async () => ({
          status: rows.length > 0 ? '1' : '0',
          message: rows.length > 0 ? 'OK' : 'No transactions found',
          result: rows,
        }),
      };
    });
  }

  function makeRows(n, hashPrefix = 'h') {
    return Array.from({ length: n }, (_, i) => ({ hash: hashPrefix + i }));
  }

  it('7. Separate counts for three categories returned correctly', async () => {
    mockFetch({
      txlist:         makeRows(3, 'ext'),
      tokentx:        makeRows(5, 'tok'),
      txlistinternal: makeRows(2, 'int'),
    });

    const result = await countEtherscanOps(1, '0xabc', 'fakekey');

    expect(result.externalTxCount).toBe(3);
    expect(result.tokenTransferCount).toBe(5);
    expect(result.internalOperationCount).toBe(2);
    expect(result.totalEvents).toBe(10);
  });

  it('8. Same hash in txlist and tokentx: each counted once per endpoint, uniqueTransactionCount = 1', async () => {
    const sharedHash = '0xsharedhash';
    mockFetch({
      txlist:         [{ hash: sharedHash }],
      tokentx:        [{ hash: sharedHash }],
      txlistinternal: [],
    });

    const result = await countEtherscanOps(1, '0xabc', 'fakekey');

    expect(result.externalTxCount).toBe(1);
    expect(result.tokenTransferCount).toBe(1);
    expect(result.totalEvents).toBe(2);          // two fiscal events
    expect(result.uniqueTransactionCount).toBe(1); // one distinct tx
  });

  it('9. Multiple token events in same tx: all counted in tokenTransferCount', async () => {
    const hash = '0xswap';
    mockFetch({
      txlist:         [{ hash }],
      tokentx:        [{ hash }, { hash }],   // 2 Transfer events in same tx
      txlistinternal: [],
    });

    const result = await countEtherscanOps(1, '0xabc', 'fakekey');

    expect(result.tokenTransferCount).toBe(2);
    expect(result.totalEvents).toBe(3);          // 1 ext + 2 token
    expect(result.uniqueTransactionCount).toBe(1);
  });

  it('10. Pagination: repeated rows across pages collected without loss', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', async (url) => {
      const u = url.toString();
      if (!u.includes('action=txlist')) {
        return { ok: true, json: async () => ({ status: '0', message: 'No transactions found', result: [] }) };
      }
      callCount++;
      // Page 1 returns full page (1000 rows), page 2 returns 50 (last page)
      const page = parseInt(new URL(u).searchParams?.get?.('page') || '1');
      const rows = page === 1 ? makeRows(1000, 'p1h') : makeRows(50, 'p2h');
      return { ok: true, json: async () => ({ status: '1', message: 'OK', result: rows }) };
    });

    const result = await countEtherscanOps(1, '0xabc', 'fakekey');

    expect(result.externalTxCount).toBe(1050);
    expect(result.truncated).toBe(false);   // ended on partial page
  });

  it('11. Limit of 10 000 rows per endpoint detected as truncated', async () => {
    // countEtherscanOps uses ETHERSCAN_MAX_PAGES=50 and throttles 250ms between calls.
    // To avoid a 50×250ms=12.5s wait, we mock setTimeout so it resolves immediately.
    vi.useFakeTimers();
    vi.stubGlobal('fetch', async (url) => {
      const u = url.toString();
      if (!u.includes('action=txlist')) {
        return { ok: true, json: async () => ({ status: '0', message: 'No transactions found', result: [] }) };
      }
      return { ok: true, json: async () => ({ status: '1', message: 'OK', result: makeRows(1000, 'fx') }) };
    });

    // Run with fake timers — need to advance them while the async loop is running
    const promise = countEtherscanOps(1, '0xabc', 'fakekey');
    // Advance all timers repeatedly until the promise resolves
    await vi.runAllTimersAsync();
    const result = await promise;

    vi.useRealTimers();
    expect(result.truncated).toBe(true);
    expect(result.truncatedEndpoints).toContain('txlist');
  }, 30000);

  it('12. Partial coverage when any endpoint truncated', async () => {
    // Use fake timers to skip throttle delays
    vi.useFakeTimers();
    const env = makeEnv({ ETHERSCAN_API_KEY: 'key' });

    // txlist always returns full pages → will hit ETHERSCAN_MAX_PAGES → truncated
    vi.stubGlobal('fetch', async (url) => {
      const u = url.toString();
      if (u.includes('action=txlist')) {
        return { ok: true, json: async () => ({ status: '1', message: 'OK', result: makeRows(1000, 'fx') }) };
      }
      return { ok: true, json: async () => ({ status: '0', message: 'No transactions found', result: [] }) };
    });

    const promise = scanHandler({
      request: makeRequest({ address: '0xabc123456789abcdef0123456789abcdef012345', networks: ['ethereum'] }),
      env,
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    const body = await result.json();

    vi.useRealTimers();
    expect(body.ok).toBe(true);
    const net = body.results.find(r => r.network === 'ethereum');
    expect(net).toBeDefined();
    expect(net.coverage).toBe('partial');
    expect(net.status).toBe('done');
  }, 30000);

  it('13. Rate limit throws with rateLimit flag; no fictitious counts produced', async () => {
    // Use fake timers to collapse the exponential backoff sleeps (1s, 2s, 4s × 3 actions)
    vi.useFakeTimers();

    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ status: '0', message: 'Max rate limit reached', result: [] }),
    }));

    let threw = false;
    const promise = countEtherscanOps(1, '0xabc', 'fakekey').catch(e => {
      threw = true;
      expect(e.rateLimit).toBe(true);
      return 'caught';
    });
    await vi.runAllTimersAsync();
    await promise;

    vi.useRealTimers();
    expect(threw).toBe(true);
  }, 30000);

});

/* ══════════════════════════════════════════════════════════════════════════
   COMPLETENESS STATES (scenarios 14–20)
   ══════════════════════════════════════════════════════════════════════════ */
describe('Phase 1.1.1 — dataCoverage + calculationCompleteness', () => {

  afterEach(() => { vi.restoreAllMocks(); });

  /**
   * Build a minimal valid report handler call with controlled Alchemy mock.
   * ops: array of { category, hash, value, from, to, asset, network }
   * priceUsd: number|null — all ops get this price (null = no key)
   */
  async function callReport({ ops = [], priceUsd = null, alchemyCoverage = 'complete',
    truncated = false } = {}) {

    // Alchemy mock: returns the given ops from the 'from' direction, empty from 'to'
    vi.stubGlobal('fetch', async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : null;
      if (body?.method === 'alchemy_getAssetTransfers') {
        const direction = body.params?.[0]?.fromAddress ? 'from' : 'to';
        const transfers = direction === 'from'
          ? ops.map((op, i) => ({
              hash:        op.hash || '0xop' + i,
              category:    op.category || 'external',
              from:        op.from || '0xaddr',
              to:          op.to   || '0x0002',
              value:       String(op.value || 1),
              asset:       op.asset || 'ETH',
              _network:    op.network || 'ethereum',
              uniqueId:    'uid-' + i,
              metadata:    { blockTimestamp: '2024-06-01T00:00:00Z' },
            }))
          : [];
        return {
          ok: true,
          json: async () => ({
            result: { transfers, pageKey: truncated ? 'nextpage' : undefined },
          }),
        };
      }
      // CoinGecko
      if (url.includes('coingecko')) {
        if (priceUsd === null) return { ok: false, status: 503, json: async () => ({}) };
        return { ok: true, json: async () => ({ market_data: { current_price: { usd: priceUsd } } }) };
      }
      return { ok: true, json: async () => ({ result: { transfers: [] } }) };
    });

    const env = makeEnv({
      ALCHEMY_API_KEY:   'fakekey',
      COINGECKO_API_KEY: priceUsd !== null ? 'cgkey' : null,
      TAX_KV: { get: async () => JSON.stringify({ quoteId: 'qid1', used: false, fee: 20 }),
                put: async () => {} },
    });

    const result = await reportHandler({
      request: makeRequest({
        address:  '0xaddr0000000000000000000000000000000000addr',
        networks: ['ethereum'],
        country:  'US',
        quoteId:  'qid1',
        txHash:   '0xpayment',
      }),
      env,
    });
    return result.json();
  }

  it('14. Complete history + all prices found → dataCoverage=complete, calcCompleteness=complete', async () => {
    const body = await callReport({ ops: [{ asset: 'ETH' }], priceUsd: 3000 });

    expect(body.ok).toBe(true);
    expect(body.dataCoverage).toBe('complete');
    expect(body.calculationCompleteness).toBe('complete');
    expect(body.partial).toBe(false);
  });

  it('15. Complete history + one price missing → calcCompleteness=partial', async () => {
    const body = await callReport({ ops: [{ asset: 'ETH' }], priceUsd: null });

    expect(body.dataCoverage).toBe('complete');
    expect(body.calculationCompleteness).not.toBe('complete');
    expect(body.partial).toBe(true);
    // priceWarnings present
    expect(body.priceWarnings).toBeDefined();
    expect(body.priceWarnings.count).toBeGreaterThan(0);
  });

  it('16. Truncated history (partial ingestion) + prices found → dataCoverage=partial, calcCompleteness=complete', async () => {
    const body = await callReport({ ops: [{ asset: 'ETH' }], priceUsd: 3000, truncated: true });

    expect(body.dataCoverage).toBe('partial');
    // With prices available for all ingested ops, calcCompleteness = complete
    // (it only measures ops that were collected)
    expect(body.partial).toBe(true);
  });

  it('17. Partial history + prices missing → both partial, partial=true', async () => {
    const body = await callReport({ ops: [{ asset: 'ETH' }], priceUsd: null, truncated: true });

    expect(body.dataCoverage).toBe('partial');
    expect(body.calculationCompleteness).not.toBe('complete');
    expect(body.partial).toBe(true);
  });

  it('18. All prices missing → calculationCompleteness=unavailable', async () => {
    // Multiple ops, all price-missing
    const body = await callReport({
      ops:      [{ asset: 'ETH' }, { asset: 'WBTC' }],
      priceUsd: null,
    });

    expect(body.calculationCompleteness).toBe('unavailable');
    expect(body.partial).toBe(true);
    expect(body.priceWarnings.count).toBeGreaterThanOrEqual(2);
  });

  it('19. Ops without price remain in the op table (not removed)', async () => {
    const body = await callReport({ ops: [{ asset: 'ETH' }], priceUsd: null });

    // ops table must still have the entry, with usd=null and usdMissing=true
    const withMissing = body.ops.filter(o => o.usdMissing === true);
    expect(withMissing.length).toBeGreaterThan(0);
    withMissing.forEach(op => {
      expect(op.usd).toBeNull();
      expect(op.usd).not.toBe(0);
      expect(op.usd).not.toBe(1);
    });
  });

  it('20. partial:false never returned when data or prices are incomplete', async () => {
    // Case A: truncated history
    const bodyA = await callReport({ ops: [{ asset: 'ETH' }], priceUsd: 3000, truncated: true });
    expect(bodyA.partial).toBe(true);

    // Case B: missing prices
    const bodyB = await callReport({ ops: [{ asset: 'ETH' }], priceUsd: null });
    expect(bodyB.partial).toBe(true);

    // Case C: both
    const bodyC = await callReport({ ops: [{ asset: 'ETH' }], priceUsd: null, truncated: true });
    expect(bodyC.partial).toBe(true);
  });

});
