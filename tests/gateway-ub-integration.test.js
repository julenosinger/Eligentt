/**
 * Gateway Unified Balance Integration Tests — Fase 2.7
 * GUB1–GUB6: shared cache, Send/Swap/Bridge consistency, invalidation,
 * stale guard, no-float display, GATEWAY_SPEND_BLOCKED guard.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs   from 'fs';
import path from 'path';

// ── helpers ──────────────────────────────────────────────────────────────────
const indexSrc = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

// Extract a named function from source (takes the text between balanced braces).
function extractFn(src, fnName) {
  // Match the function declaration / expression.
  const re = new RegExp(`function ${fnName}\\s*\\(`);
  const idx = src.search(re);
  if (idx === -1) return null;
  const start = src.indexOf('{', idx);
  if (start === -1) return null;
  let depth = 0, pos = start;
  while (pos < src.length) {
    if (src[pos] === '{') depth++;
    else if (src[pos] === '}') { depth--; if (depth === 0) return src.slice(start, pos + 1); }
    pos++;
  }
  return null;
}

// ── GUB1: _ubGwCache declaration ─────────────────────────────────────────────
describe('GUB1 — _ubGwCache shared state declaration', () => {
  it('GUB1.1 — _ubGwCache declared in index.html with required fields', () => {
    const idx = indexSrc.indexOf('var _ubGwCache');
    expect(idx).toBeGreaterThan(-1);
    const block = indexSrc.slice(idx, idx + 400);
    expect(block).toContain('data');
    expect(block).toContain('ts');
    expect(block).toContain('addr');
    expect(block).toContain('status');
    expect(block).toContain("'empty'");
  });

  it('GUB1.2 — _ubGwCache populated in ubGatewayRender', () => {
    const renderIdx = indexSrc.indexOf('function ubGatewayRender(');
    expect(renderIdx).toBeGreaterThan(-1);
    const renderBlock = indexSrc.slice(renderIdx, renderIdx + 6000);
    expect(renderBlock).toContain('_ubGwCache.data');
    expect(renderBlock).toContain('_ubGwCache.ts');
    expect(renderBlock).toContain('_ubGwCache.addr');
    expect(renderBlock).toContain("_ubGwCache.status = 'ok'");
  });

  it('GUB1.3 — _ubGwCache is the ONLY place that sets status=ok', () => {
    // Only ubGatewayRender should set status=ok; nowhere else.
    const matches = [...indexSrc.matchAll(/_ubGwCache\.status\s*=\s*'ok'/g)];
    expect(matches.length).toBe(1);
  });
});

// ── GUB2: ubGetGatewayBalance ─────────────────────────────────────────────────
describe('GUB2 — ubGetGatewayBalance reads cache, never fetches', () => {
  it('GUB2.1 — ubGetGatewayBalance function declared', () => {
    expect(indexSrc).toContain('function ubGetGatewayBalance(');
  });

  it('GUB2.2 — ubGetGatewayBalance reads _ubGwCache.data', () => {
    const fnSrc = extractFn(indexSrc, 'ubGetGatewayBalance');
    expect(fnSrc).not.toBeNull();
    expect(fnSrc).toContain('_ubGwCache');
    expect(fnSrc).toContain('_ubGwCache.status');
    expect(fnSrc).toContain('_ubGwCache.data');
  });

  it('GUB2.3 — ubGetGatewayBalance does NOT call fetch', () => {
    const fnSrc = extractFn(indexSrc, 'ubGetGatewayBalance');
    // Must not have a direct fetch() call (not even in a comment).
    // Use a pattern that matches fetch( as a function call, not a word in a comment.
    expect(fnSrc).not.toMatch(/[^a-zA-Z_]fetch\s*\(/);
    expect(fnSrc).not.toContain('/api/gateway/balances');
  });

  it('GUB2.4 — ubGetGatewayBalance returns null when status != ok', () => {
    const fnSrc = extractFn(indexSrc, 'ubGetGatewayBalance');
    expect(fnSrc).toContain("status !== 'ok'");
  });

  it('GUB2.5 — ubGetGatewayBalance validates wallet address', () => {
    const fnSrc = extractFn(indexSrc, 'ubGetGatewayBalance');
    expect(fnSrc).toContain('_ubGwCache.addr');
    expect(fnSrc).toContain('toLowerCase');
  });

  it('GUB2.6 — ubGetGatewayBalance has stale guard (90s)', () => {
    const fnSrc = extractFn(indexSrc, 'ubGetGatewayBalance');
    expect(fnSrc).toContain('90000');
    expect(fnSrc).toContain('Date.now()');
    expect(fnSrc).toContain('_ubGwCache.ts');
  });

  it('GUB2.7 — ubGetGatewayBalance uses string arithmetic (_ubGwAddStr), not float', () => {
    const fnSrc = extractFn(indexSrc, 'ubGetGatewayBalance');
    expect(fnSrc).toContain('_ubGwAddStr');
    expect(fnSrc).not.toContain('parseFloat');
    expect(fnSrc).not.toContain('Number(');
  });
});

// ── GUB3: ubInvalidateGatewayCache ───────────────────────────────────────────
describe('GUB3 — ubInvalidateGatewayCache clears cache and schedules refresh', () => {
  it('GUB3.1 — ubInvalidateGatewayCache function declared', () => {
    expect(indexSrc).toContain('function ubInvalidateGatewayCache(');
  });

  it('GUB3.2 — ubInvalidateGatewayCache sets status to empty', () => {
    const fnSrc = extractFn(indexSrc, 'ubInvalidateGatewayCache');
    expect(fnSrc).not.toBeNull();
    expect(fnSrc).toContain("_ubGwCache.status = 'empty'");
  });

  it('GUB3.3 — ubInvalidateGatewayCache resets ts', () => {
    const fnSrc = extractFn(indexSrc, 'ubInvalidateGatewayCache');
    expect(fnSrc).toContain('_ubGwCache.ts');
    expect(fnSrc).toContain('= 0');
  });

  it('GUB3.4 — ubInvalidateGatewayCache triggers ubGatewaySyncRefresh', () => {
    const fnSrc = extractFn(indexSrc, 'ubInvalidateGatewayCache');
    expect(fnSrc).toContain('ubGatewaySyncRefresh');
  });

  it('GUB3.5 — ubInvalidateGatewayCache does NOT clear _ubGwLastData', () => {
    // Keep asset rows visible until new data arrives.
    const fnSrc = extractFn(indexSrc, 'ubInvalidateGatewayCache');
    expect(fnSrc).not.toContain('_ubGwLastData');
  });
});

// ── GUB4: saLoadGatewayBalance reads cache ────────────────────────────────────
describe('GUB4 — saLoadGatewayBalance uses shared cache', () => {
  it('GUB4.1 — saLoadGatewayBalance calls ubGetGatewayBalance', () => {
    const fnSrc = extractFn(indexSrc, 'saLoadGatewayBalance');
    expect(fnSrc).not.toBeNull();
    expect(fnSrc).toContain('ubGetGatewayBalance');
  });

  it('GUB4.2 — saLoadGatewayBalance does NOT call fetch directly', () => {
    const fnSrc = extractFn(indexSrc, 'saLoadGatewayBalance');
    expect(fnSrc).not.toContain("fetch('/api/gateway/balances");
    expect(fnSrc).not.toContain('fetch(`/api/gateway/balances');
  });

  it('GUB4.3 — saLoadGatewayBalance triggers ubGatewaySyncRefresh on cache miss', () => {
    const fnSrc = extractFn(indexSrc, 'saLoadGatewayBalance');
    expect(fnSrc).toContain('ubGatewaySyncRefresh');
  });

  it('GUB4.4 — saLoadGatewayBalance uses _saFmtGwBal for display, no parseFloat', () => {
    const fnSrc = extractFn(indexSrc, 'saLoadGatewayBalance');
    expect(fnSrc).toContain('_saFmtGwBal');
    expect(fnSrc).not.toContain('parseFloat');
    expect(fnSrc).not.toContain('.toFixed(');
  });
});

// ── GUB5: swpLoadGatewayBalance reads cache ───────────────────────────────────
describe('GUB5 — swpLoadGatewayBalance uses shared cache', () => {
  it('GUB5.1 — swpLoadGatewayBalance calls ubGetGatewayBalance', () => {
    const fnSrc = extractFn(indexSrc, 'swpLoadGatewayBalance');
    expect(fnSrc).not.toBeNull();
    expect(fnSrc).toContain('ubGetGatewayBalance');
  });

  it('GUB5.2 — swpLoadGatewayBalance does NOT call fetch directly', () => {
    const fnSrc = extractFn(indexSrc, 'swpLoadGatewayBalance');
    expect(fnSrc).not.toContain("fetch('/api/gateway/balances");
    expect(fnSrc).not.toContain('fetch(`/api/gateway/balances');
  });

  it('GUB5.3 — swpLoadGatewayBalance uses _saFmtGwBal, not parseFloat', () => {
    const fnSrc = extractFn(indexSrc, 'swpLoadGatewayBalance');
    expect(fnSrc).not.toContain('parseFloat');
    expect(fnSrc).not.toContain('.toFixed(');
  });
});

// ── GUB6: saExecGateway invalidates cache after spend ────────────────────────
describe('GUB6 — saExecGateway invalidates cache after confirmed operation', () => {
  it('GUB6.1 — saExecGateway calls ubInvalidateGatewayCache on result.ok', () => {
    const fnSrc = extractFn(indexSrc, 'saExecGateway');
    expect(fnSrc).not.toBeNull();
    // Find the resp.ok success branch (Fase 2.9.3: inline implementation).
    const okIdx = fnSrc.indexOf('resp.ok');
    expect(okIdx).toBeGreaterThan(-1);
    const okBranch = fnSrc.slice(okIdx, okIdx + 500);
    expect(okBranch).toContain('ubInvalidateGatewayCache');
  });

  it('GUB6.2 — saExecGateway does NOT invalidate on error path', () => {
    const fnSrc = extractFn(indexSrc, 'saExecGateway');
    // ubInvalidateGatewayCache must only appear inside the result.ok branch,
    // not in the error branch or finally block.
    // The call (and its typeof guard) appear together — 2 occurrences per call site.
    // Both must be inside the result.ok branch, never in error/finally.
    const invalidateCount = (fnSrc.match(/ubInvalidateGatewayCache/g) || []).length;
    expect(invalidateCount).toBeGreaterThanOrEqual(1);
    expect(invalidateCount).toBeLessThanOrEqual(3); // typeof guard + call, max 1 call site
    // Confirm it is NOT in the catch or finally block.
    const catchIdx = fnSrc.indexOf('} catch(');
    // Look for the outer `} catch(e) {` block (not inner `catch(_)` guards)
    const outerCatchIdx = fnSrc.indexOf('} catch(e) {');
    if (outerCatchIdx > -1) {
      const catchBlock = fnSrc.slice(outerCatchIdx);
      expect(catchBlock).not.toContain('ubInvalidateGatewayCache');
    }
  });

  it('GUB6.3 — saExecGateway uses inline EIP-712 sign and validates wallet + amount (Fase 2.9.3)', () => {
    const fnSrc = extractFn(indexSrc, 'saExecGateway');
    // Fase 2.9.3: GATEWAY_SPEND_BLOCKED removed, inline implementation with explicit guards.
    expect(fnSrc).toContain('eth_signTypedData_v4');
    expect(fnSrc).toContain('BurnIntent');
    expect(fnSrc).toContain('no_wallet');
    expect(fnSrc).toContain('invalid_amount');
  });
});

// ── GUB7: no parallel /api/gateway/balances calls from Send/Swap ─────────────
describe('GUB7 — single fetch path: only ubGatewayFetch calls /api/gateway/balances', () => {
  it('GUB7.1 — only ONE function calls /api/gateway/balances directly', () => {
    // The ONLY allowed caller is ubGatewayFetch. saLoadGatewayBalance and
    // swpLoadGatewayBalance must not have their own direct fetch calls.
    const allMatches = [...indexSrc.matchAll(/fetch\(['"]\/?api\/gateway\/balances/g)];
    // There may be multiple in ubGatewayFetch but zero in sa/swp load functions.
    // Count occurrences OUTSIDE of ubGatewayFetch.
    const fetchFnSrc = extractFn(indexSrc, 'ubGatewayFetch') || '';
    const countInFetch = (fetchFnSrc.match(/fetch\(['"]\/?api\/gateway\/balances/g) || []).length;
    // All occurrences should be inside ubGatewayFetch.
    expect(allMatches.length).toBe(countInFetch);
  });

  it('GUB7.2 — saLoadGatewayBalance has zero direct fetch calls', () => {
    const fnSrc = extractFn(indexSrc, 'saLoadGatewayBalance') || '';
    const matches = (fnSrc.match(/fetch\s*\(/g) || []).length;
    expect(matches).toBe(0);
  });

  it('GUB7.3 — swpLoadGatewayBalance has zero direct fetch calls', () => {
    const fnSrc = extractFn(indexSrc, 'swpLoadGatewayBalance') || '';
    const matches = (fnSrc.match(/fetch\s*\(/g) || []).length;
    expect(matches).toBe(0);
  });
});

// ── GUB8: _saFmtGwBal display format ─────────────────────────────────────────
describe('GUB8 — _saFmtGwBal formats balance without float arithmetic', () => {
  it('GUB8.1 — _saFmtGwBal declared', () => {
    expect(indexSrc).toContain('function _saFmtGwBal(');
  });

  it('GUB8.2 — _saFmtGwBal uses string slice, not parseFloat', () => {
    const fnSrc = extractFn(indexSrc, '_saFmtGwBal');
    expect(fnSrc).not.toBeNull();
    expect(fnSrc).not.toContain('parseFloat');
    expect(fnSrc).not.toContain('.toFixed(');
    expect(fnSrc).toContain('.slice(');
  });

  it('GUB8.3 — _saFmtGwBal handles integer input (no dot)', () => {
    const fnSrc = extractFn(indexSrc, '_saFmtGwBal');
    // Should handle the case where the input has no decimal point.
    expect(fnSrc).toContain("'.000000'");
  });
});

// ── GUB9: GATEWAY_SPEND_BLOCKED structural integrity ─────────────────────────
describe('GUB9 — GATEWAY_SPEND_BLOCKED is declared and set to false (Fase 2.9.2: security approved)', () => {
  it('GUB9.1 — var GATEWAY_SPEND_BLOCKED is declared as false', () => {
    const declIdx = indexSrc.indexOf('var GATEWAY_SPEND_BLOCKED = ');
    expect(declIdx).toBeGreaterThan(-1);
    const decl = indexSrc.slice(declIdx, declIdx + 50);
    // Fase 2.9.2: all code-level security checks approved; CF infra checklist in comment.
    expect(decl).toContain('false');
  });
});
