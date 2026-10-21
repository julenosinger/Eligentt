/**
 * swap-history-unified.test.js
 * Regression gate for the unified Swap History panel.
 * Verifies: local persistence, merge logic, filters, safe DOM rendering,
 * provider labels, cross-chain entries, dedup, and no false "Done" status.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const html = readFileSync(join(__dirname, '../index.html'), 'utf8');

// ── Helpers ────────────────────────────────────────────────────────────────
function fnBody(src, name, windowSize = 3000) {
  const idx = src.indexOf('function ' + name + '(');
  if (idx < 0) return '';
  return src.slice(idx, idx + windowSize);
}
function blockAt(src, anchor, size = 2000) {
  const idx = src.indexOf(anchor);
  if (idx < 0) return '';
  return src.slice(idx, idx + size);
}
function countOccurrences(src, needle) {
  let n = 0, pos = 0;
  while ((pos = src.indexOf(needle, pos)) >= 0) { n++; pos += needle.length; }
  return n;
}

// ── A: Local persistence functions present ─────────────────────────────────
describe('A — Local persistence layer', () => {
  it('A1: _swpLocalKey() is defined', () => {
    expect(html).toContain('function _swpLocalKey()');
  });
  it('A2: _swpLocalLoad() is defined', () => {
    expect(html).toContain('function _swpLocalLoad()');
  });
  it('A3: _swpLocalSave() is defined', () => {
    expect(html).toContain('function _swpLocalSave(');
  });
  it('A4: swpLocalRecord() is defined', () => {
    expect(html).toContain('function swpLocalRecord(');
  });
  it('A5: swpLocalUpdateStatus() is defined', () => {
    expect(html).toContain('function swpLocalUpdateStatus(');
  });
  it('A6: _swpMergeHistory() is defined', () => {
    expect(html).toContain('function _swpMergeHistory(');
  });

  const localKey = fnBody(html, '_swpLocalKey');
  it('A7: key is wallet-scoped (uses walletAddress)', () => {
    expect(localKey).toContain('walletAddress');
  });

  const localLoad = fnBody(html, '_swpLocalLoad');
  it('A8: _swpLocalLoad reads from localStorage', () => {
    expect(localLoad).toContain('localStorage.getItem');
  });
  it('A9: _swpLocalLoad returns [] on parse error', () => {
    expect(localLoad).toContain('return []');
  });

  const localSave = fnBody(html, '_swpLocalSave');
  it('A10: _swpLocalSave caps at 200 entries', () => {
    expect(localSave).toContain('200');
  });
  it('A11: _swpLocalSave writes to localStorage', () => {
    expect(localSave).toContain('localStorage.setItem');
  });
});

// ── B: swpLocalRecord stores correct fields ────────────────────────────────
describe('B — swpLocalRecord fields', () => {
  const rec = fnBody(html, 'swpLocalRecord', 2000);

  it('B1: guards against missing txHash', () => {
    expect(rec).toContain('if (!opts || !opts.txHash) return');
  });
  it('B2: stores txHash', () => {
    expect(rec).toContain('txHash: opts.txHash');
  });
  it('B3: stores tokenIn', () => {
    expect(rec).toContain('tokenIn:');
  });
  it('B4: stores tokenOut', () => {
    expect(rec).toContain('tokenOut:');
  });
  it('B5: stores provider', () => {
    expect(rec).toContain('provider:');
  });
  it('B6: stores type (same-chain / cross-chain)', () => {
    expect(rec).toContain("type:");
  });
  it('B7: initial status defaults to pending', () => {
    expect(rec).toContain("|| 'pending'");
  });
  it('B8: dedup — updates existing entry if txHash already present', () => {
    expect(rec).toContain('findIndex');
    expect(rec).toContain('existing[idx]');
  });
});

// ── C: swpAddHistory persists immediately ──────────────────────────────────
describe('C — swpAddHistory immediate persistence', () => {
  const addHist = fnBody(html, 'swpAddHistory', 2500);

  it('C1: signature accepts opts param', () => {
    expect(html).toContain('function swpAddHistory(symIn, symOut, amtIn, amtOut, txHash, opts)');
  });
  it('C2: validates txHash with regex before persisting', () => {
    expect(addHist).toContain('/^0x[0-9a-fA-F]{64}$/.test(txHash)');
  });
  it('C3: calls swpLocalRecord', () => {
    expect(addHist).toContain('swpLocalRecord(');
  });
  it('C4: re-renders panel immediately if open', () => {
    // should have at least 2 re-render calls (immediate + after server)
    expect(countOccurrences(addHist, 'swpHistRender()')).toBeGreaterThanOrEqual(2);
  });
  it('C5: calls refreshAuthoritativeSwapHistory', () => {
    expect(addHist).toContain('refreshAuthoritativeSwapHistory(true)');
  });
  it('C6: marks entry done after server confirms', () => {
    expect(addHist).toContain("swpLocalUpdateStatus(txHash, 'done')");
  });
  it('C7: does NOT mark failed on server error (stays pending)', () => {
    const catchBlock = addHist.slice(addHist.lastIndexOf('.catch('));
    expect(catchBlock).not.toContain("'failed'");
  });
});

// ── D: call sites pass provider + type ────────────────────────────────────
describe('D — call sites pass provider labels', () => {
  it('D1: Tower call passes { provider: "Tower", type: "same-chain" }', () => {
    expect(html).toContain("{ provider: 'Tower', type: 'same-chain' }");
  });
  it('D2: LI.FI call passes { provider: "LI.FI", type: "same-chain" }', () => {
    expect(html).toContain("{ provider: 'LI.FI', type: 'same-chain' }");
  });
  it('D3: native pool/multi-hop call passes type same-chain', () => {
    expect(html).toContain("type: 'same-chain' }");
  });
  it('D4: native pool call uses route.source for provider label', () => {
    expect(html).toContain('_swpProvLabel');
    const provLine = blockAt(html, '_swpProvLabel', 200);
    expect(provLine).toContain("route.source || 'Elligentt'");
  });
});

// ── E: _swpMergeHistory logic ──────────────────────────────────────────────
describe('E — merge logic', () => {
  const merge = fnBody(html, '_swpMergeHistory', 1500);

  it('E1: builds authHashes index for dedup', () => {
    expect(merge).toContain('authHashes');
  });
  it('E2: authoritative events are NOT duplicated for known txHashes', () => {
    expect(merge).toContain('!authHashes[e.txHash.toLowerCase()]');
  });
  it('E3: local entries are normalized to match authoritative shape', () => {
    expect(merge).toContain('_local: true');
  });
  it('E4: merged list is sorted newest-first by timestamp', () => {
    expect(merge).toContain('(b.timestamp || 0) - (a.timestamp || 0)');
  });
  it('E5: result is concat of auth + filtered local', () => {
    expect(merge).toContain('authEvents.concat(localNorm)');
  });
});

// ── F: swpHistRender uses merged source ────────────────────────────────────
describe('F — swpHistRender uses merged source', () => {
  const render = fnBody(html, 'swpHistRender', 8000);

  it('F1: calls _swpLocalLoad()', () => {
    expect(render).toContain('_swpLocalLoad()');
  });
  it('F2: calls _swpMergeHistory()', () => {
    expect(render).toContain('_swpMergeHistory(');
  });
  it('F3: does NOT use .map().join() injection for rows', () => {
    // Old pattern was: list.innerHTML = filtered.map(function(ev){ ... }).join('');
    // New pattern uses forEach + createElement.
    expect(render).not.toContain(".join('')");
  });
  it('F4: builds rows via createElement (safe DOM)', () => {
    expect(render).toContain('createElement(');
  });
  it('F5: uses textContent for token names (no innerHTML injection)', () => {
    expect(render).toContain('.textContent = tIn');
    expect(render).toContain('.textContent = tOut');
  });
  it('F6: validates txHash with regex before creating explorer link', () => {
    expect(render).toContain('/^0x[0-9a-fA-F]{64}$/.test(ev.txHash)');
  });
  it('F7: validates explorer base URL as https:', () => {
    expect(render).toContain('/^https:\\/\\//.test(explorerBase)');
  });
  it('F8: cross-chain destination link also validated', () => {
    expect(render).toContain('/^0x[0-9a-fA-F]{64}$/.test(ev.txHashDst)');
  });
  it('F9: local entries use amountIn/amountOut (not raw)', () => {
    expect(render).toContain('ev._local');
    expect(render).toContain('ev.amountIn');
  });
  it('F10: cross-chain entries show visual badge', () => {
    expect(render).toContain('Cross-chain');
  });
});

// ── G: filters ─────────────────────────────────────────────────────────────
describe('G — filters', () => {
  it('G1: "same-chain" filter defined', () => {
    expect(html).toContain("data-filter=\"same-chain\"");
  });
  it('G2: "cross-chain" filter defined', () => {
    expect(html).toContain("data-filter=\"cross-chain\"");
  });
  it('G3: "failed" filter defined', () => {
    expect(html).toContain("data-filter=\"failed\"");
  });
  const render = fnBody(html, 'swpHistRender', 8000);
  it('G4: same-chain filter logic in render', () => {
    expect(render).toContain("_swpHistFilter === 'same-chain'");
  });
  it('G5: cross-chain filter logic in render', () => {
    expect(render).toContain("_swpHistFilter === 'cross-chain'");
  });
  it('G6: failed filter logic in render', () => {
    expect(render).toContain("_swpHistFilter === 'failed'");
  });
});

// ── H: empty state messages ────────────────────────────────────────────────
describe('H — empty state', () => {
  const render = fnBody(html, 'swpHistRender', 8000);

  it('H1: empty state uses safe DOM (createElement, not innerHTML)', () => {
    const emptyBlock = render.slice(render.indexOf('emptyDiv'));
    expect(emptyBlock).toContain('createElement(');
    expect(emptyBlock).toContain('.textContent = emptyMsg');
  });
  it('H2: INDEX_WARMING shows warming message', () => {
    expect(render).toContain('INDEX_WARMING');
  });
  it('H3: no "No swaps found" literal (replaced with "No swaps yet")', () => {
    // The old message was "No swaps found"; we replaced with "No swaps yet"
    expect(render).not.toContain("'No swaps found'");
    expect(render).toContain("'No swaps yet'");
  });
});

// ── I: scope guard — other modules untouched ──────────────────────────────
describe('I — scope guard: other modules unchanged', () => {
  it('I1: Bridge execution functions untouched', () => {
    expect(html).toContain('function executeBridgeViaCCTP(');
    expect(html).toContain('function executeBridgeViaLiFi(');
  });
  it('I2: Send Assets execution untouched', () => {
    expect(html).toContain('function saExecuteSend(');
  });
  it('I3: Autonoma untouched', () => {
    expect(html).toContain('function autRenderDocSummary(');
  });
  it('I4: swpHistFilter data-filter values include original all/done/pending', () => {
    expect(html).toContain('data-filter="all"');
    expect(html).toContain('data-filter="done"');
    expect(html).toContain('data-filter="pending"');
  });
});
