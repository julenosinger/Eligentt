/**
 * POST /api/tax/report
 *
 * Phase 1.1 hardening:
 *   P0-A  fetchPrice()         — null for every missing/unknown/error case; no $1 fallback
 *   P0-B  deduplicateTransfers() — uniqueId preferred; hash+contract+logIndex for ERC-20;
 *                                  hash+traceIndex for internal; preserves distinct events
 *   P0-C  countEtherscanOps()  — NOTE: cross-category counting limitation documented in scan.js
 *   P0-D  aggCoverage          — empty networks → 'unavailable'; [].every() trap eliminated
 *
 * Body:    { address, targetType, networks, country, quoteId, txHash, hasDefi }
 * Returns: { ok, country, address, period, coverage, partial, warnings, metrics, ops,
 *             priceWarnings? }
 *
 * coverage values per network: 'complete' | 'partial' | 'unavailable' | 'error'
 * Aggregate coverage: 'complete' only when every queried network returned complete data.
 *                     NEVER 'complete' when no networks were queried.
 */

import { jsonResp, errResp, classifyOp, calcCountry, isSafeUrl } from './_tax-utils.mjs';

const COUNTRY_META = {
  BR: { name: 'Brazil',         currency: 'BRL', method: 'Average cost', period: 'Monthly'  },
  PT: { name: 'Portugal',       currency: 'EUR', method: 'FIFO',         period: 'Annual'   },
  US: { name: 'United States',  currency: 'USD', method: 'FIFO',         period: 'Annual'   },
  DE: { name: 'Germany',        currency: 'EUR', method: 'FIFO',         period: 'Annual'   },
  GB: { name: 'United Kingdom', currency: 'GBP', method: 'Section 104',  period: 'Annual'   },
};

const VALID_NETWORKS = new Set(['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'arc', 'solana']);

/** Maximum pageKeys to follow per direction. 50 × 1 000 = 50 000 transfers per direction. */
const ALCHEMY_MAX_PAGES = 50;

/* ═══════════════════════════════════════════════════════════════════════════
   P0-A  fetchPrice — null for every non-authoritative case
   ═══════════════════════════════════════════════════════════════════════════ */
/**
 * Fetch historical USD price for an asset at a given timestamp.
 *
 * Returns one of:
 *   { price: number, source: 'coingecko' }   — authoritative price found
 *   { price: null, reason: 'no_key' }         — COINGECKO_API_KEY absent
 *   { price: null, reason: 'unknown_asset' }  — asset not in idMap and not a CoinGecko slug
 *   { price: null, reason: 'no_data' }        — API returned no price for the date
 *   { price: null, reason: 'http_error', detail }  — API responded with non-200
 *   { price: null, reason: 'timeout' }        — request timed out
 *   { price: null, reason: 'provider_error', detail } — other network/parse error
 *
 * NEVER returns a synthetic price (1, 0, or any constant).
 * Stablecoins are NOT special-cased — even USDC must have an authoritative price
 * or the caller must decide how to handle the missing_price state.
 */
export async function fetchPrice(assetId, ts, env) {
  const key = env.COINGECKO_API_KEY;
  if (!key) {
    return { price: null, reason: 'no_key' };
  }
  if (!assetId || typeof assetId !== 'string' || assetId.trim() === '') {
    return { price: null, reason: 'unknown_asset' };
  }
  if (!ts || isNaN(Number(ts))) {
    return { price: null, reason: 'no_data' };
  }

  // CoinGecko expects DD-MM-YYYY
  const d    = new Date(Number(ts));
  const date = [
    String(d.getUTCDate()).padStart(2, '0'),
    String(d.getUTCMonth() + 1).padStart(2, '0'),
    d.getUTCFullYear(),
  ].join('-');

  // Well-known symbol → CoinGecko ID mapping (expand as needed)
  const idMap = {
    USDC:   'usd-coin',
    USDT:   'tether',
    ETH:    'ethereum',
    WETH:   'weth',
    BTC:    'bitcoin',
    WBTC:   'wrapped-bitcoin',
    MATIC:  'matic-network',
    POL:    'matic-network',
    ARB:    'arbitrum',
    OP:     'optimism',
    EURC:   'euro-coin',
  };
  const upper = assetId.toUpperCase();
  const cgId  = idMap[upper] || assetId.toLowerCase();

  // Reject obviously invalid slugs (empty after lower, contains spaces, very short)
  if (!cgId || cgId.trim() === '' || cgId.includes(' ') || cgId.length < 2) {
    return { price: null, reason: 'unknown_asset' };
  }

  let resp;
  try {
    // arc-studio-allow-onchain-literal
    resp = await fetch(
      `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(cgId)}/history?date=${date}&localization=false`,
      {
        headers: { 'x-cg-pro-api-key': key },
        signal:  AbortSignal.timeout(6000),
      },
    );
  } catch (e) {
    const reason = e.name === 'AbortError' || e.name === 'TimeoutError' ? 'timeout' : 'provider_error';
    return { price: null, reason, detail: e.message?.slice(0, 80) };
  }

  if (!resp.ok) {
    return { price: null, reason: 'http_error', detail: 'HTTP ' + resp.status };
  }

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return { price: null, reason: 'provider_error', detail: 'JSON parse failed' };
  }

  const usd = data?.market_data?.current_price?.usd;
  if (usd == null || typeof usd !== 'number' || !isFinite(usd)) {
    return { price: null, reason: 'no_data' };
  }
  return { price: usd, source: 'coingecko' };
}

/* ═══════════════════════════════════════════════════════════════════════════
   P0-B  deduplicateTransfers — preserve distinct events, drop only true dupes
   ═══════════════════════════════════════════════════════════════════════════ */
/**
 * Dedup key priority:
 *   1. Alchemy `uniqueId` field — most precise; present on most transfers
 *   2. ERC-20/721/1155:  network + hash + rawContract.address + log.logIndex
 *   3. External/native:  network + hash + 'external' + from + to
 *   4. Internal:         network + hash + 'internal' + traceAddress (or index)
 *   5. Fallback:         network + hash + category + value + from + to
 *      (preserves unknown events but flags possible_duplicate)
 *
 * Transfers that share a hash but are genuinely distinct (e.g. two ERC-20
 * events inside one swap tx) are NEVER collapsed because their logIndex differs.
 *
 * Returns: { deduped: object[], possibleDuplicates: number }
 */
export function deduplicateTransfers(transfers) {
  const seen    = new Map();   // key → first-seen transfer (for audit trail)
  const deduped = [];
  let possibleDuplicates = 0;

  for (const t of transfers) {
    let key;
    let isFallback = false;

    if (t.uniqueId) {
      // Alchemy's own dedup field — most reliable
      key = 'uid:' + t.uniqueId;
    } else {
      const net  = t._network || '';
      const hash = (t.hash || '').toLowerCase();
      const cat  = (t.category || '').toLowerCase();

      if (cat === 'erc20' || cat === 'erc721' || cat === 'erc1155' || cat === 'specialnft') {
        // Token events: differentiated by log index within the tx
        const logIdx    = t.log?.logIndex != null ? String(t.log.logIndex) : null;
        const contract  = (t.rawContract?.address || '').toLowerCase();
        if (logIdx !== null) {
          key = `tok:${net}:${hash}:${contract}:${logIdx}`;
        } else {
          // No logIndex — use fallback with flag
          key = `tok_fl:${net}:${hash}:${contract}:${(t.value || '')}`;
          isFallback = true;
        }
      } else if (cat === 'internal') {
        // Internal calls: differentiated by traceAddress or index
        const trace = t.traceAddress
          ? JSON.stringify(t.traceAddress)
          : (t.internalIndex != null ? String(t.internalIndex) : null);
        if (trace !== null) {
          key = `int:${net}:${hash}:${trace}`;
        } else {
          key = `int_fl:${net}:${hash}:${(t.from || '').toLowerCase()}:${(t.to || '').toLowerCase()}:${t.value || ''}`;
          isFallback = true;
        }
      } else {
        // External/native ETH transfer: hash + from + to identifies the event
        // (a tx can only have one external ETH transfer for a given from+to pair)
        key = `ext:${net}:${hash}:${(t.from || '').toLowerCase()}:${(t.to || '').toLowerCase()}`;
      }
    }

    if (seen.has(key)) {
      if (isFallback) possibleDuplicates++;
      continue;  // genuine duplicate — discard
    }
    seen.set(key, t);
    // Tag the transfer with its dedup key for auditability
    deduped.push({ ...t, _dedupKey: key, _dedupFallback: isFallback || undefined });
  }

  return { deduped, possibleDuplicates };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Alchemy getAssetTransfers — one direction, fully paginated
   ═══════════════════════════════════════════════════════════════════════════ */
async function alchemyFetchDirection(url, address, direction, signal) {
  const paramKey  = direction === 'from' ? 'fromAddress' : 'toAddress';
  const CATEGORIES = ['erc20', 'erc721', 'erc1155', 'external', 'internal', 'specialnft'];

  let transfers = [];
  let pageKey   = undefined;
  let pages     = 0;
  let truncated = false;

  while (pages < ALCHEMY_MAX_PAGES) {
    const params = {
      [paramKey]: address,
      category:   CATEGORIES,
      withMetadata: true,
      maxCount:   '0x3e8',
      order:      'asc',
      ...(pageKey ? { pageKey } : {}),
    };

    const resp = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ jsonrpc: '2.0', id: 1,
        method: 'alchemy_getAssetTransfers', params: [params] }),
      signal,
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message || 'Alchemy RPC error');

    const page = data.result?.transfers || [];
    transfers  = transfers.concat(page);
    pageKey    = data.result?.pageKey || undefined;
    pages++;
    if (!pageKey) break;
  }

  if (pageKey) truncated = true;
  return { transfers, truncated };
}

/* ── Normalize a raw Alchemy transfer ───────────────────────────────────── */
function normalizeTransfer(t, address, network) {
  const addrLower  = (address || '').toLowerCase();
  const isIncoming = (t.to || '').toLowerCase() === addrLower;

  return {
    hash:        t.hash            || null,
    ts:          t.metadata?.blockTimestamp
                   ? new Date(t.metadata.blockTimestamp).getTime()
                   : null,
    network,
    isIncoming,
    rawType:     t.category        || 'unknown',
    assetId:     t.asset           || (t.category === 'external' ? 'ETH' : 'UNKNOWN'),
    qty:         parseFloat(t.value || 0),
    price:       null,             // enriched below — never pre-set to 0 or 1
    priceState:  'pending',        // 'found' | 'missing_price' | 'no_key' | 'unknown_asset' | ...
    fees:        0,
    _from:       t.from            || null,
    _to:         t.to              || null,
    _logIndex:   t.log?.logIndex   != null ? String(t.log.logIndex) : null,
    _contractAddress: t.rawContract?.address || null,
    _network:    network,          // used by dedup key builder
    // Preserve Alchemy's own dedup field if present
    uniqueId:    t.uniqueId        || undefined,
    traceAddress: t.traceAddress   || undefined,
    internalIndex: t.internalIndex || undefined,
  };
}

/* ── Fetch all transfers for one EVM network ────────────────────────────── */
async function fetchEvmTxs(address, network, env) {
  const ak = env.ALCHEMY_API_KEY;
  if (!ak) {
    return { ops: [], coverage: 'unavailable', note: 'ALCHEMY_API_KEY not configured' };
  }

  // arc-studio-allow-onchain-literal
  const rpcUrlMap = {
    ethereum: `https://eth-mainnet.g.alchemy.com/v2/${ak}`,
    base:     `https://base-mainnet.g.alchemy.com/v2/${ak}`,
    arbitrum: `https://arb-mainnet.g.alchemy.com/v2/${ak}`,
    optimism: `https://opt-mainnet.g.alchemy.com/v2/${ak}`,
    polygon:  `https://polygon-mainnet.g.alchemy.com/v2/${ak}`,
  };

  const url = rpcUrlMap[network];
  if (!url) {
    if (network === 'arc')    return { ops: [], coverage: 'unavailable', note: 'Arc Mainnet tx-history API not yet available' };
    if (network === 'solana') return { ops: [], coverage: 'unavailable', note: 'Solana requires a dedicated adapter' };
    return { ops: [], coverage: 'unavailable', note: 'Unsupported network: ' + network };
  }
  if (!isSafeUrl(url)) {
    return { ops: [], coverage: 'error', note: 'RPC URL blocked by SSRF guard' };
  }

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 30000);

  try {
    const [outRes, inRes] = await Promise.all([
      alchemyFetchDirection(url, address, 'from', controller.signal),
      alchemyFetchDirection(url, address, 'to',   controller.signal),
    ]);

    // Tag each raw transfer with its network before dedup (needed for key building)
    const raw = [
      ...outRes.transfers.map(t => ({ ...t, _network: network })),
      ...inRes.transfers.map(t => ({ ...t, _network: network })),
    ];

    const { deduped, possibleDuplicates } = deduplicateTransfers(raw);
    const ops = deduped.map(t => normalizeTransfer(t, address, network));

    const truncated = outRes.truncated || inRes.truncated;
    return {
      ops,
      coverage: truncated ? 'partial' : 'complete',
      possibleDuplicates,
      ...(truncated ? { note: 'History truncated at ' + ALCHEMY_MAX_PAGES + ' pages per direction' } : {}),
    };
  } catch (e) {
    return { ops: [], coverage: 'error', note: e.message.slice(0, 120) };
  } finally {
    clearTimeout(timeout);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   P0-D  Main handler — empty-networks guard + correct aggCoverage
   ═══════════════════════════════════════════════════════════════════════════ */
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (_) { return errResp('Invalid JSON'); }

  const {
    address,
    targetType,
    networks,
    country  = 'US',
    quoteId,
    txHash,
    hasDefi,
  } = body;

  if (!address)  return errResp('address required');
  if (!quoteId)  return errResp('quoteId required');

  // ── P0-D: validate networks — never let an empty array silently pass
  if (!Array.isArray(networks) || networks.length === 0) {
    return errResp('networks must be a non-empty array');
  }
  // Deduplicate and validate network names
  const seen = new Set();
  const validNets = [];
  const invalidNets = [];
  for (const n of networks) {
    if (typeof n !== 'string' || !VALID_NETWORKS.has(n)) {
      invalidNets.push(n);
      continue;
    }
    if (seen.has(n)) continue;   // silently drop duplicates
    seen.add(n);
    validNets.push(n);
  }
  if (invalidNets.length > 0) {
    return errResp('invalid networks: ' + invalidNets.join(', '));
  }
  if (validNets.length === 0) {
    return errResp('no valid networks after deduplication');
  }

  const isEvm = /^0x[0-9a-fA-F]{40}$/.test(address);

  // ── Collect per-network
  let allOps    = [];
  const coverageMap = {};
  const noteMap     = {};

  for (const net of validNets) {
    if (net === 'solana' && isEvm) {
      coverageMap[net] = 'unavailable';
      noteMap[net]     = 'Solana history not implemented for EVM addresses';
      continue;
    }
    if (net === 'solana' && !isEvm) {
      coverageMap[net] = 'unavailable';
      noteMap[net]     = 'Solana history adapter not yet implemented';
      continue;
    }
    if (net === 'arc') {
      coverageMap[net] = 'unavailable';
      noteMap[net]     = 'Arc Mainnet transaction-history API not yet publicly available';
      continue;
    }

    const res          = await fetchEvmTxs(address, net, env);
    allOps             = allOps.concat(res.ops);
    coverageMap[net]   = res.coverage;
    if (res.note) noteMap[net] = res.note;
  }

  // ── P0-D: aggCoverage — [].every() trap eliminated
  // validNets.length ≥ 1 is guaranteed by the guard above.
  const coverageValues = Object.values(coverageMap);
  let aggCoverage;
  if (coverageValues.length === 0) {
    // Should be unreachable given the guard, but be explicit
    aggCoverage = 'unavailable';
  } else if (coverageValues.every(c => c === 'complete')) {
    aggCoverage = 'complete';
  } else if (coverageValues.every(c => c === 'unavailable')) {
    aggCoverage = 'unavailable';
  } else {
    aggCoverage = 'partial';
  }

  // ── P0-A: Enrich with historical prices — null stays null
  const priceCache    = {};
  const priceWarnings = [];  // ops where price could not be determined

  for (const op of allOps) {
    const cacheKey = (op.assetId || 'UNKNOWN') + ':' + (op.ts || 0);
    if (priceCache[cacheKey] === undefined) {
      priceCache[cacheKey] = await fetchPrice(op.assetId, op.ts, env);
    }
    const result = priceCache[cacheKey];
    op.price      = result.price;          // null when unavailable — NEVER coerced to 0 or 1
    op.priceState = result.price != null ? 'found' : (result.reason || 'missing_price');

    if (op.price == null) {
      priceWarnings.push({
        hash:    op.hash,
        network: op.network,
        asset:   op.assetId,
        reason:  op.priceState,
      });
    }
  }

  // ── Classify — ops with null price keep their price as null
  const classified = allOps.map(classifyOp);
  const ops        = classified.filter(op => op.type !== 'ignored');
  const ignored    = classified.filter(op => op.type === 'ignored').length;

  // ── Country rules — only use ops with a known price for financial calculations
  // Ops with null price are included in the table but excluded from gain/loss math
  const opsWithPrice    = ops.filter(op => op.price != null);
  const opsWithoutPrice = ops.filter(op => op.price == null);
  const metrics         = calcCountry(country, opsWithPrice);
  metrics.classifiedOps       = ops.length;
  metrics.ignoredSelfTransfer = ignored;
  metrics.priceMissing        = opsWithoutPrice.length;
  metrics.priceFound          = opsWithPrice.length;

  const countryMeta = COUNTRY_META[country] || COUNTRY_META['US'];

  // ── Period
  const period = (() => {
    const timestamps = allOps.map(t => t.ts).filter(Boolean).sort((a, b) => a - b);
    if (timestamps.length === 0) return null;
    const y0 = new Date(timestamps[0]).getFullYear();
    const y1 = new Date(timestamps[timestamps.length - 1]).getFullYear();
    return y0 === y1 ? String(y0) : y0 + '–' + y1;
  })();

  // ── Warnings
  const coverageWarnings = [];
  for (const [net, cov] of Object.entries(coverageMap)) {
    if (cov !== 'complete') {
      coverageWarnings.push({ network: net, coverage: cov, note: noteMap[net] || cov });
    }
  }

  // ── Op table — null price serialised as null (never as 0 or 1)
  const opTable = ops.slice(0, 500).map(op => ({
    date:         op.ts ? new Date(op.ts).toISOString().slice(0, 10) : null,
    chain:        op.network  || null,
    type:         op.type,
    in:           op.isIncoming  ? ((op.qty || 0).toFixed(4) + ' ' + (op.assetId || '?')) : null,
    out:          !op.isIncoming ? ((op.qty || 0).toFixed(4) + ' ' + (op.assetId || '?')) : null,
    usd:          op.price != null
                    ? parseFloat(((op.qty || 0) * op.price).toFixed(2))
                    : null,   // null, not 0
    usdMissing:   op.price == null ? true : undefined,
    gas:          parseFloat((op.fees || 0).toFixed(4)),
    pl:           op.type === 'sell' && op.price != null && op._costBasis != null
                    ? parseFloat(((op.price - op._costBasis) * (op.qty || 0)).toFixed(2))
                    : null,
    hash:         op.hash || null,
    dedupKey:     op._dedupKey || undefined,
  }));

  return jsonResp({
    ok:       true,
    address,
    country:  countryMeta,
    period,
    coverage: aggCoverage,
    partial:  aggCoverage !== 'complete',
    warnings: coverageWarnings.length ? coverageWarnings : undefined,
    priceWarnings: priceWarnings.length
      ? {
          count:   priceWarnings.length,
          samples: priceWarnings.slice(0, 10),
          note:    'Operations with missing prices are shown in the table but excluded from gain/loss calculations. ' +
                   'Results are not final until all prices are resolved.',
        }
      : undefined,
    metrics,
    ops:  opTable,
    demo: false,
  });
}
