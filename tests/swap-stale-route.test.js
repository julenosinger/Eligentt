/**
 * swap-stale-route.test.js
 * ═══════════════════════════════════════════════════════════════════════
 * Guards the fix for the intermittent `LI.FI route rejected: from_token_mismatch`:
 *
 * A route selected from getRoutes needs getStepTransaction to resolve calldata.
 * That fetch is ASYNC — if the user changes token/network before it completes,
 * the resolved step (bound to the OLD token) must NOT be applied to
 * SWP._towerQuoteData, or execution later fails with from_token_mismatch.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

describe('swpSelectRoute — stale async resolution guard', () => {
  it('defines a selection signature helper (_swpSelSig)', () => {
    expect(html).toContain('function _swpSelSig()');
  });

  it('captures the selection signature before fetching the step', () => {
    const fn = html.slice(html.indexOf('function swpSelectRoute(source)'), html.indexOf('function swpApplySelectedQuote('));
    expect(fn).toContain('var selSig = _swpSelSig();');
    expect(fn.indexOf('var selSig = _swpSelSig();')).toBeLessThan(fn.indexOf('LiFiAdapter.getStepTransaction(step)'));
  });

  it('discards the resolved step when the selection changed', () => {
    const fn = html.slice(html.indexOf('function swpSelectRoute(source)'), html.indexOf('function swpApplySelectedQuote('));
    expect(fn).toContain('if (_swpSelSig() !== selSig) return;');
  });
});

describe('swpExecuteLiFi — clear message on token/network mismatch', () => {
  it('maps token/chain mismatch to a clear "stale quote" message', () => {
    const fn = html.slice(html.indexOf('async function swpExecuteLiFi('), html.indexOf('// ── Execute Swap'));
    expect(fn).toContain("Quote is stale (token/network changed) — refresh and try again");
    expect(fn).toContain("vres.reason === 'from_token_mismatch'");
  });
});
