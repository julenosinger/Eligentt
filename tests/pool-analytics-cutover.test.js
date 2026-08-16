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
  it('volume reduction does not sum null as 0', () => {
    expect(html).toContain('const anyMissingPrice = evt.swaps.some');
    expect(html).toContain('evt.volume24h = anyMissingPrice ? null');
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
  it('indexPoolEvents supports the Swapped branch', () => {
    expect(html).toContain("poolCfg.swapEventType === 'swapped'");
    expect(html).toContain('POOL_SWAPPED_EVENT_ABI');
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
