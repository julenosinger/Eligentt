/**
 * POST /api/tax/report
 *
 * Phase 1.1.1 corrections on top of Phase 1.1:
 *   P0-A  deduplicateTransfers() — uniqueId now scoped by network;
 *                                  fallback-key collision PRESERVES both records (no silent discard);
 *                                  dedupStats exposed on every response.
 *   P0-B  report response        — dataCoverage + calculationCompleteness (independent states);
 *                                  legacy coverage field kept for frontend compatibility.
 *
 * Body:    { address, targetType, networks, country, quoteId, txHash, hasDefi }
 * Returns: { ok, country, address, period,
 *             coverage,                        ← legacy compat (same as dataCoverage)
 *             dataCoverage,                    ← completeness of raw tx ingestion per network
 *             calculationCompleteness,         ← completeness of price-enriched calculations
 *             partial, warnings, metrics, ops,
 *             dedupStats, priceWarnings? }
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
   P0-A (Phase 1.1)  fetchPrice — null for every non-authoritative case
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
   P0-A (Phase 1.1.1)  deduplicateTransfers — corrected dedup logic
   ═══════════════════════════════════════════════════════════════════════════ */
/**
 * Dedup key priority:
 *   1. Alchemy `uniqueId` field — scoped by network (Phase 1.1.1 fix: was unscoped)
 *   2. ERC-20/721/1155:  network + hash + rawContract.address + log.logIndex
 *   3. External/native:  network + hash + 'external' + from + to
 *   4. Internal:         network + hash + 'internal' + traceAddress (or index)
 *   5. Fallback:         network + hash + category + value + from + to
 *      IMPORTANT (Phase 1.1.1 fix): fallback-key collision PRESERVES BOTH records
 *      and marks possibleDuplicate on each. We never silently discard a record
 *      whose identity cannot be fully established.
 *
 * Returns: {
 *   deduped:            Transfer[] with _dedupKey / _dedupFallback / _possibleDuplicate,
 *   stats: {
 *     input:            number of records received,
 *     provenDuplicates: number removed (confident dedup only),
 *     preserved:        number in output,
 *     possibleDuplicates: number flagged (in output, not removed),
 *     fallbackKeys:     number that used the fallback path,
 *   }
 * }
 */
export function deduplicateTransfers(transfers) {
  // Two separate seen-sets:
  //   seenConfident — for keys built with reliable identifiers (uid, logIndex, traceAddress)
  //   seenFallback  — for fallback keys; collision → PRESERVE + flag (not discard)
  const seenConfident = new Map();   // key → true (for audit)
  const seenFallback  = new Map();   // key → count of times seen

  const deduped          = [];
  let provenDuplicates   = 0;
  let possibleDuplicates = 0;
  let fallbackKeys       = 0;

  for (const t of transfers) {
    let key;
    let isConfident = true;   // true → collision = proven duplicate → discard
                              // false → collision = possible duplicate → preserve + flag

    const net  = t._network || '';
    const hash = (t.hash || '').toLowerCase();
    const cat  = (t.category || '').toLowerCase();

    // P0.3 (Phase 1.1.2): if hash is absent/empty we cannot build a reliable key
    // for ANY category — force fallback so these records are preserved, not silently
    // collapsed with each other or with legitimate zero-hash placeholders.
    const hasHash = hash.length > 0 && hash !== '0x';

    if (t.uniqueId) {
      // Phase 1.1.1: scope uniqueId by network so the same Alchemy uniqueId on two
      // different chains (edge case, but possible with wrapped assets) is not collapsed.
      key        = `uid:${net}:${t.uniqueId}`;
      isConfident = true;
    } else if (cat === 'erc20' || cat === 'erc721' || cat === 'erc1155' || cat === 'specialnft') {
      const logIdx   = t.log?.logIndex != null ? String(t.log.logIndex) : null;
      const contract = (t.rawContract?.address || '').toLowerCase();
      if (hasHash && logIdx !== null) {
        key        = `tok:${net}:${hash}:${contract}:${logIdx}`;
        isConfident = true;
      } else {
        // No logIndex or no hash — fallback; do NOT discard on collision
        key        = `tok_fl:${net}:${hash}:${contract}:${logIdx || ''}:${t.value || ''}`;
        isConfident = false;
        fallbackKeys++;
      }
    } else if (cat === 'internal') {
      const trace = t.traceAddress
        ? JSON.stringify(t.traceAddress)
        : (t.internalIndex != null ? String(t.internalIndex) : null);
      if (hasHash && trace !== null) {
        key        = `int:${net}:${hash}:${trace}`;
        isConfident = true;
      } else {
        key        = `int_fl:${net}:${hash}:${(t.from || '').toLowerCase()}:${(t.to || '').toLowerCase()}:${t.value || ''}`;
        isConfident = false;
        fallbackKeys++;
      }
    } else {
      if (hasHash) {
        // External/native: hash uniquely identifies this event in context of from+to
        key        = `ext:${net}:${hash}:${(t.from || '').toLowerCase()}:${(t.to || '').toLowerCase()}`;
        isConfident = true;
      } else {
        // No hash — cannot build a reliable key; preserve and flag
        key        = `ext_fl:${net}:${(t.from || '').toLowerCase()}:${(t.to || '').toLowerCase()}:${t.value || ''}:${Date.now()}:${Math.random()}`;
        isConfident = false;
        fallbackKeys++;
      }
    }

    if (isConfident) {
      if (seenConfident.has(key)) {
        provenDuplicates++;
        continue;   // proven duplicate — safe to discard
      }
      seenConfident.set(key, true);
      deduped.push({ ...t, _dedupKey: key });
    } else {
      // Fallback path: ALWAYS preserve; flag possibleDuplicate when key was seen before
      const count = (seenFallback.get(key) || 0) + 1;
      seenFallback.set(key, count);
      const isPossDup = count > 1;
      if (isPossDup) possibleDuplicates++;
      deduped.push({
        ...t,
        _dedupKey:         key,
        _dedupFallback:    true,
        _possibleDuplicate: isPossDup || undefined,
      });
    }
  }

  return {
    deduped,
    stats: {
      input:             transfers.length,
      provenDuplicates,
      preserved:         deduped.length,
      possibleDuplicates,
      fallbackKeys,
    },
  };
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
    // P0.2 (Phase 1.1.2): propagate dedup metadata set by deduplicateTransfers()
    // so the op table and downstream classification retain audit trail fields.
    _dedupKey:         t._dedupKey          || undefined,
    _dedupFallback:    t._dedupFallback     || undefined,
    _possibleDuplicate: t._possibleDuplicate || undefined,
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

    const { deduped, stats } = deduplicateTransfers(raw);
    const ops = deduped.map(t => normalizeTransfer(t, address, network));

    const truncated = outRes.truncated || inRes.truncated;
    return {
      ops,
      coverage: truncated ? 'partial' : 'complete',
      dedupStats: stats,
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
   Phase 1.1.1: dataCoverage + calculationCompleteness (independent states)
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
  const seenNets   = new Set();
  const validNets  = [];
  const invalidNets = [];
  for (const n of networks) {
    if (typeof n !== 'string' || !VALID_NETWORKS.has(n)) {
      invalidNets.push(n);
      continue;
    }
    if (seenNets.has(n)) continue;   // silently drop duplicates
    seenNets.add(n);
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
  let allOps       = [];
  const coverageMap = {};
  const noteMap     = {};
  const dedupStatsByNetwork = {};

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
    if (res.note)        noteMap[net]         = res.note;
    if (res.dedupStats)  dedupStatsByNetwork[net] = res.dedupStats;
  }

  // ── P0-D / P1.5 (Phase 1.1.2): aggCoverage with explicit error precedence
  // Precedence: error > partial > complete > unavailable
  //   error      — at least one network returned a provider error (not just unavailable)
  //   partial    — mix of states, or at least one network is partial or truncated
  //   complete   — every queried network returned full history
  //   unavailable— every network is unavailable (none queryable)
  // validNets.length ≥ 1 is guaranteed by the guard above.
  const coverageValues = Object.values(coverageMap);
  let aggCoverage;
  if (coverageValues.length === 0) {
    aggCoverage = 'unavailable';   // unreachable given the guard — explicit for safety
  } else if (coverageValues.some(c => c === 'error')) {
    aggCoverage = 'error';         // any provider error propagates up
  } else if (coverageValues.every(c => c === 'complete')) {
    aggCoverage = 'complete';
  } else if (coverageValues.every(c => c === 'unavailable')) {
    aggCoverage = 'unavailable';
  } else {
    aggCoverage = 'partial';       // any mix of partial/complete/unavailable
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

  // ── Phase 1.1.1: dataCoverage vs calculationCompleteness (independent states)
  //
  // dataCoverage        — did we successfully ingest all available history?
  //                       'complete'   → every queried network returned full history
  //                       'partial'    → at least one network is partial or unavailable
  //                       'unavailable'→ every network is unavailable
  //                       'error'      → at least one network errored
  //
  // calculationCompleteness — are tax calculations meaningful over the collected ops?
  //                       'complete'   → all relevant ops have prices; safe to finalize
  //                       'partial'    → some ops lack prices; calculations are estimates
  //                       'unavailable'→ no ops with prices found (nothing calculated)
  //
  // Both can differ: ingestion can be 'complete' while prices are 'partial', and vice versa.
  const dataCoverage = aggCoverage;  // same logic, renamed for clarity

  let calculationCompleteness;
  if (ops.length === 0) {
    calculationCompleteness = opsWithoutPrice.length === 0 ? 'complete' : 'unavailable';
  } else if (opsWithoutPrice.length === 0) {
    calculationCompleteness = 'complete';
  } else if (opsWithPrice.length === 0) {
    calculationCompleteness = 'unavailable';
  } else {
    calculationCompleteness = 'partial';
  }

  const isPartial = dataCoverage !== 'complete' || calculationCompleteness !== 'complete';

  // ── Aggregate dedup stats across networks
  const totalDedupStats = Object.values(dedupStatsByNetwork).reduce(
    (acc, s) => ({
      input:             (acc.input             || 0) + s.input,
      provenDuplicates:  (acc.provenDuplicates  || 0) + s.provenDuplicates,
      preserved:         (acc.preserved         || 0) + s.preserved,
      possibleDuplicates:(acc.possibleDuplicates || 0) + s.possibleDuplicates,
      fallbackKeys:      (acc.fallbackKeys       || 0) + s.fallbackKeys,
    }),
    {}
  );
  // P1.4 (Phase 1.1.2): always emit dedupStats — zero values must be explicit, not undefined.
  const EMPTY_DEDUP = { input: 0, provenDuplicates: 0, preserved: 0, possibleDuplicates: 0, fallbackKeys: 0 };
  const hasDedupStats = Object.keys(totalDedupStats).length > 0;

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
    possibleDuplicate: op._possibleDuplicate || undefined,
  }));

  return jsonResp({
    ok:       true,
    address,
    country:  countryMeta,
    period,

    // Legacy field — kept for frontend compatibility
    coverage: dataCoverage,

    // Phase 1.1.1: independent state fields
    dataCoverage,
    calculationCompleteness,

    partial:  isPartial,
    warnings: coverageWarnings.length ? coverageWarnings : undefined,
    priceWarnings: priceWarnings.length
      ? {
          count:   priceWarnings.length,
          samples: priceWarnings.slice(0, 10),
          note:    'Operations with missing prices are shown in the table but excluded from ' +
                   'gain/loss calculations. Results are not final until all prices are resolved.',
        }
      : undefined,
    dedupStats: hasDedupStats ? totalDedupStats : EMPTY_DEDUP,
    metrics,
    ops:  opTable,
    demo: false,
  });
}
