/**
 * x402 Phase 1.2.4 — Real pay() session guard tests.
 *
 * Replaces the previous placeholder (expect(true).toBe(true)).
 *
 * Tests here specifically verify the Phase 1.2.4 changes:
 *   - pay() success path: NO setBusy(false) when session is stale
 *   - pay() catch path:   session guard present (added in Phase 1.2.4)
 *
 * Uses real SA_X402 from index.html via new Function() + _setSettlementOverride
 * to bypass the SETTLEMENT_IMPLEMENTED=false gate without changing production flags.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const html     = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
const sa402Start = html.indexOf('var SA_X402 = (function()');
const sa402End   = html.indexOf('})();', sa402Start) + 5;
const sa402Src   = sa402Start > -1 ? html.slice(sa402Start, sa402End) : null;
if (!sa402Src) throw new Error('SA_X402 source not found in index.html');

function makeDoc(ids = []) {
  const els = {};
  ids.forEach(id => {
    els[id] = {
      style: { display: '' }, innerHTML: '', disabled: false, value: '',
      classList: { _s: new Set(), add(c){this._s.add(c);}, remove(c){this._s.delete(c);}, contains(c){return this._s.has(c);} },
    };
  });
  return {
    els,
    getElementById(id) { return els[id] || null; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    createElement() { return { style:{}, innerHTML:'', classList:{add(){},remove(){},contains(){return false;}}, appendChild(){} }; },
  };
}

function makeX402(overrides = {}) {
  return {
    getStatus:  vi.fn().mockResolvedValue({ ok: true, data: { user: { id: 'u-1' }, settlement: { available: false }, networks: {} } }),
    discover:   vi.fn().mockResolvedValue({ ok: false, status: 503, data: {} }),
    prepare:    vi.fn().mockResolvedValue({ ok: false, status: 503, data: {} }),
    pay:        vi.fn().mockResolvedValue({ ok: false, status: 503, data: {} }),
    _setUserId: vi.fn(),
    ...overrides,
  };
}

function makeIntent(id = 'i-1') {
  return { id, status: 'ready', walletAddress: '0xDeaD0000000000000000000000000000DeaDBeEf',
    payTo: '0xCafe000000000000000000000000000000000001',
    amountUsd: 1.0, amountAtomic: '1000000', network: 'Base', networkCaip: 'eip155:8453', scheme: 'exact' };
}

function makePrepare(intent) { return { ok: true, status: 200, data: { intent } }; }

function buildSA(doc, X402, toast = vi.fn()) {
  return new Function('_doc', '_X402', '_toast', `
    var document = _doc;
    var X402 = _X402;
    var toast = _toast;
    ${sa402Src}
    return SA_X402;
  `)(doc, X402, toast);
}

/* ══════════════════════════════════════════════════════════════════════════════
   Phase 1.2.4 fix verification: pay() success path — no stale setBusy(false)
══════════════════════════════════════════════════════════════════════════════ */
describe('Phase 1.2.4 — pay() success path session guard', () => {

  it('stale X402.pay() resolve does NOT set _step=done', async () => {
    let resolveStale;
    const stalePromise = new Promise(r => { resolveStale = r; });
    const X402 = makeX402({ pay: vi.fn(() => stalePromise) });
    const SA   = buildSA(makeDoc(['sa-x402-panel']), X402);

    SA._setSettlementOverride(true);
    SA._setPrepare(makePrepare(makeIntent('p124-succ-step')));
    SA._setStatus({ settlement: { available: false } });

    const payProm = SA.pay();
    expect(X402.pay).toHaveBeenCalledTimes(1); // reached X402.pay
    expect(SA._getStep()).toBe('settling');

    SA._resetSession(); // session A invalidated

    resolveStale({ ok: true, status: 200, data: { txHash: '0xSTALE' } });
    await payProm;

    expect(SA._getStep()).toBe('discover'); // must NOT be 'done'
  });

  it('stale success does NOT call renderDone (no done-state html)', async () => {
    let resolveStale;
    const stalePromise = new Promise(r => { resolveStale = r; });
    const panel = {
      style: { display: '' }, innerHTML: 'INITIAL',
      disabled: false, value: '',
      classList: { _s: new Set(), add(c){this._s.add(c);}, remove(c){this._s.delete(c);}, contains(c){return this._s.has(c);} },
    };
    const doc = makeDoc(['sa-x402-panel']);
    doc.els['sa-x402-panel'] = panel;

    const X402 = makeX402({ pay: vi.fn(() => stalePromise) });
    const SA   = buildSA(doc, X402);

    SA._setSettlementOverride(true);
    SA._setPrepare(makePrepare(makeIntent('p124-succ-html')));
    SA._setStatus({ settlement: { available: false } });

    const payProm = SA.pay();
    const htmlBeforeReset = panel.innerHTML;

    SA._resetSession();

    resolveStale({ ok: true, status: 200, data: { txHash: '0xSTALE_HTML' } });
    await payProm;

    // renderDone writes 'payment-done' or 'txHash' content — must not appear
    expect(panel.innerHTML).not.toContain('payment-done');
    expect(panel.innerHTML).not.toContain('0xSTALE_HTML');
  });

  it('session B can start discover immediately after stale success', async () => {
    let resolveStale;
    const stalePromise = new Promise(r => { resolveStale = r; });
    let discoverRan = false;
    const X402 = makeX402({
      pay:      vi.fn(() => stalePromise),
      discover: vi.fn(async () => { discoverRan = true; return { ok: false, status: 503, data: {} }; }),
    });
    const doc = makeDoc(['sa-x402-panel', 'sax402-url', 'sax402-disc-btn']);
    doc.els['sax402-url'] = { value: 'https://test.example.com' };
    const SA = buildSA(doc, X402);

    SA._setSettlementOverride(true);
    SA._setPrepare(makePrepare(makeIntent('p124-discover-after')));
    SA._setStatus({ settlement: { available: false } });

    const payProm = SA.pay();
    SA._resetSession();

    resolveStale({ ok: true, data: {} });
    await payProm;

    // _busy must be false — session B discover can run
    SA._setSettlementOverride(true);
    await SA.discover();
    expect(discoverRan).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
   Phase 1.2.4 fix verification: pay() catch path session guard
══════════════════════════════════════════════════════════════════════════════ */
describe('Phase 1.2.4 — pay() catch path session guard', () => {

  it('stale X402.pay() rejection does NOT set _step=done', async () => {
    let rejectStale;
    const stalePromise = new Promise((_, r) => { rejectStale = r; });
    const X402 = makeX402({ pay: vi.fn(() => stalePromise) });
    const SA   = buildSA(makeDoc(['sa-x402-panel']), X402);

    SA._setSettlementOverride(true);
    SA._setPrepare(makePrepare(makeIntent('p124-err-step')));
    SA._setStatus({ settlement: { available: false } });

    const payProm = SA.pay();
    expect(X402.pay).toHaveBeenCalledTimes(1);
    expect(SA._getStep()).toBe('settling');

    SA._resetSession();

    rejectStale(new Error('network timeout'));
    await payProm;

    expect(SA._getStep()).toBe('discover'); // must NOT be 'done'
  });

  it('stale rejection does NOT emit error toast for new session', async () => {
    let rejectStale;
    const stalePromise = new Promise((_, r) => { rejectStale = r; });
    const toast = vi.fn();
    const X402 = makeX402({ pay: vi.fn(() => stalePromise) });
    const SA   = buildSA(makeDoc(['sa-x402-panel']), X402, toast);

    SA._setSettlementOverride(true);
    SA._setPrepare(makePrepare(makeIntent('p124-err-toast')));
    SA._setStatus({ settlement: { available: false } });

    const payProm = SA.pay();
    SA._resetSession();
    const callsBefore = toast.mock.calls.length;

    rejectStale(new Error('stale failure'));
    await payProm;

    const newErrors = toast.mock.calls.slice(callsBefore).filter(c => c[1] === 'error');
    expect(newErrors.length).toBe(0); // no error toast for stale session
  });

  it('session B discover runs after stale rejection', async () => {
    let rejectStale;
    const stalePromise = new Promise((_, r) => { rejectStale = r; });
    let discoverRan = false;
    const X402 = makeX402({
      pay:      vi.fn(() => stalePromise),
      discover: vi.fn(async () => { discoverRan = true; return { ok: false, status: 503, data: {} }; }),
    });
    const doc = makeDoc(['sa-x402-panel', 'sax402-url', 'sax402-disc-btn']);
    doc.els['sax402-url'] = { value: 'https://test.example.com' };
    const SA = buildSA(doc, X402);

    SA._setSettlementOverride(true);
    SA._setPrepare(makePrepare(makeIntent('p124-err-busy')));
    SA._setStatus({ settlement: { available: false } });

    const payProm = SA.pay();
    SA._resetSession();

    rejectStale(new Error('timeout'));
    await payProm;

    SA._setSettlementOverride(true);
    await SA.discover();
    expect(discoverRan).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
   Settlement gate still works (not bypassed in production)
══════════════════════════════════════════════════════════════════════════════ */
describe('Phase 1.2.4 — settlement gate integrity', () => {

  it('without override, pay() never reaches X402.pay()', async () => {
    const X402 = makeX402({ pay: vi.fn() });
    const SA   = buildSA(makeDoc(['sa-x402-panel']), X402);
    SA._setPrepare(makePrepare(makeIntent('gate-no-override')));
    SA._setStatus({ settlement: { available: false } });
    await SA.pay();
    expect(X402.pay).not.toHaveBeenCalled();
  });

  it('_setSettlementOverride(null) re-closes the gate', async () => {
    const X402 = makeX402({ pay: vi.fn().mockResolvedValue({ ok: false, status: 503, data: {} }) });
    const SA   = buildSA(makeDoc(['sa-x402-panel']), X402);
    SA._setSettlementOverride(true);
    SA._setPrepare(makePrepare(makeIntent('gate-reclose-1')));
    SA._setStatus({ settlement: { available: false } });
    await SA.pay();
    expect(X402.pay).toHaveBeenCalledTimes(1);

    // Now close the gate
    SA._setSettlementOverride(null);
    SA._setPrepare(makePrepare(makeIntent('gate-reclose-2')));
    await SA.pay();
    expect(X402.pay).toHaveBeenCalledTimes(1); // NOT called again
  });
});
