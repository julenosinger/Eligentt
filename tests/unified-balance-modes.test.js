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

  it('enterUnifiedBalanceMode opens the operation drawer (real flows, never page navigation)', () => {
    // Extract the body of enterUnifiedBalanceMode up to exitUnifiedBalanceMode
    const fn = html.slice(html.indexOf('function enterUnifiedBalanceMode'), html.indexOf('function exitUnifiedBalanceMode'));
    // Quick Actions open the drawer via UBScreen (real handlers), never showPage.
    expect(fn).toContain('UBScreen');
    expect(fn).not.toContain('showPage');
    // Circle Agent stays available as an explicit option (not the mandatory entry).
    expect(fn).toContain('_ubOpenAgentPanel');
    // Fund source defaults to the real EVM flows.
    expect(html).toContain("let _ubSourceWallet = 'evm'");
  });

  it('_ubOpenAgentPanel and _ubAgentPreview are defined (Circle Agent wiring)', () => {
    expect(html).toContain('function _ubOpenAgentPanel');
    expect(html).toContain('function _ubAgentPreview');
    expect(html).toContain('function _ubPanelApprove');
  });

  it('_ubAgentPreview calls AgentCapabilityRouter.createSurface (not direct execution)', () => {
    const fn = html.slice(html.indexOf('function _ubAgentPreview'), html.indexOf('async function _ubPanelApprove'));
    expect(fn).toContain('AgentCapabilityRouter.createSurface');
    expect(fn).not.toContain('saExecuteSend');
    expect(fn).not.toContain('executeSwap');
    expect(fn).not.toContain('xcExecuteSend');
  });

  it('_ubPanelApprove uses __autExecuteIntent (same path as Autonoma chat)', () => {
    const fn = html.slice(html.indexOf('async function _ubPanelApprove'), html.indexOf('function _ubDirectExec'));
    expect(fn).toContain('__autExecuteIntent');
    expect(fn).toContain('UBOperationBus');
  });

  it('"move" mode is normalised to BRIDGE intent in _ubAgentPreview', () => {
    const fn = html.slice(html.indexOf('function _ubAgentPreview'), html.indexOf('async function _ubPanelApprove'));
    expect(fn).toContain("intent = 'BRIDGE'");
  });

  it('UBScreen execution still delegates to the real handlers (no duplicated engines)', () => {
    // UBScreen still references the real handlers — they are NOT removed.
    // They are still used by UBAction (asset-row send/swap/bridge buttons).
    expect(html).toContain('saExecuteSend()');
    expect(html).toContain('executeSwap()');
    expect(html).toContain('xcExecuteSend()');
  });

  it('header [Send][Swap][Move] use the unified mode entry point (not UBScreen directly, not showPage)', () => {
    // The three action buttons live near ub2-qa-btn in the HTML (ub-hero-card is CSS-only).
    // Slice around the ub2-qa-btn send button and verify the onclick targets.
    const qaStart = html.indexOf('ub2-qa-btn send');
    const qaSection = qaStart >= 0 ? html.slice(qaStart - 100, qaStart + 600) : '';
    expect(qaSection).toContain("enterUnifiedBalanceMode('send')");
    expect(qaSection).toContain("enterUnifiedBalanceMode('swap')");
    expect(qaSection).toContain("enterUnifiedBalanceMode('move')");
    expect(qaSection).not.toContain('UBScreen.openSend()');
    // Verify globally that these buttons never use showPage
    const sendBtn = html.match(/class="ub2-qa-btn send"[^>]*>/g) || [];
    sendBtn.forEach(b => { expect(b).not.toContain('showPage'); });
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

  it('op panel closes reset to live (Back to Live → exitUnifiedBalanceMode)', () => {
    expect(html).toContain('exitUnifiedBalanceMode()');
    // Closing the panel via the X button calls exitUnifiedBalanceMode
    expect(html).toContain('exitUnifiedBalanceMode();if');
    // _cleanupAll resets liveMode (UBScreen internal cleanup path)
    const cleanup = html.slice(html.indexOf('function _cleanupAll'), html.indexOf('function hideOperation'));
    expect(cleanup).toContain("UB.liveMode = 'live'");
  });

  it('__autExecuteIntent is exposed in autonomaInit (eager exposure for UB panel)', () => {
    const initFn = html.slice(html.indexOf('window.autonomaInit = function'), html.indexOf('window.autonomaNewChat = function'));
    expect(initFn).toContain('window.__autExecuteIntent = _executeIntent');
  });

  it('ubInit eagerly exposes __autExecuteIntent via autonomaInit', () => {
    const initFn = html.slice(html.indexOf('function ubInit()'), html.indexOf('// Auto-refresh when wallet connects'));
    expect(initFn).toContain('window.__autExecuteIntent');
    expect(initFn).toContain('autonomaInit');
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
