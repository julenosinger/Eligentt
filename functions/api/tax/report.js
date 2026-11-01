/**
 * POST /api/tax/report
 * Generates a classified tax report for a wallet / contract.
 *
 * Fetches transactions, enriches with historical prices, classifies events,
 * runs country rules, and returns metrics + per-op table.
 *
 * Body: { address, targetType, networks, country, quoteId, txHash, hasDefi }
 * Returns: { ok, country, address, period, coverage, metrics, ops, partial? }
 *
 * Env vars:
 *   ALCHEMY_API_KEY    — required for EVM tx history
 *   ARC_RPC_URL        — optional; Arc Mainnet (tx-history API not yet available)
 *   SOLANA_RPC_URL     — optional; Solana history (separate adapter)
 *   COINGECKO_API_KEY  — optional; historical prices (defaults to $1 for stablecoins)
 *   TAX_KV             — optional CF KV for report caching
 *
 * Coverage states per network:
 *   complete   — all pages fetched successfully
 *   partial    — truncated (too many rows) or some pages failed
 *   unavailable — provider not configured
 *   error      — provider returned an error
 */

import { jsonResp, errResp, classifyOp, calcCountry, isSafeUrl } from './_tax-utils.mjs';

const COUNTRY_META = {
  BR: { name: 'Brazil',         currency: 'BRL', method: 'Average cost', period: 'Monthly'  },
  PT: { name: 'Portugal',       currency: 'EUR', method: 'FIFO',         period: 'Annual'   },
  US: { name: 'United States',  currency: 'USD', method: 'FIFO',         period: 'Annual'   },
  DE: { name: 'Germany',        currency: 'EUR', method: 'FIFO',         period: 'Annual'   },
  GB: { name: 'United Kingdom', currency: 'GBP', method: 'Section 104',  period: 'Annual'   },
};

/** Maximum pageKeys to follow per direction to guard against huge wallets. */
const ALCHEMY_MAX_PAGES = 50;

/* ── Alchemy getAssetTransfers — one direction, fully paginated ─────────── */
/**
 * @param {'from'|'to'} direction  — 'from' = outbound, 'to' = inbound
 * @returns {{ transfers: object[], truncated: boolean }}
 */
async function alchemyFetchDirection(url, address, direction, signal) {
  const paramKey = direction === 'from' ? 'fromAddress' : 'toAddress';
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
      maxCount:   '0x3e8', // 1 000 per page
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
    transfers = transfers.concat(page);
    pageKey   = data.result?.pageKey || undefined;
    pages++;

    if (!pageKey) break; // no more pages
  }

  if (pageKey) truncated = true; // still had pages but hit limit

  return { transfers, truncated };
}

/* ── Deduplicate raw Alchemy transfers ──────────────────────────────────── */
/**
 * Dedup key:
 *   - ERC-20/native/internal: hash + logIndex (or 'native' for eth external)
 * This preserves distinct transfers that share a hash (e.g. multi-hop swap)
 * while eliminating exact duplicates that come from querying both directions.
 */
function deduplicateTransfers(transfers) {
  const seen = new Set();
  return transfers.filter(t => {
    // logIndex is present for token transfers; use 'native' for ETH externals
    const logIdx = t.log?.logIndex != null ? String(t.log.logIndex) : 'native';
    const key    = (t.hash || '') + ':' + logIdx;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ── Normalize a raw Alchemy transfer to a canonical op ────────────────── */
function normalizeTransfer(t, address, network) {
  const addrLower  = (address || '').toLowerCase();
  const toLower    = (t.to   || '').toLowerCase();
  const fromLower  = (t.from || '').toLowerCase();
  const isIncoming = toLower === addrLower;

  return {
    hash:       t.hash        || null,
    ts:         t.metadata?.blockTimestamp
                  ? new Date(t.metadata.blockTimestamp).getTime()
                  : null,
    network:    network,           // always set from caller — never undefined
    isIncoming,
    rawType:    t.category   || 'unknown',
    assetId:    t.asset      || (t.category === 'external' ? 'ETH' : 'UNKNOWN'),
    qty:        parseFloat(t.value || 0),
    price:      0,                 // enriched below
    fees:       0,                 // gas enrichment deferred
    _from:      t.from       || null,
    _to:        t.to         || null,
    _logIndex:  t.log?.logIndex != null ? String(t.log.logIndex) : null,
    _contractAddress: t.rawContract?.address || null,
  };
}

/* ── Fetch all transfers for one EVM network (both directions) ───────────── */
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
    // Arc and Solana have their own adapters; other unknowns are unsupported
    if (network === 'arc') {
      return { ops: [], coverage: 'unavailable',
        note: 'Arc Mainnet transaction-history API not yet available' };
    }
    return { ops: [], coverage: 'unavailable', note: 'Unsupported network: ' + network };
  }
  if (!isSafeUrl(url)) {
    return { ops: [], coverage: 'error', note: 'RPC URL blocked by SSRF guard' };
  }

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 30000);

  try {
    // Fetch outbound and inbound in parallel — then dedup
    const [outRes, inRes] = await Promise.all([
      alchemyFetchDirection(url, address, 'from', controller.signal),
      alchemyFetchDirection(url, address, 'to',   controller.signal),
    ]);

    const raw    = [...outRes.transfers, ...inRes.transfers];
    const deduped = deduplicateTransfers(raw);
    const ops    = deduped.map(t => normalizeTransfer(t, address, network));

    const truncated = outRes.truncated || inRes.truncated;
    return {
      ops,
      coverage: truncated ? 'partial' : 'complete',
      ...(truncated ? { note: 'History truncated at ' + ALCHEMY_MAX_PAGES + ' pages per direction' } : {}),
    };
  } catch (e) {
    return { ops: [], coverage: 'error', note: e.message.slice(0, 120) };
  } finally {
    clearTimeout(timeout);
  }
}

/* ── Historical USD price (CoinGecko) ───────────────────────────────────── */
async function fetchPrice(assetId, ts, env) {
  const key = env.COINGECKO_API_KEY;
  // Without a key: stablecoins stay $1; other assets default to $1 (acknowledged limitation)
  if (!key) return 1;
  // CoinGecko expects DD-MM-YYYY
  const d    = new Date(ts);
  const date = [
    String(d.getUTCDate()).padStart(2, '0'),
    String(d.getUTCMonth() + 1).padStart(2, '0'),
    d.getUTCFullYear(),
  ].join('-');
  const idMap = {
    USDC: 'usd-coin', USDT: 'tether', ETH: 'ethereum',
    BTC: 'bitcoin', MATIC: 'matic-network', ARB: 'arbitrum', OP: 'optimism',
  };
  const cgId = idMap[assetId?.toUpperCase()] || assetId?.toLowerCase();
  if (!cgId) return 1;
  try {
    const resp = await fetch(
      // arc-studio-allow-onchain-literal
      `https://api.coingecko.com/api/v3/coins/${cgId}/history?date=${date}&localization=false`,
      { headers: { 'x-cg-pro-api-key': key }, signal: AbortSignal.timeout(5000) }
    );
    const data = await resp.json();
    return data.market_data?.current_price?.usd ?? 1;
  } catch (_) {
    return 1;
  }
}

/* ── Main handler ────────────────────────────────────────────────────────── */
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (_) { return errResp('Invalid JSON'); }

  const {
    address,
    targetType,
    networks = [],
    country  = 'US',
    quoteId,
    txHash,
    hasDefi,
  } = body;

  if (!address) return errResp('address required');
  if (!quoteId) return errResp('quoteId required');

  const isEvm = /^0x[0-9a-fA-F]{40}$/.test(address);

  // ── Collect from each selected network (serial to be kind to rate limits)
  let allOps      = [];
  const coverageMap = {};  // network → coverage string
  const noteMap     = {};  // network → note string (for partial/error)

  for (const net of networks) {
    if (net === 'solana' && isEvm) {
      coverageMap[net] = 'unavailable';
      noteMap[net]     = 'Solana history collection not yet implemented for EVM addresses';
      continue;
    }
    if (net === 'solana' && !isEvm) {
      coverageMap[net] = 'unavailable';
      noteMap[net]     = 'Solana history collection requires a separate adapter (not yet implemented)';
      continue;
    }
    if (net === 'arc') {
      coverageMap[net] = 'unavailable';
      noteMap[net]     = 'Arc Mainnet transaction-history API not yet publicly available';
      continue;
    }

    const res = await fetchEvmTxs(address, net, env);
    allOps             = allOps.concat(res.ops);
    coverageMap[net]   = res.coverage;
    if (res.note) noteMap[net] = res.note;
  }

  // Aggregate coverage: complete only if every network is complete
  const coverageValues = Object.values(coverageMap);
  const aggCoverage =
    coverageValues.every(c => c === 'complete')   ? 'complete'   :
    coverageValues.every(c => c === 'unavailable') ? 'unavailable' :
    coverageValues.some(c => c === 'error')        ? 'partial'    :
    'partial';

  // ── Enrich with historical prices (serial; cache by assetId+date)
  const priceCache = {};
  for (const op of allOps) {
    const key = (op.assetId || 'UNKNOWN') + ':' + (op.ts || 0);
    if (priceCache[key] === undefined) {
      priceCache[key] = await fetchPrice(op.assetId, op.ts, env);
    }
    op.price = priceCache[key];
  }

  // ── Classify
  const classified = allOps.map(classifyOp);
  const ops        = classified.filter(op => op.type !== 'ignored');
  const ignored    = classified.filter(op => op.type === 'ignored').length;

  // ── Run country rules
  const metrics = calcCountry(country, ops);
  metrics.classifiedOps       = ops.length;
  metrics.ignoredSelfTransfer = ignored;

  const countryMeta = COUNTRY_META[country] || COUNTRY_META['US'];

  // ── Period
  const period = (() => {
    const timestamps = allOps.map(t => t.ts).filter(Boolean).sort((a, b) => a - b);
    if (timestamps.length === 0) return null; // no data — do not invent a period
    const y0 = new Date(timestamps[0]).getFullYear();
    const y1 = new Date(timestamps[timestamps.length - 1]).getFullYear();
    return y0 === y1 ? String(y0) : y0 + '–' + y1;
  })();

  // ── Warnings for partial / unavailable coverage
  const warnings = [];
  for (const [net, cov] of Object.entries(coverageMap)) {
    if (cov !== 'complete') {
      warnings.push({ network: net, coverage: cov, note: noteMap[net] || cov });
    }
  }

  return jsonResp({
    ok:       true,
    address,
    country:  countryMeta,
    period,
    coverage: aggCoverage,
    partial:  aggCoverage !== 'complete',
    warnings: warnings.length ? warnings : undefined,
    metrics,
    ops:      ops.length > 0
      ? ops.slice(0, 500).map(op => ({
          date:    op.ts ? new Date(op.ts).toISOString().slice(0, 10) : null,
          chain:   op.network || null,   // always set; null only if genuinely unknown
          type:    op.type,
          in:      op.isIncoming  ? ((op.qty || 0).toFixed(4) + ' ' + (op.assetId || '?')) : null,
          out:     !op.isIncoming ? ((op.qty || 0).toFixed(4) + ' ' + (op.assetId || '?')) : null,
          usd:     parseFloat(((op.qty || 0) * (op.price || 0)).toFixed(2)),
          gas:     parseFloat((op.fees || 0).toFixed(4)),
          pl:      op.type === 'sell'
                     ? parseFloat(((( op.price || 0) - (op._costBasis || op.price || 0)) * (op.qty || 0)).toFixed(2))
                     : 0,
          hash:    op.hash || null,
        }))
      : [],  // empty array — NOT null — so the caller knows the collection ran but found nothing
    demo: false,  // never present a report as demo; caller must check coverage
  });
}
