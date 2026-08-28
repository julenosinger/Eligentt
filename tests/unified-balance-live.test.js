/**
 * Unified Balance Live — Global Operations Center tests.
 * ═══════════════════════════════════════════════════════════════════════
 * Covers the operation bus (dedup, bounded history, single subscription) and
 * the Live controller (mode switching, real-time stream). Pure module eval —
 * no DOM beyond a tiny mock.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

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

describe('UBOperationBus — event layer', () => {
  it('publish stores + exposes history (latest first)', () => {
    const b = makeBus();
    b.publish('start', { id: 'op1', type: 'send', amount: 100 });
    b.publish('confirmed', { id: 'op2', type: 'swap', amount: 50 });
    expect(b.history().length).toBe(2);
    expect(b.history()[0].id).toBe('op2');
  });

  it('same operation.id is UPDATED, never duplicated', () => {
    const b = makeBus();
    b.publish('start', { id: 'opX', type: 'batch' });
    b.publish('pending', { id: 'opX', type: 'batch' });
    b.publish('confirmed', { id: 'opX', type: 'batch', txHash: '0xabc' });
    expect(b.history().length).toBe(1);
    expect(b.history()[0].status).toBe('confirmed');
    expect(b.history()[0].txHash).toBe('0xabc');
  });

  it('history is bounded', () => {
    const b = makeBus();
    for (let i = 0; i < 150; i++) b.publish('update', { id: 'op' + i });
    expect(b.history().length).toBeLessThanOrEqual(100);
    expect(b.history()[0].id).toBe('op149');
  });

  it('on() fires on publish (real-time), single callback', () => {
    const b = makeBus();
    let calls = 0;
    let lastStatus = null;
    b.on((op, status) => { calls++; lastStatus = status; });
    b.publish('confirmed', { id: 'r1', type: 'bridge' });
    expect(calls).toBe(1);
    expect(lastStatus).toBe('confirmed');
  });

  it('track() lifecycle → start/pending/confirmed/complete', () => {
    const b = makeBus();
    const t = b.track({ id: 'trk1', type: 'swap', amount: 100, asset: 'USDC' });
    t.start();
    t.pending();
    t.confirmed({ txHash: '0xdef' });
    t.complete();
    expect(b.history().length).toBe(1);
    expect(b.history()[0].status).toBe('complete');
    expect(b.history()[0].txHash).toBe('0xdef');
  });

  it('count() reflects registered listeners', () => {
    const b = makeBus();
    expect(b.count()).toBe(0);
    const sub = b.on(() => {});
    expect(b.count()).toBe(1);
    sub.off();
    expect(b.count()).toBe(0);
  });
});

describe('UBLive — Live Mode + Action Modes', () => {
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

  it('starts in mode=live', () => {
    expect(live.getMode()).toBe('live');
  });

  it('Send muda para send', () => { expect(live.setMode('send')).toBe('send'); expect(live.getMode()).toBe('send'); });
  it('Swap muda para swap', () => { expect(live.setMode('swap')).toBe('swap'); });
  it('Move muda para move', () => { expect(live.setMode('move')).toBe('move'); });
  it('Batch muda para batch', () => { expect(live.setMode('batch')).toBe('batch'); });
  it('Bridge muda para bridge', () => { expect(live.setMode('bridge')).toBe('bridge'); });

  it('invalid mode falls back to live', () => {
    live.setMode('banana');
    expect(live.getMode()).toBe('live');
  });

  it('enterAction + exitToLive', () => {
    live.enterAction('send');
    expect(live.getMode()).toBe('send');
    live.exitToLive();
    expect(live.getMode()).toBe('live');
  });

  it('init subscribes to the bus exactly ONCE (no duplicate listeners)', () => {
    live.init();
    expect(bus.count()).toBe(1);
    live.init(); // idempotent
    expect(bus.count()).toBe(1);
  });

  it('new operations appear in the stream in real time', () => {
    live.init();
    bus.publish('confirmed', { id: 'live1', type: 'send', amount: 250, asset: 'USDC', destination: '0x82A7', txHash: '0xabc123' });
    expect(doc.els['ub-live-feed'].innerHTML).toContain('SEND');
  });

  it('same operation.id updates the stream without duplicating', () => {
    live.init();
    bus.publish('start', { id: 'dup1', type: 'swap', amount: 100 });
    bus.publish('confirmed', { id: 'dup1', type: 'swap', amount: 100, txHash: '0x999' });
    expect(bus.history().length).toBe(1);
    expect(doc.els['ub-live-feed'].innerHTML).toContain('confirmed');
  });

  it('operation:failed status updates the stream', () => {
    live.init();
    bus.publish('failed', { id: 'fail1', type: 'bridge', amount: 500 });
    expect(doc.els['ub-live-feed'].innerHTML).toContain('failed');
  });

  it('financial indicators render (compact, from existing calculators)', () => {
    live.init();
    live.refresh();
    const fin = doc.els['ub-financial-center'].innerHTML;
    expect(fin).toContain('Balance');
    expect(fin).toContain('Net Flow');
    expect(fin).toContain('Tx Count');
  });
});
