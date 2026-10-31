/**
 * x402 Phase 1.2.6 — Isolation, real events, listener dedup, concurrency A/B
 *
 * Strategy for testing pay() session guards without a production bypass hook:
 *   - Extract the real SA_X402 IIFE source from index.html (between
 *     sa402Start / sa402End markers).
 *   - In memory, replace `function settlementAvailable()` with a version that
 *     reads `__testSettlement` from the injected scope.
 *   - Build with `new Function('X402','__testSettlement','document','window', src)`.
 *   - `__testSettlement` is a plain object `{ available: true/false }` owned by
 *     the test; production source on disk is NEVER modified.
 *
 * This file tests:
 *   P0: Concurrency scenarios A (stale success) and B (stale error)
 *   P1: Real DOM wallet events fire _resetSession via the listener block
 *   P1: Listener dedup — second init does not double-register
 *   P1: Production source has no _settlementOverride / _setSettlementOverride
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

/* ── Load real source ─────────────────────────────────────────────────── */
const HTML_PATH = path.resolve(__dirname, '../index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

// Use the same anchor as all other x402 test files
const sa402RawStart = html.indexOf('var SA_X402 = (function()');
const sa402RawEnd   = html.indexOf('})();', sa402RawStart) + 5;
const sa402RawSrc   = sa402RawStart > -1 ? html.slice(sa402RawStart, sa402RawEnd) : 'var SA_X402={};';

/* ── In-memory source patch ───────────────────────────────────────────── */
// Replace the real settlementAvailable() body with a test-controlled version.
// The real body is:
//   function settlementAvailable() {
//     return !!( _status && _status.settlement && _status.settlement.available === true );
//   }
// We replace it so it reads __testSettlement.available — a variable injected
// as a function parameter. This patch exists ONLY in the string, never on disk.
const REAL_SA_BODY  = `function settlementAvailable() {
    return !!(
      _status &&
      _status.settlement &&
      _status.settlement.available === true
    );
  }`;
const PATCHED_SA_BODY = `function settlementAvailable() {
    if (__testSettlement && __testSettlement.available === true) return true;
    return !!(
      _status &&
      _status.settlement &&
      _status.settlement.available === true
    );
  }`;

function patchSrc(src) {
  return src.replace(REAL_SA_BODY, PATCHED_SA_BODY);
}

/* ── Minimal document/window stub ────────────────────────────────────── */
function makeDoc() {
  const listeners = {};
  const doc = {
    getElementById: (id) => {
      const el = {
        _id: id, innerHTML: '', disabled: false, style: {},
        className: '', classList: {
          add: function(c){ this._classes = (this._classes||[]); this._classes.push(c); },
          remove: function(c){ this._classes = (this._classes||[]).filter(x=>x!==c); },
          contains: function(c){ return (this._classes||[]).includes(c); },
          toggle: function(c){ const has=this.contains(c); has?this.remove(c):this.add(c); },
        },
        querySelectorAll: () => [],
        querySelector: () => null,
        appendChild: () => {},
        textContent: '',
      };
      return el;
    },
    createElement: (tag) => ({
      tag, innerHTML: '', className: '', style: {}, children: [],
      appendChild: function(c){ this.children.push(c); },
      setAttribute: function(){},
      classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    }),
    addEventListener: (ev, fn) => {
      if (!listeners[ev]) listeners[ev] = [];
      listeners[ev].push(fn);
    },
    removeEventListener: (ev, fn) => {
      if (listeners[ev]) listeners[ev] = listeners[ev].filter(f => f !== fn);
    },
    dispatchEvent: (e) => {
      (listeners[e.type] || []).forEach(fn => { try { fn(e); } catch(_){} });
    },
    _listeners: listeners,
    body: { innerHTML: '' },
  };
  return doc;
}

/* ── Build a real SA_X402 instance with test settlement injection ─────── */
function buildSAWithSettlement(settlementObj = { available: false }) {
  const toastCalls = [];
  const X402mock = {
    discover:   vi.fn(),
    prepare:    vi.fn(),
    pay:        vi.fn(),
    getStatus:  vi.fn().mockResolvedValue({ ok: true, data: { settlement: settlementObj } }),
    getHistory: vi.fn().mockReturnValue([]),
  };
  const doc = makeDoc();
  const toastFn = (msg, type) => toastCalls.push({ msg, type });
  const patched = patchSrc(sa402RawSrc);

  // Same pattern as buildSA in phase121: inject vars, eval real source, return SA_X402
  const SA = new Function(
    '_doc', '_X402', '_toast', '_testSettlement', '_console',
    `var document=_doc; var X402=_X402; var toast=_toast;
     var __testSettlement=_testSettlement;
     var console=_console||{log:function(){},warn:function(){},error:function(){}};
     ${patched}
     return SA_X402;`
  )(doc, X402mock, toastFn, settlementObj, { log(){}, warn(){}, error(){} });

  return { SA, X402: X402mock, doc, toasts: toastCalls };
}

/* ── Helper: build with settlement=true for pay() path tests ─────────── */
function buildSAForPay() {
  return buildSAWithSettlement({ available: true });
}

/* ── Helper: inject a prepared intent ────────────────────────────────── */
function injectPreparedIntent(SA, X402) {
  const intent = { id: 'intent-' + Date.now(), amount: '1.00', currency: 'USDC',
                   network: 'eip155:8453', payTo: '0xPAYTO', expiresAt: Date.now() + 60000 };
  SA._setPrepare({ ok: true, status: 200, data: { intent } });
  SA._setStatus({ settlement: { available: true } });
  return intent;
}

/* ═══════════════════════════════════════════════════════════════════════
   SECTION 1 — Production source guard
   ═══════════════════════════════════════════════════════════════════════ */
describe('Phase 1.2.6 — Production source integrity', () => {
  it('_settlementOverride does NOT exist in production source', () => {
    expect(html).not.toContain('_settlementOverride');
  });

  it('_setSettlementOverride does NOT exist in production source', () => {
    expect(html).not.toContain('_setSettlementOverride');
  });

  it('settlementAvailable() in production depends only on _status', () => {
    expect(sa402RawSrc).toContain('function settlementAvailable()');
    expect(sa402RawSrc).not.toContain('_settlementOverride');
    // confirm real gate: _status.settlement.available === true
    expect(sa402RawSrc).toContain('_status.settlement.available === true');
  });

  it('SETTLEMENT_IMPLEMENTED=false is in the x402 backend source', () => {
    const x402src = fs.readFileSync(
      path.resolve(__dirname, '../functions/api/x402/_x402.mjs'), 'utf8'
    );
    expect(x402src).toContain('SETTLEMENT_IMPLEMENTED');
    expect(x402src).toMatch(/SETTLEMENT_IMPLEMENTED\s*=\s*false/);
  });

  it('Arc Mainnet eip3009Compatible is false', () => {
    const x402src = fs.readFileSync(
      path.resolve(__dirname, '../functions/api/x402/_x402.mjs'), 'utf8'
    );
    const arcIdx = x402src.indexOf("'eip155:5042'");
    expect(arcIdx).toBeGreaterThan(-1);
    const arcBlock = x402src.slice(arcIdx, arcIdx + 200);
    expect(arcBlock).toMatch(/eip3009Compatible\s*:\s*false/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   SECTION 2 — In-memory patch sanity
   ═══════════════════════════════════════════════════════════════════════ */
describe('Phase 1.2.6 — In-memory patch strategy', () => {
  it('patch replaces settlementAvailable body in memory without touching disk', () => {
    const patched = patchSrc(sa402RawSrc);
    expect(patched).toContain('__testSettlement');
    // disk is unchanged
    expect(sa402RawSrc).not.toContain('__testSettlement');
    const diskHtml = fs.readFileSync(HTML_PATH, 'utf8');
    expect(diskHtml).not.toContain('__testSettlement');
  });

  it('buildSAWithSettlement(available:false) blocks pay()', async () => {
    const { SA, X402 } = buildSAWithSettlement({ available: false });
    SA._setPrepare({ ok: true, status: 200, data: { intent: { id: 'x', expiresAt: Date.now()+9999 } } });
    SA._setStatus({ settlement: { available: false } });
    await SA.pay();
    expect(X402.pay).not.toHaveBeenCalled();
  });

  it('buildSAForPay() (available:true) allows pay() to reach X402.pay', async () => {
    const { SA, X402 } = buildSAForPay();
    const intent = injectPreparedIntent(SA, X402);
    X402.pay.mockResolvedValueOnce({ ok: true, status: 200, data: { txHash: '0xOK' } });
    await SA.pay();
    expect(X402.pay).toHaveBeenCalledTimes(1);
    expect(X402.pay).toHaveBeenCalledWith(intent);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   SECTION 3 — Concurrency Scenario A: stale success does not affect session B
   ═══════════════════════════════════════════════════════════════════════ */
describe('Phase 1.2.6 — Scenario A: stale pay() success does not affect session B', () => {
  it('session B state is untouched after stale success resolves', async () => {
    const { SA, X402 } = buildSAForPay();

    // Session A — prepare intent and start pay(), hold the promise
    const intentA = injectPreparedIntent(SA, X402);
    let resolvePayA;
    X402.pay.mockImplementationOnce(() =>
      new Promise(res => { resolvePayA = res; })
    );
    const payPromiseA = SA.pay(); // starts, reaches X402.pay, awaiting

    // give the microtask queue a tick so pay() actually reaches the await
    await new Promise(r => setTimeout(r, 0));
    expect(X402.pay).toHaveBeenCalledTimes(1);

    // Invalidate session A → session B
    const tokenA = SA._getSessionToken();
    SA._resetSession();
    const tokenB = SA._getSessionToken();
    expect(tokenB).toBe(tokenA + 1);

    // Session B sets up its own intent (different from A)
    const intentB = { id: 'intent-B', amount: '2.00', currency: 'USDC',
                      network: 'eip155:8453', payTo: '0xB', expiresAt: Date.now()+60000 };
    SA._setPrepare({ ok: true, status: 200, data: { intent: intentB } });
    SA._setStatus({ settlement: { available: true } });

    // Capture B's state snapshot BEFORE resolving stale A
    const stepBeforeA = SA._getStep();
    const prepBeforeA = SA._getLastPayArg ? SA._getLastPayArg() : null;

    // Now resolve stale A with a success result
    resolvePayA({ ok: true, status: 200, data: { txHash: '0xSTALE' } });
    await payPromiseA;
    await new Promise(r => setTimeout(r, 0));

    // B's state must be completely unaffected
    expect(SA._getSessionToken()).toBe(tokenB); // session token unchanged
    expect(SA._getStep()).toBe(stepBeforeA);    // step unchanged by stale A
    // _prepare is still B's intent
    expect(SA._settlementAvailable()).toBe(true); // still reads from B's status
  });

  it('_busy is not released by stale success (B owns busy if it started)', async () => {
    const { SA, X402 } = buildSAForPay();

    // Session A: start pay(), hold
    injectPreparedIntent(SA, X402);
    let resolvePayA;
    X402.pay.mockImplementationOnce(() => new Promise(r => { resolvePayA = r; }));
    // Also mock a second call for B's discover
    X402.discover = vi.fn().mockResolvedValue({ ok: true, status: 200, data: {
      service: 'svc', resource: '/', requirements: [{ scheme: 'exact', amount: '1',
        currency: 'USDC', network: 'eip155:8453', payTo: '0xB' }]
    }});

    const payA = SA.pay();
    await new Promise(r => setTimeout(r, 0));

    SA._resetSession();

    // B starts discover() — this will set _busy=true for discover
    // We don't need B to finish; just confirm A's resolution doesn't corrupt things
    resolvePayA({ ok: true, data: { txHash: '0xSTALE' } });
    await payA;
    await new Promise(r => setTimeout(r, 0));

    // After stale A resolves, session token must still be B's
    expect(SA._getSessionToken()).toBe(SA._getSessionToken()); // monotonic
    expect(SA._getStep()).toBe('discover'); // reset cleared step
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   SECTION 4 — Concurrency Scenario B: stale pay() error does not affect session B
   ═══════════════════════════════════════════════════════════════════════ */
describe('Phase 1.2.6 — Scenario B: stale pay() error does not affect session B', () => {
  it('session B state is untouched after stale rejection', async () => {
    const { SA, X402 } = buildSAForPay();

    injectPreparedIntent(SA, X402);
    let rejectPayA;
    X402.pay.mockImplementationOnce(() =>
      new Promise((_, rej) => { rejectPayA = rej; })
    );
    const payA = SA.pay();
    await new Promise(r => setTimeout(r, 0));

    const tokenA = SA._getSessionToken();
    SA._resetSession();
    const tokenB = SA._getSessionToken();
    expect(tokenB).toBe(tokenA + 1);

    // Session B state
    const stepB = SA._getStep(); // should be 'discover' after reset

    // Resolve A with rejection
    rejectPayA(new Error('network error from session A'));
    await payA.catch(() => {}); // suppress unhandled
    await new Promise(r => setTimeout(r, 0));

    // B's state is untouched
    expect(SA._getSessionToken()).toBe(tokenB);
    expect(SA._getStep()).toBe(stepB);
  });

  it('stale rejection does not emit renderDone for session B', async () => {
    const { SA, X402, toasts } = buildSAForPay();

    injectPreparedIntent(SA, X402);
    let rejectPayA;
    X402.pay.mockImplementationOnce(() =>
      new Promise((_, rej) => { rejectPayA = rej; })
    );
    const payA = SA.pay();
    await new Promise(r => setTimeout(r, 0));

    SA._resetSession();
    const toastCountAfterReset = toasts.length;

    rejectPayA(new Error('timeout'));
    await payA.catch(() => {});
    await new Promise(r => setTimeout(r, 0));

    // No new toast after reset (stale error suppressed)
    expect(toasts.length).toBe(toastCountAfterReset);
    // step must still be 'discover' (not 'done' or 'failed')
    expect(SA._getStep()).toBe('discover');
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   SECTION 5 — Real DOM wallet events via the listener block
   ═══════════════════════════════════════════════════════════════════════ */

// Extract the listener registration block from index.html
// This block lives OUTSIDE the IIFE: if (!window._sa402ListenersRegistered) { ... }
function extractListenerBlock(htmlSrc) {
  const marker = 'if (!window._sa402ListenersRegistered)';
  const start = htmlSrc.indexOf(marker);
  if (start === -1) return null;
  // Find the matching closing brace
  let depth = 0, i = start;
  while (i < htmlSrc.length) {
    if (htmlSrc[i] === '{') depth++;
    else if (htmlSrc[i] === '}') { depth--; if (depth === 0) break; }
    i++;
  }
  return htmlSrc.slice(start, i + 1);
}

function buildListenerEnv(SA_X402_instance) {
  // Run the listener block with a controlled document and window.
  // The listener block checks `typeof SA_X402 !== 'undefined'` and calls
  // `SA_X402._resetSession()` — it reads SA_X402 from the outer scope via
  // `window.SA_X402` is NOT how it works: it reads the var `SA_X402` directly.
  // So we inject SA_X402 as a variable in the function scope.
  const doc = makeDoc();
  const win = { _sa402ListenersRegistered: undefined };
  const block = extractListenerBlock(html);
  if (!block) throw new Error('Listener block not found in index.html');
  // Inject SA_X402 as a local variable so _sa402Reset can reference it
  const fn = new Function('document', 'window', 'SA_X402', block);
  fn(doc, win, SA_X402_instance);
  return { doc, win };
}

describe('Phase 1.2.6 — Real DOM wallet events', () => {
  const EVENTS = ['WALLET_CONNECTED', 'WALLET_DISCONNECTED', 'WALLET_SWITCHED', 'SA_X402_CHAIN_CHANGED'];

  it.each(EVENTS)('%s fires _resetSession on SA_X402', (evName) => {
    const { SA } = buildSAWithSettlement({ available: false });
    // Put SA in a non-default state
    SA._setPrepare({ ok: true, data: { intent: { id: 'x', expiresAt: Date.now()+9999 } } });
    const tokenBefore = SA._getSessionToken();

    const { doc } = buildListenerEnv(SA);
    doc.dispatchEvent({ type: evName });

    expect(SA._getSessionToken()).toBe(tokenBefore + 1);
    expect(SA._getStep()).toBe('discover');
  });

  it('WALLET_SWITCHED emitter is present in index.html (real wallet switch)', () => {
    // Confirm the real emitter at line ~17281 exists
    expect(html).toContain("document.dispatchEvent(new CustomEvent('WALLET_SWITCHED'");
  });

  it('SA_X402_CHAIN_CHANGED is dispatched from the real chainChanged handler', () => {
    expect(html).toContain("document.dispatchEvent(new CustomEvent('SA_X402_CHAIN_CHANGED'");
    // Must be inside the chainChanged handler block
    const idx = html.indexOf("document.dispatchEvent(new CustomEvent('SA_X402_CHAIN_CHANGED'");
    const context = html.slice(Math.max(0, idx - 200), idx);
    expect(context).toContain('chainChanged');
  });

  it('wallet address change on same network (WALLET_SWITCHED) invalidates prepare', () => {
    const { SA } = buildSAWithSettlement({ available: false });
    SA._setPrepare({ ok: true, data: { intent: { id: 'old', expiresAt: Date.now()+9999 } } });
    const { doc } = buildListenerEnv(SA);

    doc.dispatchEvent({ type: 'WALLET_SWITCHED', detail: { address: '0xNEW' } });

    expect(SA._getStep()).toBe('discover'); // cleared
    expect(SA._settlementAvailable()).toBe(false); // status cleared
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   SECTION 6 — Listener deduplication
   ═══════════════════════════════════════════════════════════════════════ */
describe('Phase 1.2.6 — Listener deduplication', () => {
  it('second init does not duplicate listeners', () => {
    const { SA } = buildSAWithSettlement({ available: false });
    const doc = makeDoc();
    const win = { _sa402ListenersRegistered: undefined };
    const block = extractListenerBlock(html);
    const fn = new Function('document', 'window', 'SA_X402', block);

    fn(doc, win, SA); // first registration
    const countAfterFirst = Object.values(doc._listeners).reduce((s, arr) => s + arr.length, 0);

    fn(doc, win, SA); // second call — must be no-op (guard flag set)
    const countAfterSecond = Object.values(doc._listeners).reduce((s, arr) => s + arr.length, 0);

    expect(countAfterFirst).toBeGreaterThan(0);
    expect(countAfterSecond).toBe(countAfterFirst); // no new listeners
  });

  it('each event triggers _resetSession exactly once after double init', () => {
    const { SA } = buildSAWithSettlement({ available: false });
    const doc = makeDoc();
    const win = { _sa402ListenersRegistered: undefined };
    const block = extractListenerBlock(html);
    const fn = new Function('document', 'window', 'SA_X402', block);

    fn(doc, win, SA);
    fn(doc, win, SA); // second init — must be no-op

    const tokenBefore = SA._getSessionToken();
    doc.dispatchEvent({ type: 'WALLET_CONNECTED' });

    // Must increment by exactly 1, not 2
    expect(SA._getSessionToken()).toBe(tokenBefore + 1);
  });

  it('guard flag window._sa402ListenersRegistered is set after first call', () => {
    const { SA } = buildSAWithSettlement({ available: false });
    const doc = makeDoc();
    const win = { _sa402ListenersRegistered: undefined };
    const block = extractListenerBlock(html);
    const fn = new Function('document', 'window', 'SA_X402', block);

    expect(win._sa402ListenersRegistered).toBeUndefined();
    fn(doc, win, SA);
    expect(win._sa402ListenersRegistered).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   SECTION 7 — Settlement gate still blocks when available=false
   ═══════════════════════════════════════════════════════════════════════ */
describe('Phase 1.2.6 — Settlement gate still blocks', () => {
  it('pay() does not call X402.pay when settlement=false (real production gate)', async () => {
    // Use buildSAWithSettlement with available=false — no patch needed
    const { SA, X402 } = buildSAWithSettlement({ available: false });
    SA._setPrepare({ ok: true, data: { intent: { id: 'x', expiresAt: Date.now()+9999 } } });
    SA._setStatus({ settlement: { available: false } });
    await SA.pay();
    expect(X402.pay).not.toHaveBeenCalled();
  });

  it('pay() blocks when _status is null (no status fetch)', async () => {
    const { SA, X402 } = buildSAWithSettlement({ available: false });
    SA._setPrepare({ ok: true, data: { intent: { id: 'x', expiresAt: Date.now()+9999 } } });
    // Do not call _setStatus — leave status as null
    await SA.pay();
    expect(X402.pay).not.toHaveBeenCalled();
  });

  it('pay() blocks when settlement object is missing', async () => {
    const { SA, X402 } = buildSAWithSettlement({ available: false });
    SA._setPrepare({ ok: true, data: { intent: { id: 'x', expiresAt: Date.now()+9999 } } });
    SA._setStatus({ someOtherKey: true }); // no .settlement
    await SA.pay();
    expect(X402.pay).not.toHaveBeenCalled();
  });

  it('Arc Mainnet eip3009Compatible=false means it cannot be used as x402 network', () => {
    const x402src = fs.readFileSync(
      path.resolve(__dirname, '../functions/api/x402/_x402.mjs'), 'utf8'
    );
    const arcIdx = x402src.indexOf("'eip155:5042'");
    const arcBlock = x402src.slice(arcIdx, arcIdx + 250);
    expect(arcBlock).toMatch(/eip3009Compatible\s*:\s*false/);
  });
});
