/**
 * swap-token-modal-balances.test.js
 * Regression tests for the Swap token selector modal balance display.
 *
 * Uses source-level analysis (no JSDOM) — matches the pattern of the rest of
 * this test suite.
 *
 * Requirements enforced:
 * 1. After all fetches settle, "—" must not remain: either a real balance or
 *    "0.0000" is written to the DOM row.
 * 2. When walletAddress is falsy, "0.0000" is set immediately without any fetch.
 * 3. BalanceService.getTokenBalance is used when available (preferred path).
 * 4. Falls back to direct ethers call when BalanceService is absent.
 * 5. A fetch error results in "0.0000", not a re-throw or "—".
 * 6. After all fetches settle, tokens with balance > 0 are re-sorted to the top.
 * 7. No regressions: selectTokenObj, filterTokenList, renderItem still present.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const htmlPath = path.resolve(__dirname, '../index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

// Pull the renderTokenList function source for targeted inspection.
function extractFn(src, name) {
  const marker = `async function ${name}`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`${name} not found`);
  let depth = 0, i = start, entered = false;
  while (i < src.length) {
    if (src[i] === '{') { depth++; entered = true; }
    else if (src[i] === '}') { depth--; if (entered && depth === 0) { i++; break; } }
    i++;
  }
  return src.slice(start, i);
}

const renderSrc = extractFn(html, 'renderTokenList');

describe('renderTokenList — source-level regression', () => {

  // ── 1. No "—" left after fetch ────────────────────────────────────────────

  it('sets bal to "0.0000" as default before the try block (never leaves "—" on error)', () => {
    // The variable initialisation `let bal = '0.0000'` must appear INSIDE the
    // async forEach / map callback, before the try block.
    expect(renderSrc).toContain("let bal = '0.0000'");
  });

  it('catches fetch errors and keeps bal as "0.0000"', () => {
    // catch block must assign '0.0000', not re-throw or leave empty.
    expect(renderSrc).toMatch(/catch\s*\([^)]*\)\s*\{\s*bal\s*=\s*'0\.0000'/);
  });

  // ── 2. No-wallet path ─────────────────────────────────────────────────────

  it('has an else branch for no-wallet that sets all rows to "0.0000"', () => {
    expect(renderSrc).toContain("valEl.textContent = '0.0000'");
    // The else branch (no walletAddress) must exist and set '0.0000'
    const elseIdx = renderSrc.indexOf('} else {');
    expect(elseIdx).toBeGreaterThan(-1);
    const elseBlock = renderSrc.slice(elseIdx, elseIdx + 300);
    expect(elseBlock).toContain("'0.0000'");
  });

  // ── 3. BalanceService preferred ───────────────────────────────────────────

  it('uses BalanceService.getTokenBalance when available', () => {
    expect(renderSrc).toContain('BalanceService.getTokenBalance');
  });

  it('checks BalanceService availability before using it', () => {
    expect(renderSrc).toMatch(/typeof BalanceService\s*!==\s*['"]undefined['"]/);
  });

  // ── 4. Ethers fallback ────────────────────────────────────────────────────

  it('falls back to ethers.Contract.balanceOf when BalanceService is absent', () => {
    expect(renderSrc).toContain('ethers.Contract');
    expect(renderSrc).toContain('balanceOf(walletAddress)');
  });

  it('uses else if (prov) guard for the ethers fallback (not unconditional)', () => {
    expect(renderSrc).toMatch(/else if\s*\(\s*prov\s*\)/);
  });

  // ── 5. Re-sort after all fetches settle ───────────────────────────────────

  it('uses Promise.allSettled to re-sort rows after all balance fetches settle', () => {
    expect(renderSrc).toContain('Promise.allSettled');
  });

  it('sorts rows by descending balance (higher balance first)', () => {
    // Must compare bb - ba (descending)
    expect(renderSrc).toContain('bb - ba');
  });

  it('moves DOM nodes via insertBefore without a full re-render', () => {
    expect(renderSrc).toContain('insertBefore');
  });

  // ── 6. USD value only shown for non-zero balances ─────────────────────────

  it('does not compute USD value for "0.0000" balances', () => {
    // usdHtml condition must exclude '0.0000'
    expect(renderSrc).toContain("bal !== '0.0000'");
  });

  it('checks parseFloat(bal) > 0 before writing USD value in the async update', () => {
    expect(renderSrc).toContain('parseFloat(bal) > 0');
  });

  // ── 7. Regressions: existing functions still present ─────────────────────

  it('filterTokenList still calls renderTokenList', () => {
    const filterSrc = html.slice(html.indexOf('function filterTokenList'));
    expect(filterSrc.slice(0, 200)).toContain('renderTokenList');
  });

  it('selectTokenObj still exists and accepts a tokenObj', () => {
    expect(html).toContain('function selectTokenObj(tokenObj)');
  });

  it('_tokRenderMap is still reset each render to prevent stale references', () => {
    expect(renderSrc).toContain('_tokRenderMap = []');
  });

  it('renderItem still builds tok-item with tok-item-bal-val', () => {
    expect(renderSrc).toContain('tok-item-bal-val');
  });

  // ── 8. No old broken "—" path remains ────────────────────────────────────

  it('does not leave "—" in a catch/finally block (no catch assigning "—")', () => {
    // Ensure no catch block assigns the dash placeholder.
    const catchBlocks = renderSrc.match(/catch\s*\([^)]*\)\s*\{[^}]*\}/g) || [];
    catchBlocks.forEach(block => {
      expect(block).not.toContain("'—'");
    });
  });

  it('the initial render still uses "—" as placeholder (before async fetch)', () => {
    // The synchronous first-pass render must use '—' so the user sees something
    // instantly, even before balances load.
    expect(renderSrc).toContain("renderItem(t, '—')");
  });
});

describe('renderTokenList — integration with BalanceService contract', () => {

  it('BalanceService.getTokenBalance is called with (walletAddress, tokenObj, chainId)', () => {
    // Correct call signature: address first, then token, then chainId.
    expect(renderSrc).toContain('BalanceService.getTokenBalance(walletAddress, tokenArg, chainId)');
  });

  it('passes a full token object (address+symbol+decimals) not just symbol string', () => {
    expect(renderSrc).toContain('const tokenArg = { address: t.address, symbol: t.symbol, decimals: t.decimals }');
  });

  it('parses the formatted string from BalanceService with parseFloat', () => {
    // getTokenBalance returns a formatted string — use parseFloat, not formatUnits.
    expect(renderSrc).toContain('bal = parseFloat(raw).toFixed(4)');
  });

  it('null result from BalanceService keeps bal as "0.0000" (not NaN or crash)', () => {
    // The check `if (raw != null)` guards against null/undefined from BalanceService.
    expect(renderSrc).toContain('if (raw != null)');
  });
});
