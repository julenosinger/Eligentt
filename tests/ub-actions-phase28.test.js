/**
 * Fase 2.8 — UB Actions: balance display and integration tests
 * Tests: UBScreen Swap balance (BalanceService path), Send balance,
 * cache integration, no UB.state.assets dependency, Gateway cache path,
 * cache invalidation after confirmed op.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const src = readFileSync(join(__dirname, '../index.html'), 'utf8');

// Helper: extract a named function body (up to balanced braces).
function extractFn(text, name) {
  const idx = text.indexOf('function ' + name);
  if (idx < 0) return '';
  let depth = 0, i = idx, found = false;
  for (; i < text.length; i++) {
    if (text[i] === '{') { depth++; found = true; }
    else if (text[i] === '}') { if (--depth === 0 && found) break; }
  }
  return text.slice(idx, i + 1);
}

// ── UB28-1: _refreshSwap does NOT read UB.state.assets ───────────────────────
describe('UB28-1 — _refreshSwap balance source', () => {
  it('does NOT read from UB.state.assets (stale float values)', () => {
    // Find UBScreen's _refreshSwap (the one that has ub-scr-swap-amt)
    const idx = src.indexOf('id="ub-scr-swap-amt"');
    // Go back to find the enclosing _refreshSwap
    const region = src.slice(Math.max(0, idx - 5000), idx + 500);
    expect(region).not.toContain('UB.state.assets');
  });

  it('reads balance via BalanceService.getTokenBalance for EVM source', () => {
    // UBScreen's _refreshSwap has a space before { — "function _refreshSwap() {"
    // (the UBAction one uses no space: "function _refreshSwap(){")
    const idx = src.indexOf("function _refreshSwap() {");
    expect(idx).toBeGreaterThan(0);
    const fnBody = src.slice(idx, idx + 4000);
    expect(fnBody).toContain('BalanceService.getTokenBalance');
    // 'UB.state.assets' may appear in a comment ("Never read from UB.state.assets")
    // but must NOT appear as an actual code expression (outside a comment line).
    const liveCode = fnBody.replace(/\/\/[^\n]*/g, '');
    expect(liveCode).not.toContain('UB.state.assets');
  });

  it('reads balance via ubGetGatewayBalance for gateway source', () => {
    const idx = src.indexOf("function _refreshSwap() {");
    const fnBody = src.slice(idx, idx + 4000);
    expect(fnBody).toContain('ubGetGatewayBalance');
    expect(fnBody).toContain("_ubSourceWallet === 'gateway'");
  });

  it('shows loading state (…) before async balance resolves', () => {
    const idx = src.indexOf("function _refreshSwap() {");
    const fnBody = src.slice(idx, idx + 4000);
    expect(fnBody).toContain("'Balance: …'");
  });

  it('handles BalanceService failure gracefully (RPC error text, no throw)', () => {
    const idx = src.indexOf("function _refreshSwap() {");
    const fnBody = src.slice(idx, idx + 4000);
    expect(fnBody).toContain('.catch(');
    expect(fnBody).toContain('RPC error');
  });
});

// ── UB28-2: Send drawer balance display ──────────────────────────────────────
describe('UB28-2 — Send drawer balance display', () => {
  it('sends drawer has ub-scr-send-bal element', () => {
    expect(src).toContain('id="ub-scr-send-bal"');
  });

  it('send balance uses BalanceService.getTokenBalance for EVM source', () => {
    const idx = src.indexOf('id="ub-scr-send-bal"');
    const region = src.slice(idx, idx + 4500);
    expect(region).toContain('BalanceService.getTokenBalance');
  });

  it('send balance label says Available not Balance', () => {
    const idx = src.indexOf('id="ub-scr-send-bal"');
    const region = src.slice(Math.max(0, idx - 200), idx + 50);
    expect(region).toContain('>Available<');
  });

  it('send balance updates on token change', () => {
    const idx = src.indexOf("_ubScrSendLoadBal");
    const region = src.slice(idx, idx + 3500);
    expect(region).toContain("addEventListener('change', _ubScrSendLoadBal)");
  });

  it('send total updates with selected token symbol not hardcoded USDC', () => {
    // sym2 is defined in the amount input handler inside the setTimeout
    const idx = src.indexOf('_ubScrSendLoadBal');
    const region = src.slice(idx, idx + 4500);
    expect(region).toContain('sym2');
  });
});

// ── UB28-3: UBAction.openSwap wires into UBAction quote engine ───────────────
describe('UB28-3 — UBAction Swap quote engine', () => {
  it('openSwap sets SWP.tokenInIdx and tokenOutIdx', () => {
    const idx = src.indexOf('function openSwap(');
    const fnBody = src.slice(idx, idx + 1500);
    expect(fnBody).toContain('SWP.tokenInIdx');
    expect(fnBody).toContain('SWP.tokenOutIdx');
  });

  it('_ubFetchSwapQuote uses SwapAggregator.getBestQuote', () => {
    const idx = src.indexOf('async function _ubFetchSwapQuote(');
    const fnBody = src.slice(idx, idx + 3000);
    expect(fnBody).toContain('SwapAggregator.getBestQuote');
  });

  it('_ubFetchSwapQuote shows No route when aggregator returns nothing', () => {
    const idx = src.indexOf('async function _ubFetchSwapQuote(');
    const fnBody = src.slice(idx, idx + 3000);
    expect(fnBody).toContain('No route');
  });
});

// ── UB28-4: UBScreen._refreshSwap uses SwapAggregator ────────────────────────
describe('UB28-4 — UBScreen Swap quote wiring', () => {
  it('UBScreen._ubQuoteSwap uses SwapAggregator.getBestQuote', () => {
    const idx = src.indexOf('async function _ubQuoteSwap(');
    const fnBody = src.slice(idx, idx + 4000);
    expect(fnBody).toContain('SwapAggregator.getBestQuote');
  });

  it('UBScreen swap has hard 9s timeout guard', () => {
    const idx = src.indexOf('async function _ubQuoteSwap(');
    const fnBody = src.slice(idx, idx + 4000);
    expect(fnBody).toContain('HARD_TIMEOUT');
    expect(fnBody).toContain('9000');
  });

  it('UBScreen swap shows No route available when no quote', () => {
    // _ubSwapNoRoute is the helper called on no-route — check it exists and
    // has the 'No route' text; the call itself is in _ubQuoteSwap region.
    const idx = src.indexOf('function _ubSwapNoRoute(');
    expect(idx).toBeGreaterThan(0);
    const fnBody = src.slice(idx, idx + 500);
    expect(fnBody).toContain('No route');
  });
});

// ── UB28-5: ubGwCache integration ────────────────────────────────────────────
describe('UB28-5 — ubGwCache is single source for Gateway balances', () => {
  it('ubGetGatewayBalance exists and reads _ubGwCache', () => {
    expect(src).toContain('function ubGetGatewayBalance(');
    const idx = src.indexOf('function ubGetGatewayBalance(');
    const fnBody = src.slice(idx, idx + 1500);
    expect(fnBody).toContain('_ubGwCache');
    expect(fnBody).not.toContain("fetch('/api/gateway/balances");
  });

  it('ubInvalidateGatewayCache exists, clears cache, and triggers a GW refresh', () => {
    expect(src).toContain('function ubInvalidateGatewayCache(');
    const idx = src.indexOf('function ubInvalidateGatewayCache(');
    const fnBody = src.slice(idx, idx + 1500);
    expect(fnBody).toContain('_ubGwCache');
    // Triggers ubGatewaySyncRefresh (lightweight GW-only refresh, not full ubRefresh)
    expect(fnBody).toContain('ubGatewaySyncRefresh');
  });

  it('saLoadGatewayBalance reads from shared cache (ubGetGatewayBalance)', () => {
    const idx = src.indexOf('function saLoadGatewayBalance()');
    const fnBody = src.slice(idx, idx + 1200);
    expect(fnBody).toContain('ubGetGatewayBalance');
    expect(fnBody).not.toContain("fetch('/api/gateway/balances");
  });

  it('swpLoadGatewayBalance reads from shared cache (ubGetGatewayBalance)', () => {
    const idx = src.indexOf('function swpLoadGatewayBalance()');
    const fnBody = src.slice(idx, idx + 1200);
    expect(fnBody).toContain('ubGetGatewayBalance');
    expect(fnBody).not.toContain("fetch('/api/gateway/balances");
  });

  it('saExecGateway calls ubInvalidateGatewayCache after success', () => {
    const idx = src.indexOf('async function saExecGateway(');
    const fnBody = src.slice(idx, idx + 4000);
    expect(fnBody).toContain('ubInvalidateGatewayCache');
  });
});

// ── UB28-6: GATEWAY_SPEND_BLOCKED (Fase 2.9.2: set to false — security approved) ─
describe('UB28-6 — GATEWAY_SPEND_BLOCKED enforcement', () => {
  it('GATEWAY_SPEND_BLOCKED is declared as false (Fase 2.9.2: all security checks approved)', () => {
    const idx = src.indexOf('var GATEWAY_SPEND_BLOCKED');
    expect(idx).toBeGreaterThan(0);
    const decl = src.slice(idx, idx + 60);
    expect(decl).toContain('false');
  });

  it('saExecGateway no longer hard-blocks execution (Fase 2.9.2: flag removed, backend health-check instead)', () => {
    // Fase 2.9.2: GATEWAY_SPEND_BLOCKED removed from saExecGateway.
    // Backend availability is checked by GatewaySpendService.execute at runtime.
    const idx = src.indexOf('async function saExecGateway(');
    expect(idx).toBeGreaterThan(0);
    const fnBody = src.slice(idx, idx + 3000);
    // Must route to GatewaySpendService.execute
    expect(fnBody).toContain('GatewaySpendService');
  });
});

// ── UB28-7: No double-fetch of /api/gateway/balances ─────────────────────────
describe('UB28-7 — Single fetch path for Gateway balances', () => {
  it('only ubGatewayFetch assigns the /api/gateway/balances URL', () => {
    // ubGatewayFetch builds: var url = '/api/gateway/balances?address='
    // Other functions use the cache via ubGetGatewayBalance — no direct URL assignment.
    const matches = [];
    const re = /['"]\/api\/gateway\/balances/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      // Only count if the surrounding context is NOT a comment line
      const lineStart = src.lastIndexOf('\n', m.index) + 1;
      const lineText = src.slice(lineStart, m.index + 30);
      if (!lineText.trim().startsWith('//') && !lineText.trim().startsWith('*')) {
        matches.push(m.index);
      }
    }
    // Exactly one non-comment occurrence — the URL assignment in ubGatewayFetch
    expect(matches.length).toBe(1);
    const fnIdx = src.indexOf('function ubGatewayFetch(');
    const fnEnd = fnIdx + 3000;
    expect(matches[0]).toBeGreaterThan(fnIdx);
    expect(matches[0]).toBeLessThan(fnEnd);
  });
});

// ── UB28-8: UBAction asset-row buttons exist ─────────────────────────────────
describe('UB28-8 — Asset row action buttons', () => {
  // The onclick attributes use escaped quotes (\') in the JS string literal,
  // so readFileSync gives back "UBAction.openSend(\'" not "UBAction.openSend('".
  it('Send button calls UBAction.openSend', () => {
    expect(src).toContain("UBAction.openSend");
  });

  it('Swap button calls UBAction.openSwap (Arc group only)', () => {
    expect(src).toContain("UBAction.openSwap");
    const idx = src.indexOf("UBAction.openSwap");
    const region = src.slice(Math.max(0, idx - 300), idx + 100);
    expect(region).toContain('isArcGroup');
  });

  it('Bridge button calls UBAction.openBridge (Arc group only)', () => {
    expect(src).toContain("UBAction.openBridge");
    const idx = src.indexOf("UBAction.openBridge");
    const region = src.slice(Math.max(0, idx - 300), idx + 100);
    expect(region).toContain('isArcGroup');
  });
});
