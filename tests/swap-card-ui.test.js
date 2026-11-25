/**
 * swap-card-ui.test.js
 * ═══════════════════════════════════════════════════════════════════════════
 * Swap Card UI 2.0 — presentation-only refinement of the existing card.
 *  1. Stale quote cells (Price Impact / Min Received / LP Fee / Route) are cleared whenever there is no
 *     valid quote. Real helper + real chart renderer are extracted from index.html and executed.
 *  2. Chart: marker + latest value come ONLY from the real observation accumulator.
 *  3. CSS stays scoped (Standard card / light tokens), the single !important is documented, and the
 *     markup contracts (ids, handlers, button states) are untouched.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');

const slice = (from, to) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
const updateFn = slice('async function updateSwapRate() {', 'function calcRoutePriceImpact(');

function el(id) { return { id, textContent: '', className: '', style: { setProperty(k, v) { this[k] = v; } }, innerHTML: '' }; }

describe('stale quote cells', () => {
  const helperSrc = slice('var _SWP_DETAIL_PRISTINE', 'function swpClearQuoteDetails() {') + slice('function swpClearQuoteDetails() {', '// ── Pre-swap Validation');
  const make = () => {
    const els = {};
    ['swp-impact-val', 'swp-min-received', 'swp-fee-val', 'swp-route-pool', 'swap-rate', 'swp-rate-detail', 'swp-source-val'].forEach((i) => (els[i] = el(i)));
    const ctx = { document: { getElementById: (i) => els[i] || null } };
    vm.createContext(ctx);
    vm.runInContext(helperSrc + '\nthis.clear = swpClearQuoteDetails;', ctx);
    return { els, clear: ctx.clear };
  };

  it('resets exactly the four quote-derived cells to the pristine placeholder + classes', () => {
    const { els, clear } = make();
    els['swp-impact-val'].textContent = '0.012%'; els['swp-impact-val'].className = 'swp-detail-val green';
    els['swp-min-received'].textContent = '90.7 EURC'; els['swp-min-received'].className = 'swp-detail-val green';
    els['swp-fee-val'].textContent = '0.0 USDC'; els['swp-route-pool'].textContent = 'LI.FI · Kyberswap';
    els['swap-rate'].textContent = 'No route available'; els['swp-rate-detail'].textContent = 'keep'; els['swp-source-val'].textContent = 'keep';
    clear();
    expect(['swp-impact-val', 'swp-min-received', 'swp-fee-val', 'swp-route-pool'].map((i) => els[i].textContent)).toEqual(['—', '—', '—', '—']);
    expect(els['swp-min-received'].className).toBe('st-swap-detail-val green');
    expect(els['swp-route-pool'].className).toBe('st-swap-detail-val purple');
    expect(els['swp-impact-val'].className).toBe('st-swap-detail-val');
    // not part of the contract: rate text and summary cells are left to their owners
    expect(els['swap-rate'].textContent).toBe('No route available');
    expect(els['swp-rate-detail'].textContent).toBe('keep');
  });

  it('every "no valid quote" reset inside updateSwapRate also clears the cells', () => {
    const resets = updateFn.match(/SWP\.lastQuote = null;/g) || [];
    const cleared = updateFn.match(/SWP\.lastQuote = null; swpClearQuoteDetails\(\);/g) || [];
    expect(resets.length).toBeGreaterThanOrEqual(10);
    expect(cleared.length).toBe(resets.length);
  });
  it('a VALID quote assignment is never followed by a clear', () => {
    expect(updateFn).not.toMatch(/SWP\.lastQuote = \{[^;]*\};\s*swpClearQuoteDetails/);
  });
  it('the empty/zero amount branch clears before returning', () => {
    const empty = updateFn.slice(updateFn.indexOf('if (amtIn <= 0) {'), updateFn.indexOf('const rateEl = document.getElementById'));
    expect(empty).toContain('swpClearQuoteDetails();');
    expect(empty.indexOf('swpClearQuoteDetails();')).toBeLessThan(empty.indexOf('return;'));
  });
  it('the helper does not touch quote, route or execution state', () => {
    const body = slice('function swpClearQuoteDetails() {', '// ── Pre-swap Validation');
    expect(body).not.toMatch(/SWP\.|executeSwap|fetch\(|setTimeout|setInterval/);
  });
});

describe('rate chart (real renderer, real accumulator)', () => {
  const src = slice('var _swpChartData = [];', 'const SWP = {').replace(/\/\/ ──+\s*$/, '');
  const make = (rates) => {
    const els = {};
    ['swp-chart-wrap', 'swp-chart-label', 'swp-chart-pts', 'swp-chart-line', 'swp-chart-fill', 'swp-chart-last', 'swp-chart-yaxis', 'swp-chart-dot', 'swp-chart-latest'].forEach((i) => (els[i] = Object.assign(el(i), { setAttribute(k, v) { this[k] = v; } })));
    const ctx = { document: { getElementById: (i) => els[i] || null }, isFinite, Math, Date, TOKEN_LIST: [{ sym: 'USDC' }, { sym: 'EURC' }] };
    vm.createContext(ctx);
    vm.runInContext(src + '\nthis.api = { push: _swpChartPush, render: _swpChartRender, data: () => _swpChartData };', ctx);
    rates.forEach((r) => ctx.api.push(r, 'USDC', 'EURC'));
    ctx.api.render();
    return { els, api: ctx.api };
  };
  it('shows the real last observation, the observation count and a marker', () => {
    const rates = [0.913103, 0.911, 0.9095, 0.9101, 0.9125, 0.9131];
    const { els, api } = make(rates);
    expect(api.data().length).toBe(rates.length);
    expect(els['swp-chart-pts'].textContent).toBe(rates.length + ' observations');
    expect(els['swp-chart-latest'].textContent).toBe(rates[rates.length - 1].toFixed(6));
    expect(els['swp-chart-dot'].style.display).toBe('');
    expect(Number(els['swp-chart-dot'].style['--dx'])).toBeGreaterThan(0.9);
    expect(Number(els['swp-chart-dot'].style['--dy'])).toBeGreaterThanOrEqual(0);
    expect(els['swp-chart-yaxis'].innerHTML).toContain((0.913103).toFixed(6));
  });
  it('without enough data nothing is invented: no marker, no latest value', () => {
    const { els } = make([0.9131]);
    expect(els['swp-chart-pts'].textContent).toBe('1 observation');
    expect(els['swp-chart-dot'].style.display).toBe('none');
    expect(els['swp-chart-latest'].textContent).toBe('');
    expect(els['swp-chart-line'].points).toBe('');
    const none = make([]);
    expect(none.els['swp-chart-pts'].textContent).toBe('Loading…');
    expect(none.els['swp-chart-dot'].style.display).toBe('none');
  });
  it('the latest value is labelled as a historical observation, not an executable offer', () => {
    expect(html).toContain('title="Last observed quote rate (historical, not an executable offer)"');
  });
  it('no new timers, requests or libraries in the chart code', () => {
    const fn = slice('function _swpChartRender() {', '// Reset chart when pair tokens change');
    expect(fn).not.toMatch(/setTimeout|setInterval|fetch\(|requestAnimationFrame|import\(|<script/);
  });
});

describe('styles stay isolated', () => {
  const css = slice('/* ═══ Swap Card UI 2.0', '/* ═══ Swap Route Cards UI 2.0');
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [];
  rules.replace(/(^|\})\s*([^{}@]+)\{/g, (_m, _p, sel) => { sel.split(',').forEach((x) => selectors.push(x.trim())); return ''; });
  const allowedBase = /^(\.swp-di|\.swp-src-label|\.swp-src-btn|\.swp-chart-latest|\.swp-chart-foot|\.swp-chart-grid|\.swp-chart-dot|#page-swap\.swp-advanced \.swp-chart-dot|#page-swap \.swp-mode-|#page-swap\.swp-standard \.swp-mode-|#page-swap\.swp-standard \.st-swap-panel|html\[data-theme="light"\]:not\(:has\(#page-unified-balance\.active\)\) (#page-swap|#page-swap\.swp-standard \.st-swap-panel))/;
  it('every selector is a new-hook base rule, Standard-card scoped, mode-selector scoped, or light-token scoped', () => {
    const bad = selectors.filter((s) => s && !allowedBase.test(s));
    expect(bad).toEqual([]);
  });
  it('the only !important rules are the documented ones (iOS no-zoom override, inline-styled GW label, row gap, chevron)', () => {
    const imp = (rules.match(/[^{};]+!important/g) || []).map((x) => x.trim());
    const unknown = imp.filter((x) => !/font-size:(28|26|20)px!important|gap:8px!important|margin-top:6px!important|font-size:11px!important|display:none!important/.test(x));
    expect(unknown).toEqual([]);
    expect(css).toContain('A global <=768px rule forces every input to 16px !important');
  });
  it('Unified Balance exclusion and dark theme: nothing is scoped to dark, light rules keep the UB guard', () => {
    expect(css).not.toContain('data-theme="dark"');
    const lightSel = selectors.filter((s) => s.startsWith('html[data-theme="light"]'));
    expect(lightSel.length).toBeGreaterThan(5);
    lightSel.forEach((s) => expect(s).toContain(':not(:has(#page-unified-balance.active))'));
  });
  it('card dimensions: figure 28-32px desktop, details 12-13px, button 46-48px', () => {
    expect(css).toMatch(/\.st-swap-input\{font-size:30px/);
    expect(css).toMatch(/\.st-swap-detail-row\{padding:5px 0;font-size:12\.5px/);
    expect(css).toMatch(/\.st-swap-submit\{margin-top:0;min-height:48px/);
  });
});

describe('markup + handler contracts are preserved', () => {
  it.each([
    ['id="swap-amount-in"', 'oninput="updateSwapRate()"'],
    ['onclick="swpSetPct(25)"', 'onclick="swpSetPct(50)"'],
    ['onclick="swpSetMax()"', 'onclick="swapTokens()"'],
    ['onclick="swpSetSlippage(0.1,this)"', 'onclick="swpSetSlippage(3.0,this)"'],
    ['oninput="swpSetCustomSlippage(this.value)"', 'onclick="executeSwap()"'],
    ["onclick=\"openTokenSelector('in')\"", "onclick=\"openTokenSelector('out')\""],
    ["onclick=\"swpSetSource('evm')\"", "onclick=\"swpSetSource('gateway')\""],
    ["onclick=\"SwapUiModes.setMode('standard')\"", "onclick=\"SwapUiModes.setMode('advanced')\""],
  ])('keeps %s and %s', (a, b) => { expect(html).toContain(a); expect(html).toContain(b); });
  it('quote cells and the swap button keep their ids and state markup', () => {
    ['id="swap-rate"', 'id="swp-impact-val"', 'id="swp-min-received"', 'id="swp-fee-val"', 'id="swp-route-pool"', 'id="swap-btn"', 'id="swp-btn-label"', 'id="swp-btn-loading"', 'id="swp-btn-done"', 'id="swp-precheck"'].forEach((x) => expect(html).toContain(x));
    expect(html).toContain('<div class="swp-chart-wrap" id="swp-chart-wrap" style="display:none">');
  });
  it('button state styles (active/disabled/connect/loading/done) all remain', () => {
    ['.st-swap-submit.active{', '.st-swap-submit.disabled{', '.st-swap-submit.connect{', '.st-swap-submit.loading{', '.st-swap-submit.done{'].forEach((x) => expect(html).toContain(x));
  });
  it('the source buttons keep JS-owned colors inline (swpSetSource still drives them)', () => {
    expect(html).toMatch(/id="swp-src-evm" class="swp-src-btn"[^>]*style="border:1px solid rgba\(79,142,247,\.4\);background:rgba\(79,142,247,\.12\);color:var\(--blue\)"/);
    expect(html).toContain('Object.assign(evmBtn.style, _swpGwSource');
  });
});
