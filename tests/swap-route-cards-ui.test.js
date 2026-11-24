/**
 * swap-route-cards-ui.test.js
 * ═══════════════════════════════════════════════════════════════════════════
 * Swap "Available Routes" cards UI 2.0 — presentation only.
 *
 * Runs the REAL shared/swapUiModes.js renderer and pins that:
 *  - every metric / badge / button / state is still emitted (nothing removed, nothing invented)
 *  - Best Rate / Fastest classification and selection are unchanged
 *  - unavailable providers stay compact (identity + status only, no metrics)
 *  - the two renderer edits are class hooks only (no inline styles, no timers / fetch / listeners)
 *  - all new CSS is scoped to #swap-route-list, so the Bridge cards and other consumers are untouched
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const src = fs.readFileSync(path.join(root, 'shared/swapUiModes.js'), 'utf8');

function load() {
  const win = {};
  const ctx = { window: win, document: { readyState: 'complete', getElementById: () => null, querySelectorAll: () => [], addEventListener() {} }, console, BigInt, String, Number, Math, Object, Array };
  ctx.window = ctx; // the IIFE publishes window.SwapUiModes
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.SwapUiModes;
}
const M = load();

const q = (o) => ({ ok: true, executable: true, expectedOutRaw: '911948', minOutRaw: '900000', feeBps: 25, feeCostUSD: 0.014, gasCostUSD: 0.002, estimatedTime: 10, stepsData: [{}], ...o });
const opts = { tokenOut: { symbol: 'EURC', decimals: 6 }, tokenOutDecimals: 6 };
const decision = {
  quotes: [
    q({ source: 'lifi-kyber', label: 'Kyberswap', expectedOutRaw: '911948', estimatedTime: 10 }),
    q({ source: 'lifi-1inch', label: '1inch', expectedOutRaw: '911940', estimatedTime: 1 }),
    q({ source: 'brand-new-provider', label: 'Brand New', expectedOutRaw: '900000', estimatedTime: 20 }),
    q({ source: 'ref', expectedOutRaw: '800000', executable: false }),
    { ok: false, source: 'tower' },
    { ok: false, source: 'local' },
  ],
};
const cards = (out) => out.split(/(?=<div class="brs-route[ "])/).filter((c) => c.startsWith('<div class="brs-route'));

describe('renderer output (content unchanged)', () => {
  const out = M.buildRouteListHtml(decision, 'lifi-1inch', opts);
  const cs = cards(out);

  it('renders every provider dynamically, available first, unavailable last', () => {
    expect(cs.length).toBe(6);
    expect(out).toContain('Kyberswap');
    expect(out).toContain('1inch');
    expect(out).toContain('brand-new-provider');
    expect(out).toContain('Tower');
    expect(out).toContain('Elligentt');
  });

  it('every available card keeps the five metrics, the received amount + token and the button', () => {
    cs.slice(0, 4).forEach((c) => {
      ['Bridge fee', 'Protocol fees', 'Est. gas', 'Est. time', 'Steps'].forEach((l) => expect(c).toContain('>' + l + '<'));
      expect(c).toContain('EURC received');
      expect(c).toContain('brs-out-val');
      expect(c).toMatch(/brs-select-btn|brs-unavail-tag/);
    });
  });

  it('Best Rate = first card; Fastest = quickest other card; both distinct from Selected', () => {
    expect(out.split('>Best Rate<').length - 1).toBe(1);
    expect(cs[0]).toContain('>Best Rate<');
    expect(out.split('brs-badge--fast">Fastest<').length - 1).toBe(1);
    const fast = cs.findIndex((c) => c.includes('>Fastest<'));
    expect(cs[fast]).toContain('1inch');
    const sel = cs.filter((c) => c.includes('brs-select-btn--selected'));
    expect(sel.length).toBe(1);
    expect(sel[0]).toContain('1inch');
    expect(cs[0]).not.toContain('brs-select-btn--selected');
    expect(cs[0]).not.toContain(' brs-selected');
  });

  it('unavailable providers are compact: identity + Unavailable only (no metrics, not interactive)', () => {
    const un = cs.filter((c) => c.includes('brs-unavail') && c.includes('>Unavailable<'));
    expect(un.length).toBe(2);
    un.forEach((c) => {
      expect(c).not.toContain('brs-meta');
      expect(c).not.toContain('onclick=');
      expect(c).not.toContain('brs-select-btn');
    });
  });

  it('reference-only quotes keep their metrics and a "Reference" tag, and are not selectable', () => {
    const ref = cs.find((c) => c.includes('>Reference<'));
    expect(ref).toBeTruthy();
    expect(ref).toContain('brs-meta');
    expect(ref).not.toContain('onclick=');
  });

  it('selectable cards keep click + keyboard selection through swpSelectRoute', () => {
    expect(cs[0]).toContain('role="button" tabindex="0"');
    expect(cs[0]).toContain("onclick=\"swpSelectRoute('lifi-kyber')\"");
    expect(cs[0]).toContain("event.key==='Enter'");
    expect(out).toContain("onclick=\"event.stopPropagation();swpSelectRoute('lifi-1inch')\"");
  });

  it('is deterministic: identical input -> identical HTML (the list-diff skip keeps working)', () => {
    expect(M.buildRouteListHtml(decision, 'lifi-1inch', opts)).toBe(out);
  });

  it('no routes -> the existing empty state', () => {
    expect(M.buildRouteListHtml({ quotes: [{ ok: false, source: 'tower' }] }, null, opts)).toContain('No routes available');
  });

  it('missing numbers are an em dash, never 0 / NaN', () => {
    const o = M.buildRouteListHtml({ quotes: [q({ source: 'lifi-x', label: 'X', feeBps: null, feeCostUSD: null, gasCostUSD: null, estimatedTime: null })] }, null, opts);
    expect(o).not.toContain('NaN');
    expect(o).toContain('>—<');
  });
});

describe('renderer edits are presentation hooks only', () => {
  const fnSrc = src.slice(src.indexOf('function buildRouteListHtml'), src.indexOf('/** Render the ROUTES selector'));

  it('Fastest badge and provider column use classes instead of inline styles', () => {
    expect(fnSrc).toContain('class="brs-best-badge brs-badge--fast">Fastest');
    expect(fnSrc).toContain('<div class="brs-prov-info">');
    expect(fnSrc).not.toMatch(/brs-best-badge"[^>]*style=/);
  });

  it('adds no timers, requests or listeners to the renderer', () => {
    expect(fnSrc).not.toMatch(/setTimeout|setInterval|requestAnimationFrame|fetch\(|XMLHttpRequest|addEventListener/);
  });

  it('selection / refresh logic is untouched (diff-skip + best-first ordering still present)', () => {
    expect(src).toContain('if (list && html !== _lastRouteListHtml)');
    expect(src).toContain('showRouteUpdating');
    expect(fnSrc).toContain('var bestRateIdx = 0;');
    expect(fnSrc).toContain('if (fastestIdx === 0) fastestIdx = -1;');
  });
});

describe('CSS scope', () => {
  const start = html.indexOf('/* ═══ Swap Route Cards UI 2.0');
  const end = html.indexOf('/* Mobile: stack Swap card above the side column', start);
  const css = html.slice(start, end);
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const sels = [];
  clean.replace(/([^{}@]+)\{[^{}]*\}/g, (_, s) => { sels.push(s.trim()); return ''; });
  const L = 'html[data-theme="light"]:not(:has(#page-unified-balance.active)) ';

  it('every selector is limited to the Swap route panel', () => {
    expect(sels.length).toBeGreaterThan(40);
    sels.forEach((group) => group.split(',').forEach((s) => {
      const t = s.trim().replace(L, '');
      expect(t.startsWith('#swap-route-list') || t.startsWith('#swap-route-selector'), `unscoped: ${t}`).toBe(true);
    }));
  });

  it('never targets the Bridge panel, dark-theme tokens or Advanced mode', () => {
    expect(css).not.toContain('bridge-routes');
    expect(css).not.toContain('data-theme="dark"');
    expect(css).not.toContain('swp-advanced');
  });

  it('the only !important uses are the documented ones (header icon size, 400px grid margin reset)', () => {
    const imp = css.match(/[^;{}]*!important/g) || [];
    expect(imp.length).toBe(3);
    imp.forEach((i) => expect(/margin-left:0|font-size:14px/.test(i)).toBe(true));
  });

  it('uses the shared type scale, tabular figures and a divided, evenly spaced metrics grid', () => {
    expect(css).toContain('font-variant-numeric:tabular-nums');
    expect(css).toMatch(/\.brs-provider-name\{font-size:14\.5px/);
    expect(css).toMatch(/\.brs-out-val\{font-size:17\.5px/);
    expect(css).toMatch(/\.brs-meta-val\{font-size:12\.5px/);
    expect(css).toMatch(/\.brs-meta-lbl\{font-size:10\.5px/);
    expect(css).toMatch(/\.brs-meta\{display:grid;[^}]*border-top:1px solid var\(--border\)/);
  });

  it('cards grow with content (min-height only) and unavailable ones are compact', () => {
    expect(css).toMatch(/\.brs-route\{flex:0 0 auto;min-height:100px;padding:12px 14px 10px/);
    expect(css).not.toMatch(/\.brs-route\{[^}]*[^-]height:\d/);
    expect(css).toMatch(/\.brs-route\.brs-unavail:not\(:has\(\.brs-meta\)\)\{min-height:0;padding:8px 12px/);
  });

  it('the stacked layout no longer caps the panel with a nested scrollbar', () => {
    expect(css).toMatch(/@media\(max-width:960px\)\{\s*#swap-route-selector\{max-height:none\}/);
  });

  it('Bridge card CSS is still scoped to its own panel (unchanged contract)', () => {
    expect(html).toContain('#bridge-routes-inner .brs-route{flex:0 0 auto;min-height:100px');
  });
});
