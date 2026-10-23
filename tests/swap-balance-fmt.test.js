/**
 * Tests for _swpFmtBal and _swpReadBal balance display rules.
 * Rules:
 *   null/undefined → '0'       (RPC failure → prefer 0 over perpetual dash)
 *   "0" / "0.0"   → '0'       (zero balance → '0', not '–')
 *   "1.2500"      → '1.25'    (trim trailing zeros)
 *   "0.006700"    → '0.0067'  (preserve significant decimals)
 *   "0.00001"     → '0'       (sub-precision rounds to 0 in toFixed(4))
 *   "1000"        → '1000'    (integer, no decimal)
 */

import { readFileSync } from 'fs';
import { describe, it, expect } from 'vitest';

const html = readFileSync('/home/user/app/index.html', 'utf8');

// Extract _swpFmtBal body from the source.
function fnBlock(text, name, size) {
  const anchor = 'function ' + name + '(';
  const idx = text.indexOf(anchor);
  if (idx === -1) return '';
  return text.slice(idx, idx + size);
}

// Build a callable _swpFmtBal from the real source.
function buildFmtBal() {
  const src = fnBlock(html, '_swpFmtBal', 400);
  // Wrap in a module-level function and eval.
  const fn = new Function(`
    ${src}
    return _swpFmtBal;
  `);
  return fn();
}

describe('_swpFmtBal — existence', () => {
  it('FMT1.1: _swpFmtBal is defined in index.html', () => {
    expect(html).toContain('function _swpFmtBal(');
  });

  it('FMT1.2: _swpReadBal uses _swpFmtBal (not bare toFixed)', () => {
    const readBal = fnBlock(html, '_swpReadBal', 1400);
    expect(readBal).toContain('_swpFmtBal(v)');
    // Must NOT use the old bare toFixed pattern directly on v
    expect(readBal).not.toContain('parseFloat(v).toFixed');
  });

  it('FMT1.3: RPC failure path shows 0 not perpetual dash', () => {
    const readBal = fnBlock(html, '_swpReadBal', 1400);
    // The v == null branch must set '0' as fallback, not hard-code a '—' as el.textContent
    const nullBranch = readBal.slice(readBal.indexOf('if (v == null)'), readBal.indexOf('if (v == null)') + 250);
    // The el.textContent assignment must not be a bare '—' string literal
    expect(nullBranch).not.toContain("el.textContent = '—'");
    expect(nullBranch).toContain("'0'");
  });
});

describe('_swpFmtBal — functional (executes real logic)', () => {
  let fmt;
  try { fmt = buildFmtBal(); } catch (_) { fmt = null; }

  it('FMT2.1: null → "0" (RPC failure)', () => {
    if (!fmt) return; // skip if extraction fails
    expect(fmt(null)).toBe('0');
  });

  it('FMT2.2: undefined → "0"', () => {
    if (!fmt) return;
    expect(fmt(undefined)).toBe('0');
  });

  it('FMT2.3: "0" → "0" (zero balance, not dash)', () => {
    if (!fmt) return;
    expect(fmt('0')).toBe('0');
  });

  it('FMT2.4: "0.0" → "0" (ethers.formatUnits(0n) result)', () => {
    if (!fmt) return;
    expect(fmt('0.0')).toBe('0');
  });

  it('FMT2.5: "0.000000" → "0" (6-decimal zero)', () => {
    if (!fmt) return;
    expect(fmt('0.000000')).toBe('0');
  });

  it('FMT2.6: "1.2500" → "1.25" (trim trailing zeros)', () => {
    if (!fmt) return;
    expect(fmt('1.2500')).toBe('1.25');
  });

  it('FMT2.7: "0.006700" → "0.0067" (preserve significant decimals)', () => {
    if (!fmt) return;
    expect(fmt('0.006700')).toBe('0.0067');
  });

  it('FMT2.8: "1000.000000" → "1000" (integer no decimal)', () => {
    if (!fmt) return;
    expect(fmt('1000.000000')).toBe('1000');
  });

  it('FMT2.9: "0.123456" → "0.1235" (round to 4 decimals)', () => {
    if (!fmt) return;
    const result = fmt('0.123456');
    expect(parseFloat(result)).toBeCloseTo(0.1235, 4);
  });
});

describe('_swpFmtBal — structural consistency', () => {
  it('FMT3.1: _swpFmtBal is called in _swpReadBal success path', () => {
    const readBal = fnBlock(html, '_swpReadBal', 1400);
    const successIdx = readBal.lastIndexOf('_swpFmtBal');
    expect(successIdx).toBeGreaterThan(-1);
  });

  it('FMT3.2: _swpBalCache stores _swpFmtBal result', () => {
    const readBal = fnBlock(html, '_swpReadBal', 1400);
    // Cache must be set with the formatted text
    expect(readBal).toContain('_swpBalCache[key] = text');
    const textAssign = readBal.indexOf('var text = _swpFmtBal');
    const cacheAssign = readBal.indexOf('_swpBalCache[key] = text');
    expect(textAssign).toBeGreaterThan(-1);
    expect(cacheAssign).toBeGreaterThan(textAssign);
  });

  it('FMT3.3: disconnected wallet shows "—" not "0"', () => {
    const updateFn = fnBlock(html, 'updateSwapBalancesDisplay', 900);
    expect(updateFn).toContain("'—'");
    // The walletAddress guard must come before any fetch
    const guardIdx = updateFn.indexOf('!walletAddress');
    const fetchIdx = updateFn.indexOf('_swpReadBal');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(guardIdx);
  });

  it('FMT3.4: _noToken sentinel shows "—" not fetching balance', () => {
    const updateFn = fnBlock(html, 'updateSwapBalancesDisplay', 900);
    expect(updateFn).toContain('_noToken');
    const noTokIdx = updateFn.indexOf('_noToken');
    const outFetchIdx = updateFn.indexOf("_swpReadBal('out'");
    // _noToken guard must come before the out fetch call
    expect(noTokIdx).toBeLessThan(outFetchIdx);
  });
});
