/**
 * send-assets-precision.test.js
 * ═══════════════════════════════════════════════════════════════════════════
 * Phase SA-1 — Send Assets financial-precision regression tests.
 *
 * Confirmed P0 defect: saToRaw() used floating-point arithmetic
 * (`BigInt(Math.round(parseFloat(amount) * Math.pow(10, dec)))`), which loses
 * precision for large/high-precision amounts and silently rounds excess decimals.
 *
 * These tests exercise the PRODUCTION saToRaw + _saParseUnitsExact extracted from
 * index.html (not a duplicate implementation) and assert exact decimal → BigInt
 * conversion, matching ethers.parseUnits semantics.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function extractFn(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(marker + ' not found');
  let depth = 0, i = start, entered = false;
  while (i < src.length) {
    if (src[i] === '{') { depth++; entered = true; }
    else if (src[i] === '}') { depth--; if (entered && depth === 0) { i++; break; } }
    i++;
  }
  return src.slice(start, i);
}

// _saParseUnitsExact(str, dec) → BigInt|null (pure).
const parseExact = (() => {
  const src = extractFn(html, 'function _saParseUnitsExact(str, dec)');
  return new Function(src + '\nreturn _saParseUnitsExact;')();
})();

// saToRaw(amount) → BigInt, using the fallback parser (ethers absent) + a
// mocked saGetTokenDecimals. Extract both saToRaw AND _saParseUnitsExact (they
// are adjacent) so the fallback resolves.
function buildSaToRaw(decimals) {
  const start = html.indexOf('function saToRaw(amount)');
  const end = html.indexOf('function saUpdateNetwork', start);
  if (start === -1 || end === -1) throw new Error('saToRaw block not found');
  const block = html.slice(start, end);
  const fn = new Function('saGetTokenDecimals', 'ethers', block + '\nreturn saToRaw;');
  return fn(() => decimals, undefined); // ethers undefined → uses _saParseUnitsExact fallback
}

describe('source contract — saToRaw must not use floating point', () => {
  it('saToRaw uses ethers.parseUnits (exact), not Math.round(parseFloat(...))', () => {
    const src = extractFn(html, 'function saToRaw(amount)');
    expect(src).toContain('ethers.parseUnits(String(amount), dec)');
    expect(src).not.toContain('Math.round(parseFloat');
  });
  it('_saParseUnitsExact rejects excess precision (never silently truncates)', () => {
    expect(html).toContain("if (fracPart.length > dec) return null;");
  });
});

describe('_saParseUnitsExact — exact decimal conversion', () => {
  it('integer amount', () => expect(parseExact('123', 6)).toBe(123000000n));
  it('fractional amount', () => expect(parseExact('0.1', 6)).toBe(100000n));
  it('full precision (6 decimals)', () => expect(parseExact('0.123456', 6)).toBe(123456n));
  it('8 decimals (cirBTC)', () => expect(parseExact('0.12345678', 8)).toBe(12345678n));
  it('zero', () => expect(parseExact('0', 6)).toBe(0n));
  it('zero with decimals', () => expect(parseExact('0.0', 6)).toBe(0n));
  it('large amount (no float drift)', () => expect(parseExact('1234567890.123456', 6)).toBe(1234567890123456n));
  it('large 8-decimal amount', () => expect(parseExact('12345678.12345678', 8)).toBe(1234567812345678n));
});

describe('_saParseUnitsExact — rejects invalid / excess / ambiguous input', () => {
  it('excess decimals (7 for a 6-dec token)', () => expect(parseExact('0.1234567', 6)).toBeNull());
  it('negative', () => expect(parseExact('-5', 6)).toBeNull());
  it('empty string', () => expect(parseExact('', 6)).toBeNull());
  it('whitespace-only', () => expect(parseExact('   ', 6)).toBeNull());
  it('non-numeric', () => expect(parseExact('abc', 6)).toBeNull());
  it('scientific notation', () => expect(parseExact('1e3', 6)).toBeNull());
  it('multiple dots', () => expect(parseExact('1.2.3', 6)).toBeNull());
  it('trailing dot', () => expect(parseExact('1.', 6)).toBeNull());
});

describe('saToRaw — integration (fallback path, 6 decimals)', () => {
  const saToRaw = buildSaToRaw(6);
  it('converts exactly', () => expect(saToRaw('0.1')).toBe(100000n));
  it('invalid input yields 0n (not a thrown exception, not a truncated value)', () => {
    expect(saToRaw('abc')).toBe(0n);
    expect(saToRaw('')).toBe(0n);
    expect(saToRaw('0.1234567')).toBe(0n); // excess precision → 0n (caller rejects via validation)
  });
  it('matches ethers.parseUnits for valid inputs', async () => {
    // Import the real ethers to cross-check the exact result.
    const { parseUnits } = await import('ethers');
    for (const s of ['0', '0.1', '1.5', '1234.56789', '1234567890.123456']) {
      expect(saToRaw(s)).toBe(parseUnits(s, 6));
    }
  });
});
