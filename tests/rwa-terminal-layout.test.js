/**
 * RWA header + Trade Terminal layout.
 *
 * Static checks always run. The real-browser layout checks (actual element positions and
 * sizes) are opt-in because they need a running dev server and Playwright:
 *
 *   bun run dev &                                   # http://localhost:5173
 *   RWA_LAYOUT_E2E=1 bunx vitest run tests/rwa-terminal-layout.test.js
 *   (set PLAYWRIGHT_MODULE=/path/to/playwright if it is not resolvable from here)
 *
 * All network calls (LI.FI tokens/routes, RPC) are mocked: no funds are ever touched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const hdrStart = html.indexOf('<div class="rwa-header">');
const navStart = html.indexOf('<div class="rwa-nav">');
const HEADER = html.slice(hdrStart, navStart);

const cssStart = html.indexOf('/* ═══ RWA header + Trade Terminal fit');
const cssEnd = html.indexOf('</style>', cssStart);
const FIT_CSS = html.slice(cssStart, cssEnd);

describe('RWA header: compact, status integrated', () => {
  it('policy status lives inside the header (not a full-width row) with the same ids', () => {
    const bar = HEADER.indexOf('id="rwa-policy-bar"');
    expect(bar).toBeGreaterThan(0);
    expect(HEADER).toContain('id="rwa-policy-dot"');
    expect(HEADER).toContain('id="rwa-policy-msg"');
    expect(HEADER).toContain('role="status"');
    expect(HEADER).toContain('style="display:none"');              // still revealed by _rwaShowPolicy only
    expect(html.indexOf('id="rwa-policy-bar"')).toBeLessThan(navStart);
    // nothing between header and nav any more
    expect(html.slice(html.indexOf('</div>\n        <!-- Sub-navigation -->') - 20, navStart)).not.toContain('rwa-policy-bar');
  });
  it('everything that was in the header is still there', () => {
    for (const t of ['rwa-header-icon', 'RWA Advanced Trading', 'Tokenized real-world assets', 'id="rwa-policy-badge"', 'onclick="rwaRefresh()"', 'id="rwa-refresh-icon"'])
      expect(HEADER).toContain(t);
  });
  it('policy rendering logic is untouched', () => {
    const fn = html.slice(html.indexOf('function _rwaShowPolicy('), html.indexOf('// ── Tab navigation'));
    expect(fn).toContain("bar.style.display = 'flex';");
    expect(fn).toContain("badge.textContent = 'RWA Enabled';");
    expect(fn).toContain("badge.textContent = 'RWA Blocked';");
    expect(fn).toContain("badge.textContent = 'Policy Pending';");
  });
  it('sub-navigation keeps its five tabs in order', () => {
    const nav = html.slice(navStart, html.indexOf('<!-- Panels -->'));
    const ids = [...nav.matchAll(/id="rwa-tab-([a-z]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(['markets', 'trade', 'routes', 'portfolio', 'history']);
  });
});

describe('fit CSS is isolated and structural (no offsets or negative margins)', () => {
  const rules = FIT_CSS.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map((r) => r.trim()).filter(Boolean);
  const selectors = rules.map((r) => r.split('{')[0].trim()).filter((s) => s && !s.startsWith('@media'));
  it('every selector is scoped to #page-rwa / #rwa-panel-trade', () => {
    expect(selectors.length).toBeGreaterThan(15);
    for (const sel of selectors) for (const part of sel.split(',').map((x) => x.trim()).filter(Boolean))
      expect(part).toMatch(/^(#page-rwa|#rwa-panel-trade)/);
  });
  it('no negative margins, no magic offsets', () => {
    expect(FIT_CSS).not.toMatch(/margin(-top|-bottom)?:\s*-\d/);
    expect(FIT_CSS).not.toMatch(/(^|[;{\s])top:\s*-?\d+px/);
    expect(FIT_CSS).not.toMatch(/position:\s*(fixed|absolute)/);
  });
  it('only two documented !important (inline-style overrides on the Refresh button)', () => {
    expect((FIT_CSS.match(/!important/g) || []).length).toBe(2);
  });
  it('desktop: columns stretch to one row; the catalog is sized by the row, not the row by the catalog', () => {
    expect(FIT_CSS).toContain('@media(min-width:1181px)');
    expect(FIT_CSS).toContain('align-items:stretch');
    expect(FIT_CSS).toContain('height:0;min-height:100%');
  });
  it('centre column never scrolls on its own and the button stays in the normal flow', () => {
    const noComments = FIT_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(noComments).not.toMatch(/position:\s*sticky/);
    expect(noComments).not.toMatch(/scrollbar-width/);
    expect(noComments).not.toMatch(/rwa-trade-wrap[^{]*\{[^}]*overflow/);
    expect(noComments).not.toMatch(/rwa-exec-btn[^{]*\{[^}]*(^|[;{\s])(position|bottom|top)\s*:/);
    expect(noComments).toMatch(/\.rwa-exec-btn\{margin-top:6px\}/);
    // the earlier terminal rules must not reintroduce a clipped/scrolling centre column either
    const tt = html.slice(html.indexOf('/* ═══ RWA Trade Terminal 2.0'), html.indexOf('@media(max-width:768px){\n        .rwa-grid{')).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(tt).not.toMatch(/\.rwa-trade-wrap[^{]*\{[^}]*overflow/);
    expect(tt).not.toMatch(/\.rwa-exec-btn[^{]*\{[^}]*(^|[;{\s])position:\s*(sticky|fixed|absolute)/);
  });
  it('the page panel stays the vertical scroller', () => {
    expect(html).toMatch(/\.rwa-panel\{display:none;flex:1;overflow-y:auto/);
    expect(FIT_CSS).not.toContain('#rwa-panel-trade.active{display:flex');
    expect(FIT_CSS).not.toMatch(/#rwa-panel-trade(\.active)?\s*\{[^}]*overflow/);
  });
  it('sub-nav is 40px, header min-height 56px', () => {
    expect(FIT_CSS).toContain('#page-rwa .rwa-tab{height:40px');
    expect(FIT_CSS).toContain('min-height:56px');
  });
  it('responsive: header wraps on tablet/mobile instead of overlapping', () => {
    expect(FIT_CSS).toContain('@media(max-width:1180px)');
    expect(FIT_CSS).toContain('flex-wrap:wrap');
  });
  it('does not touch other tabs\' panels or the global header/sidebar', () => {
    expect(FIT_CSS).not.toMatch(/\.sidebar|\.topbar|\.page-header|#page-(send|swap|bridge|unified)/);
  });
});

// ── real browser: actual positions and sizes ───────────────────────────────────
const E2E = !!process.env.RWA_LAYOUT_E2E;
describe.skipIf(!E2E)('real layout in Chromium (mocked network)', () => {
  let browser, chromium;
  const VIEWS = [[1920, 1080], [1440, 900], [1366, 768]];
  const tokens = { '1': [{ symbol: 'SPYx', name: 'S&P 500 ETF', address: '0x1111111111111111111111111111111111111111', decimals: 18, tags: ['rwa'], priceUSD: '548.2' }] };
  const route = { id: 'r1', toAmount: '182356000000000000', toAmountMin: '181420000000000000', toAmountUSD: '99.9', steps: [{ id: 's', tool: 'across', toolDetails: { name: 'Across' }, estimate: { toAmount: '182356000000000000', toAmountMin: '181420000000000000', executionDuration: 20, gasCosts: [{ amountUSD: '0.04' }], feeCosts: [{ amountUSD: '0.25' }] } }] };
  beforeAll(async () => {
    ({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright'));
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu'] });
  });
  afterAll(async () => { if (browser) await browser.close(); });

  for (const theme of ['dark', 'light']) for (const [w, h] of VIEWS) for (const collapsed of [false, true]) {
    it(`${theme} ${w}x${h}${collapsed ? ' (sidebar collapsed)' : ''}`, async () => {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      await ctx.route('**/*', (r) => {
        const u = r.request().url();
        if (u.includes('/api/lifi/tokens')) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, tokens }) });
        if (u.includes('/api/lifi/routes')) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, routes: [route] }) });
        if (r.request().method() === 'POST' && (r.request().postData() || '').includes('"jsonrpc"')) {
          const q = JSON.parse(r.request().postData()); const one = (x) => ({ jsonrpc: '2.0', id: x.id, result: '0x' + (551296990n).toString(16).padStart(64, '0') });
          return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(Array.isArray(q) ? q.map(one) : one(q)) });
        }
        return r.continue();
      });
      const p = await ctx.newPage();
      await p.goto('http://localhost:5173/', { waitUntil: 'load' });
      await p.waitForFunction(() => typeof showPage === 'function');
      await p.waitForTimeout(1000);
      await p.evaluate((t) => { document.documentElement.setAttribute('data-theme', t); walletAddress = '0x01de000000000000000000000000000000687d11'; showPage('rwa'); }, theme);
      if (collapsed) await p.evaluate(() => toggleSidebar());
      await p.waitForTimeout(700);
      await p.evaluate(() => rwaTab('trade'));
      await p.fill('#rwa-amount-in', '100');
      await p.locator('.rwa-ttm-item').first().click();
      await p.waitForTimeout(1500);
      const m = await p.evaluate(() => {
        const r = (s) => document.querySelector(s).getBoundingClientRect();
        const panel = document.getElementById('rwa-panel-trade');
        const wrap = document.querySelector('.rwa-trade-wrap'), btnEl = document.getElementById('rwa-trade-btn'), b = btnEl.getBoundingClientRect();
        const others = [...wrap.children].filter((e) => e !== btnEl && e.offsetHeight > 0).map((e) => e.getBoundingClientRect());
        const btnOverlap = others.reduce((a, o) => a + Math.max(0, Math.min(b.bottom, o.bottom) - Math.max(b.top, o.top)), 0);
        const info = document.getElementById('rwa-info').getBoundingClientRect();
        return { centerScroll: wrap.scrollHeight - wrap.clientHeight, centerOverflow: getComputedStyle(wrap).overflowY, btnPos: getComputedStyle(btnEl).position, btnGap: Math.round(b.top - info.bottom), btnOverlap,
          header: r('.rwa-header').height, nav: r('.rwa-nav').height, navBottom: r('.rwa-nav').bottom, cols: [r('.rwa-tt-markets').top, r('.rwa-trade-wrap').top, r('.rwa-tt-side').top],
          label: r('.rwa-field-label').top, routes: r('.rwa-ttr-title').top, markets: r('.rwa-ttm-title').top, btn: r('#rwa-trade-btn'), vh: innerHeight,
          ovfX: document.documentElement.scrollWidth > innerWidth || panel.scrollWidth > panel.clientWidth + 1 };
      });
      await p.evaluate(() => document.getElementById('rwa-trade-btn').scrollIntoView({ block: 'nearest' }));
      m.reachable = await p.evaluate(() => { const b = document.getElementById('rwa-trade-btn').getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight + 1; });
      expect(m.header).toBeLessThanOrEqual(64);                       // 56-64px header (status integrated)
      expect(m.nav).toBeGreaterThanOrEqual(40); expect(m.nav).toBeLessThanOrEqual(44);
      expect(new Set(m.cols.map(Math.round)).size).toBe(1);           // three columns share one top edge
      const gap = m.cols[0] - m.navBottom;
      expect(gap).toBeGreaterThanOrEqual(16); expect(gap).toBeLessThanOrEqual(22);
      expect(m.label).toBeGreaterThan(m.navBottom); expect(m.routes).toBeGreaterThan(m.navBottom); expect(m.markets).toBeGreaterThan(m.navBottom);
      expect(m.centerScroll).toBeLessThanOrEqual(1);                   // centre column has no scrollbar of its own
      expect(m.centerOverflow).toBe('visible');
      expect(m.btnPos).toBe('static');
      expect(m.btnGap).toBeGreaterThanOrEqual(12); expect(m.btnGap).toBeLessThanOrEqual(16);   // button sits below the last info block
      expect(m.btnOverlap).toBe(0);                                    // ...and overlaps nothing
      expect(m.reachable).toBe(true);                                  // reachable by scrolling the page panel
      expect(m.ovfX).toBe(false);
      await ctx.close();
    }, 60000);
  }
});
