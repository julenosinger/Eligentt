/**
 * bridge-multi-route.test.js
 * Tests for the multi-route bridge selection flow.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const html = readFileSync(join(__dirname, '../index.html'), 'utf8');

// ── CF Function presence ──────────────────────────────────────────────────
describe('CF Functions', () => {
  it('routes.js exists', () => {
    const src = readFileSync(join(__dirname, '../functions/api/lifi/routes.js'), 'utf8');
    expect(src).toContain('/advanced/routes');
    expect(src).toContain('onRequestPost');
  });

  it('routes.js never exposes LIFI_API_KEY to response body', () => {
    const src = readFileSync(join(__dirname, '../functions/api/lifi/routes.js'), 'utf8');
    // LIFI_API_KEY must never appear inside a json() response body.
    // Strategy: check that no `return json(` call has LIFI_API_KEY inside its argument block.
    // We find each `return json(` and scan forward to the matching `)` to get the arg.
    let idx = 0;
    while ((idx = src.indexOf('return json(', idx)) !== -1) {
      const argStart = idx + 'return json('.length;
      // Scan for the closing paren at nesting depth 0 (skip nested parens)
      let depth = 1, pos = argStart;
      while (pos < src.length && depth > 0) {
        if (src[pos] === '(') depth++;
        else if (src[pos] === ')') depth--;
        pos++;
      }
      const argBody = src.slice(argStart, pos - 1);
      expect(argBody).not.toContain('LIFI_API_KEY');
      idx = pos;
    }
    // Also verify the key IS used in upstream request headers (not hardcoded in body)
    expect(src).toContain("headers['x-lifi-api-key']");
  });

  it('step-transaction.js exists', () => {
    const src = readFileSync(join(__dirname, '../functions/api/lifi/step-transaction.js'), 'utf8');
    expect(src).toContain('/advanced/stepTransaction');
    expect(src).toContain('onRequestPost');
  });

  it('step-transaction.js validates step has id and action', () => {
    const src = readFileSync(join(__dirname, '../functions/api/lifi/step-transaction.js'), 'utf8');
    expect(src).toContain('step.id');
    expect(src).toContain('step.action');
  });
});

// ── LiFiAdapter ───────────────────────────────────────────────────────────
describe('LiFiAdapter', () => {
  it('exports getRoutes', () => {
    const src = readFileSync(join(__dirname, '../shared/LiFiAdapter.js'), 'utf8');
    expect(src).toContain('getRoutes: getRoutes');
  });

  it('exports getStepTransaction', () => {
    const src = readFileSync(join(__dirname, '../shared/LiFiAdapter.js'), 'utf8');
    expect(src).toContain('getStepTransaction: getStepTransaction');
  });

  it('getQuote is still exported (no regression)', () => {
    const src = readFileSync(join(__dirname, '../shared/LiFiAdapter.js'), 'utf8');
    expect(src).toContain('getQuote: getQuote');
  });

  it('getRoutes uses /api/lifi/routes endpoint', () => {
    const src = readFileSync(join(__dirname, '../shared/LiFiAdapter.js'), 'utf8');
    expect(src).toContain("var ROUTES_API = '/api/lifi/routes'");
    expect(src).toContain('ROUTES_API');
  });

  it('getStepTransaction uses /api/lifi/step-transaction endpoint', () => {
    const src = readFileSync(join(__dirname, '../shared/LiFiAdapter.js'), 'utf8');
    expect(src).toContain("var STEP_TX_API = '/api/lifi/step-transaction'");
    expect(src).toContain('STEP_TX_API');
  });
});

// ── Bridge routes panel — no auto-selection ──────────────────────────────
describe('Bridge route selection', () => {
  it('_fetchBridgeRoutes uses getRoutes not only getQuote', () => {
    const fetch = html.slice(html.indexOf('async function _fetchBridgeRoutes('), html.indexOf('// ── Route panel rendering'));
    expect(fetch).toContain('LiFiAdapter.getRoutes');
  });

  it('No auto-selection of routes[0] after fetch', () => {
    const startIdx = html.indexOf('// Store routes. NO auto-selection');
    const chunk = html.slice(startIdx, startIdx + 200);
    expect(chunk).toContain('_selectedBridgeRoute = null');
    expect(chunk).not.toContain('_selectedBridgeRoute = routes[0]');
  });

  it('executeBridgeOrTurbo guards require explicit selection when routes loaded', () => {
    const fn = html.slice(html.indexOf('function executeBridgeOrTurbo()'), html.indexOf('// ── Fallback: no routes loaded'));
    expect(fn).toContain('_bridgeRoutes.length > 0 && !_selectedBridgeRoute');
    expect(fn).toContain("toast('Please select a route before bridging.'");
  });

  it('brSelectRoute sets _selectedBridgeRoute (not auto)', () => {
    const fn = html.slice(html.indexOf('function brSelectRoute(idx)'), html.indexOf('// Clear routes'));
    expect(fn).toContain('_selectedBridgeRoute = route');
  });

  it('brSelectRoute stores quote for execution', () => {
    const fn = html.slice(html.indexOf('function brSelectRoute(idx)'), html.indexOf('// Clear routes'));
    expect(fn).toContain("_bridgeLastQuote = route.quote");
  });

  it('Best Rate badge is informational only (not auto-executed)', () => {
    // _brsRenderRoutes spans from its function def to inner.innerHTML = html
    const startIdx = html.indexOf('function _brsRenderRoutes(');
    const endIdx   = html.indexOf("inner.innerHTML = html;", startIdx);
    const render = html.slice(startIdx, endIdx + 30);
    expect(render).toContain('Best Rate');
    // Must NOT auto-set _selectedBridgeRoute inside _brsRenderRoutes
    expect(render).not.toContain('_selectedBridgeRoute =');
  });

  it('Fastest badge is shown for route with lowest execSec', () => {
    const startIdx = html.indexOf('// Identify FASTEST route');
    const render = html.slice(startIdx, startIdx + 400);
    expect(render).toContain('fastestIdx');
    expect(render).toContain('minExecSec');
  });

  it('Fastest badge only shown when different from Best Rate (index 0)', () => {
    const startIdx = html.indexOf('// Only show FASTEST badge');
    const render = html.slice(startIdx, startIdx + 160);
    expect(render).toContain('fastestIdx === 0');
    expect(render).toContain('fastestIdx = -1');
  });

  it('SELECT button is present for each route card', () => {
    const render = html.slice(html.indexOf('function _brsRenderRoutes('), html.indexOf('// Select a route explicitly'));
    expect(render).toContain('brs-select-btn');
    expect(render).toContain("onclick=\"event.stopPropagation();brSelectRoute(");
  });
});

// ── executeBridgeViaLiFi — uses selected route + stepTransaction ──────────
describe('executeBridgeViaLiFi', () => {
  it('calls getStepTransaction for selected route step', () => {
    // executeBridgeViaLiFi is at line ~35265, after executeBridgeViaCCTP
    const startIdx = html.indexOf('async function executeBridgeViaLiFi()');
    const fn = html.slice(startIdx, startIdx + 8000);
    expect(fn).toContain('LiFiAdapter.getStepTransaction');
    expect(fn).toContain('_selStep');
  });

  it('falls back to getQuote when no route is selected', () => {
    const startIdx = html.indexOf('async function executeBridgeViaLiFi()');
    const fn = html.slice(startIdx, startIdx + 8000);
    expect(fn).toContain('LiFiAdapter.getQuote');
    expect(fn).toContain('Fallback: no route selected');
  });

  it('validates route via LiFiAdapter.validateRoute before execution', () => {
    const startIdx = html.indexOf('async function executeBridgeViaLiFi()');
    const fn = html.slice(startIdx, startIdx + 8000);
    expect(fn).toContain('LiFiAdapter.validateRoute');
  });

  it('does not re-fetch a quote when a route was selected', () => {
    const fn = html.slice(
      html.indexOf('// 1. Obtain transactionRequest for the SELECTED route step.'),
      html.indexOf('// 2. Switch to source chain')
    );
    // The selected-route path uses getStepTransaction, not getQuote
    const selectedPath = fn.slice(0, fn.indexOf('} else {'));
    expect(selectedPath).not.toContain('LiFiAdapter.getQuote');
    expect(selectedPath).toContain('LiFiAdapter.getStepTransaction');
  });
});

// ── No regression: existing functions still present ──────────────────────
describe('No regression', () => {
  it('executeBridgeViaCCTP still exists', () => {
    expect(html).toContain('function executeBridgeViaCCTP');
  });

  it('xcExecuteSend still exists', () => {
    expect(html).toContain('function xcExecuteSend');
  });

  it('LiFiAdapter.validateRoute still exists', () => {
    const src = readFileSync(join(__dirname, '../shared/LiFiAdapter.js'), 'utf8');
    expect(src).toContain('validateRoute: validateRoute');
  });

  it('LiFiAdapter.getStatus still exists', () => {
    const src = readFileSync(join(__dirname, '../shared/LiFiAdapter.js'), 'utf8');
    expect(src).toContain('getStatus: getStatus');
  });

  it('Bridge Steps card still present in HTML', () => {
    expect(html).toContain('bridge-steps-card');
    expect(html).toContain('bridge-step-list');
  });

  it('_brsShowSteps still exists', () => {
    expect(html).toContain('function _brsShowSteps');
  });

  it('_brsShowRoutes still exists', () => {
    expect(html).toContain('function _brsShowRoutes');
  });

  it('_brsClearRoutes still exists', () => {
    expect(html).toContain('function _brsClearRoutes');
  });

  it('BridgeEngine.notifyStandardStart still called', () => {
    const startIdx = html.indexOf('async function executeBridgeViaLiFi()');
    const fn = html.slice(startIdx, startIdx + 8000);
    expect(fn).toContain('BridgeEngine.notifyStandardStart');
  });
});
