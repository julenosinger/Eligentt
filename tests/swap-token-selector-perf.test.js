/**
 * swap-token-selector-perf.test.js
 * ═══════════════════════════════════════════════════════════════════════
 * Guards the slow "Select Input/Output Token" fix:
 *
 *   1. The LI.FI tokens proxy must filter by `chains` (not pull the entire EVM
 *      catalog ~4MB) — the root cause of the slow load.
 *   2. The Swap page prefetches the token catalog for every supported chain in
 *      the background, so the selector opens instantly.
 *   3. An empty LI.FI result triggers the local-registry fallback (`.length`).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const tokensCF = fs.readFileSync(path.join(root, 'functions', 'api', 'lifi', 'tokens.js'), 'utf8');

describe('LI.FI tokens proxy — chain-filtered fetch', () => {
  it('sets the `chains` query param (no full EVM catalog)', () => {
    expect(tokensCF).toContain("searchParams.set('chains', requestedChains.join(','))");
  });

  it('keeps the chain-type filter + allowlist + cache intact', () => {
    expect(tokensCF).toContain("searchParams.set('chainTypes', 'EVM')");
    expect(tokensCF).toContain('ALLOWED_CHAIN_IDS');
    expect(tokensCF).toContain('caches.default');
    expect(tokensCF).toContain('CACHE_TTL_SECONDS');
  });
});

describe('Swap page — token catalog prefetch', () => {
  it('defines swapPrefetchTokens()', () => {
    expect(html).toContain('function swapPrefetchTokens()');
  });

  it('prefetches all supported chains in the background', () => {
    const fn = html.slice(html.indexOf('function swapPrefetchTokens()'), html.indexOf('function _swpClearBalCache'));
    expect(fn).toContain('LiFiAdapter.getTokens');
    expect(fn).toContain('[5042, 1, 8453, 42161, 10, 137]');
  });

  it('wires the prefetch on Swap page open', () => {
    expect(html).toContain("if (typeof swapPrefetchTokens === 'function') swapPrefetchTokens();");
  });
});

describe('Token selector — fallback on empty LI.FI result', () => {
  it('falls back to the local registry only when the list is empty (.length)', () => {
    expect(html).toContain("res.tokens[chainId] && res.tokens[chainId].length");
  });
});
