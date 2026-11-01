/**
 * Unit tests for Tax country rule modules.
 * Tests use known values with deterministic expected outputs.
 * No real RPC, no real wallet, no external deps.
 */
import { describe, it, expect } from 'vitest';

// Import the utils module directly
import {
  calcBR,
  calcPT,
  calcUS,
  calcDE,
  calcGB,
  calcCountry,
  calcFee,
  TAX_FEE,
  classifyOp,
} from '../functions/api/tax/_tax-utils.mjs';

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function makeEvents(raw) {
  return raw.map(r => ({
    type:    r.type,
    assetId: r.asset || 'USDC',
    qty:     r.qty,
    price:   r.price,
    ts:      r.ts || Date.now(),
    fees:    r.fees || 0,
    ...r,
  }));
}

/* ── TAX_FEE config ──────────────────────────────────────────────────────── */
describe('TAX_FEE config', () => {
  it('base fee is 20 USDC', () => expect(TAX_FEE.base).toBe(20));
  it('volume fee is 4 USDC per 500 ops over first 500', () => expect(TAX_FEE.volumePer500).toBe(4));
  it('extra network fee is 3 USDC', () => expect(TAX_FEE.perExtraNet).toBe(3));
  it('complexity fee is 8 USDC', () => expect(TAX_FEE.complexity).toBe(8));
  it('quote expiry is 15 min', () => expect(TAX_FEE.quoteExpiryMs).toBe(15 * 60 * 1000));
});

/* ── calcFee ─────────────────────────────────────────────────────────────── */
describe('calcFee', () => {
  it('base case: 1 net, 0 ops, no defi → 20 USDC', () => {
    expect(calcFee({ totalOps: 0, numNets: 1, hasDefi: false })).toBe(20);
  });
  it('2 nets → 20 + 3 = 23 USDC', () => {
    expect(calcFee({ totalOps: 0, numNets: 2, hasDefi: false })).toBe(23);
  });
  it('3 nets + defi → 20 + 6 + 8 = 34 USDC', () => {
    expect(calcFee({ totalOps: 0, numNets: 3, hasDefi: true })).toBe(34);
  });
  it('1001 ops: ceil((1001-500)/500)=2 blocks * 4 = 8 → total 28 USDC', () => {
    // ceil(501/500) = 2 → 2*4 = 8 volume fee
    expect(calcFee({ totalOps: 1001, numNets: 1, hasDefi: false })).toBe(28);
  });
  it('1000 ops: ceil(500/500)=1 block * 4 = 4 → total 24 USDC', () => {
    // ceil(500/500) = 1 → 1*4 = 4 volume fee
    expect(calcFee({ totalOps: 1000, numNets: 1, hasDefi: false })).toBe(24);
  });
  it('1500 ops: ceil(1000/500)=2 blocks → 20 + 8 = 28 USDC', () => {
    expect(calcFee({ totalOps: 1500, numNets: 1, hasDefi: false })).toBe(28);
  });
  it('500 ops (on boundary, 0 extra) → 20 USDC', () => {
    expect(calcFee({ totalOps: 500, numNets: 1, hasDefi: false })).toBe(20);
  });
  it('full: 3 nets, 1001 ops, defi → 20 + 8(vol) + 6(nets) + 8(defi) = 42 USDC', () => {
    // 1001 ops → 2 blocks → 8; 3 nets → 6; defi → 8; total = 42
    expect(calcFee({ totalOps: 1001, numNets: 3, hasDefi: true })).toBe(42);
  });
});

/* ── classifyOp ─────────────────────────────────────────────────────────── */
describe('classifyOp', () => {
  it('self-transfer → ignored', () => {
    expect(classifyOp({ isSelfTransfer: true, rawType: 'transfer' }).type).toBe('ignored');
  });
  it('bridge → ignored (not taxable by itself)', () => {
    expect(classifyOp({ isBridge: true, rawType: 'bridge' }).type).toBe('ignored');
  });
  it('swap detected from rawType', () => {
    expect(classifyOp({ rawType: 'swap', isIncoming: false }).type).toBe('swap');
  });
  it('staking detected from rawType', () => {
    expect(classifyOp({ rawType: 'staking_reward', isIncoming: true }).type).toBe('staking');
  });
  it('airdrop detected', () => {
    expect(classifyOp({ rawType: 'airdrop', isIncoming: true }).type).toBe('airdrop');
  });
  it('incoming → receive', () => {
    expect(classifyOp({ rawType: 'erc20', isIncoming: true }).type).toBe('receive');
  });
  it('outgoing → send', () => {
    expect(classifyOp({ rawType: 'erc20', isIncoming: false }).type).toBe('send');
  });
});

/* ── Brazil (Average cost) ───────────────────────────────────────────────── */
describe('calcBR — average cost', () => {
  it('simple buy→sell gain', () => {
    // Buy 100 USDC worth of ETH at $2000, sell at $2500 → gain = 100 * (2500-2000)/2000 = 25
    const events = makeEvents([
      { type: 'buy',  asset: 'ETH', qty: 0.05, price: 2000 }, // cost = 100
      { type: 'sell', asset: 'ETH', qty: 0.05, price: 2500 }, // proceeds = 125
    ]);
    const r = calcBR(events);
    expect(r.realizedGain).toBeCloseTo(25, 4);
    expect(r.estimatedTax).toBeCloseTo(25 * 0.15, 4);
  });

  it('staking income captured', () => {
    const events = makeEvents([
      { type: 'staking', asset: 'USDC', qty: 10, price: 1 },
    ]);
    const r = calcBR(events);
    expect(r.income).toBeCloseTo(10, 4);
  });

  it('zero gain on no sell', () => {
    const events = makeEvents([
      { type: 'buy', asset: 'ETH', qty: 1, price: 3000 },
    ]);
    const r = calcBR(events);
    expect(r.realizedGain).toBe(0);
  });

  it('average cost recalculated across two buys', () => {
    // Buy 1 ETH @3000 and 1 ETH @4000 → avg cost = 3500
    // Sell 1 ETH @3500 → gain = 0
    const events = makeEvents([
      { type: 'buy',  asset: 'ETH', qty: 1, price: 3000 },
      { type: 'buy',  asset: 'ETH', qty: 1, price: 4000 },
      { type: 'sell', asset: 'ETH', qty: 1, price: 3500 },
    ]);
    const r = calcBR(events);
    expect(r.realizedGain).toBeCloseTo(0, 4);
  });

  it('deductible fees accumulated', () => {
    const events = makeEvents([
      { type: 'send', asset: 'USDC', qty: 10, price: 1, fees: 0.5 },
      { type: 'send', asset: 'USDC', qty: 10, price: 1, fees: 0.3 },
    ]);
    const r = calcBR(events);
    expect(r.deductibleFees).toBeCloseTo(0.8, 4);
  });
});

/* ── Portugal (FIFO) ─────────────────────────────────────────────────────── */
describe('calcPT — FIFO', () => {
  it('FIFO: first lot used first', () => {
    // Buy 1 ETH @2000, 1 ETH @3000; sell 1 ETH @2500 → gain = 500 (used first lot)
    const events = makeEvents([
      { type: 'buy',  asset: 'ETH', qty: 1, price: 2000 },
      { type: 'buy',  asset: 'ETH', qty: 1, price: 3000 },
      { type: 'sell', asset: 'ETH', qty: 1, price: 2500 },
    ]);
    const r = calcPT(events);
    expect(r.realizedGain).toBeCloseTo(500, 4);
  });

  it('loss deducted', () => {
    // Buy 1 ETH @3000, sell at @2000 → loss = -1000
    const events = makeEvents([
      { type: 'buy',  asset: 'ETH', qty: 1, price: 3000 },
      { type: 'sell', asset: 'ETH', qty: 1, price: 2000 },
    ]);
    const r = calcPT(events);
    expect(r.realizedGain).toBeCloseTo(-1000, 4);
    expect(r.estimatedTax).toBe(0); // negative gain → 0 tax
  });
});

/* ── United States (FIFO) ────────────────────────────────────────────────── */
describe('calcUS — FIFO', () => {
  it('FIFO gain same as PT formula', () => {
    const events = makeEvents([
      { type: 'buy',  asset: 'BTC', qty: 0.01, price: 40000 },
      { type: 'sell', asset: 'BTC', qty: 0.01, price: 50000 },
    ]);
    const r = calcUS(events);
    expect(r.realizedGain).toBeCloseTo(100, 4); // 0.01*(50000-40000) = 100
    expect(r.estimatedTax).toBeCloseTo(100 * 0.20, 4);
  });

  it('airdrop counted as income', () => {
    const events = makeEvents([
      { type: 'airdrop', asset: 'TOKEN', qty: 100, price: 0.5 },
    ]);
    const r = calcUS(events);
    expect(r.income).toBeCloseTo(50, 4);
  });
});

/* ── Germany (FIFO, 1-year exemption) ───────────────────────────────────── */
describe('calcDE — FIFO 1-year exempt', () => {
  it('sale within 1 year → taxed', () => {
    const now = Date.now();
    const events = makeEvents([
      { type: 'buy',  asset: 'ETH', qty: 1, price: 2000, ts: now - 200 * 86400000 },
      { type: 'sell', asset: 'ETH', qty: 1, price: 3000, ts: now - 10 * 86400000 },
    ]);
    const r = calcDE(events);
    expect(r.realizedGain).toBeCloseTo(1000, 4);
    expect(r.estimatedTax).toBeCloseTo(1000 * 0.25, 4);
  });

  it('sale after 1 year → exempt (no gain)', () => {
    const now = Date.now();
    const events = makeEvents([
      { type: 'buy',  asset: 'ETH', qty: 1, price: 2000, ts: now - 400 * 86400000 },
      { type: 'sell', asset: 'ETH', qty: 1, price: 5000, ts: now },
    ]);
    const r = calcDE(events);
    expect(r.realizedGain).toBe(0);
    expect(r.estimatedTax).toBe(0);
  });
});

/* ── United Kingdom (Section 104) ───────────────────────────────────────── */
describe('calcGB — Section 104 pool', () => {
  it('pooled average cost applied on sale', () => {
    // Buy 1 @2000 + 1 @4000 → pool avg 3000; sell 1 @3500 → gain = 500
    const events = makeEvents([
      { type: 'buy',  asset: 'ETH', qty: 1, price: 2000 },
      { type: 'buy',  asset: 'ETH', qty: 1, price: 4000 },
      { type: 'sell', asset: 'ETH', qty: 1, price: 3500 },
    ]);
    const r = calcGB(events);
    expect(r.realizedGain).toBeCloseTo(500, 4);
    expect(r.estimatedTax).toBeCloseTo(500 * 0.20, 4);
  });
});

/* ── calcCountry router ──────────────────────────────────────────────────── */
describe('calcCountry router', () => {
  const events = makeEvents([
    { type: 'buy',  asset: 'ETH', qty: 1, price: 2000 },
    { type: 'sell', asset: 'ETH', qty: 1, price: 2500 },
  ]);
  it('BR routes to calcBR', () => expect(calcCountry('BR', events).realizedGain).toBeCloseTo(500, 4));
  it('PT routes to calcPT', () => expect(calcCountry('PT', events).realizedGain).toBeCloseTo(500, 4));
  it('US routes to calcUS', () => expect(calcCountry('US', events).realizedGain).toBeCloseTo(500, 4));
  it('DE routes to calcDE', () => expect(calcCountry('DE', events).realizedGain).toBeCloseTo(500, 4));
  it('GB routes to calcGB', () => expect(calcCountry('GB', events).realizedGain).toBeCloseTo(500, 4));
  it('unknown → US default', () => expect(calcCountry('XX', events).realizedGain).toBeCloseTo(500, 4));
});

/* ── Self-transfer / bridge non-taxation ────────────────────────────────── */
describe('bridge and self-transfer are non-taxable', () => {
  it('bridge events classified as ignored → not in tax base', () => {
    const raw = { isBridge: true, rawType: 'bridge', assetId: 'USDC', qty: 100, price: 1, ts: Date.now(), fees: 0 };
    const classified = classifyOp(raw);
    expect(classified.type).toBe('ignored');
    // Running calcUS on ignored event: ignored events are filtered out by report.js
    const r = calcUS([{ ...classified }]);
    // since type='ignored' is not handled by _calcFIFO, realizedGain stays 0
    expect(r.realizedGain).toBe(0);
  });

  it('self-transfer classified as ignored', () => {
    const raw = { isSelfTransfer: true, rawType: 'transfer', assetId: 'USDC', qty: 50, price: 1, ts: Date.now(), fees: 0 };
    const classified = classifyOp(raw);
    expect(classified.type).toBe('ignored');
  });
});
