import { describe, it, expect } from 'vitest';
import fs from 'fs';
import vm from 'vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const tradeStart = html.indexOf('<div class="rwa-panel" id="rwa-panel-trade">');
const tradeEnd = html.indexOf('<!-- Route Comparison -->', tradeStart);
const TRADE_HTML = html.slice(tradeStart, tradeEnd);

const jsStart = html.indexOf('// ═══ RWA Trade Terminal 2.0');
const jsEnd = html.indexOf('// ═══ end RWA Trade Terminal 2.0');
const TT_JS = html.slice(jsStart, jsEnd);

const cssStart = html.indexOf('/* ═══ RWA Trade Terminal 2.0');
const cssEnd = html.indexOf('@media(max-width:768px){\n        .rwa-grid{', cssStart);
const TT_CSS = html.slice(cssStart, cssEnd);

const fnStart = html.indexOf('async function rwaFetchQuote() {');
const fnEnd = html.indexOf('function _rwaSetQuoteLoading(on)', fnStart);
const FETCH_QUOTE = html.slice(fnStart, fnEnd);

describe('layout: three columns, existing card preserved', () => {
  it('markets | swap | routes+summary, in that order', () => {
    const a = TRADE_HTML.indexOf('class="rwa-tt-markets"');
    const b = TRADE_HTML.indexOf('class="rwa-trade-wrap"');
    const c = TRADE_HTML.indexOf('class="rwa-tt-side"');
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(TRADE_HTML).toContain('id="rwa-ttr"');
    expect(TRADE_HTML).toContain('id="rwa-tts"');
  });
  it('grid proportions are 25 / 40 / 35', () => {
    expect(TT_CSS).toMatch(/grid-template-columns:minmax\(230px,25fr\) minmax\(340px,40fr\) minmax\(300px,35fr\)/);
  });
  it('keeps every id and handler of the original swap card', () => {
    for (const id of ['rwa-from-sel', 'rwa-from-sym', 'rwa-amount-in', 'rwa-from-bal', 'rwa-to-sel', 'rwa-to-sym', 'rwa-amount-out', 'rwa-amount-out-min', 'rwa-to-bal', 'rwa-from-chain', 'rwa-to-chain', 'rwa-quote-box', 'rwa-quote-tool', 'rwa-quote-out', 'rwa-quote-min', 'rwa-quote-fee', 'rwa-quote-time', 'rwa-quote-err', 'rwa-trade-btn'])
      expect(TRADE_HTML).toContain('id="' + id + '"');
    for (const h of ["onclick=\"rwaOpenPicker('from')\"", "onclick=\"rwaOpenPicker('to')\"", 'onclick="rwaSwapDirection()"', 'onchange="rwaOnChainChange()"', 'oninput="rwaOnAmountChange()"', 'onclick="rwaConfirmTrade()"'])
      expect(TRADE_HTML).toContain(h);
  });
  it('only real controls are added (25/50/MAX call a real handler, no slippage input)', () => {
    expect(TRADE_HTML).toContain('onclick="rwaSetPct(25)"');
    expect(TRADE_HTML).toContain('onclick="rwaSetPct(50)"');
    expect(TRADE_HTML).toContain('onclick="rwaSetPct(100)"');
    expect(TRADE_HTML).not.toMatch(/id="rwa-slippage/);
  });
  it('catalog is collapsible for tablet/mobile and accessible', () => {
    expect(TRADE_HTML).toContain('aria-expanded="false"');
    expect(TRADE_HTML).toContain('role="listbox"');
    expect(TRADE_HTML).toContain('aria-label="Search RWA assets"');
  });
  it('other sub-tabs are untouched', () => {
    for (const id of ['rwa-panel-markets', 'rwa-panel-routes', 'rwa-panel-portfolio', 'rwa-panel-history', 'rwa-markets-grid', 'rwa-routes-list', 'rwa-portfolio-list'])
      expect(html).toContain('id="' + id + '"');
  });
});

describe('pure helpers (real source, run in a sandbox)', () => {
  const src = TT_JS.slice(TT_JS.indexOf('// <RWA-TT-PURE>'), TT_JS.indexOf('// </RWA-TT-PURE>'));
  const ctx = vm.createContext({});
  vm.runInContext(src, ctx);
  const f = (n) => ctx[n];

  it('identity is chainId + lower-cased address (same symbol on two chains differs)', () => {
    expect(f('_rwaTTKey')(1, '0xABCDEF')).toBe('1:0xabcdef');
    expect(f('_rwaTTKey')(1, '0xabc')).not.toBe(f('_rwaTTKey')(42161, '0xabc'));
    expect(f('_rwaTTKey')('1', '0xAbC')).toBe(f('_rwaTTKey')(1, '0xabc'));
  });
  it('percentage amounts are exact BigInt maths (floor, no float drift)', () => {
    expect(f('_rwaTTPctAmount')(551296990n, 25, 6)).toBe('137.824247');
    expect(f('_rwaTTPctAmount')(551296990n, 50, 6)).toBe('275.648495');
    expect(f('_rwaTTPctAmount')(551296990n, 100, 6)).toBe('551.29699');
    expect(f('_rwaTTPctAmount')(123456789012345678901n, 100, 18)).toBe('123.456789012345678901');
    expect(f('_rwaTTPctAmount')(1n, 25, 6)).toBe('0');
    expect(f('_rwaTTPctAmount')(100n, 0, 6)).toBe('');
    expect(f('_rwaTTPctAmount')(100n, 101, 6)).toBe('');
    expect(f('_rwaTTPctAmount')('x', 50, 6)).toBe('');
  });
  it('units formatting keeps precision and trims zeros', () => {
    expect(f('_rwaTTUnits')(1000000n, 6)).toBe('1');
    expect(f('_rwaTTUnits')(1n, 6)).toBe('0.000001');
    expect(f('_rwaTTUnits')(1500000n, 6)).toBe('1.5');
    expect(f('_rwaTTUnits')(5n, 0)).toBe('5');
  });
  const R = (routeId, out, dur) => ({ routeId, toAmountRaw: BigInt(out), executionDuration: dur });
  it('Best Rate / Fastest: real comparisons, independent, only with 2+ comparable routes', () => {
    expect(f('_rwaTTRank')([R('a', 100, 30)])).toEqual({ best: null, fast: null });
    expect(f('_rwaTTRank')([])).toEqual({ best: null, fast: null });
    expect(f('_rwaTTRank')([R('a', 100, 30), R('b', 90, 10)])).toEqual({ best: 'a', fast: 'b' });
    expect(f('_rwaTTRank')([R('a', 100, 10), R('b', 90, 30)])).toEqual({ best: 'a', fast: 'a' });
    expect(f('_rwaTTRank')([R('a', 100, 30), R('b', 100, 30)])).toEqual({ best: null, fast: null });
    expect(f('_rwaTTRank')([R('a', 100, null), R('b', 90, null)])).toEqual({ best: 'a', fast: null });
    expect(f('_rwaTTRank')([R('a', 100, null), R('b', 90, 20), R('c', 80, 5)])).toEqual({ best: 'a', fast: 'c' });
  });
  it('missing data is a dash, never a fake zero', () => {
    expect(f('_rwaTTFmtUsd')(null)).toBe('\u2014');
    expect(f('_rwaTTFmtUsd')(undefined)).toBe('\u2014');
    expect(f('_rwaTTFmtUsd')(NaN)).toBe('\u2014');
    expect(f('_rwaTTFmtUsd')(0.25)).toBe('$0.2500');
    expect(f('_rwaTTFmtUsd')(12.3456)).toBe('$12.35');
    expect(f('_rwaTTFmtTime')(null)).toBe('\u2014');
    expect(f('_rwaTTFmtTime')(0)).toBe('\u2014');
    expect(f('_rwaTTFmtTime')(12)).toBe('~12s');
    expect(f('_rwaTTFmtTime')(61)).toBe('~2 min');
    expect(f('_rwaTTRate')('', 5n, 6)).toBe('');
    expect(f('_rwaTTRate')('0', 5n, 6)).toBe('');
    expect(f('_rwaTTRate')('100', 0n, 6)).toBe('');
    expect(f('_rwaTTRate')('100', 182356000000000000n, 18)).toBe('0.00182356');
  });
  it('route key identifies provider + path, not the per-request id', () => {
    const a = { label: 'Across', steps: 2, stepsData: [{ tool: 'across' }, { tool: 'uniswap' }], routeId: 'x1' };
    const b = { label: 'Across', steps: 2, stepsData: [{ tool: 'across' }, { tool: 'uniswap' }], routeId: 'x2' };
    const c = { label: 'Across', steps: 1, stepsData: [{ tool: 'across' }], routeId: 'x3' };
    expect(f('_rwaTTRouteKey')(a)).toBe(f('_rwaTTRouteKey')(b));
    expect(f('_rwaTTRouteKey')(a)).not.toBe(f('_rwaTTRouteKey')(c));
  });
  it('error text maps to a distinct UI state (loading/none/unavailable/error/wallet)', () => {
    const m = f('_rwaTTStatusFromErr');
    expect(m(null)).toBe('idle');
    expect(m('Connect your wallet to get a quote.')).toBe('wallet');
    expect(m('Select source and destination tokens.')).toBe('pair');
    expect(m('RWA trading is not enabled for this integrator. Please configure ...')).toBe('blocked');
    expect(m('No routes available for this RWA pair. The asset may ...')).toBe('none');
    expect(m('LIFI_ROUTES_UNAVAILABLE')).toBe('error');
  });
});

describe('stale-response protection (existing quote function, minimal edit)', () => {
  it('every request bumps the sequence first, before any early return', () => {
    expect(FETCH_QUOTE).toMatch(/async function rwaFetchQuote\(\) \{\n  var _rwaSeq = \+\+_rwaQuoteSeq;\n  if \(typeof LiFiAdapter/);
  });
  it('a superseded response returns before touching any state', () => {
    const guard = FETCH_QUOTE.indexOf('if (_rwaSeq !== _rwaQuoteSeq) return;');
    const awaitAt = FETCH_QUOTE.indexOf('await LiFiAdapter.getRoutes');
    const firstWrite = FETCH_QUOTE.indexOf('_rwaSetQuoteLoading(false)');
    expect(awaitAt).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(awaitAt);
    expect(guard).toBeLessThan(firstWrite);
  });
  it('quote parameters and the engine call are untouched', () => {
    expect(FETCH_QUOTE).toContain('slippageBps: 50');
    expect(FETCH_QUOTE).toContain('LiFiAdapter.getRoutes({');
    expect(FETCH_QUOTE).toContain('fracPart = fracPart.slice(0, d)');
    expect(TT_JS).toContain("_RWA_SLIPPAGE_LABEL = '0.5%'");
  });
  it('invalidation bumps the same sequence so in-flight responses are dropped', () => {
    const inv = TT_JS.slice(TT_JS.indexOf('function _rwaInvalidateQuote()'), TT_JS.indexOf('// ── pct buttons'));
    expect(inv).toContain('_rwaQuoteSeq++');
    expect(inv).toContain('_rwaRoutes = []; _rwaSelectedRoute = null; _rwaCurrentQuote = null;');
  });
  it('wrapper bumps nothing twice and clears a pending debounce instead of adding a timer', () => {
    expect(TT_JS).toContain('clearTimeout(window._rwaQuoteTimer);');
    expect(TT_JS).not.toContain('setInterval');
    expect((TT_JS.match(/setTimeout\(/g) || []).length).toBe(1);   // search debounce only
  });
});

describe('route selection', () => {
  const sel = TT_JS.slice(TT_JS.indexOf('function _rwaSelectRoute('), TT_JS.indexOf('// ── invalidation'));
  it('uses the stable routeId and never a list index', () => {
    expect(sel).toContain('String(x.routeId) === String(arg)');
    expect(sel).not.toMatch(/\[\s*i\s*\]/);
    expect(TT_JS).toContain("c.getAttribute('data-route-id')");
  });
  it('binds execution to the displayed route (same variables confirm/execute read)', () => {
    expect(sel).toContain('_rwaSelectedRoute = r;');
    expect(sel).toContain('_rwaCurrentQuote = r;');
    const exec = html.slice(html.indexOf('async function rwaExecuteTrade()'), html.indexOf('async function rwaExecuteTrade()') + 800);
    expect(exec).toContain('_rwaSelectedRoute');
  });
  it('refuses non-members, unavailable and expired routes', () => {
    expect(sel).toContain('_rwaRoutes.indexOf(r) === -1');
    expect(sel).toContain('r.available === false');
    expect(sel).toContain('_RWA_QUOTE_TTL_MS');
  });
  it('legacy Route Comparison list shares the same selection', () => {
    expect(html).toContain("card.setAttribute('data-route-id', String(r.routeId));");
    expect(html).toContain("card.addEventListener('click', function() { _rwaSelectRoute(r); });");
  });
  it('a manual choice is only restored when the same provider/path comes back, otherwise the user is told', () => {
    expect(TT_JS).toContain('_rwaTTRouteKey(r) === want.key');
    expect(TT_JS).toContain('Your previous route is no longer available');
  });
});

describe('the Trade Terminal layer never touches funds or the engine', () => {
  it('no signing / approvals / transport / engine calls', () => {
    const code = TT_JS.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    for (const bad of ['LiFiAdapter', 'getStepTransaction', 'sendTransaction', 'signer', 'approve(', 'allowance', 'fetch(', 'XMLHttpRequest', 'rwaExecuteTrade', 'localStorage', 'ethers.'])
      expect(code).not.toContain(bad);
  });
  it('asset selection only fills the form and asks for a quote', () => {
    const s = TT_JS.slice(TT_JS.indexOf('function rwaTTSelectAsset('), TT_JS.indexOf('// <<') > 0 ? undefined : undefined);
    const body = s.slice(0, s.indexOf('\n}\n') + 2);
    expect(body).toContain('_rwaUpdateTokenUI();');
    expect(body).toContain('rwaFetchQuote();');
    expect(body).not.toContain('rwaConfirmTrade');
    expect(body).not.toContain('rwaExecuteTrade');
  });
  it('wraps the existing functions instead of replacing them', () => {
    for (const w of ['_rwaRenderRoutes_base = _rwaRenderRoutes', '_rwaSetQuoteLoading_base = _rwaSetQuoteLoading', '_rwaSetQuoteErr_base = _rwaSetQuoteErr', '_rwaUpdateBalances_base = _rwaUpdateBalances', '_rwaFetchTokenBalance_base = _rwaFetchTokenBalance', '_rwaOnAmountChange_base = rwaOnAmountChange', '_rwaFetchQuote_base = rwaFetchQuote', '_rwaConfirmTrade_base = rwaConfirmTrade', '_rwaLoadMarkets_base = rwaLoadMarkets'])
      expect(TT_JS).toContain(w);
    for (const e of ['rwaOnAmountChange', 'rwaFetchQuote', 'rwaConfirmTrade', 'rwaLoadMarkets', 'rwaSetPct', 'rwaTTSelectAsset'])
      expect(TT_JS).toContain('window.' + e + ' = ' + e + ';');
  });
});

describe('state cannot move under a trade being confirmed or signed', () => {
  const lock = TT_JS.slice(TT_JS.indexOf('function _rwaTTLocked()'), TT_JS.indexOf('function _rwaTTWalletOk()'));
  it('lock = execution pending OR confirm dialog open', () => {
    expect(lock).toContain('_rwaExecPending');
    expect(lock).toContain("classList.contains('open')");
    expect(lock).toContain('rwa-confirm-overlay');
  });
  it('user-driven changes are refused while locked', () => {
    for (const fn of ['function _rwaSelectRoute(arg, auto) {', 'function rwaTTSelectAsset(t) {', 'function rwaSetPct(p) {'])
      expect(TT_JS.slice(TT_JS.indexOf(fn), TT_JS.indexOf(fn) + 200)).toContain('_rwaTTLocked()');
  });
  it('invalidation never clears the route while a trade is being signed (rwaExecuteTrade keeps reading it)', () => {
    expect(TT_JS.slice(TT_JS.indexOf('function _rwaInvalidateQuote()'), TT_JS.indexOf('function _rwaInvalidateQuote()') + 200)).toContain('if (_rwaExecPending) return;');
    expect(TT_JS).toContain("&& !_rwaExecPending) { _rwaRoutes = []; _rwaSelectedRoute = null; }");
  });
});

describe('styles are isolated', () => {
  const sels = TT_CSS.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map((r) => r.split('{')[0].trim()).filter(Boolean);
  const OK = /^(\.rwa-tt|\.rwa-ttm|\.rwa-ttr|\.rwa-tts|\.rwa-rc|\.rwa-sk|\.rwa-info|\.rwa-pct|\.rwa-fmeta|\.rwa-usd|#rwa-to-usd|\.rwa-tok-logo|\[data-theme="light"\] \.rwa-|@media|@container)/;
  it('every selector belongs to the terminal', () => {
    expect(sels.length).toBeGreaterThan(80);
    for (const sel of sels) for (const part of sel.split(',').map((x) => x.trim()).filter(Boolean)) {
      if (/^(\.rwa-tt|\.rwa-ttm|\.rwa-ttr|\.rwa-tts|\.rwa-rc|\.rwa-sk|\.rwa-info|\.rwa-pct|\.rwa-fmeta|\.rwa-usd|#rwa-to-usd|\.rwa-tok-logo|\[data-theme="light"\] \.rwa-|@media|@container|\.rwa-ttm)/.test(part) || /^(\.rwa-[a-z-]+|#rwa-[a-z-]+)\b/.test(part) || part.startsWith('@')) continue;
      expect(part).toMatch(OK);
    }
  });
  it('does not restyle other RWA tabs or the confirm/picker modals', () => {
    expect(TT_CSS).not.toMatch(/\.rwa-card\b|\.rwa-grid\b|\.rwa-pos-|\.rwa-hist-|\.rwa-confirm-|\.rwa-picker-|\.rwa-nav|\.rwa-tab\b/);
  });
  it('the only !important uses override inline styles of the existing card', () => {
    const rules = TT_CSS.replace(/\/\*[\s\S]*?\*\//g, '').split('}').filter((r) => r.includes('!important'));
    expect(rules.length).toBe(6);
    for (const r of rules) expect(r.split('{')[0]).toMatch(/#rwa-from-sym|#rwa-amount-out|rwa-field-group select|#rwa-quote-box|rwa-amount-input/);
  });
  it('uses design tokens and violet accent; no new global rules', () => {
    expect(TT_CSS).toContain('var(--card)');
    expect(TT_CSS).toContain('#a855f7');
    expect(TT_CSS).not.toMatch(/(^|\n)\s*(body|html|\*|div|button|input|select)\s*[{,]/);
  });
});
