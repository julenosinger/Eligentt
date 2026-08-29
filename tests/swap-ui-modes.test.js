/**
 * SWAP V2 — ROUTES comparison selector (Standard mode) + route selection.
 * ═══════════════════════════════════════════════════════════════════════
 * Proves: (a) mode state machine, (b) the ROUTES list renders real quotes with
 * explicit selection (best-executable auto-selected; reference-only non-selectable),
 * (c) manual selection persists across refreshes with the same params and resets
 * when params change / provider becomes invalid, and (d) the existing execution
 * architecture is preserved (no duplication, no hardcoded Tower winner).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const modeSrc = fs.readFileSync(path.join(root, 'shared', 'swapUiModes.js'), 'utf8');
const aggSrc = fs.readFileSync(path.join(root, 'shared', 'SwapAggregator.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function evalModule(src) {
  const win = {};
  const fn = new Function('window', src);
  fn.call(null, win);
  return win;
}
function modes() { return evalModule(modeSrc).SwapUiModes; }
function agg() { return evalModule(aggSrc).SwapAggregator; }

function q(source, over) {
  return Object.assign({
    source, ok: true, tokenIn: 'USDC', tokenOut: 'EURC',
    amountInRaw: 1000000n, expectedOutRaw: 1000000n, minOutRaw: 995000n,
    feeBps: 30, provider: null, executable: false,
  }, over || {});
}

const OPTS = { tokenIn: 'USDC', tokenInDecimals: 6, tokenOut: 'EURC', tokenOutDecimals: 6, amountInRaw: 1000000n };

describe('SwapUiModes — mode state machine', () => {
  it('defaults to standard', () => { expect(modes().getMode()).toBe('standard'); });
  it('setMode advanced → advanced (no page navigation)', () => {
    const m = modes(); expect(m.setMode('advanced')).toBe('advanced'); expect(m.getMode()).toBe('advanced');
  });
  it('setMode standard → standard', () => {
    const m = modes(); m.setMode('advanced'); expect(m.setMode('standard')).toBe('standard');
  });
  it('invalid mode falls back to standard', () => {
    const m = modes(); m.setMode('banana'); expect(m.getMode()).toBe('standard');
  });
});

describe('SwapUiModes — route selection (canonical state)', () => {
  it('auto-selects best executable when nothing selected', () => {
    const m = modes();
    const decision = {
      bestExecutable: { source: 'local' },
      quotes: [
        q('tower', { expectedOutRaw: 1001400n, executable: false }),
        q('local', { expectedOutRaw: 998200n, executable: true }),
      ],
    };
    expect(m.resolveSelection(decision, null, null, 'USDC|EURC|1000000')).toBe('local');
  });

  it('manual selection persists across refresh with the SAME params', () => {
    const m = modes();
    const decision = {
      bestExecutable: { source: 'local' },
      quotes: [
        q('tower', { expectedOutRaw: 1001400n, executable: true }),
        q('local', { expectedOutRaw: 998200n, executable: true }),
      ],
    };
    expect(m.resolveSelection(decision, 'tower', 'USDC|EURC|1000000', 'USDC|EURC|1000000')).toBe('tower');
  });

  it('amount change resets provider selection', () => {
    const m = modes();
    const decision = {
      bestExecutable: { source: 'local' },
      quotes: [
        q('tower', { expectedOutRaw: 1001400n, executable: true }),
        q('local', { expectedOutRaw: 998200n, executable: true }),
      ],
    };
    expect(m.resolveSelection(decision, 'tower', 'USDC|EURC|1000000', 'USDC|EURC|10000000')).toBe('local');
  });

  it('token change resets provider selection', () => {
    const m = modes();
    const decision = {
      bestExecutable: { source: 'local' },
      quotes: [
        q('tower', { expectedOutRaw: 1001400n, executable: true }),
        q('local', { expectedOutRaw: 998200n, executable: true }),
      ],
    };
    expect(m.resolveSelection(decision, 'tower', 'USDC|EURC|1000000', 'USDC|cirBTC|1000000')).toBe('local');
  });

  it('selected provider became invalid → falls back to best executable', () => {
    const m = modes();
    const decision = {
      bestExecutable: { source: 'local' },
      quotes: [
        { source: 'tower', ok: false, error: 'TOWER_UNAVAILABLE' },
        q('local', { expectedOutRaw: 998200n, executable: true }),
      ],
    };
    expect(m.resolveSelection(decision, 'tower', 'USDC|EURC|1000000', 'USDC|EURC|1000000')).toBe('local');
  });

  it('no executable quote → null (nothing to execute)', () => {
    const m = modes();
    const decision = {
      bestExecutable: null,
      quotes: [
        q('tower', { expectedOutRaw: 1001400n, executable: false }),
        { source: 'local', ok: false },
      ],
    };
    expect(m.resolveSelection(decision, null, null, 'USDC|EURC|1000000')).toBeNull();
  });

  it('findExecutableQuote returns only executable quotes', () => {
    const m = modes();
    const quotes = [
      q('tower', { expectedOutRaw: 1001400n, executable: false }),
      q('local', { expectedOutRaw: 998200n, executable: true }),
    ];
    expect(m.findExecutableQuote(quotes, 'tower')).toBeNull();
    expect(m.findExecutableQuote(quotes, 'local').source).toBe('local');
  });
});

describe('SwapUiModes — ROUTES list rendering (real quotes, no mock)', () => {
  it('renders Elligentt + Tower side-by-side from real quotes', () => {
    const m = modes();
    const h = m.buildRouteListHtml({
      bestExecutable: { source: 'local' },
      quotes: [
        q('tower', { expectedOutRaw: 1001400n, feeBps: 25, executable: false }),
        q('local', { expectedOutRaw: 998200n, feeBps: 10, executable: true }),
      ],
    }, 'local', OPTS);
    expect(h).toContain('Elligentt');
    expect(h).toContain('Tower');
    expect(h).toContain('Selected');
  });

  it('best executable is auto-selected (✓ Selected on Elligentt)', () => {
    const m = modes();
    const h = m.buildRouteListHtml({
      bestExecutable: { source: 'local' },
      quotes: [q('local', { expectedOutRaw: 998200n, executable: true })],
    }, 'local', OPTS);
    expect(h).toContain('✓ Selected');
    expect(h.indexOf('Elligentt')).toBeLessThan(h.indexOf('Selected'));
  });

  it('Tower reference-only is not selectable (no onclick, Reference only)', () => {
    const m = modes();
    const h = m.buildRouteListHtml({
      bestExecutable: { source: 'local' },
      quotes: [
        q('tower', { expectedOutRaw: 1001400n, executable: false }),
        q('local', { expectedOutRaw: 998200n, executable: true }),
      ],
    }, 'local', OPTS);
    expect(h).toContain('Reference only');
    // The tower row must not carry a selection onclick.
    const towerRow = h.slice(h.indexOf('data-source="tower"'));
    expect(towerRow).not.toContain('swpSelectRoute');
  });

  it('executable row carries the selection click', () => {
    const m = modes();
    const h = m.buildRouteListHtml({
      bestExecutable: { source: 'local' },
      quotes: [q('local', { expectedOutRaw: 998200n, executable: true })],
    }, null, OPTS);
    expect(h).toContain("swpSelectRoute('local')");
  });

  it('unavailable provider shows discreetly (Tower failure does not hide Elligentt)', () => {
    const m = modes();
    const h = m.buildRouteListHtml({
      bestExecutable: { source: 'local' },
      quotes: [
        { source: 'tower', ok: false, error: 'TOWER_UNAVAILABLE' },
        q('local', { expectedOutRaw: 998200n, executable: true }),
      ],
    }, 'local', OPTS);
    expect(h).toContain('unavailable');
    expect(h).toContain('Elligentt');
  });

  it('both unavailable → "No routes available"', () => {
    const m = modes();
    const h = m.buildRouteListHtml({
      bestExecutable: null,
      quotes: [{ source: 'tower', ok: false }, { source: 'local', ok: false }],
    }, null, OPTS);
    expect(h).toContain('No routes available');
  });

  it('ordering uses BigInt (expectedOutRaw desc)', () => {
    const m = modes();
    const big = 1000000000000000000000n, small = 999999999999999999999n;
    const h = m.buildRouteListHtml({
      bestExecutable: { source: 'tower' },
      quotes: [
        q('local', { expectedOutRaw: small, executable: true }),
        q('tower', { expectedOutRaw: big, executable: true }),
      ],
    }, 'tower', OPTS);
    expect(h.indexOf('Tower')).toBeLessThan(h.indexOf('Elligentt'));
  });

  it('providers rendered from metadata (no hardcoded tower/local if)', () => {
    expect(modeSrc).not.toContain('if (source === tower)');
    const m = modes();
    expect(m.providerMeta('local').name).toBe('Elligentt');
    expect(m.providerMeta('tower').name).toBe('Tower');
  });
});

describe('index.html — Swap V2 ROUTES structural invariants', () => {
  it('mode toggle present and drives SwapUiModes', () => {
    expect(html).toContain('id="swp-mode-toggle"');
    expect(html).toContain("SwapUiModes.setMode('standard')");
    expect(html).toContain("SwapUiModes.setMode('advanced')");
  });

  it('ROUTES selector card present (right panel)', () => {
    expect(html).toContain('id="swap-route-selector"');
    expect(html).toContain('id="swap-route-list"');
  });

  it('Standard hides chart/market; routes card only in Standard via swp-routes', () => {
    expect(html).toContain('#page-swap.swp-standard .st-chart-section{display:none}');
    expect(html).toContain('#page-swap.swp-standard.swp-routes .swap-route-selector{display:flex}');
    expect(html).toContain('.swap-route-selector{display:none');
    expect(html).toContain('.swp-side-col');
  });

  it('selection is canonical + persisted in SWP', () => {
    expect(html).toContain('selectedSource');
    expect(html).toContain('selectedParamsKey');
    expect(html).toContain('resolveSelection');
    expect(html).toContain('swpSelectRoute');
  });

  it('execution follows selected route (no silent fallback)', () => {
    expect(html).toContain('SWP._towerQuoteData = selected.calldata ? selected : null');
    expect(html).toContain('findExecutableQuote');
  });

  it('execution is not duplicated — canonical swap modules preserved', () => {
    for (const f of ['swapMath.js', 'poolEngine.js', 'poolRouter.js', 'poolExecutor.js', 'swapIsolation.js', 'TowerAdapter.js', 'LocalAdapter.js', 'SwapAggregator.js']) {
      expect(fs.existsSync(path.join(root, 'shared', f))).toBe(true);
    }
    for (const f of ['swapMath.js', 'poolEngine.js', 'poolRouter.js', 'poolExecutor.js']) {
      expect(html).toContain('/shared/' + f);
    }
  });
});
