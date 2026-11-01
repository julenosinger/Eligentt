/**
 * Tax module shared utilities — Cloudflare Pages Functions
 * All chain-scanning, fee calculation, classification and country rules live here.
 */

/* ── Fee config (mirror of front-end TAX_FEE, server is authoritative) ── */
export const TAX_FEE = {
  base:         20,
  volumePer500:  4,
  perExtraNet:   3,
  complexity:    8,
  quoteExpiryMs: 15 * 60 * 1000,
};

/* ── SSRF-safe URL fetch helper ─────────────────────────────────────────── */
const BLOCKED_PATTERNS = [
  /^https?:\/\/localhost/i,
  /^https?:\/\/127\./,
  /^https?:\/\/10\./,
  /^https?:\/\/172\.(1[6-9]|2[0-9]|3[01])\./,
  /^https?:\/\/192\.168\./,
  /169\.254\./,
  /metadata\.google\.internal/i,
  /169\.254\.169\.254/,
];
export function isSafeUrl(url) {
  return !BLOCKED_PATTERNS.some(p => p.test(url));
}

/* ── Quote calculation (server-authoritative) ───────────────────────────── */
export function calcFee({ totalOps, numNets, hasDefi }) {
  const volumeFee  = Math.ceil(Math.max(0, totalOps - 500) / 500) * TAX_FEE.volumePer500;
  const networkFee = Math.max(0, numNets - 1) * TAX_FEE.perExtraNet;
  const complexFee = hasDefi ? TAX_FEE.complexity : 0;
  return TAX_FEE.base + volumeFee + networkFee + complexFee;
}

/* ── Country rule modules ───────────────────────────────────────────────── */
// Each module: { id, name, currency, method, calcGain(events), label }
// Events: [{ type, assetId, qty, price, ts, fees }]

/** Brazil — Average cost (preço médio), monthly appraisal */
export function calcBR(events) {
  const avgCost = {}; // assetId → { totalQty, totalCost }
  let realizedGain = 0, income = 0, deductibleFees = 0;
  for (const e of events) {
    if (e.type === 'buy' || e.type === 'receive') {
      const ac = avgCost[e.assetId] || { totalQty: 0, totalCost: 0 };
      ac.totalQty  += e.qty;
      ac.totalCost += e.qty * e.price;
      avgCost[e.assetId] = ac;
    } else if (e.type === 'sell' || e.type === 'send') {
      const ac = avgCost[e.assetId];
      if (ac && ac.totalQty > 0) {
        const cost = (ac.totalCost / ac.totalQty) * e.qty;
        realizedGain += e.qty * e.price - cost;
        ac.totalQty  -= e.qty;
        ac.totalCost -= cost;
      }
    } else if (e.type === 'staking' || e.type === 'airdrop') {
      income += e.qty * e.price;
    }
    deductibleFees += (e.fees || 0);
  }
  const taxRate = 0.15; // simplified flat rate (Brazil: 15–22.5%)
  return { realizedGain, income, deductibleFees, estimatedTax: Math.max(0, realizedGain) * taxRate };
}

/** Portugal — FIFO */
export function calcPT(events) {
  return _calcFIFO(events, 0.28);
}

/** United States — FIFO / HIFO (simplified: FIFO) */
export function calcUS(events) {
  return _calcFIFO(events, 0.20);
}

/** Germany — FIFO, 1-year exemption */
export function calcDE(events) {
  const lots = {}; // assetId → [{ qty, price, ts }]
  let realizedGain = 0, income = 0, deductibleFees = 0;
  const ONE_YEAR = 365 * 24 * 3600 * 1000;
  for (const e of events) {
    if (e.type === 'buy' || e.type === 'receive') {
      if (!lots[e.assetId]) lots[e.assetId] = [];
      lots[e.assetId].push({ qty: e.qty, price: e.price, ts: e.ts });
    } else if (e.type === 'sell' || e.type === 'send') {
      let remain = e.qty;
      const ls = lots[e.assetId] || [];
      while (remain > 0 && ls.length > 0) {
        const lot = ls[0];
        const used = Math.min(lot.qty, remain);
        const exempt = (e.ts - lot.ts) > ONE_YEAR;
        if (!exempt) realizedGain += used * (e.price - lot.price);
        lot.qty -= used; remain -= used;
        if (lot.qty <= 0) ls.shift();
      }
    } else if (e.type === 'staking' || e.type === 'airdrop') {
      income += e.qty * e.price;
    }
    deductibleFees += (e.fees || 0);
  }
  return { realizedGain, income, deductibleFees, estimatedTax: Math.max(0, realizedGain) * 0.25 };
}

/** United Kingdom — Section 104 pooling */
export function calcGB(events) {
  const pools = {}; // assetId → { totalQty, totalCost }
  let realizedGain = 0, income = 0, deductibleFees = 0;
  for (const e of events) {
    if (e.type === 'buy' || e.type === 'receive') {
      const p = pools[e.assetId] || { totalQty: 0, totalCost: 0 };
      p.totalQty  += e.qty;
      p.totalCost += e.qty * e.price;
      pools[e.assetId] = p;
    } else if (e.type === 'sell' || e.type === 'send') {
      const p = pools[e.assetId];
      if (p && p.totalQty > 0) {
        const avgCost = p.totalCost / p.totalQty;
        realizedGain += e.qty * (e.price - avgCost);
        p.totalQty  -= e.qty;
        p.totalCost -= avgCost * e.qty;
      }
    } else if (e.type === 'staking' || e.type === 'airdrop') {
      income += e.qty * e.price;
    }
    deductibleFees += (e.fees || 0);
  }
  return { realizedGain, income, deductibleFees, estimatedTax: Math.max(0, realizedGain) * 0.20 };
}

function _calcFIFO(events, taxRate) {
  const lots = {}; // assetId → [{ qty, price }]
  let realizedGain = 0, income = 0, deductibleFees = 0;
  for (const e of events) {
    if (e.type === 'buy' || e.type === 'receive') {
      if (!lots[e.assetId]) lots[e.assetId] = [];
      lots[e.assetId].push({ qty: e.qty, price: e.price });
    } else if (e.type === 'sell' || e.type === 'send') {
      let remain = e.qty;
      const ls = lots[e.assetId] || [];
      while (remain > 0 && ls.length > 0) {
        const lot = ls[0];
        const used = Math.min(lot.qty, remain);
        realizedGain += used * (e.price - lot.price);
        lot.qty -= used; remain -= used;
        if (lot.qty <= 0) ls.shift();
      }
    } else if (e.type === 'staking' || e.type === 'airdrop') {
      income += e.qty * e.price;
    }
    deductibleFees += (e.fees || 0);
  }
  return { realizedGain, income, deductibleFees, estimatedTax: Math.max(0, realizedGain) * taxRate };
}

/** Router: pick country calc by ID */
export function calcCountry(countryId, events) {
  switch (countryId) {
    case 'BR': return calcBR(events);
    case 'PT': return calcPT(events);
    case 'US': return calcUS(events);
    case 'DE': return calcDE(events);
    case 'GB': return calcGB(events);
    default:   return calcUS(events);
  }
}

/* ── Event classifier ───────────────────────────────────────────────────── */
export function classifyOp(raw) {
  // Detect self-transfer / bridge (no taxable event)
  if (raw.isSelfTransfer || raw.isBridge) return { ...raw, type: 'ignored' };
  // Map raw type to canonical
  const t = (raw.rawType || '').toLowerCase();
  if (t.includes('swap'))    return { ...raw, type: 'swap' };
  if (t.includes('stake') || t.includes('reward') || t.includes('yield')) return { ...raw, type: 'staking' };
  if (t.includes('airdrop')) return { ...raw, type: 'airdrop' };
  if (t.includes('bridge'))  return { ...raw, type: 'bridge' }; // typically ignored
  if (raw.isIncoming)        return { ...raw, type: 'receive' };
  if (!raw.isIncoming)       return { ...raw, type: 'send' };
  return { ...raw, type: 'unknown' };
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */
export function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
export function errResp(msg, status = 400) {
  return jsonResp({ ok: false, error: msg }, status);
}
