/**
 * POOL ANALYTICS CUTOVER — Phase 6.2.1 static regression guards.
 * ═══════════════════════════════════════════════════════════════════════════
 * These are guard-rail tests: they fail if the legacy authoritative analytics
 * patterns re-appear in index.html (Date.now() timestamp fallback, missing-price
 * → USD 0). They do NOT flag legitimate UI formatting or session tracking.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const idxSrc = fs.readFileSync(path.join(root, 'shared', 'poolIndexer.js'), 'utf8');

describe('Authoritative timestamp resolution (no Date.now fallback)', () => {
  it('index.html no longer uses `block.timestamp || now` fallback', () => {
    expect(html).not.toMatch(/block\.timestamp \|\| now/);
  });
  it('index.html no longer uses `.getBlock().catch(() => ({ timestamp: now }))`', () => {
    expect(html).not.toContain('({ timestamp: now })');
  });
  it('index.html uses a real block-timestamp helper returning null on failure', () => {
    expect(html).toContain('async function _eventBlockTs(ev)');
    expect(html).toContain('return (b && b.timestamp != null) ? Number(b.timestamp) : null');
  });
});

describe('Missing USD price is null, never 0 (authoritative analytics)', () => {
  it('no `usdVal = ... : 0` remains in index.html analytics', () => {
    expect(html).not.toMatch(/usdVal\s*=\s*rateIn !== null \? amountIn \* rateIn : 0/);
    expect(html).not.toMatch(/usdValue\s*=\s*tokenRate !== null \? amount \* tokenRate : 0/);
  });
  it('authoritative volume returns null (not 0) when the API data is unavailable', () => {
    expect(html).toContain('if (!a || !a.analytics) return null');
    expect(html).toContain('if (r0 === null || r1 === null) return null');
  });
  it('indexer computeVolume keeps usdVolume null without a price', () => {
    expect(idxSrc).toContain('usdVolume: usdVolume');
    expect(idxSrc).toContain('var usdVolume = null');
  });
});

describe('Session volume remains separated from authoritative volume', () => {
  it('session volume lives in a distinct namespace', () => {
    expect(html).toContain('SESSION_OBSERVED_VOLUME');
    expect(html).toContain('evt.sessionVolume24h');
    expect(html).toContain('getSessionObservedVolume24h');
  });
});

describe('USDC/EURC is a valid indexed swap pool (Swapped event)', () => {
  it('capability detection classifies swapped pools', () => {
    expect(idxSrc).toContain("SWAPPED: 'swapped'");
    expect(idxSrc).toContain('detectSwapEventType');
  });
});

describe('Frontend no longer independently indexes authoritative swap history', () => {
  it('no filters.Swap / filters.Swapped queryFilter in index.html', () => {
    expect(html).not.toContain('filters.Swap(');
    expect(html).not.toContain('filters.Swapped(');
    expect(html).not.toContain('POOL_SWAPPED_EVENT_ABI');
  });
  it('frontend consumes /api/pool-index as the authoritative source', () => {
    expect(html).toContain('/api/pool-index?pool=');
    expect(html).toContain('refreshAuthoritativeAnalytics');
    expect(html).toContain('fetchPoolAnalytics');
  });
  it('authoritative volume/fees return null when unavailable (never 0)', () => {
    expect(html).toContain('if (!a || !a.analytics) return null');
    expect(html).toContain('getPoolVolume24h');
  });
});

describe('BigInt raw amounts remain exact (no float in authoritative indexer)', () => {
  it('indexer has no parseFloat/Number on raw amounts', () => {
    expect(idxSrc).not.toMatch(/parseFloat/);
    expect(idxSrc).not.toMatch(/Number\(raw/);
  });
  it('indexer serializes BigInt as strings', () => {
    expect(idxSrc).toContain("if (typeof v === 'bigint') out[k] = v.toString()");
  });
});
