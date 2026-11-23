/**
 * send-bank-tab.test.js
 * ═══════════════════════════════════════════════════════════════════════════
 * "Send to Bank" (CPN) as the third Send Assets mode tab.
 *
 * The CPN engine is NOT re-implemented: the tab is a navigation layer over the
 * existing saToggleCPN / saFetchCPNQuotes / saExecuteCPNPayout. These tests pin:
 *   - markup: three tabs in order, CPN button gone from Transfer Details
 *   - navigation behaviour (run against the real extracted controller code)
 *   - no financial function is ever invoked by navigation
 *   - in-flight guards + idempotency-key preservation across tab switches
 *   - the original saSetModeTab and the CPN engine are byte-for-byte intact
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(path.resolve(__dirname, '..'), 'index.html'), 'utf8');

const START = '//  SEND ASSETS — "Send to Bank" (CPN) mode tab';
const END = '//  SA_X402 — Inline x402 panel controller for Send Assets.';
const ctrlStart = html.indexOf(START);
const ctrlEnd = html.indexOf(END);
const controllerSrc = html.slice(ctrlStart, ctrlEnd);

describe('markup — three tabs, CPN button moved out of Transfer Details', () => {
  const tabsBlock = html.slice(html.indexOf('id="sa-mode-tabs"'), html.indexOf('id="sa-x402-panel"'));

  it('renders Single & Batch Send, x402 Payments, Send to Bank in that order', () => {
    const iSend = tabsBlock.indexOf('id="sa-mtab-send"');
    const iX402 = tabsBlock.indexOf('id="sa-mtab-x402"');
    const iBank = tabsBlock.indexOf('id="sa-mtab-bank"');
    expect(iSend).toBeGreaterThan(-1);
    expect(iX402).toBeGreaterThan(iSend);
    expect(iBank).toBeGreaterThan(iX402);
    expect(tabsBlock).toContain('Send to Bank');
    expect(tabsBlock).toContain('ti-building-bank');
  });

  it('Single & Batch Send stays the default active tab', () => {
    expect(html).toContain('class="sa-mode-tab sa-mode-active" id="sa-mtab-send"');
    expect(html).not.toMatch(/class="sa-mode-tab[^"]*sa-mode-active[^"]*" id="sa-mtab-(x402|bank)"/);
    expect(html).toContain("var _saModeCur = 'send';");
  });

  it('the CPN toggle button is gone from the Transfer Details header', () => {
    const card = html.slice(html.indexOf('<!-- Transfer Form -->'), html.indexOf('id="sa-cpn-notice"'));
    expect(card).toContain('Transfer Details');
    expect(card).not.toContain('sa-cpn-toggle');
    expect(card).not.toContain('Send to Bank');
    expect(card).not.toContain('saToggleCPN');
  });

  it('keeps every CPN form element (reused, not duplicated)', () => {
    ['sa-cpn-form', 'sa-cpn-notice', 'sa-cpn-currency', 'sa-cpn-bene-name', 'sa-cpn-bank-name', 'sa-cpn-account',
      'sa-cpn-country', 'sa-cpn-routing', 'sa-cpn-sender-name', 'sa-cpn-sender-country', 'sa-cpn-quote-btn',
      'sa-cpn-quote-preview', 'sa-cpn-quotes-list', 'sa-rt-cpn-rows'].forEach((id) => {
      expect(html.split('id="' + id + '"').length - 1).toBe(1);
    });
  });

  it('no new page / sidebar entry was added', () => {
    expect(html).not.toContain('id="page-bank"');
    expect(html).not.toContain('id="nav-bank"');
  });

  it('crypto-only chrome is hidden only under the scoped bank-mode class', () => {
    expect(html).toContain('#sa-panel-send.sa-bank-mode #sa-origin-bar');
    expect(html).toContain('#sa-panel-send.sa-bank-mode .sa-quick-actions-card');
  });
});

describe('untouched code (financial + x402 safety)', () => {
  it('original saSetModeTab is intact (x402 init, panel restore, double-toggle guard)', () => {
    const m = html.match(/function saSetModeTab\(mode,\s*btn\)\s*\{[\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    expect(m[0]).toContain('SA_X402.init()');
    expect(m[0]).toContain("sendPanel.style.display = ''");
    expect(m[0]).toContain("x402Panel.style.display = 'none'");
    expect(m[0]).not.toMatch(/saExecute|saToggleCPN|CPN/);
  });

  it('saToggleCPN still resets the idempotency key on cancel and has no early return', () => {
    const fn = html.slice(html.indexOf('function saToggleCPN()'), html.indexOf('function saToggleCPN()') + 2600);
    expect(fn).toContain('_saCPNMode = !_saCPNMode');
    expect(fn).toContain('_saCPNIdempotencyKey = null');
    expect(fn).not.toContain('SA_CPN_ENABLED');
  });

  it('the controller never calls a financial entry point', () => {
    const code = controllerSrc.replace(/\/\/.*$/gm, '');
    // It may only reference the three names to OBSERVE them (map keys) and call saToggleCPN.
    const calls = code.match(/\b(saExecuteSend|saExecGateway|saExecuteCPNPayout|saFetchCPNQuotes|saDispatchSend|fetch)\s*\(/g);
    expect(calls).toBeNull();
    expect(code).not.toMatch(/X402\.pay|\/api\//);
  });

  it('controller is registered after the CPN + Gateway dispatch patches', () => {
    expect(ctrlStart).toBeGreaterThan(html.indexOf('saDispatchSend = function'));
    expect(ctrlStart).toBeGreaterThan(html.indexOf('function saExecuteCPNPayout'));
  });
});

// ── Behavioural tests against the REAL controller source ───────────────────
function makeEnv() {
  const log = [];
  const classes = { 'sa-mtab-send': new Set(['sa-mode-active']), 'sa-mtab-x402': new Set(), 'sa-mtab-bank': new Set(), 'sa-panel-send': new Set() };
  const mk = (id) => ({ id, classList: {
    add: (c) => classes[id].add(c), remove: (c) => classes[id].delete(c), contains: (c) => classes[id].has(c) } });
  const els = Object.fromEntries(Object.keys(classes).map((id) => [id, mk(id)]));
  const ctx = {
    log, classes, toasts: [], window: null,
    document: {
      getElementById: (id) => els[id] || null,
      querySelectorAll: () => ['sa-mtab-send', 'sa-mtab-x402', 'sa-mtab-bank'].map((id) => els[id]),
    },
    toast: (m, k) => ctx.toasts.push([m, k]),
    Promise, Math,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  // Stand-ins for the globals the real controller layers on top of.
  vm.runInContext(`
    var _saCPNMode = false, _saCPNQuotes = [], _saCPNSelectedQuote = null,
        _saCPNIdempotencyKey = null, _saCPNPaymentId = null, _saCPNExpectedRecipient = null;
    var routeUpdates = 0, cpnPayouts = 0, sends = 0, gwSends = 0;
    function saUpdateRoute() { routeUpdates++; }
    // Mirrors saToggleCPN's state effects (exit path resets the in-flight pins).
    function saToggleCPN() {
      _saCPNMode = !_saCPNMode;
      if (!_saCPNMode) { _saCPNQuotes = []; _saCPNSelectedQuote = null; _saCPNIdempotencyKey = null; _saCPNPaymentId = null; _saCPNExpectedRecipient = null; }
      log.push('toggle:' + (_saCPNMode ? 'on' : 'off'));
      saUpdateRoute();
    }
    var resolvers = [];
    function saExecuteSend() { sends++; return new Promise(function(r){ resolvers.push(r); }); }
    function saExecGateway() { gwSends++; return new Promise(function(r){ resolvers.push(r); }); }
    function saExecuteCPNPayout() { cpnPayouts++; return new Promise(function(r){ resolvers.push(r); }); }
    function saSetModeTab(mode, btn) { log.push('base:' + mode); var t = btn || document.getElementById(mode==='x402'?'sa-mtab-x402':'sa-mtab-send');
      ['sa-mtab-send','sa-mtab-x402','sa-mtab-bank'].forEach(function(i){ document.getElementById(i).classList.remove('sa-mode-active'); }); t.classList.add('sa-mode-active'); }
  `, ctx);
  vm.runInContext(controllerSrc, ctx);
  const get = (n) => vm.runInContext(n, ctx);
  return { ctx, get, run: (c) => vm.runInContext(c, ctx), active: () => Object.keys(classes).filter((k) => k.startsWith('sa-mtab') && classes[k].has('sa-mode-active')) };
}

describe('navigation behaviour', () => {
  let e;
  beforeEach(() => { e = makeEnv(); });

  it('opening Send to Bank turns CPN mode on, marks only the bank tab active and shows the bank layout', () => {
    e.run("saSetModeTab('bank', document.getElementById('sa-mtab-bank'))");
    expect(e.get('_saCPNMode')).toBe(true);
    expect(e.active()).toEqual(['sa-mtab-bank']);
    expect(e.ctx.classes['sa-panel-send'].has('sa-bank-mode')).toBe(true);
    expect(e.get('_saModeCur')).toBe('bank');
  });

  it('leaving to Single & Batch Send turns CPN mode off so Send Asset cannot route to CPN', () => {
    e.run("saSetModeTab('bank')");
    e.run("saSetModeTab('send', document.getElementById('sa-mtab-send'))");
    expect(e.get('_saCPNMode')).toBe(false);
    expect(e.active()).toEqual(['sa-mtab-send']);
    expect(e.ctx.classes['sa-panel-send'].has('sa-bank-mode')).toBe(false);
  });

  it('x402 -> bank -> x402 leaves CPN off and uses the original x402 switch', () => {
    e.run("saSetModeTab('x402', document.getElementById('sa-mtab-x402'))");
    e.run("saSetModeTab('bank')");
    expect(e.get('_saCPNMode')).toBe(true);
    e.run("saSetModeTab('x402', document.getElementById('sa-mtab-x402'))");
    expect(e.get('_saCPNMode')).toBe(false);
    expect(e.ctx.log.filter((l) => l === 'base:x402').length).toBe(2);
    expect(e.active()).toEqual(['sa-mtab-x402']);
  });

  it('switching many times never leaves CPN mode out of sync with the active tab and never fires a financial call', () => {
    const seq = ['bank', 'send', 'bank', 'x402', 'bank', 'bank', 'send', 'x402', 'send', 'bank'];
    seq.forEach((m) => {
      e.run(`saSetModeTab('${m}')`);
      expect(e.get('_saCPNMode')).toBe(m === 'bank');
    });
    expect(e.get('cpnPayouts')).toBe(0);
    expect(e.get('sends')).toBe(0);
    expect(e.get('gwSends')).toBe(0);
    expect(e.ctx.toasts.length).toBe(0);
  });

  it('re-clicking the bank tab does not toggle CPN again', () => {
    e.run("saSetModeTab('bank')");
    e.run("saSetModeTab('bank')");
    expect(e.ctx.log.filter((l) => l.startsWith('toggle:'))).toEqual(['toggle:on']);
  });

  it('unknown mode falls back to Single & Batch Send', () => {
    e.run("saSetModeTab('bank')");
    e.run("saSetModeTab('nope')");
    expect(e.get('_saModeCur')).toBe('send');
    expect(e.get('_saCPNMode')).toBe(false);
  });
});

describe('state isolation and in-flight safety', () => {
  let e;
  beforeEach(() => { e = makeEnv(); });

  it('an unfinished payout keeps its idempotency key / payment pin across tab switches', () => {
    e.run("saSetModeTab('bank')");
    e.run("_saCPNQuotes=[{id:'q1'}]; _saCPNSelectedQuote={id:'q1'}; _saCPNIdempotencyKey='idem-1'; _saCPNPaymentId='pay-1'; _saCPNExpectedRecipient='0xabc';");
    e.run("saSetModeTab('send')");
    // While away, nothing from the bank flow is live in the crypto tab.
    expect(e.get('_saCPNMode')).toBe(false);
    expect(e.get('_saCPNIdempotencyKey')).toBeNull();
    e.run("saSetModeTab('bank')");
    expect(e.get('_saCPNIdempotencyKey')).toBe('idem-1');
    expect(e.get('_saCPNPaymentId')).toBe('pay-1');
    expect(e.get('_saCPNExpectedRecipient')).toBe('0xabc');
    expect(e.get('_saCPNSelectedQuote').id).toBe('q1');
    expect(e.get('_saCPNQuotes').length).toBe(1);
  });

  it('a pristine bank tab leaves nothing to restore (no state invented)', () => {
    e.run("saSetModeTab('bank')");
    e.run("saSetModeTab('send')");
    expect(e.get('_saBankStash')).toBeNull();
    e.run("saSetModeTab('bank')");
    expect(e.get('_saCPNIdempotencyKey')).toBeNull();
  });

  it('cannot leave Send to Bank while a CPN payout is in flight, and resumes after it settles', async () => {
    e.run("saSetModeTab('bank')");
    e.run("saExecuteCPNPayout()");
    e.run("saSetModeTab('send')");
    expect(e.get('_saCPNMode')).toBe(true);
    expect(e.get('_saModeCur')).toBe('bank');
    expect(e.ctx.toasts.length).toBe(1);
    e.run('resolvers.shift()()');
    await Promise.resolve(); await Promise.resolve();
    e.run("saSetModeTab('send')");
    expect(e.get('_saCPNMode')).toBe(false);
    expect(e.get('_saModeCur')).toBe('send');
  });

  it('releases the in-flight lock when the payout rejects', async () => {
    e.run("saSetModeTab('bank')");
    e.run("saExecuteCPNPayout = (function(orig){ return function(){ return Promise.reject(new Error('x')); }; })();");
    // The tracking wrapper was installed over the original; install a rejecting engine and re-track.
    e.run(controllerSrc);
    const p = e.run("var pr = saExecuteCPNPayout(); pr");
    await expect(p).rejects.toThrow('x');
    await Promise.resolve(); await Promise.resolve();
    expect(e.get('_saBusy.cpn')).toBe(0);
  });

  it('cannot open Send to Bank while a crypto or Gateway send is in flight', () => {
    e.run('saExecuteSend()');
    e.run("saSetModeTab('bank')");
    expect(e.get('_saCPNMode')).toBe(false);
    expect(e.get('_saModeCur')).toBe('send');
    expect(e.ctx.toasts.length).toBe(1);
    e.run('resolvers.length = 0');
  });

  it('tracking returns the original promise untouched (same result for callers)', async () => {
    const p = e.run('saExecuteSend()');
    e.run('resolvers.shift()("receipt")');
    await expect(p).resolves.toBe('receipt');
  });

  it('crypto/x402 tab switches are never blocked by a running CPN-unrelated send', () => {
    e.run('saExecuteSend()');
    e.run("saSetModeTab('x402')");
    expect(e.get('_saModeCur')).toBe('x402');
    e.run("saSetModeTab('send')");
    expect(e.get('_saModeCur')).toBe('send');
    expect(e.ctx.toasts.length).toBe(0);
  });
});
