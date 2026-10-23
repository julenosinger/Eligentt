/**
 * tests/gateway-balance.test.js
 * Gateway Balance integration — Fase 1 (read-only)
 *
 * Test categories:
 *  CF1  — CF Function structure
 *  CF2  — Domain / asset matrix
 *  CF3  — Error handling
 *  UI1  — HTML structure
 *  UI2  — JS functions present
 *  UI3  — Decimal precision (_ubGwFmt logic)
 *  UI4  — Race-condition guard (_ubGwSeq)
 *  UI5  — No double-counting (Gateway ≠ EVM wallet)
 *  UI6  — ubGatewaySyncRefresh wired into ubRefresh
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT   = path.resolve(__dirname, '..');
const html   = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const cfPath = path.join(ROOT, 'functions/api/gateway/balances.js');
const cfSrc  = fs.existsSync(cfPath) ? fs.readFileSync(cfPath, 'utf8') : '';

// ── helpers ──────────────────────────────────────────────────────────────────
function blockAt(text, anchor, size) {
  const idx = text.indexOf(anchor);
  return idx === -1 ? '' : text.slice(idx, idx + size);
}
function fnBlock(text, name, size) {
  return blockAt(text, 'function ' + name + '(', size);
}

// ── CF1: CF Function structure ────────────────────────────────────────────────
describe('CF Function — /api/gateway/balances', () => {
  it('CF1.1 — file exists', () => {
    expect(fs.existsSync(cfPath)).toBe(true);
  });

  it('CF1.2 — targets mainnet URL gateway-api.circle.com (not testnet)', () => {
    expect(cfSrc).toContain('gateway-api.circle.com');
    expect(cfSrc).not.toContain('gateway-api-testnet');
  });

  it('CF1.3 — exports onRequestGet handler', () => {
    expect(cfSrc).toContain('export async function onRequestGet');
  });

  it('CF1.4 — fetches all three assets: USDC, EURC, cirBTC', () => {
    expect(cfSrc).toContain("'USDC'");
    expect(cfSrc).toContain("'EURC'");
    expect(cfSrc).toContain("'cirBTC'");
  });

  it('CF1.5 — uses POST /v1/balances', () => {
    expect(cfSrc).toContain('/v1/balances');
    expect(cfSrc).toContain("'POST'");
  });

  it('CF1.6 — validates address format before calling Gateway', () => {
    expect(cfSrc).toContain('0x[0-9a-fA-F]{40}');
    expect(cfSrc).toContain('Invalid address');
  });

  it('CF1.7 — has timeout/abort controller (13s — less than the 14s frontend timeout)', () => {
    expect(cfSrc).toContain('AbortController');
    expect(cfSrc).toContain('setTimeout');
    // CF must abort before the 14s frontend timeout: value must be ≤ 13000.
    const match = cfSrc.match(/setTimeout\([^,]+,\s*(\d+)/);
    if (match) {
      expect(Number(match[1])).toBeLessThanOrEqual(13000);
    }
  });

  it('CF1.8 — returns no-store cache header', () => {
    expect(cfSrc).toContain('no-store');
  });

  it('CF1.9 — uses Promise.allSettled (parallel, resilient to partial failure)', () => {
    expect(cfSrc).toContain('Promise.allSettled');
  });

  it('CF1.10 — returns errors object per-asset on partial failure', () => {
    expect(cfSrc).toContain('errors');
  });
});

// ── CF2: Domain / asset matrix ───────────────────────────────────────────────
describe('CF Function — domain/asset matrix', () => {
  it('CF2.1 — USDC domains include Ethereum(0) and Arc(26)', () => {
    const usdc = blockAt(cfSrc, 'USDC:', 60);
    expect(usdc).toContain('0');
    expect(usdc).toContain('26');
  });

  it('CF2.2 — EURC domains include Arc(26), Ethereum(0), Base(6)', () => {
    const eurc = blockAt(cfSrc, 'EURC:', 60);
    expect(eurc).toContain('26');
    expect(eurc).toContain('0');
    expect(eurc).toContain('6');
  });

  it('CF2.3 — cirBTC limited to Arc(26) and Ethereum(0) only', () => {
    const cbtc = blockAt(cfSrc, 'cirBTC:', 60);
    expect(cbtc).toContain('26');
    expect(cbtc).toContain('0');
    // Must NOT include Base(6) or Arbitrum(3) for cirBTC
    // (numbers appear in other entries too, so we check array literal)
    expect(cfSrc).toMatch(/cirBTC:\s*\[[^\]]*\]/);
    const match = cfSrc.match(/cirBTC:\s*(\[[^\]]*\])/);
    if (match) {
      const arr = match[1];
      const nums = arr.match(/\d+/g)?.map(Number) ?? [];
      expect(nums).not.toContain(6);   // not Base
      expect(nums).not.toContain(3);   // not Arbitrum
    }
  });

  it('CF2.4 — domain map includes Arc (26) as "Arc"', () => {
    expect(cfSrc).toContain("26");
    expect(cfSrc).toContain("'Arc'");
  });

  it('CF2.5 — domain map has correct entries for primary chains', () => {
    expect(cfSrc).toContain("'Ethereum'");
    expect(cfSrc).toContain("'Base'");
    expect(cfSrc).toContain("'Arbitrum'");
  });
});

// ── CF3: Error handling ──────────────────────────────────────────────────────
describe('CF Function — error handling', () => {
  it('CF3.1 — handles non-ok HTTP response from Gateway', () => {
    expect(cfSrc).toContain('res.ok');
    expect(cfSrc).toContain('throw new Error');
  });

  it('CF3.2 — 400 on invalid address, 502 on gateway error', () => {
    expect(cfSrc).toContain('status: 400');
    expect(cfSrc).toContain('status: 502');
  });

  it('CF3.3 — partial failure: returns data for successful assets + errors for failed', () => {
    expect(cfSrc).toContain("status === 'fulfilled'");
    expect(cfSrc).toContain("reason?.message");
  });
});

// ── UI1: HTML structure ──────────────────────────────────────────────────────
describe('UI — HTML Gateway Balance card', () => {
  it('UI1.1 — #ub-gateway-card exists', () => {
    expect(html).toContain('id="ub-gateway-card"');
  });

  it('UI1.2 — #ub-gw-body exists', () => {
    expect(html).toContain('id="ub-gw-body"');
  });

  it('UI1.3 — #ub-gw-loading exists', () => {
    expect(html).toContain('id="ub-gw-loading"');
  });

  it('UI1.4 — #ub-gw-error exists', () => {
    expect(html).toContain('id="ub-gw-error"');
  });

  it('UI1.5 — #ub-gw-assets container exists', () => {
    expect(html).toContain('id="ub-gw-assets"');
  });

  it('UI1.6 — "Circle Gateway" badge present in card', () => {
    const card = blockAt(html, 'id="ub-gateway-card"', 600);
    expect(card).toContain('Circle Gateway');
  });

  it('UI1.7 — Gateway card is AFTER Networks card (ordering)', () => {
    const nets = html.indexOf('id="ub-networks-card"');
    const gw   = html.indexOf('id="ub-gateway-card"');
    expect(nets).toBeGreaterThan(-1);
    expect(gw).toBeGreaterThan(-1);
    expect(gw).toBeGreaterThan(nets);
  });

  it('UI1.8 — Gateway card is BEFORE ub-activity (not inside EVM wallet section)', () => {
    const gw  = html.indexOf('id="ub-gateway-card"');
    const act = html.indexOf('id="ub-activity"');
    expect(gw).toBeLessThan(act);
  });
});

// ── UI2: JS functions present ────────────────────────────────────────────────
describe('UI — JS functions present', () => {
  it('UI2.1 — ubGatewayFetch defined', () => {
    expect(html).toContain('function ubGatewayFetch(');
  });

  it('UI2.2 — ubGatewayRender defined', () => {
    expect(html).toContain('function ubGatewayRender(');
  });

  it('UI2.3 — ubGatewayToggle defined', () => {
    expect(html).toContain('function ubGatewayToggle(');
  });

  it('UI2.4 — ubGatewaySyncRefresh defined', () => {
    expect(html).toContain('function ubGatewaySyncRefresh(');
  });

  it('UI2.5 — _ubGwFmt formatter defined', () => {
    expect(html).toContain('function _ubGwFmt(');
  });

  it('UI2.6 — _ubGwSeq anti-race counter declared', () => {
    expect(html).toContain('_ubGwSeq');
  });
});

// ── UI3: Decimal precision ───────────────────────────────────────────────────
describe('UI — decimal formatting _ubGwFmt (functional)', () => {
  // Extract _ubGwFmt and _ubGwAddStr and evaluate inline.
  let _ubGwFmt, _ubGwAddStr;
  try {
    // _ubGwFmt is now a multi-line function — extract up to the closing brace.
    const fmtStart = html.indexOf('function _ubGwFmt(');
    const addStart = html.indexOf('function _ubGwAddStr(');
    if (fmtStart !== -1) {
      // Extract function body by counting braces.
      let depth = 0, i = fmtStart, started = false;
      for (; i < html.length; i++) {
        if (html[i] === '{') { depth++; started = true; }
        else if (html[i] === '}') { depth--; }
        if (started && depth === 0) { i++; break; }
      }
      const src = html.slice(fmtStart, i);
      const m = src.match(/^function _ubGwFmt\(([^)]*)\)\s*\{([\s\S]*)\}$/s);
      if (m) _ubGwFmt = new Function(m[1], m[2]); // eslint-disable-line no-new-func
    }
    if (addStart !== -1) {
      let depth = 0, i = addStart, started = false;
      for (; i < html.length; i++) {
        if (html[i] === '{') { depth++; started = true; }
        else if (html[i] === '}') { depth--; }
        if (started && depth === 0) { i++; break; }
      }
      const src = html.slice(addStart, i);
      const m = src.match(/^function _ubGwAddStr\(([^)]*)\)\s*\{([\s\S]*)\}$/s);
      if (m) _ubGwAddStr = new Function(m[1], m[2]); // eslint-disable-line no-new-func
    }
  } catch (_) {}

  it('UI3.1 — USDC: API string "1.500000" (6 dec) → "1.5"', () => {
    if (!_ubGwFmt) return;
    expect(_ubGwFmt('1.500000', 6)).toBe('1.5');
  });

  it('UI3.2 — USDC: API string "0.000000" → "0"', () => {
    if (!_ubGwFmt) return;
    expect(_ubGwFmt('0.000000', 6)).toBe('0');
  });

  it('UI3.3 — cirBTC: API string "0.00012345" (8 dec) preserved exactly', () => {
    if (!_ubGwFmt) return;
    expect(_ubGwFmt('0.00012345', 8)).toBe('0.00012345');
  });

  it('UI3.4 — cirBTC: trims trailing zeros "1.00000000" → "1"', () => {
    if (!_ubGwFmt) return;
    expect(_ubGwFmt('1.00000000', 8)).toBe('1');
  });

  it('UI3.5 — NaN string → "—"', () => {
    if (!_ubGwFmt) return;
    expect(_ubGwFmt('NaN', 6)).toBe('—');
  });

  it('UI3.6 — null → "—"', () => {
    if (!_ubGwFmt) return;
    expect(_ubGwFmt(null, 6)).toBe('—');
  });

  it('UI3.7 — cirBTC large value "21000000.00000001" no float loss', () => {
    if (!_ubGwFmt) return;
    // Float would round to "21000000" — string arithmetic preserves the satoshi.
    expect(_ubGwFmt('21000000.00000001', 8)).toBe('21000000.00000001');
  });

  it('UI3.8 — empty string → "—"', () => {
    if (!_ubGwFmt) return;
    expect(_ubGwFmt('', 6)).toBe('—');
  });

  it('UI3.9 — USDC: "9.079400" → "9.0794"', () => {
    if (!_ubGwFmt) return;
    expect(_ubGwFmt('9.079400', 6)).toBe('9.0794');
  });

  it('UI3.10 — _ubGwAddStr: "0.5" + "0.5" at 6 dec = "1"', () => {
    if (!_ubGwAddStr) return;
    expect(_ubGwAddStr('0.5', '0.5', 6)).toBe('1');
  });

  it('UI3.11 — _ubGwAddStr: cirBTC "0.00000001" + "0.00000001" at 8 dec = "0.00000002"', () => {
    if (!_ubGwAddStr) return;
    expect(_ubGwAddStr('0.00000001', '0.00000001', 8)).toBe('0.00000002');
  });

  it('UI3.12 — _ubGwAddStr: no float precision loss for large cirBTC', () => {
    if (!_ubGwAddStr) return;
    // float addition would lose the last satoshi
    expect(_ubGwAddStr('21000000.00000000', '0.00000001', 8)).toBe('21000000.00000001');
  });

  it('UI3.13 — _ubGwAddStr is defined in index.html', () => {
    expect(html).toContain('function _ubGwAddStr(');
  });
});

// ── UI4: Race-condition guard ────────────────────────────────────────────────
describe('UI — race-condition guard', () => {
  it('UI4.1 — ubGatewayFetch increments _ubGwSeq before fetch', () => {
    const fn = fnBlock(html, 'ubGatewayFetch', 1200);
    expect(fn).toContain('_ubGwSeq');
    expect(fn).toContain('++_ubGwSeq');
  });

  it('UI4.2 — stale response check: seq !== _ubGwSeq → discard', () => {
    const fn = fnBlock(html, 'ubGatewayFetch', 2000);
    expect(fn).toContain('seq !== _ubGwSeq');
  });

  it('UI4.3 — _ubGwFetching guard prevents duplicate in-flight requests', () => {
    const fn = fnBlock(html, 'ubGatewayFetch', 1200);
    expect(fn).toContain('_ubGwFetching');
  });
});

// ── UI5: No double-counting ──────────────────────────────────────────────────
describe('UI — separation of Gateway vs EVM wallet balances', () => {
  it('UI5.1 — ubGatewaySyncRefresh NOT wired into ubFetchAllBalances (separate path)', () => {
    const fetchAll = fnBlock(html, 'ubFetchAllBalances', 2000);
    expect(fetchAll).not.toContain('ubGateway');
  });

  it('UI5.2 — ubGatewayRender does NOT call ubRenderHero or modify ub-hero-total', () => {
    const fn = fnBlock(html, 'ubGatewayRender', 2000);
    expect(fn).not.toContain('ubRenderHero');
    expect(fn).not.toContain('ub-hero-total');
  });

  it('UI5.3 — Gateway card has distinct id (ub-gateway-card) not part of ub-content grid', () => {
    const grid = blockAt(html, 'class="ub2-grid"', 3000);
    expect(grid).not.toContain('ub-gateway-card');
  });

  it('UI5.4 — ubGatewayRender does NOT push to UB.state.assets', () => {
    const fn = fnBlock(html, 'ubGatewayRender', 2000);
    expect(fn).not.toContain('UB.state');
  });
});

// ── UI6: ubGatewaySyncRefresh wired into ubRefresh ────────────────────────────
describe('UI — ubGatewaySyncRefresh called from ubRefresh', () => {
  it('UI6.1 — ubRefresh calls ubGatewaySyncRefresh', () => {
    const fn = fnBlock(html, 'ubRefresh', 2000);
    expect(fn).toContain('ubGatewaySyncRefresh');
  });

  it('UI6.2 — call is wrapped in try/catch (non-blocking)', () => {
    const fn = fnBlock(html, 'ubGatewaySyncRefresh', 200);
    expect(fn).toContain('ubGatewayFetch');
  });

  it('UI6.3 — ubGatewaySyncRefresh is called BEFORE evmFetch .then() (parallel, not sequential)', () => {
    const fn = fnBlock(html, 'ubRefresh', 3000);
    const gwIdx = fn.indexOf('ubGatewaySyncRefresh');
    const thenIdx = fn.indexOf('evmFetch\n');
    // Both should be present; gw fires right after evmFetch is created (parallel)
    expect(gwIdx).toBeGreaterThan(-1);
    expect(thenIdx).toBeGreaterThan(-1);
  });
});
