/**
 * Swap — route picker regression tests.
 * ═══════════════════════════════════════════════════════════════════════════
 * Locks in the surgical route-picker implementation:
 *
 *  1. swpSelectRoute: sets SWP.selectedSource + applies quote display.
 *  2. Non-executable / missing quotes are rejected by swpSelectRoute.
 *  3. LI.FI lazy calldata path (_needsStepTx) is handled inside swpSelectRoute.
 *  4. swpApplySelectedQuote labels: Tower → "Tower Aggregator",
 *     LI.FI → "LI.FI [· Tool]", local → "Elligentt AMM".
 *  5. selectedParamsKey resets when token/amount params change.
 *  6. resolveSelection: persists selection when params unchanged,
 *     falls back to bestExecutable when params change.
 *  7. findExecutableQuote: returns lifi-N (_needsStepTx) quotes as selectable.
 *  8. Execution follows ONLY the selected source — no silent fallback.
 *
 * Source-level tests: read production index.html + shared/ modules.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const modesSrc = fs.readFileSync(path.join(root, 'shared', 'swapUiModes.js'), 'utf8');

// ── Module evaluator ──────────────────────────────────────────────────────
function evalModule(src, win) {
  new Function('window', src).call(null, win);
}
function makeModes() {
  const w = { SwapUiModes: undefined };
  evalModule(modesSrc, w);
  return w.SwapUiModes;
}

function q(source, over) {
  return Object.assign({
    source,
    ok: true,
    executable: true,
    tokenIn: 'USDC', tokenOut: 'EURC',
    amountInRaw: 1000000n,
    expectedOutRaw: 1000000n,
    minOutRaw: 995000n,
    calldata: '0xabcdef',
    to: '0x1234000000000000000000000000000000000001',
    spender: '0x1234000000000000000000000000000000000001',
    expiresAt: Date.now() + 60000,
    _needsStepTx: false,
  }, over || {});
}

// ── 1. swpSelectRoute structure ───────────────────────────────────────────
describe('swpSelectRoute — structure (index.html)', () => {
  it('function exists in index.html', () => {
    expect(html).toContain('function swpSelectRoute(source)');
  });

  it('sets SWP.selectedSource to the chosen source', () => {
    const fn = html.slice(
      html.indexOf('function swpSelectRoute(source)'),
      html.indexOf('function swpApplySelectedQuote(')
    );
    expect(fn).toContain('SWP.selectedSource = source;');
  });

  it('guards against non-executable quotes (returns early when findExecutableQuote returns null)', () => {
    const fn = html.slice(
      html.indexOf('function swpSelectRoute(source)'),
      html.indexOf('function swpApplySelectedQuote(')
    );
    expect(fn).toContain('if (!q) return;');
  });

  it('calls swpApplySelectedQuote with the resolved quote', () => {
    const fn = html.slice(
      html.indexOf('function swpSelectRoute(source)'),
      html.indexOf('function swpApplySelectedQuote(')
    );
    expect(fn).toContain('swpApplySelectedQuote(q)');
  });

  it('re-renders the route selector after selection', () => {
    const fn = html.slice(
      html.indexOf('function swpSelectRoute(source)'),
      html.indexOf('function swpApplySelectedQuote(')
    );
    expect(fn).toContain('SwapUiModes.renderRouteSelector');
  });
});

// ── 2. LI.FI lazy calldata path ───────────────────────────────────────────
describe('swpSelectRoute — LI.FI _needsStepTx path', () => {
  it('detects _needsStepTx and calls LiFiAdapter.getStepTransaction', () => {
    const fn = html.slice(
      html.indexOf('function swpSelectRoute(source)'),
      html.indexOf('function swpApplySelectedQuote(')
    );
    expect(fn).toContain('q._needsStepTx');
    expect(fn).toContain('LiFiAdapter.getStepTransaction(step)');
  });

  it('patches aggQuotes in-place after calldata resolves', () => {
    const fn = html.slice(
      html.indexOf('function swpSelectRoute(source)'),
      html.indexOf('function swpApplySelectedQuote(')
    );
    expect(fn).toContain('SWP.aggQuotes[_qi] = patchedQ;');
  });

  it('stores resolved calldata in SWP._towerQuoteData so executeSwap can use it', () => {
    const fn = html.slice(
      html.indexOf('function swpSelectRoute(source)'),
      html.indexOf('function swpApplySelectedQuote(')
    );
    expect(fn).toContain('SWP._towerQuoteData = patchedQ;');
  });

  it('marks swapButton as "Fetching route…" while calldata is loading', () => {
    const fn = html.slice(
      html.indexOf('function swpSelectRoute(source)'),
      html.indexOf('function swpApplySelectedQuote(')
    );
    expect(fn).toContain("'Fetching route\u2026'");
  });

  it('toasts + resets button on getStepTransaction failure (no silent discard)', () => {
    const fn = html.slice(
      html.indexOf('function swpSelectRoute(source)'),
      html.indexOf('function swpApplySelectedQuote(')
    );
    expect(fn).toContain("'LI.FI route unavailable");
    expect(fn).toContain("swpSetBtn('ready'");
  });
});

// ── 3. swpApplySelectedQuote labels ──────────────────────────────────────
describe('swpApplySelectedQuote — provider display labels', () => {
  it('Tower source → "Tower Aggregator"', () => {
    const fn = html.slice(
      html.indexOf('function swpApplySelectedQuote('),
      html.indexOf('// Re-derive the main-card display') + 1 ||
      html.indexOf('function swpSelectRoute') + 1
    );
    // Use the broader section after swpApplySelectedQuote
    const section = html.slice(
      html.indexOf('function swpApplySelectedQuote('),
      html.indexOf('// Execution state: store quote in _towerQuoteData') + 200
    );
    expect(section).toContain("'Tower Aggregator'");
  });

  it('LI.FI source → starts with "LI.FI"', () => {
    const section = html.slice(
      html.indexOf('function swpApplySelectedQuote('),
      html.indexOf('// Execution state: store quote in _towerQuoteData') + 200
    );
    expect(section).toContain("'LI.FI'");
  });

  it('local source → "Elligentt AMM"', () => {
    const section = html.slice(
      html.indexOf('function swpApplySelectedQuote('),
      html.indexOf('// Execution state: store quote in _towerQuoteData') + 200
    );
    expect(section).toContain("'Elligentt AMM'");
  });

  it('cross-chain appends " · Cross-chain" to the label', () => {
    const section = html.slice(
      html.indexOf('function swpApplySelectedQuote('),
      html.indexOf('// Execution state: store quote in _towerQuoteData') + 200
    );
    expect(section).toContain("' · Cross-chain'");
  });

  it('stores quote in _towerQuoteData for Tower + LI.FI with calldata', () => {
    const section = html.slice(
      html.indexOf('// Execution state: store quote in _towerQuoteData'),
      html.indexOf('// Execution state: store quote in _towerQuoteData') + 400
    );
    expect(section).toContain('SWP._towerQuoteData = q;');
    expect(section).toContain("q.source === 'tower'");
  });

  it('clears _towerQuoteData for local route (no external calldata)', () => {
    const section = html.slice(
      html.indexOf('// Execution state: store quote in _towerQuoteData'),
      html.indexOf('// Execution state: store quote in _towerQuoteData') + 400
    );
    expect(section).toContain('SWP._towerQuoteData = null;');
  });
});

// ── 4. selectedParamsKey reset ────────────────────────────────────────────
describe('selectedParamsKey — params-change reset', () => {
  it('paramsKey is built from tokenIn|tokenOut|amountInRaw', () => {
    const fn = html.slice(
      html.indexOf('const paramsKey = tIn.sym'),
      html.indexOf('const paramsKey = tIn.sym') + 150
    );
    expect(fn).toContain("tIn.sym + '|' + tOut.sym + '|' + amountInRaw.toString()");
  });

  it('resolveSelection is called with prevSource, prevKey and currentKey', () => {
    const fn = html.slice(
      html.indexOf('SwapUiModes.resolveSelection'),
      html.indexOf('SwapUiModes.resolveSelection') + 200
    );
    expect(fn).toContain('SWP.selectedSource');
    expect(fn).toContain('SWP.selectedParamsKey');
    expect(fn).toContain('paramsKey');
  });

  it('selectedParamsKey is updated to currentKey after each quote cycle', () => {
    expect(html).toContain('SWP.selectedParamsKey = paramsKey;');
  });

  it('selectedParamsKey resets to null on token change', () => {
    const resets = (html.match(/SWP\.selectedParamsKey\s*=\s*null/g) || []).length;
    expect(resets).toBeGreaterThanOrEqual(2); // token change + amount-clear paths
  });
});

// ── 5. resolveSelection (SwapUiModes) ────────────────────────────────────
describe('SwapUiModes.resolveSelection — selection persistence logic', () => {
  let modes;
  beforeEach(() => { modes = makeModes(); });

  function decision(quotes, bestExecutable) {
    return { ok: true, quotes, bestExecutable: bestExecutable || null };
  }

  it('persists previous selection when paramsKey unchanged and source still executable', () => {
    const quotes = [q('tower'), q('local', { executionType: 'local' })];
    const r = modes.resolveSelection(decision(quotes, q('tower')), 'local', 'USDC|EURC|1000000', 'USDC|EURC|1000000');
    expect(r).toBe('local');
  });

  it('resets to bestExecutable when paramsKey changes', () => {
    const quotes = [q('tower'), q('local', { executionType: 'local' })];
    const r = modes.resolveSelection(decision(quotes, q('tower')), 'local', 'USDC|EURC|1000000', 'USDC|EURC|2000000');
    expect(r).toBe('tower');
  });

  it('resets to bestExecutable when previous source disappeared from quotes', () => {
    const quotes = [q('tower')]; // 'local' gone
    const r = modes.resolveSelection(decision(quotes, q('tower')), 'local', 'USDC|EURC|1000000', 'USDC|EURC|1000000');
    expect(r).toBe('tower');
  });

  it('treats lifi-N (_needsStepTx) as selectable even without calldata', () => {
    const lifiQ = q('lifi-abc', { calldata: null, _needsStepTx: true });
    const quotes = [lifiQ, q('tower')];
    const r = modes.resolveSelection(decision(quotes, q('tower')), 'lifi-abc', 'USDC|EURC|1000000', 'USDC|EURC|1000000');
    expect(r).toBe('lifi-abc');
  });

  it('returns null when no executable quote exists', () => {
    const r = modes.resolveSelection(
      decision([{ source: 'tower', ok: false }, { source: 'local', ok: false }], null),
      null, null, 'USDC|EURC|1000000'
    );
    expect(r).toBeNull();
  });
});

// ── 6. findExecutableQuote (SwapUiModes) ─────────────────────────────────
describe('SwapUiModes.findExecutableQuote', () => {
  let modes;
  beforeEach(() => { modes = makeModes(); });

  it('returns null for a non-executable (ok=false) quote', () => {
    expect(modes.findExecutableQuote([{ source: 'tower', ok: false }], 'tower')).toBeNull();
  });

  it('returns the quote when executable=true and calldata present', () => {
    const quotes = [q('tower')];
    expect(modes.findExecutableQuote(quotes, 'tower')).toEqual(quotes[0]);
  });

  it('returns lifi-N quote even when _needsStepTx (no calldata yet)', () => {
    const lifiQ = q('lifi-abc', { calldata: null, _needsStepTx: true });
    expect(modes.findExecutableQuote([lifiQ], 'lifi-abc')).toEqual(lifiQ);
  });

  it('returns null when source not found in quotes list', () => {
    expect(modes.findExecutableQuote([q('tower')], 'local')).toBeNull();
  });

  it('handles empty/null quotes array safely', () => {
    expect(modes.findExecutableQuote(null, 'tower')).toBeNull();
    expect(modes.findExecutableQuote([], 'tower')).toBeNull();
  });
});

// ── 7. No silent fallback in execution ───────────────────────────────────
describe('Execution follows selected route only — no silent fallback', () => {
  it('Tower execution path uses SWP._towerQuoteData (never local pool)', () => {
    expect(html).toContain('if (SWP._towerQuoteData && SWP._towerQuoteData.calldata) {');
  });

  it('local execution never falls back to Tower on failure', () => {
    expect(html).toContain('swpExecuteTowerOnly');
    expect(html).not.toContain('usando pool local');
  });

  it('SWP.selectedSource is the canonical state for execution routing', () => {
    expect(html).toContain('selectedSource: null');
    expect(html).toContain('SWP.selectedSource = source;');
  });

  it('aggQuotes stores all provider quotes for selection (not just best)', () => {
    expect(html).toContain('aggQuotes: null');
    expect(html).toContain('SWP.aggQuotes');
  });
});
