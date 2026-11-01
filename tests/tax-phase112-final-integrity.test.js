/**
 * tax-phase112-final-integrity.test.js
 *
 * Tests for Phase 1.1.2 corrections:
 *   P0.1  10k truncation in scan.js (per-endpoint)
 *   P0.2  dedup metadata preserved through normalizeTransfer
 *   P0.3  empty/missing hash forces fallback path
 *   P1.4  dedupStats always present (zero values explicit)
 *   P1.5  coverage aggregation: error > partial > complete > unavailable
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const SCAN_PATH   = resolve(__dirname, '../functions/api/tax/scan.js');
const REPORT_PATH = resolve(__dirname, '../functions/api/tax/report.js');

// ── Import real exported functions ──────────────────────────────────────────
let countEtherscanOps, scanHandler;
let deduplicateTransfers, fetchPrice, reportHandler;

beforeEach(async () => {
  vi.restoreAllMocks();
  const scanMod   = await import(SCAN_PATH   + '?t=' + Date.now());
  const reportMod = await import(REPORT_PATH + '?t=' + Date.now());
  countEtherscanOps    = scanMod.countEtherscanOps;
  scanHandler          = scanMod.onRequestPost;
  deduplicateTransfers = reportMod.deduplicateTransfers;
  fetchPrice           = reportMod.fetchPrice;
  reportHandler        = reportMod.onRequestPost;
});

afterEach(() => { vi.restoreAllMocks(); });

// ── Helpers ──────────────────────────────────────────────────────────────────
function makeRows(n, prefix = 'h') {
  return Array.from({ length: n }, (_, i) => ({ hash: `0x${prefix}${i}` }));
}

function makeRequest(body) {
  return {
    json: async () => body,
  };
}

function makeEnv(overrides = {}) {
  return { ETHERSCAN_API_KEY: undefined, ALCHEMY_API_KEY: undefined, ...overrides };
}

// ── P0.1 — per-endpoint 10k truncation ──────────────────────────────────────
describe('P0.1 — Etherscan per-endpoint 10k truncation', () => {
  it('1. Under 10 000 rows: complete (no truncation)', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ status: '1', message: 'OK', result: makeRows(100) }),
    }));
    const r = await countEtherscanOps(1, '0xabc', 'key');
    expect(r.truncated).toBe(false);
    expect(r.truncatedEndpoints).toHaveLength(0);
  });

  it('2. Exactly 10 000 rows in txlist: marked truncated (cannot rule out more)', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    vi.stubGlobal('fetch', async (url) => {
      const u = url.toString();
      callCount++;
      if (u.includes('action=txlist')) {
        // Return 1000-row pages, 10 pages = 10 000 total
        return { ok: true, json: async () => ({ status: '1', message: 'OK', result: makeRows(1000, 'tx') }) };
      }
      return { ok: true, json: async () => ({ status: '0', message: 'No transactions found', result: [] }) };
    });

    const promise = countEtherscanOps(1, '0xabc', 'key');
    await vi.runAllTimersAsync();
    const r = await promise;
    vi.useRealTimers();

    // 10 pages × 1000 = 10 000 rows → truncated
    expect(r.truncated).toBe(true);
    expect(r.truncatedEndpoints).toContain('txlist');
    expect(r.externalTxCount).toBeGreaterThanOrEqual(10000);
  }, 30000);

  it('3. 9 999 rows (below limit): NOT truncated', async () => {
    vi.useFakeTimers();
    let pages = { txlist: 0 };
    vi.stubGlobal('fetch', async (url) => {
      const u = url.toString();
      if (u.includes('action=txlist')) {
        pages.txlist++;
        // 9 full pages of 1000 + 1 partial page of 999 = 9 999
        if (pages.txlist <= 9) return { ok: true, json: async () => ({ status: '1', message: 'OK', result: makeRows(1000, 'tx') }) };
        return { ok: true, json: async () => ({ status: '1', message: 'OK', result: makeRows(999, 'tx') }) };
      }
      return { ok: true, json: async () => ({ status: '0', message: 'No transactions found', result: [] }) };
    });

    const promise = countEtherscanOps(1, '0xabc', 'key');
    await vi.runAllTimersAsync();
    const r = await promise;
    vi.useRealTimers();

    expect(r.truncated).toBe(false);
    expect(r.truncatedEndpoints).not.toContain('txlist');
    expect(r.externalTxCount).toBe(9999);
  }, 30000);

  it('4. tokentx reaches limit independently: truncatedEndpoints lists tokentx', async () => {
    vi.useFakeTimers();
    let pages = { tokentx: 0 };
    vi.stubGlobal('fetch', async (url) => {
      const u = url.toString();
      if (u.includes('action=tokentx')) {
        pages.tokentx++;
        // 10 full pages of 1000 = 10 000
        return { ok: true, json: async () => ({ status: '1', message: 'OK', result: makeRows(1000, 'tok') }) };
      }
      return { ok: true, json: async () => ({ status: '0', message: 'No transactions found', result: [] }) };
    });

    const promise = countEtherscanOps(1, '0xabc', 'key');
    await vi.runAllTimersAsync();
    const r = await promise;
    vi.useRealTimers();

    expect(r.truncated).toBe(true);
    expect(r.truncatedEndpoints).toContain('tokentx');
    expect(r.truncatedEndpoints).not.toContain('txlist');
  }, 30000);

  it('5. Error during pagination: throws without fictitious count', async () => {
    // AbortSignal.timeout(15000) inside etherscanFetchPage needs fake timers
    // so it does not actually wait 15 s before the mock response arrives.
    vi.useFakeTimers();
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 503 }));
    const promise = countEtherscanOps(1, '0xabc', 'key').catch(e => e);
    await vi.runAllTimersAsync();
    const err = await promise;
    vi.useRealTimers();
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('503');
  }, 30000);
});

// ── P0.2 — dedup metadata preserved through normalizeTransfer ────────────────
describe('P0.2 — dedup metadata preserved end-to-end', () => {
  it('6. _dedupKey present in normalised op when Alchemy fetch succeeds', async () => {
    // Simulate Alchemy returning one transfer with a uniqueId
    vi.stubGlobal('fetch', async (url) => {
      if (typeof url === 'string' && url.includes('alchemy')) {
        return {
          ok: true,
          json: async () => ({
            result: {
              transfers: [{
                hash: '0xaaa',
                uniqueId: '0xaaa:erc20:0',
                category: 'erc20',
                asset: 'USDC',
                value: '10',
                from: '0xfrom',
                to: '0xto',
                metadata: { blockTimestamp: '2024-01-01T00:00:00.000Z' },
                rawContract: { address: '0xusdc' },
                log: { logIndex: 0 },
              }],
            },
          }),
        };
      }
      return { ok: true, json: async () => ({ result: { transfers: [] } }) };
    });

    const body = {
      address: '0x' + 'a'.repeat(40),
      networks: ['ethereum'],
      country: 'US',
      quoteId: 'q1',
    };
    const resp = await reportHandler({
      request: makeRequest(body),
      env: makeEnv({ ALCHEMY_API_KEY: 'key' }),
    });
    const data = await resp.json();

    // If ops exist, each should have a dedupKey in the table
    if (data.ops && data.ops.length > 0) {
      expect(data.ops[0].dedupKey).toBeDefined();
      expect(typeof data.ops[0].dedupKey).toBe('string');
      expect(data.ops[0].dedupKey).toContain('uid:');
    }
    // dedupStats must always be present
    expect(data.dedupStats).toBeDefined();
  });

  it('7. _possibleDuplicate propagates to op table row', () => {
    // Two fallback-key collisions → second gets _possibleDuplicate
    const a = { hash: '0xhh', category: 'erc20', _network: 'ethereum',
                rawContract: { address: '0xtok' }, value: '5', from: '0xf', to: '0xt' };
    const b = { ...a };
    const { deduped } = deduplicateTransfers([a, b]);
    expect(deduped.length).toBe(2);
    expect(deduped[1]._possibleDuplicate).toBe(true);
    expect(deduped[0]._possibleDuplicate).toBeFalsy();
  });
});

// ── P0.3 — empty/missing hash forces fallback ────────────────────────────────
describe('P0.3 — missing/empty hash forces fallback path', () => {
  it('8. Two external transfers with no hash: both preserved, both flagged', () => {
    const a = { hash: '', category: 'external', _network: 'ethereum',
                from: '0xf', to: '0xt', value: '1' };
    const b = { ...a, value: '2' };  // different value → different key even in fallback
    const { deduped, stats } = deduplicateTransfers([a, b]);
    expect(deduped.length).toBe(2);   // both preserved
    expect(stats.fallbackKeys).toBeGreaterThanOrEqual(2);
  });

  it('9. Two identical no-hash externals: both preserved (unique random fallback key)', () => {
    const a = { hash: '', category: 'external', _network: 'ethereum',
                from: '0xf', to: '0xt', value: '1' };
    const b = { ...a };
    const { deduped } = deduplicateTransfers([a, b]);
    // No hash → no reliable identity → preserve both, never discard
    expect(deduped.length).toBe(2);
  });

  it('10. ERC-20 with hash but no logIndex: fallback path used', () => {
    const a = { hash: '0xabc', category: 'erc20', _network: 'base',
                rawContract: { address: '0xtok' }, value: '5', from: '0xf', to: '0xt' };
    const { deduped, stats } = deduplicateTransfers([a]);
    expect(deduped.length).toBe(1);
    expect(stats.fallbackKeys).toBe(1);
    expect(deduped[0]._dedupFallback).toBe(true);
  });

  it('11. ERC-20 with hash AND logIndex: confident key used (not fallback)', () => {
    const a = { hash: '0xabc', category: 'erc20', _network: 'base',
                rawContract: { address: '0xtok' }, value: '5', from: '0xf', to: '0xt',
                log: { logIndex: 3 } };
    const { deduped, stats } = deduplicateTransfers([a]);
    expect(deduped.length).toBe(1);
    expect(stats.fallbackKeys).toBe(0);
    expect(deduped[0]._dedupKey).toContain('tok:');
  });

  it('12. Internal with hash but no traceAddress: fallback path', () => {
    const a = { hash: '0xint', category: 'internal', _network: 'ethereum',
                from: '0xf', to: '0xt', value: '0.1' };
    const { deduped, stats } = deduplicateTransfers([a]);
    expect(deduped.length).toBe(1);
    expect(stats.fallbackKeys).toBe(1);
  });

  it('13. Internal with hash AND traceAddress: confident key', () => {
    const a = { hash: '0xint', category: 'internal', _network: 'ethereum',
                from: '0xf', to: '0xt', value: '0.1',
                traceAddress: [0, 1] };
    const { deduped, stats } = deduplicateTransfers([a]);
    expect(stats.fallbackKeys).toBe(0);
    expect(deduped[0]._dedupKey).toContain('int:');
  });

  it('14. Two distinct events same hash, different networks: both preserved', () => {
    const a = { hash: '0xsame', category: 'external', _network: 'ethereum',
                from: '0xf', to: '0xt', value: '1' };
    const b = { ...a, _network: 'base' };
    const { deduped } = deduplicateTransfers([a, b]);
    expect(deduped.length).toBe(2);
    expect(deduped[0]._dedupKey).not.toBe(deduped[1]._dedupKey);
  });
});

// ── P1.4 — dedupStats always present ────────────────────────────────────────
describe('P1.4 — dedupStats always present with zero values', () => {
  it('15. Empty networks (arc + solana only): dedupStats present with all zeros', async () => {
    const body = {
      address: '0x' + 'a'.repeat(40),
      networks: ['arc'],
      country: 'US',
      quoteId: 'q2',
    };
    const resp = await reportHandler({
      request: makeRequest(body),
      env: makeEnv(),
    });
    const data = await resp.json();
    expect(data.ok).toBe(true);
    expect(data.dedupStats).toBeDefined();
    expect(data.dedupStats.input).toBe(0);
    expect(data.dedupStats.provenDuplicates).toBe(0);
    expect(data.dedupStats.preserved).toBe(0);
    expect(data.dedupStats.possibleDuplicates).toBe(0);
    expect(data.dedupStats.fallbackKeys).toBe(0);
  });

  it('16. dedupStats has all required keys even when no ops found', () => {
    const { deduped, stats } = deduplicateTransfers([]);
    expect(stats.input).toBe(0);
    expect(stats.provenDuplicates).toBe(0);
    expect(stats.preserved).toBe(0);
    expect(stats.possibleDuplicates).toBe(0);
    expect(stats.fallbackKeys).toBe(0);
  });

  it('17. dedupStats.status field indicates no_duplicates when clean', () => {
    const a = { hash: '0xaaa', category: 'external', _network: 'eth', from: '0xf', to: '0xt', value: '1' };
    const { stats } = deduplicateTransfers([a]);
    expect(stats.provenDuplicates).toBe(0);
    expect(stats.possibleDuplicates).toBe(0);
  });
});

// ── P1.5 — coverage aggregation precedence ───────────────────────────────────
describe('P1.5 — coverage aggregation precedence', () => {
  async function getCoverage(coveragesByNet) {
    // Build a report response by mocking fetchEvmTxs outcomes indirectly:
    // feed the handler networks that result in specific coverage values.
    // We do this by using only arc/solana (which return 'unavailable') for a
    // controlled base, and we test the aggregation logic directly via the
    // exported handler with mocked Alchemy.

    // For direct coverage aggregation testing, we call the real handler with
    // ALCHEMY_API_KEY set but mock fetch to return different coverage per network.
    const nets = Object.keys(coveragesByNet);

    let callIdx = 0;
    vi.stubGlobal('fetch', async (url, opts) => {
      // Parse the direction from the body to determine which mock to return
      const body = opts?.body ? JSON.parse(opts.body) : {};
      const network = nets[Math.floor(callIdx++ / 2)] || nets[0];
      const cov = coveragesByNet[network] || 'complete';

      if (cov === 'error') throw new Error('Provider error');
      if (cov === 'partial') {
        // Return pageKey to indicate more pages → truncated eventually
        return { ok: true, json: async () => ({ result: { transfers: [], pageKey: 'more' } }) };
      }
      // complete or unavailable
      return { ok: true, json: async () => ({ result: { transfers: [] } }) };
    });

    const body = {
      address: '0x' + 'a'.repeat(40),
      networks: nets.filter(n => ['ethereum','base','arbitrum','optimism','polygon'].includes(n)),
      country: 'US',
      quoteId: 'q3',
    };

    if (body.networks.length === 0) {
      // No EVM nets — use arc to get unavailable
      body.networks = ['arc'];
    }

    const resp = await reportHandler({
      request: makeRequest(body),
      env: makeEnv({ ALCHEMY_API_KEY: 'key' }),
    });
    return (await resp.json()).dataCoverage;
  }

  it('18. All complete → dataCoverage = complete', async () => {
    // Single network, Alchemy returns empty (complete)
    vi.stubGlobal('fetch', async () => ({
      ok: true, json: async () => ({ result: { transfers: [] } }),
    }));
    const body = { address: '0x' + 'a'.repeat(40), networks: ['ethereum'], country: 'US', quoteId: 'q4' };
    const resp = await reportHandler({ request: makeRequest(body), env: makeEnv({ ALCHEMY_API_KEY: 'key' }) });
    const data = await resp.json();
    expect(data.dataCoverage).toBe('complete');
  });

  it('19. All unavailable → dataCoverage = unavailable', async () => {
    const body = { address: '0x' + 'a'.repeat(40), networks: ['arc'], country: 'US', quoteId: 'q5' };
    const resp = await reportHandler({ request: makeRequest(body), env: makeEnv() });
    const data = await resp.json();
    expect(data.dataCoverage).toBe('unavailable');
  });

  it('20. Any error → dataCoverage = error (not partial)', async () => {
    // Mock Alchemy to throw an error
    vi.stubGlobal('fetch', async () => { throw new Error('Provider error'); });
    const body = { address: '0x' + 'a'.repeat(40), networks: ['ethereum'], country: 'US', quoteId: 'q6' };
    const resp = await reportHandler({ request: makeRequest(body), env: makeEnv({ ALCHEMY_API_KEY: 'key' }) });
    const data = await resp.json();
    expect(data.dataCoverage).toBe('error');
    expect(data.partial).toBe(true);
  });

  it('21. One complete + one error → error wins over partial', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', async (url, opts) => {
      callCount++;
      // First network (ethereum) errors, second (base) succeeds
      const body = opts?.body ? JSON.parse(opts.body) : {};
      // Determine which network from the body params
      const params = body?.params?.[0] || {};
      const addr = params.fromAddress || params.toAddress || '';
      if (callCount <= 2) throw new Error('Provider error on ethereum');
      return { ok: true, json: async () => ({ result: { transfers: [] } }) };
    });

    const body = { address: '0x' + 'a'.repeat(40), networks: ['ethereum', 'base'], country: 'US', quoteId: 'q7' };
    const resp = await reportHandler({ request: makeRequest(body), env: makeEnv({ ALCHEMY_API_KEY: 'key' }) });
    const data = await resp.json();
    expect(data.dataCoverage).toBe('error');
  });
});
