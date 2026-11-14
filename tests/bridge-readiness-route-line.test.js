/**
 * tests/bridge-readiness-route-line.test.js
 *
 * Guards the visual-only "continuous route line" applied to the Bridge
 * Destination Readiness indicator. Static source checks (no DOM dependency):
 *  - new markup keeps every original DOM hook
 *  - the new visual is scoped to #dgv-panel-bridge only
 *  - state is exposed via data-state and never fakes READY
 *  - no new timers/listeners, reduced-motion respected
 *  - validation logic, Send Assets Payment Route and other panels untouched
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';

const src = fs.readFileSync('index.html', 'utf8');

function between(start, end) {
  const a = src.indexOf(start);
  const b = src.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error('block not found: ' + start);
  return src.slice(a, b);
}

const buildPanelSrc = between('function buildPanel(){', 'function cacheEls(){');
const cssSrc = between("'#dgv-panel-bridge .dgv3-route{", "document.head.appendChild(st);");
const renderSrc = between('function render(res){', 'function renderIdle(){');
const checkingSrc = between('function renderChecking(res){', 'async function run(){');

describe('route line markup', () => {
  it('bridge readiness uses the dgv3-route markup', () => {
    expect(buildPanelSrc).toContain("cfg.panelId === 'dgv-panel-bridge'");
    expect(buildPanelSrc).toContain('dgv2-readiness dgv3-route');
    expect(buildPanelSrc).toContain('dgv3-track');
    expect(buildPanelSrc).toContain('dgv3-end');
  });
  it('keeps original hooks dgv-bar-fg and dgv-checks (DOM contract)', () => {
    expect(buildPanelSrc).toContain('dgv2-bar-fg dgv-bar-fg dgv3-fill');
    expect(buildPanelSrc).toContain('dgv2-checks dgv-checks');
  });
  it('other panels keep the original bar markup', () => {
    expect(buildPanelSrc).toContain('<div class="dgv2-readiness">');
    expect(buildPanelSrc).toContain('width:0%;background:#7b8291');
  });
  it('decorative parts are aria-hidden, route is a polite status region', () => {
    expect(buildPanelSrc).toContain('role="status" aria-live="polite"');
    expect(buildPanelSrc).toContain('class="dgv3-packet" aria-hidden="true"');
  });
  it('initial state is unknown (never READY)', () => {
    expect(buildPanelSrc).toContain('dgv3-route" data-state="unknown"');
  });
});

describe('state mapping', () => {
  it('render() exposes real state via data-state (lowercased)', () => {
    expect(renderSrc).toContain("els.route.setAttribute('data-state', String(res.state || 'UNKNOWN').toLowerCase())");
  });
  it('renderChecking() sets checking state', () => {
    expect(checkingSrc).toContain("els.route.setAttribute('data-state', 'checking')");
  });
  it('width still comes from the existing _barConfig (no invented percentages)', () => {
    expect(renderSrc).toContain('var bc = _barConfig(res.state, res.exempt)');
    expect(renderSrc).toContain("els.barFg.style.width = bc.pct + '%'");
  });
  it('inline fill colour is only written for panels without the route line', () => {
    expect(renderSrc).toContain('if (!els.route) els.barFg.style.background = bc.bg');
    expect(checkingSrc).toContain("if (!els.route) els.barFg.style.background='#7b8291'");
  });
  it('_checksText / _barConfig semantics unchanged', () => {
    expect(src).toContain("return exempt?'3/3 (gas exempt)':'3/3 passed'");
    expect(src).toContain("if (s==='SAFE')     return { pct:100, bg: exempt?'#06F7E9':'#22c55e' }");
    expect(src).toContain("if (s==='BLOCKED')  return { pct:20, bg:'#ef4444' }");
  });
  it('only safe shows the confirmation icon; blocked uses the x icon', () => {
    expect(cssSrc).toContain('data-state=safe] .ic-ok');
    expect(cssSrc).toContain('data-state=blocked] .ic-bad');
    // ok icon must not be attached to any other state
    const okRules = cssSrc.match(/data-state=[a-z]+\] \.ic-ok/g) || [];
    expect(okRules).toEqual(['data-state=safe] .ic-ok']);
  });
  it('error/stale/unknown use a dashed (unconfirmed) line', () => {
    expect(cssSrc).toContain('data-state=unknown] .dgv3-track');
    expect(cssSrc).toContain('data-state=error] .dgv3-track');
    expect(cssSrc).toContain('data-state=stale] .dgv3-track');
    expect(cssSrc).toContain('repeating-linear-gradient');
  });
  it('safe is green, blocked is red', () => {
    expect(cssSrc).toMatch(/data-state=safe\]\{--c:#22c55e/);
    expect(cssSrc).toMatch(/data-state=blocked\],[^{]*\{--c:#ef4444/);
  });
});

describe('animation', () => {
  it('animation runs only in the checking state', () => {
    const animRules = cssSrc.match(/[^}]*animation:dgv3-[^}]*\}/g) || [];
    expect(animRules.length).toBeGreaterThan(0);
    animRules.forEach(r => {
      if (r.includes('prefers-reduced-motion')) return;
      expect(r).toContain('data-state=checking');
    });
  });
  it('respects prefers-reduced-motion', () => {
    expect(cssSrc).toContain('@media(prefers-reduced-motion:reduce)');
    expect(cssSrc).toMatch(/reduce\)\{[^}]*animation:none/);
  });
  it('defines the two keyframes', () => {
    expect(cssSrc).toContain('@keyframes dgv3-sweep');
    expect(cssSrc).toContain('@keyframes dgv3-travel');
  });
});

describe('isolation and no side effects', () => {
  it('every new rule is scoped to #dgv-panel-bridge', () => {
    const rules = cssSrc.split("' +").map(s => s.trim()).filter(s => s.includes('dgv3-'));
    rules.forEach(r => {
      if (r.startsWith("'@keyframes")) return;
      expect(r).toContain('#dgv-panel-bridge');
    });
  });
  it('no new timers, observers or listeners in the DGV panel code', () => {
    // (buildPanel's pre-existing accordion/ack listeners are excluded: only the new markup is checked)
    const readinessSrc = between('var readinessHTML =', 'var panelHTML =');
    [readinessSrc, renderSrc, checkingSrc, cssSrc].forEach(b => {
      expect(b).not.toMatch(/setInterval|requestAnimationFrame|MutationObserver|addEventListener/);
    });
  });
  it('validation thresholds and Arc exempt flag are untouched', () => {
    expect(src).toContain('var THRESHOLDS = {');
    expect(src).toMatch(/5042:\s*\{[^}]*exempt:\s*true/);
  });
  it('gate and refresh hook are untouched', () => {
    expect(src).toContain('window.__DGVRefreshActive = refreshActive');
    expect(src).toContain('installGate();');
  });
  it('Send Assets Payment Route component is unchanged', () => {
    expect(src).toContain('id="sa-xroute-packet"');
    expect(src).toContain('animation:xc-travel 2.2s linear infinite');
    expect(src).toContain('<span style="font-size:10px;font-weight:600;color:#f59e0b">Payment Route</span>');
  });
  it('bridge panel anchor and button ids preserved', () => {
    expect(src).toContain('<div id="dgv-panel-bridge"></div>');
    expect(src).toContain("panelId: 'dgv-panel-bridge'");
  });
});
