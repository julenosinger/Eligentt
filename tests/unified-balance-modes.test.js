/**
 * Unified Balance — Live Mode Orchestration (Send/Swap/Move as modes).
 * ═══════════════════════════════════════════════════════════════════════
 * Verifies that Send / Swap / Move are MODES of the Screen Live (never page
 * navigation), that Quick Actions route to the same mode entry point, that
 * Back to Live returns to live, and that no existing execution flow was
 * duplicated. Combines source inspection (index.html + shared modules) with
 * pure module evaluation of the Live controller.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const hub = fs.readFileSync(path.join(root, 'shared', 'ubMerchantHub.js'), 'utf8');
const busSrc = fs.readFileSync(path.join(root, 'shared', 'unifiedBalanceOperationBus.js'), 'utf8');
const liveSrc = fs.readFileSync(path.join(root, 'shared', 'unifiedBalanceLive.js'), 'utf8');

function evalModule(src, win) {
  const fn = new Function('window', src);
  fn.call(null, win);
}

function makeBus() {
  const win = {};
  evalModule(busSrc, win);
  return win.UBOperationBus;
}

function makeDoc() {
  const els = {};
  return {
    els,
    getElementById(id) {
      if (!els[id]) els[id] = { innerHTML: '', textContent: '', style: { display: '' } };
      return els[id];
    },
  };
}

function makeLive(bus, doc) {
  const win = {};
  globalThis.UBOperationBus = bus;
  globalThis.document = doc;
  globalThis.UBMerchant = undefined;
  evalModule(liveSrc, win);
  return win.UBLive;
}

describe('Unified Balance — Live Mode state machine', () => {
  let doc, bus, live;
  beforeEach(() => {
    doc = makeDoc();
    bus = makeBus();
    live = makeLive(bus, doc);
  });
  afterEach(() => {
    delete globalThis.UBOperationBus;
    delete globalThis.document;
    delete globalThis.UBMerchant;
  });

  it('starts in liveMode = live', () => {
    expect(live.getMode()).toBe('live');
  });

  it('liveMode = send', () => { live.setMode('send'); expect(live.getMode()).toBe('send'); });
  it('liveMode = swap', () => { live.setMode('swap'); expect(live.getMode()).toBe('swap'); });
  it('liveMode = move', () => { live.setMode('move'); expect(live.getMode()).toBe('move'); });

  it('Back to Live returns to liveMode = live', () => {
    live.setMode('send');
    live.exitToLive();
    expect(live.getMode()).toBe('live');
  });

  it('mode panel renders SEND MODE with a Back to Live action', () => {
    live.init();
    live.setMode('send');
    const modeHtml = doc.els['ub-live-mode'].innerHTML;
    expect(modeHtml).toContain('SEND MODE');
    expect(modeHtml).toContain('Back to Live');
  });

  it('mode panel never references showPage (no navigation)', () => {
    live.init();
    live.setMode('send');
    live.setMode('swap');
    live.setMode('move');
    const modeHtml = doc.els['ub-live-mode'].innerHTML;
    expect(modeHtml).not.toContain('showPage');
  });

  it('subscribes to the operation bus exactly ONCE (no duplicate listeners)', () => {
    live.init();
    expect(bus.count()).toBe(1);
    live.init();
    expect(bus.count()).toBe(1);
  });
});

describe('Unified Balance — mode wiring (no page navigation)', () => {
  it('defines UB.liveMode state + orchestration functions', () => {
    expect(html).toContain('liveMode: \'live\'');
    expect(html).toContain('function enterUnifiedBalanceMode');
    expect(html).toContain('function exitUnifiedBalanceMode');
  });

  it('enterUnifiedBalanceMode reuses existing flows (Send/Swap/Move)', () => {
    const fn = html.slice(html.indexOf('function enterUnifiedBalanceMode'), html.indexOf('function exitUnifiedBalanceMode'));
    expect(fn).toContain('UBScreen.openSend()');
    expect(fn).toContain('UBScreen.openSwap()');
    expect(fn).toContain('UBScreen.openBridge()');
    expect(fn).toContain('UBLive.setMode');
    expect(fn).toContain('UB.liveMode');
  });

  it('header [Send][Swap][Move] use the unified mode entry point (not UBScreen directly, not showPage)', () => {
    const header = html.slice(html.indexOf('id="ub-hero-card"'), html.indexOf('id="ub-live-screen"'));
    expect(header).toContain("enterUnifiedBalanceMode('send')");
    expect(header).toContain("enterUnifiedBalanceMode('swap')");
    expect(header).toContain("enterUnifiedBalanceMode('move')");
    expect(header).not.toContain('showPage(');
    expect(header).not.toContain('UBScreen.openSend()');
  });

  it('Quick Action Send/Swap/Move open the same mode (not showPage)', () => {
    const qa = hub.slice(hub.indexOf('function renderQuickActions'), hub.indexOf('function renderMonthlyOverview'));
    expect(qa).toContain('enterUnifiedBalanceMode');
    expect(qa).toContain("mode('send')");
    expect(qa).toContain("mode('swap')");
    expect(qa).toContain("mode('move')");
    expect(qa).not.toContain("showPage('send')");
    expect(qa).not.toContain("showPage('swap')");
    expect(qa).not.toContain("showPage('move')");
  });

  it('UBScreen execution still delegates to the real handlers (no duplicated engines)', () => {
    expect(html).toContain('saExecuteSend()');
    expect(html).toContain('executeSwap()');
    expect(html).toContain('xcExecuteSend()');
  });

  it('op panel closes reset to live (Back to Live → exitUnifiedBalanceMode)', () => {
    expect(html).toContain('exitUnifiedBalanceMode()');
    // Closing the panel always resets the live mode
    const cleanup = html.slice(html.indexOf('function _cleanupAll'), html.indexOf('function hideOperation'));
    expect(cleanup).toContain("UB.liveMode = 'live'");
  });
});

describe('Unified Balance — telemetry presentation (no card fragmentation)', () => {
  it('financial indicators render as telemetry rows, not card cells', () => {
    expect(liveSrc).toContain('Financial Telemetry');
    expect(liveSrc).toContain('ub-fin-row');
    expect(liveSrc).not.toContain("min-width:88px;background:rgba(0,0,0,.18);border:1px solid var(--border);border-radius:6px");
  });

  it('still reads real data (existing calculators preserved)', () => {
    for (const s of ['collectSchedules', 'collectInvoices', 'collectPaymentLinks', 'collectTransactionHistory', 'collectVault', 'calcCashFlow', 'calcMonthlyOverview', 'calcAvailableToSpend']) {
      expect(hub).toContain('function ' + s);
    }
  });
});
