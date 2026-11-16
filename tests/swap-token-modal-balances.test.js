/**
 * swap-token-modal-balances.test.js
 * Regression tests for the Swap token selector modal balance display.
 *
 * Uses source-level analysis (no JSDOM) — matches the pattern of the rest of
 * this test suite.
 *
 * Requirements enforced:
 * 1. Native assets (ETH on Base/Arbitrum/Ethereum/Optimism) are NOT skipped —
 *    classified chain-aware and read via BalanceService.getTokenBalance.
 * 2. Balance states are distinct: "—" = unavailable/loading, "0.0000" = confirmed
 *    zero, <number> = confirmed balance. RPC failure → "—" (never a fake zero).
 * 3. When walletAddress is falsy, "—" (disconnected) is shown, never "0.0000".
 * 4. BalanceService.getTokenBalance is used when available (preferred path).
 * 5. Falls back to direct ethers call when BalanceService is absent.
 * 6. A render-generation guard prevents stale async results from touching the DOM.
 * 7. After all fetches settle, tokens with balance > 0 are re-sorted to the top.
 * 8. No regressions: selectTokenObj, filterTokenList, renderItem still present.
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

  // ── 1. Distinct balance states (unavailable "—" vs confirmed zero) ────────

  it('sets bal to "—" as default before the try block (RPC failure is NOT a fake zero)', () => {
    // The variable initialisation `let bal = '—'` must appear INSIDE the
    // async forEach / map callback, before the try block — so a failed read
    // never masquerades as a confirmed "0.0000" balance.
    expect(renderSrc).toContain("let bal = '—'");
  });

  it('catches fetch errors and keeps bal as "—" (unavailable, not zero)', () => {
    // catch block must assign '—' (unavailable), not '0.0000' and not re-throw.
    expect(renderSrc).toMatch(/catch\s*\([^)]*\)\s*\{\s*bal\s*=\s*'—'/);
  });

  it('only a non-null BalanceService result is treated as a confirmed balance', () => {
    expect(renderSrc).toContain('if (raw != null)');
    expect(renderSrc).toContain('bal = parseFloat(raw).toFixed(4)');
  });

  // ── 2. No-wallet path ─────────────────────────────────────────────────────

  it('has an else branch for no-wallet that shows "—" (disconnected)', () => {
    expect(renderSrc).toContain("valEl.textContent = '—'");
    // The else branch (no walletAddress) must exist and set '—'
    const elseIdx = renderSrc.indexOf('} else {');
    expect(elseIdx).toBeGreaterThan(-1);
    const elseBlock = renderSrc.slice(elseIdx, elseIdx + 300);
    expect(elseBlock).toContain("'—'");
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

  // ── 8. Unavailable state and native classification markers ────────────────

  it('catch block assigns "—" (unavailable), never "0.0000" (no fake zero)', () => {
    const catchBlocks = renderSrc.match(/catch\s*\([^)]*\)\s*\{[^}]*\}/g) || [];
    catchBlocks.forEach(block => {
      expect(block).not.toContain("'0.0000'");
    });
  });

  it('the initial render still uses "—" as placeholder (before async fetch)', () => {
    // The synchronous first-pass render must use '—' so the user sees something
    // instantly, even before balances load.
    expect(renderSrc).toContain("renderItem(t, '—')");
  });

  it('defines a chain-aware native classifier (_swpTokenIsNative)', () => {
    expect(html).toContain('function _swpTokenIsNative(t, chainId)');
  });

  it('native classification consults the chain registry, never assumes ETH globally', () => {
    expect(html).toContain('nativeCurrency');
    expect(html).toContain('CHAIN_REGISTRY[Number(chainId)]');
  });

  it('uses a render-generation guard so stale async results never touch the DOM', () => {
    expect(html).toContain('let _tokRenderGen = 0');
    expect(renderSrc).toContain('const gen = ++_tokRenderGen');
    expect(renderSrc).toContain('if (gen !== _tokRenderGen) return');
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

  it('null result from BalanceService keeps bal as "—" (unavailable, not NaN/zero)', () => {
    // The check `if (raw != null)` guards against null/undefined from BalanceService:
    // a null result means RPC failure → bal stays "—" (unavailable).
    expect(renderSrc).toContain('if (raw != null)');
  });
});
