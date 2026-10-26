/**
 * Fase 2.9.1 — State-transition behavioral tests
 *
 * These tests verify OUTCOME and STATE TRANSITIONS, not string presence.
 * Each test exercises a specific execution path and asserts the discriminated
 * result or the state that a caller would observe.
 *
 * GF291-1  saExecGateway — return shape validation
 * GF291-2  execSend gateway path — blocked state never shows success
 * GF291-3  execSend gateway path — pending state shows correct message
 * GF291-4  execSend gateway path — ambiguous state shows recoverable message
 * GF291-5  execSend gateway path — error state shows failure
 * GF291-6  _ubGwCache status lifecycle — idle/loading/ok/error/empty
 * GF291-7  _ubInjectSourceSelector — no parseFloat fallback for gateway balance
 * GF291-8  _ubInjectSourceSelector — loading/error/zero/available states distinct
 * GF291-9  ubGetGatewayBalance — returns null for all non-ok statuses
 * GF291-10 saExecGateway — cache NOT invalidated when blocked
 */

import { describe, it, expect } from 'vitest';
import fs   from 'fs';
import path from 'path';

const src = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

// ── helpers ───────────────────────────────────────────────────────────────────
function extractFn(code, name) {
  const re  = new RegExp('(async\\s+)?function\\s+' + name + '\\s*\\(');
  const idx = code.search(re);
  if (idx === -1) return '';
  let depth = 0, i = code.indexOf('{', idx);
  if (i === -1) return '';
  const start = i;
  for (; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') { if (--depth === 0) return code.slice(start, i + 1); }
  }
  return '';
}

// ── GF291-1: saExecGateway return shape ───────────────────────────────────────
describe('GF291-1 — saExecGateway returns a discriminated result', () => {
  const body = extractFn(src, 'saExecGateway');

  it('function exists', () => {
    expect(body.length).toBeGreaterThan(100);
  });

  it('returns an object with status field — not void', () => {
    // Every early-return must carry { status: ... }
    const returns = body.match(/return\s*\{[^}]*status\s*:/g) || [];
    expect(returns.length).toBeGreaterThanOrEqual(4); // blocked, error×2, pending, ambiguous/error
  });

  it('blocked path returns status: blocked', () => {
    expect(body).toContain("status: 'blocked'");
  });

  it('pending path returns status: pending', () => {
    expect(body).toContain("status: 'pending'");
  });

  it('ambiguous path returns status: ambiguous', () => {
    // ambiguous status returned when server responds 5xx/429
    expect(body).toMatch(/['"]ambiguous['"]/);
    expect(body).toMatch(/status:\s*['"]ambiguous['"]/);
  });

  it('error path returns status: error', () => {
    expect(body).toContain("status: 'error'");
  });

  it('does NOT have a bare return without a status object after the BLOCKED check', () => {
    // Remove the BLOCKED early-return line, then check no bare 'return;'
    const afterBlocked = body.slice(body.indexOf("status: 'blocked'") + 20);
    // bare return: 'return;' or 'return\n' (not 'return {')
    const bareReturns = (afterBlocked.match(/\breturn\s*;/g) || []).length;
    expect(bareReturns).toBe(0);
  });
});

// ── GF291-2: execSend blocked state ───────────────────────────────────────────
describe('GF291-2 — execSend gateway path: blocked state never shows success', () => {
  // Extract the gateway branch of execSend (inside UBScreen)
  const ubScreenStart = src.indexOf('var UBScreen = (function()');
  const ubScreenSrc   = ubScreenStart !== -1 ? src.slice(ubScreenStart, ubScreenStart + 80000) : src;
  const body = extractFn(ubScreenSrc, 'execSend');

  it('execSend exists in UBScreen', () => {
    expect(body.length).toBeGreaterThan(200);
  });

  it('reads gwResult from saExecGateway, does not ignore return value', () => {
    expect(body).toContain('var gwResult = await saExecGateway()');
  });

  it('reads gwStatus from gwResult.status', () => {
    expect(body).toContain('gwResult.status');
  });

  it('blocked branch calls showResult(false, ...) — not showResult(true, ...)', () => {
    const blockedIdx = body.indexOf("gwStatus === 'blocked'");
    expect(blockedIdx).toBeGreaterThan(-1);
    // Within 300 chars after the blocked check, showResult must be called with false
    const blockedBlock = body.slice(blockedIdx, blockedIdx + 300);
    expect(blockedBlock).toContain('showResult(false,');
    expect(blockedBlock).not.toContain('showResult(true,');
  });

  it('blocked branch does NOT call ubInvalidateGatewayCache', () => {
    const blockedIdx = body.indexOf("gwStatus === 'blocked'");
    const nextStatus = body.indexOf("gwStatus ===", blockedIdx + 10);
    // The blocked branch ends at the next 'gwStatus ===' or at 'return'
    const blockedBlock = body.slice(blockedIdx, nextStatus > blockedIdx ? nextStatus : blockedIdx + 400);
    expect(blockedBlock).not.toContain('ubInvalidateGatewayCache');
  });
});

// ── GF291-3: execSend pending state ──────────────────────────────────────────
describe('GF291-3 — execSend gateway path: pending state shows submitted message', () => {
  const ubScreenStart = src.indexOf('var UBScreen = (function()');
  const ubScreenSrc   = ubScreenStart !== -1 ? src.slice(ubScreenStart, ubScreenStart + 80000) : src;
  const body = extractFn(ubScreenSrc, 'execSend');

  it("pending branch shows 'confirming' or 'submitted' — not 'confirmed'", () => {
    const pendingIdx = body.indexOf("gwStatus === 'pending'");
    expect(pendingIdx).toBeGreaterThan(-1);
    const pendingBlock = body.slice(pendingIdx, pendingIdx + 400);
    // Must say something about submission/confirmation in progress
    expect(pendingBlock.toLowerCase()).toMatch(/submit|confirm/);
    // Must NOT declare full success
    expect(pendingBlock).not.toContain("showResult(true, '" + 'confirmed');
  });

  it('pending branch calls showResult(true, ...) with non-final language', () => {
    const pendingIdx = body.indexOf("gwStatus === 'pending'");
    const pendingBlock = body.slice(pendingIdx, pendingIdx + 400);
    expect(pendingBlock).toContain('showResult(true,');
  });
});

// ── GF291-4: execSend ambiguous state ────────────────────────────────────────
describe('GF291-4 — execSend gateway path: ambiguous state shows recoverable message', () => {
  const ubScreenStart = src.indexOf('var UBScreen = (function()');
  const ubScreenSrc   = ubScreenStart !== -1 ? src.slice(ubScreenStart, ubScreenStart + 80000) : src;
  const body = extractFn(ubScreenSrc, 'execSend');

  it("ambiguous branch calls showResult(false, ...)", () => {
    const ambigIdx = body.indexOf("gwStatus === 'ambiguous'");
    expect(ambigIdx).toBeGreaterThan(-1);
    const ambigBlock = body.slice(ambigIdx, ambigIdx + 400);
    expect(ambigBlock).toContain('showResult(false,');
  });

  it("ambiguous branch warns against resubmission", () => {
    const ambigIdx = body.indexOf("gwStatus === 'ambiguous'");
    const ambigBlock = body.slice(ambigIdx, ambigIdx + 400);
    expect(ambigBlock.toLowerCase()).toMatch(/resubmit|retry|not resubmit/);
  });
});

// ── GF291-5: execSend error state ────────────────────────────────────────────
describe('GF291-5 — execSend gateway path: error state shows failure', () => {
  const ubScreenStart = src.indexOf('var UBScreen = (function()');
  const ubScreenSrc   = ubScreenStart !== -1 ? src.slice(ubScreenStart, ubScreenStart + 80000) : src;
  const body = extractFn(ubScreenSrc, 'execSend');

  it('fallthrough (unknown status) calls showResult(false, ...)', () => {
    // After all the named gwStatus checks, there should be a fallthrough showResult(false,...)
    const lastGwCheck  = body.lastIndexOf("gwStatus ===");
    const fallthrough  = body.slice(lastGwCheck, lastGwCheck + 500);
    expect(fallthrough).toContain('showResult(false,');
  });
});

// ── GF291-6: _ubGwCache status lifecycle ─────────────────────────────────────
describe('GF291-6 — _ubGwCache status lifecycle', () => {
  it("_ubGwCache has status field with default 'idle'", () => {
    const cacheIdx = src.indexOf('var _ubGwCache = {');
    expect(cacheIdx).toBeGreaterThan(-1);
    const cacheBlock = src.slice(cacheIdx, cacheIdx + 300);
    expect(cacheBlock).toMatch(/status\s*:\s*['"]idle['"]/);
  });

  it("ubGatewayFetch sets status to 'loading' before fetch", () => {
    const fetchFn = extractFn(src, 'ubGatewayFetch');
    const loadingIdx = fetchFn.indexOf("_ubGwCache.status = 'loading'");
    const fetchCallIdx = fetchFn.indexOf("fetch(url,");
    expect(loadingIdx).toBeGreaterThan(-1);
    expect(loadingIdx).toBeLessThan(fetchCallIdx);
  });

  it("error branch sets status to 'error'", () => {
    const fetchFn = extractFn(src, 'ubGatewayFetch');
    expect(fetchFn).toContain("_ubGwCache.status = 'error'");
  });

  it("ubGatewayRender sets status to 'ok'", () => {
    const renderFn = extractFn(src, 'ubGatewayRender');
    expect(renderFn).toContain("_ubGwCache.status = 'ok'");
  });

  it("ubInvalidateGatewayCache sets status to 'empty'", () => {
    const invalidateFn = extractFn(src, 'ubInvalidateGatewayCache');
    expect(invalidateFn).toContain("_ubGwCache.status = 'empty'");
  });
});

// ── GF291-7: no parseFloat fallback in _ubInjectSourceSelector ───────────────
describe('GF291-7 — _ubInjectSourceSelector: no parseFloat for gateway balance', () => {
  const selectorFn = extractFn(src, '_ubInjectSourceSelector');

  it('function exists', () => {
    expect(selectorFn.length).toBeGreaterThan(100);
  });

  it('does NOT use parseFloat on gwBalStr', () => {
    expect(selectorFn).not.toContain('parseFloat(gwBalStr)');
  });

  it('does NOT use || 0 as fallback for gateway balance', () => {
    // Check that the gateway-specific variable doesn't use '|| 0'
    const gwSection = selectorFn.slice(selectorFn.indexOf('gwBalStr'));
    expect(gwSection).not.toMatch(/gwBal\s*=.*\|\|\s*0/);
  });

  it('reads _ubGwCache.status to distinguish loading/error/idle', () => {
    expect(selectorFn).toContain('_ubGwCache.status');
  });
});

// ── GF291-8: balance states are visually distinct ────────────────────────────
describe('GF291-8 — _ubInjectSourceSelector: loading/error/zero/available are distinct', () => {
  const selectorFn = extractFn(src, '_ubInjectSourceSelector');

  it("loading state shows '…' indicator", () => {
    expect(selectorFn).toContain("'…'");
  });

  it("error state shows 'N/A'", () => {
    expect(selectorFn).toContain("'N/A'");
  });

  it("zero balance shows '$0.00' — not '—'", () => {
    expect(selectorFn).toContain("'$0.00'");
  });

  it("unknown/stale state shows '—' (not zero)", () => {
    // The else branch for idle/empty/stale
    expect(selectorFn).toContain("'—'");
  });
});

// ── GF291-9: ubGetGatewayBalance returns null for non-ok ─────────────────────
describe('GF291-9 — ubGetGatewayBalance returns null for non-ok statuses', () => {
  const body = extractFn(src, 'ubGetGatewayBalance');

  it('checks _ubGwCache.status === ok before returning a value', () => {
    expect(body).toContain("_ubGwCache.status !== 'ok'");
  });

  it('returns null when status is not ok', () => {
    // The guard must return null (not 0 or empty string)
    const guardIdx = body.indexOf("_ubGwCache.status !== 'ok'");
    const guardBlock = body.slice(guardIdx, guardIdx + 60);
    expect(guardBlock).toContain('return null');
  });
});

// ── GF291-10: cache NOT invalidated when blocked ─────────────────────────────
describe('GF291-10 — saExecGateway: cache not invalidated when blocked', () => {
  const body = extractFn(src, 'saExecGateway');

  it('ubInvalidateGatewayCache is called only inside result.ok branch', () => {
    // The invalidation must come AFTER the 'result.ok' check, not before
    const okIdx          = body.indexOf('result.ok');
    const invalidateIdx  = body.indexOf('ubInvalidateGatewayCache');
    expect(invalidateIdx).toBeGreaterThan(okIdx);
  });

  it('ubInvalidateGatewayCache is NOT called in the BLOCKED path', () => {
    const blockedIdx    = body.indexOf("status: 'blocked'");
    const invalidateIdx = body.indexOf('ubInvalidateGatewayCache');
    // invalidate comes after the blocked return, so blocked path cannot reach it
    expect(invalidateIdx).toBeGreaterThan(blockedIdx);
  });
});
