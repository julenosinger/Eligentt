/**
 * bridge-route-cards-ui.test.js
 * ═══════════════════════════════════════════════════════════════════════════
 * Bridge "Available Routes" cards UI 2.0 — presentation only.
 *
 * Pins that:
 *  - the renderer still emits every metric / badge / button it emitted before
 *  - provider names stay dynamic (no hardcoded provider list)
 *  - Best Rate / Fastest classification and selection logic are untouched
 *  - all new CSS is scoped to the Bridge panel (Swap re-uses .brs-* classes)
 *  - the renderer gained no timers, requests or listeners
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(path.resolve(__dirname, '..'), 'index.html'), 'utf8');

const rStart = html.indexOf('function _brsRenderRoutes(');
const rEnd = html.indexOf('// Select a route explicitly');
const renderSrc = html.slice(rStart, rEnd);

const cssStart = html.lastIndexOf('/* ═══ Bridge Route Cards UI 2.0');
const cssEnd = html.indexOf('/* Mobile: panel stacks below */', cssStart);
const css = html.slice(cssStart, cssEnd);

function render(routes, selectedId) {
  const inner = { innerHTML: '' };
  const panel = { classList: { add() {} } };
  const ctx = {
    document: { getElementById: (id) => (id === 'bridge-routes-panel' ? panel : id === 'bridge-routes-inner' ? inner : null) },
    _brsSetActive() {}, _brsShowRoutes() {},
    _selectedBridgeRoute: selectedId ? { id: selectedId } : null,
    _brsFmtUsd: (v) => '$' + Number(v).toFixed(3),
    _brsFmtDur: (v) => (v == null ? '—' : v + 's'),
    escHtml: (s) => String(s),
    bridgeToToken: 'USDC',
  };
  vm.createContext(ctx);
  vm.runInContext(renderSrc, ctx);
  ctx._brsRenderRoutes(routes, { name: 'Arc Mainnet' }, { name: 'Polygon' });
  return inner.innerHTML;
}

const cardsOf = (o) => o.split('<div class="brs-route ').slice(1);

const mk = (o) => ({ available: true, outAmt: 1, feePct: 0, gasUsd: 0.01, feesUsd: 0.02, execSec: 60, steps: 1, protocol: 'LI.FI aggregator', provider: 'lifi', ...o });

describe('renderer output (content unchanged)', () => {
  const routes = [mk({ id: 'a', label: 'Circle CCTP', provider: 'cctp', execSec: 120 }), mk({ id: 'b', label: 'AcrossV4', execSec: 1 }), mk({ id: 'c', label: 'Totally New Bridge 9000', execSec: 30 })];
  const out = render(routes, 'b');

  it('shows all five lower metrics on every card', () => {
    ['Bridge fee', 'Protocol fees', 'Est. gas', 'Est. time', 'Steps'].forEach((l) => {
      expect(out.split('>' + l + '<').length - 1).toBe(routes.length);
    });
  });

  it('renders providers dynamically (any label, no hardcoded list)', () => {
    expect(out).toContain('Totally New Bridge 9000');
    expect(renderSrc).not.toMatch(/'(Circle CCTP|AcrossV4|Relay|Layerswap)'/);
  });

  it('keeps top-area contract: icon, name, protocol, received amount + token, button', () => {
    expect(out).toContain('brs-provider-icon');
    expect(out).toContain('brs-provider-name');
    expect(out).toContain('brs-protocol-tag');
    expect(out).toContain('brs-out-val');
    expect(out).toContain('USDC received');
    expect(out.split('brs-select-btn').length - 1).toBeGreaterThanOrEqual(3);
  });

  it('Best Rate is only the first available route; Fastest is the quickest other route', () => {
    expect(out.split('>Best Rate<').length - 1).toBe(1);
    const cards = cardsOf(out);
    expect(cards[0]).toContain('>Best Rate<');
    expect(out.split('brs-badge--fast">Fastest<').length - 1).toBe(1);
    expect(cards[1]).toContain('Fastest');
  });

  it('Selected is distinct from Best Rate and follows the selected route id', () => {
    expect(out.split('brs-select-btn--selected').length - 1).toBe(1);
    const cards = cardsOf(out);
    expect(cards[1]).toContain('brs-selected');
    expect(cards[0]).toContain('brs-best');
    expect(cards[0]).not.toContain('brs-selected');
    expect(cards[0]).not.toContain('brs-select-btn--selected');
  });

  it('selection survives a re-render (refresh) because it is derived from the selected id', () => {
    const again = render(routes, 'b');
    expect(again).toBe(out);
  });

  it('unavailable routes get the tag, are not clickable and have no Select button', () => {
    const o = render([mk({ id: 'x', label: 'Gone', available: false })], null);
    expect(o).toContain('brs-unavail');
    expect(o).toContain('>Unavailable<');
    expect(o).not.toContain('onclick="brSelectRoute');
  });

  it('special badges use classes (no inline style) and keep their wording', () => {
    const o = render([mk({ id: 'g', label: 'Gateway', provider: 'gateway', _gwBlocked: true }), mk({ id: 'e', label: 'CCTP EURC', provider: 'cctp', _unverifiedEurc: true })], null);
    expect(o).toContain('brs-badge--gw"><i class="ti ti-shield-lock"></i>Validation Pending');
    expect(o).toContain('brs-badge--note">EURC · not sandbox-verified');
    expect(o).not.toMatch(/brs-best-badge"[^>]*style=/);
  });

  it('missing numbers render as an em dash, never as 0 or NaN', () => {
    const o = render([mk({ id: 'm', label: 'NoData', outAmt: null, feePct: null, gasUsd: null, feesUsd: null, execSec: null })], null);
    expect(o).not.toContain('NaN');
    expect(o).toContain('>—<');
  });
});

describe('renderer is behaviourally unchanged', () => {
  it('still wires cards and buttons to brSelectRoute(i) with propagation stopped on the button', () => {
    expect(renderSrc).toContain("onclick=\"brSelectRoute(' + i + ')\"");
    expect(renderSrc).toContain("onclick=\"event.stopPropagation();brSelectRoute(' + i + ')\"");
  });

  it('adds no timers, requests, listeners or storage access', () => {
    expect(renderSrc).not.toMatch(/setTimeout|setInterval|requestAnimationFrame|fetch\(|XMLHttpRequest|addEventListener|localStorage/);
  });

  it('selection handler is untouched (does not execute, only selects)', () => {
    const fn = html.slice(html.indexOf('function brSelectRoute(idx)'), html.indexOf('// Clear routes (on chain/amount change)'));
    expect(fn).toContain('_selectedBridgeRoute = route');
    expect(fn).toContain("if (route.provider === 'lifi') { _bridgeLastQuote = route.quote; }");
    expect(fn).not.toMatch(/executeBridge|sendTransaction|approve\(/);
  });
});

describe('CSS scope and tokens', () => {
  const blocks = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const sels = [];
  blocks.replace(/([^{}@]+)\{[^{}]*\}/g, (_, sel) => { sels.push(sel.trim()); return ''; });

  it('has rules and every selector is limited to the Bridge panel', () => {
    expect(sels.length).toBeGreaterThan(30);
    sels.forEach((group) => group.split(',').forEach((s) => {
      const t = s.trim();
      const ok = t.startsWith('#bridge-routes-inner') || /^html\[data-theme="light"\]:not\(:has\(#page-unified-balance\.active\)\) #bridge-routes-inner/.test(t) || t === '.brs-prov-info';
      expect(ok, `unscoped selector: ${t}`).toBe(true);
    }));
  });

  it('does not touch the Swap route list or dark-theme tokens', () => {
    expect(css).not.toContain('swap-route-list');
    expect(css).not.toContain('data-theme="dark"');
  });

  it('only !important is the 380px grid margin reset (inline margin on the amount / button)', () => {
    const imp = css.match(/[^;{}]*!important/g) || [];
    expect(imp.length).toBe(2);
    imp.forEach((i) => expect(i).toContain('margin-left:0'));
  });

  it('uses tabular numbers and the target type scale', () => {
    expect(css).toContain('font-variant-numeric:tabular-nums');
    expect(css).toMatch(/\.brs-provider-name\{font-size:14\.5px/);
    expect(css).toMatch(/\.brs-out-val\{font-size:17\.5px/);
    expect(css).toMatch(/\.brs-meta-val\{font-size:12\.5px/);
    expect(css).toMatch(/\.brs-meta-lbl\{font-size:10\.5px/);
    expect(css).toMatch(/\.brs-select-btn\{font-size:12px/);
  });

  it('cards grow with content (min-height only, never a fixed height) and never shrink', () => {
    expect(css).toMatch(/\.brs-route\{flex:0 0 auto;min-height:100px/);
    expect(css).not.toMatch(/\.brs-route\{[^}]*[^-]height:\d/);
  });

  it('metrics sit under a hairline divider in an even grid', () => {
    expect(css).toMatch(/\.brs-meta\{display:grid;grid-template-columns:[^;]+;[^}]*border-top:1px solid var\(--border\)/);
  });
});
