/**
 * bridge-route-selection-sync.test.js
 * ═══════════════════════════════════════════════════════════════════════════
 * Regression guard for "the Bridge route is selected internally and shown in the summary, but the
 * card keeps showing Select".
 *
 * Root cause (reproduced): brSelectRoute() updated the cards with a DOCUMENT-WIDE
 * `querySelectorAll('.brs-route')` and matched them to routes BY POSITION. The Swap route list renders
 * the same .brs-* classes and comes earlier in the DOM, so once Swap had routes the positions no longer
 * lined up: the Bridge cards were never updated and the Swap cards were touched instead.
 *
 * The REAL renderer (_brsRenderRoutes) and handler (brSelectRoute / _brsSyncSelectionUi) are extracted
 * from index.html and executed against a tiny DOM that understands exactly the markup they produce.
 * Everything financial is stubbed; nothing here moves funds or touches the network.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');

const SRC = html.slice(html.indexOf('function _brsRenderRoutes('), html.indexOf('// Clear routes (on chain/amount change)'));

// ── minimal DOM for the markup the renderer emits ───────────────────────────
function cls(initial) {
  const set = new Set(String(initial || '').split(/\s+/).filter(Boolean));
  return {
    add: (c) => set.add(c), remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    toggle: (c, force) => { const on = force === undefined ? !set.has(c) : !!force; on ? set.add(c) : set.delete(c); return on; },
    toString: () => [...set].join(' '),
  };
}
function makeCard(chunk) {
  const open = chunk.match(/^<div class="([^"]*)"([^>]*)>/);
  const attrs = {};
  (open[2].match(/([\w-]+)="([^"]*)"/g) || []).forEach((a) => { const m = a.match(/([\w-]+)="([^"]*)"/); attrs[m[1]] = m[2]; });
  const stepsM = chunk.match(/<div class="brs-route-steps"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*(?:<div class="brs-meta"|$)/);
  const hint = { _html: stepsM ? stepsM[1] : '' };
  Object.defineProperty(hint, 'innerHTML', { get() { return this._html; }, set(v) { this._html = v; } });
  hint.querySelector = (sel) => {
    if (sel === '.brs-select-btn--selected') return /brs-select-btn--selected/.test(hint._html) ? {} : null;
    if (sel === '.brs-select-btn') return /class="brs-select-btn/.test(hint._html) ? {} : null;
    return null;
  };
  return {
    classList: cls(open[1]),
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    hasAttribute: (n) => n in attrs,
    querySelector: (sel) => (sel === '.brs-route-steps' && stepsM ? hint : null),
    hint, raw: chunk, attrs,
  };
}
function makeList(id) {
  const el = { id, style: {}, classList: cls(''), _cards: [], _html: '' };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; },
    set(v) {
      this._html = v;
      this._cards = v.split(/(?=<div class="brs-route[ "])/).filter((c) => c.startsWith('<div class="brs-route')).map(makeCard);
    },
  });
  el.querySelectorAll = (sel) => (sel.includes('data-route-id') ? el._cards.filter((c) => c.hasAttribute('data-route-id')) : el._cards);
  return el;
}

function setup() {
  const inner = makeList('bridge-routes-inner');
  const swapList = makeList('swap-route-list');
  const simple = () => ({ style: {}, classList: cls(''), innerHTML: '', textContent: '', offsetWidth: 0 });
  const els = { 'bridge-routes-inner': inner, 'bridge-routes-panel': simple(), 'bridge-steps-card': simple(), 'bridge-rate-box': simple(), 'bridge-amount-out': { parentElement: simple() }, 'brg-route-divider': simple(), 'brg-route-divider-label': simple(), 'bridge-btn': simple(), 'bridge-amount': { value: '5' } };
  const texts = {};
  const doc = {
    getElementById: (id) => els[id] || null,
    // Document-wide query: Swap list first (it precedes the Bridge page in the real DOM).
    querySelectorAll: (sel) => (sel === '.brs-route' ? [...swapList._cards, ...inner._cards] : []),
  };
  const ctx = {
    document: doc, escHtml: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    _brsFmtUsd: (v) => (v == null ? '—' : '$' + Number(v).toFixed(3)), _brsFmtDur: (s) => (s == null ? '—' : s + 's'),
    _brsSetActive: () => {}, _brsShowRoutes: () => {}, _bridgeSetText: (id, t) => { texts[id] = t; }, _bridgeFmtDuration: (s) => s + 's',
    bridgeToToken: 'USDC', bridgeFromToken: 'USDC', _bridgeRoutes: [], _selectedBridgeRoute: null, _bridgeLastQuote: null,
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(SRC + '\nthis.__api = { render: _brsRenderRoutes, select: brSelectRoute, sync: typeof _brsSyncSelectionUi === "function" ? _brsSyncSelectionUi : null };', ctx);
  return { ctx, inner, swapList, texts, api: ctx.__api };
}

const R = (id, label, extra = {}) => ({ id, label, protocol: 'LI.FI aggregator', provider: 'lifi', available: true, outAmt: 1, feePct: null, gasUsd: 0.01, feesUsd: 0.01, execSec: 5, steps: 1, quote: { id }, ...extra });
const routes = () => [
  R('cctp-5042-8453', 'Circle CCTP', { provider: 'cctp', protocol: 'CCTP v2', execSec: 120, outAmt: 1.0, quote: undefined }),
  R('lifi-a', 'Relay', { outAmt: 0.99, execSec: 1 }),
  R('lifi-b', 'Relay', { outAmt: 0.97, execSec: 2 }),
  R('lifi-c', 'Layerswap', { outAmt: 0.93, execSec: 5 }),
  R('lifi-x', 'Expired', { available: false, outAmt: 0 }),
];
const click = (t, which) => { // run the inline handler exactly as the browser would
  const card = t.inner._cards[which.card];
  const src = which.button ? card.hint.innerHTML : card.attrs.onclick;
  const m = String(src).match(/brSelectRoute\((\d+)\)/);
  if (m) t.api.select(Number(m[1]));
};
const view = (t) => t.inner._cards.map((c) => (c.classList.contains('brs-selected') ? 'S' : '-') + (c.hint.innerHTML.includes('brs-select-btn--selected') ? 'V' : c.hint.innerHTML.includes('brs-select-btn') ? 's' : 'x')).join(' ');
const swapView = (t) => t.swapList._cards.map((c) => (c.classList.contains('brs-selected') ? 'S' : '-') + (c.hint.innerHTML.includes('brs-select-btn--selected') ? 'V' : 's')).join(' ');
const load = (t, rs = routes()) => { t.ctx._bridgeRoutes = rs; t.ctx._selectedBridgeRoute = null; t.api.render(rs, { name: 'Arc' }, { name: 'Base' }); };

describe('renderer exposes a stable id on every card', () => {
  it('data-route-id carries the route id (not the position)', () => {
    const t = setup(); load(t);
    expect(t.inner._cards.map((c) => c.getAttribute('data-route-id'))).toEqual(['cctp-5042-8453', 'lifi-a', 'lifi-b', 'lifi-c', 'lifi-x']);
  });
});

describe.each([['Swap list empty', false], ['Swap list populated (the bug)', true]])('selection sync — %s', (_n, withSwap) => {
  let t;
  beforeEach(() => {
    t = setup();
    if (withSwap) t.swapList.innerHTML = Array.from({ length: 6 }, (_, i) => '<div class="brs-route" data-source="s' + i + '"><div class="brs-route-top"><div class="brs-route-steps"><button class="brs-select-btn">Select</button></div></div></div>').join('');
    load(t);
  });

  it('nothing is selected initially', () => { expect(view(t)).toBe('-s -s -s -s -x'); });
  it('Select button: card gets the highlight and ✓ Selected, only that one', () => {
    click(t, { card: 1, button: true });
    expect(view(t)).toBe('-s SV -s -s -x');
    expect(t.ctx._selectedBridgeRoute.id).toBe('lifi-a');
  });
  it('card body click selects through the same handler and moves the highlight', () => {
    click(t, { card: 1, button: true });
    click(t, { card: 3 });
    expect(view(t)).toBe('-s -s -s SV -x');
  });
  it('CCTP <-> LI.FI alternation keeps exactly one selected', () => {
    click(t, { card: 0, button: true }); expect(view(t)).toBe('SV -s -s -s -x');
    click(t, { card: 2, button: true }); expect(view(t)).toBe('-s -s SV -s -x');
    click(t, { card: 0 });               expect(view(t)).toBe('SV -s -s -s -x');
  });
  it('two routes from the SAME provider: only the clicked one, execution quote follows it', () => {
    click(t, { card: 2, button: true });
    expect(view(t)).toBe('-s -s SV -s -x');
    expect(t.ctx._selectedBridgeRoute.id).toBe('lifi-b');
    expect(t.ctx._bridgeLastQuote).toEqual({ id: 'lifi-b' });
    expect(t.texts['bridge-protocol']).toBe('Relay');
  });
  it('highlighted card === _selectedBridgeRoute === summary route', () => {
    click(t, { card: 3, button: true });
    const sel = t.inner._cards.find((c) => c.classList.contains('brs-selected'));
    expect(sel.getAttribute('data-route-id')).toBe(t.ctx._selectedBridgeRoute.id);
    expect(t.texts['bridge-protocol']).toBe(t.ctx._selectedBridgeRoute.label);
  });
  it('an unavailable route cannot be selected and shows nothing as selected', () => {
    expect(t.inner._cards[4].attrs.onclick).toBeUndefined();
    t.api.select(4);
    expect(t.ctx._selectedBridgeRoute).toBeNull();
    expect(view(t)).toBe('-s -s -s -s -x');
  });
  it('a failed internal selection never shows a visual selection', () => {
    t.api.select(99);
    expect(t.ctx._selectedBridgeRoute).toBeNull();
    expect(view(t)).toBe('-s -s -s -s -x');
  });
  it('re-rendering (refresh) keeps the visual selection tied to the real one', () => {
    click(t, { card: 2, button: true });
    for (let i = 0; i < 4; i++) t.api.render(t.ctx._bridgeRoutes, { name: 'Arc' }, { name: 'Base' });
    expect(view(t)).toBe('-s -s SV -s -x');
  });
  it('selected route no longer present -> nothing is highlighted (no stale selection)', () => {
    click(t, { card: 2, button: true });
    const rest = t.ctx._bridgeRoutes.filter((r) => r.id !== 'lifi-b');
    t.ctx._bridgeRoutes = rest; t.ctx._selectedBridgeRoute = null; t.api.render(rest, { name: 'Arc' }, { name: 'Base' });
    expect(view(t).includes('S')).toBe(false);
    expect(view(t).includes('V')).toBe(false);
  });
  it('Best Rate / Fastest badges are independent of Selected', () => {
    click(t, { card: 3, button: true });
    expect(t.inner._cards[0].raw).toContain('Best Rate');
    expect(t.inner._cards[0].classList.contains('brs-selected')).toBe(false);
    expect(t.inner._cards[3].raw).not.toContain('Best Rate');
  });
  it('the Swap route cards are never touched by a Bridge selection', () => {
    const before = withSwap ? swapView(t) : '';
    click(t, { card: 1, button: true });
    click(t, { card: 2 });
    expect(withSwap ? swapView(t) : '').toBe(before);
  });
});

describe('source guards (no second source of truth, no new timers or requests)', () => {
  const fnSrc = SRC.slice(SRC.indexOf('function _brsSyncSelectionUi('), SRC.indexOf('// Clear routes') === -1 ? undefined : undefined);
  it('the visual state is derived from _selectedBridgeRoute and scoped to the Bridge panel', () => {
    const sync = SRC.slice(SRC.indexOf('function _brsSyncSelectionUi('), SRC.indexOf('function brSelectRoute('));
    expect(sync).toContain('_selectedBridgeRoute');
    expect(sync).toContain("getElementById('bridge-routes-inner')");
    expect(sync).toContain('data-route-id');
    expect(sync).not.toMatch(/document\.querySelectorAll\('\.brs-route'\)/);
    expect(sync).not.toMatch(/setTimeout|setInterval|fetch\(|XMLHttpRequest/);
  });
  it('brSelectRoute no longer uses a document-wide, position-based card loop', () => {
    const sel = SRC.slice(SRC.indexOf('function brSelectRoute('));
    expect(sel).not.toMatch(/document\.querySelectorAll\('\.brs-route'\)/);
    expect(sel).toContain('_brsSyncSelectionUi();');
    expect(sel).toContain('_selectedBridgeRoute = route;');
  });
  it('selection preconditions and the stored execution quote are unchanged', () => {
    const sel = SRC.slice(SRC.indexOf('function brSelectRoute('));
    expect(sel).toContain('if (!route || !route.available) return;');
    expect(sel).toContain("if (route.provider === 'lifi') { _bridgeLastQuote = route.quote; }");
  });
  it('a quote response is still dropped when a newer request exists (stale guard untouched)', () => {
    expect(html).toContain('const seq = ++_bridgeQuoteSeq;');
    expect(html).toContain('if (seq !== _bridgeQuoteSeq) return; // stale');
  });
  it('light theme: Selected button uses a subtle token-based fill, still bridge-scoped', () => {
    expect(html).toMatch(/#bridge-routes-inner \.brs-select-btn--selected\{background:rgba\(0,143,135,\.12\);border-color:var\(--lt-accent\);color:var\(--teal\)\}/);
  });
});
