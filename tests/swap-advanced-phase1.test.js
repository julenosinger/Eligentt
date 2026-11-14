/**
 * Swap — Advanced mode polish, phase 1 (presentation only).
 * Every new rule must be scoped to #page-swap.swp-advanced so Standard cannot change.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
const start = html.indexOf('/* ── Advanced mode polish · phase 1');
const end = html.indexOf('.swp-side-col', start) > -1 ? html.indexOf('\n.swap-route-head{', start) : -1;
const block = html.slice(start, end);

describe('Advanced phase 1 CSS block', () => {
  it('exists and is bounded', () => {
    expect(start).toBeGreaterThan(-1);
    expect(block.length).toBeGreaterThan(500);
  });
  it('every selector in the block is scoped to #page-swap.swp-advanced', () => {
    const rules = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '').split('}').map(r => r.trim()).filter(Boolean);
    expect(rules.length).toBeGreaterThan(10);
    rules.forEach(r => {
      const sel = r.slice(0, r.indexOf('{'));
      sel.split(',').map(x => x.trim()).filter(Boolean).forEach(one => {
        expect(one, one).toMatch(/^(\[data-theme="light"\] )?#page-swap\.swp-advanced\b/);
      });
    });
  });
  it('never touches the Standard class', () => {
    expect(block).not.toContain('swp-standard');
  });
  it('raises sub-9px labels to a 9px floor', () => {
    expect(block).toContain('.st-market-stat-label');
    expect(block).toMatch(/\.st-refresh-label\{font-size:9px\}/);
    expect(block).toMatch(/\.st-swap-detail-val\{font-size:9\.5px\}/);
  });
  it('light theme: chart canvas inverted, hard-coded dark borders replaced by tokens', () => {
    expect(block).toContain('[data-theme="light"] #page-swap.swp-advanced #st-chart-canvas{filter:invert(1) hue-rotate(180deg)}');
    expect(block).toMatch(/\.st-slip-pill,[\s\S]*?\.st-pair-pill\{border-color:var\(--border\)\}/);
    expect(block).toMatch(/\.st-slip-custom\{background:var\(--card2\);border-color:var\(--border\)\}/);
    expect(block).toContain('.st-refresh-btn{border-color:var(--border)}');
  });
});

describe('Standard / shared base rules unchanged', () => {
  it('Standard scoped rules are intact', () => {
    expect(html).toContain('#page-swap.swp-standard .st-pool-status{display:none}');
    expect(html).toContain('#page-swap.swp-standard .st-market-bar{display:none}');
    expect(html).toContain('#page-swap.swp-standard .st-chart-section{display:none}');
  });
  it('shared base rules keep their original values', () => {
    expect(html).toContain('.st-market-stat-label{font-size:7px;');
    expect(html).toContain('.st-slip-pill{padding:3px 9px;border-radius:3px;font-size:9px;font-weight:600;cursor:pointer;border:1px solid #1a1f2e;');
    expect(html).toContain('.st-swap-max{font-size:7px;');
  });
  it('chart drawing code is untouched (JS palette stays dark; light is CSS-only)', () => {
    expect(html).toContain("ctx.fillStyle = '#060a10'; ctx.fillRect(0, 0, w, h);");
  });
});

describe('Pool status message', () => {
  const i = html.indexOf('const _poolReason = inactiveReason');
  const seg = html.slice(i - 200, i + 700);
  it('long RPC errors are replaced by a short message, full reason kept in the tooltip', () => {
    expect(i).toBeGreaterThan(-1);
    expect(seg).toContain("/^Cannot verify pool deployment/i.test(_poolReason)");
    expect(seg).toContain("'Could not verify the pool right now. Try again shortly.'");
    expect(seg).toContain('lbl.title = _poolReason');
  });
  it('active-pool label is unchanged and the raw error text still originates from the same source', () => {
    expect(seg).toContain('`${poolCfg.tokenA}/${poolCfg.tokenB} · ${riskInfo.text}`');
    expect(html).toContain("error:'Cannot verify pool deployment: ' + (codeErr.message || 'RPC error')");
    expect(html).toContain('if (pd.error) return pd.error;');
  });
});
