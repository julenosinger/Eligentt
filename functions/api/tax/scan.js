/**
 * POST /api/tax/scan
 * Counts transactions per network for a given address.
 *
 * Phase 1.1.1 corrections on top of Phase 1:
 *   P0-B  countEtherscanOps() — returns separate counts per category
 *          (externalTxCount, tokenTransferCount, internalOperationCount,
 *           totalEvents, uniqueTransactionCount, coverage, truncatedEndpoints)
 *         plus per-endpoint 10 000-row truncation detection.
 *
 * Required CF env vars:
 *   ETHERSCAN_API_KEY  — Etherscan V2 key (covers ETH/Base/Arb/OP/Polygon via chainid param)
 *   SOLANA_RPC_URL     — optional; Helius/Alchemy Solana RPC
 *   ARC_RPC_URL        — optional; Arc Mainnet RPC (tx-history API not yet publicly available)
 *
 * Returns: { ok, results: [{ network, ops, counts?, status, coverage?, note?, error? }] }
 *   status:   'done' | 'not_configured' | 'not_supported' | 'coming_soon'
 *             | 'rate_limited' | 'failed' | 'unavailable'
 *   coverage: 'complete' | 'partial' | 'unavailable' | 'error'
 *
 *   counts (EVM only, when status === 'done'):
 *     externalTxCount:       transactions in txlist
 *     tokenTransferCount:    ERC-20/token Transfer events in tokentx
 *     internalOperationCount: internal ETH calls in txlistinternal
 *     totalEvents:           sum of above (fiscal events across categories, NOT unique hashes)
 *     uniqueTransactionCount: distinct hashes seen across all three endpoints
 *     truncatedEndpoints:    string[] of endpoint names that hit the page limit
 *
 * IMPORTANT — totalEvents ≠ uniqueTransactionCount:
 *   A single tx can emit multiple Transfer events (each in tokenTransferCount)
 *   AND an internal call (internalOperationCount) AND appear once in txlist.
 *   All three are legitimate fiscal events. Reporting totalEvents does NOT imply
 *   they are all separately taxable — classification happens in the report phase.
 *
 * Rate limit: Etherscan free plan ≈5 req/s total.
 * EVM calls run SERIALLY with 250 ms gap (4 req/s max) and exponential backoff on rate-limit.
 * Pagination: iterates all pages until the API returns fewer rows than the page size.
 */

import { jsonResp, errResp, isSafeUrl } from './_tax-utils.mjs';

/* ── Etherscan V2 chain IDs ─────────────────────────────────────────────── */
const ETHERSCAN_CHAIN = {
  ethereum: 1,
  base:     8453,
  arbitrum: 42161,
  optimism: 10,
  polygon:  137,
};

/** Page size for Etherscan pagination. Max allowed by API is 10 000. */
const ETHERSCAN_PAGE_SIZE = 1000;

/**
 * Max pages per action to guard against runaway wallets (1 000 × 50 = 50 000 rows).
 *
 * 10 000-row Etherscan limit:
 *   Etherscan's offset parameter is capped at 10 000 per page. We use
 *   ETHERSCAN_PAGE_SIZE=1 000 and up to ETHERSCAN_MAX_PAGES=50 pages per action.
 *   If any action returns a full last page at ETHERSCAN_MAX_PAGES we conservatively
 *   mark that endpoint as truncated and surface coverage:'partial'.
 *   We do NOT declare complete history when truncation cannot be ruled out.
 */
const ETHERSCAN_MAX_PAGES = 50;

/* ── In-process scan cache: address+network → { ts, result } ────────────── */
const SCAN_CACHE = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cacheKey(address, network) { return address.toLowerCase() + ':' + network; }

function fromCache(address, network) {
  const entry = SCAN_CACHE.get(cacheKey(address, network));
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { SCAN_CACHE.delete(cacheKey(address, network)); return null; }
  return entry.result;
}

function toCache(address, network, result) {
  SCAN_CACHE.set(cacheKey(address, network), { ts: Date.now(), result });
  // Evict if cache grows too large (keep newest 500 entries)
  if (SCAN_CACHE.size > 500) {
    const oldest = [...SCAN_CACHE.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) SCAN_CACHE.delete(oldest[0]);
  }
}

/* ── Throttle: min gap between Etherscan calls = 250 ms (≤4 req/s) ─────── */
let _lastEtherscanCall = 0;
async function throttleEtherscan() {
  const gap = 250;
  const wait = _lastEtherscanCall + gap - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastEtherscanCall = Date.now();
}

/* ── Etherscan V2: fetch ONE page for one action ────────────────────────── */
async function etherscanFetchPage(chainId, action, address, apiKey, page) {
  // arc-studio-allow-onchain-literal
  const url = [
    'https://api.etherscan.io/v2/api',
    '?chainid=', chainId,
    '&module=account',
    '&action=', action,
    '&address=', encodeURIComponent(address),
    '&startblock=0&endblock=99999999',
    '&page=', page,
    '&offset=', ETHERSCAN_PAGE_SIZE,
    '&sort=asc',
    '&apikey=', apiKey,
  ].join('');

  const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw Object.assign(new Error('HTTP ' + resp.status), { httpError: true });
  const data = await resp.json();

  // Rate-limit signal — throw so the retry loop handles it
  if (data.message && /rate.?limit/i.test(data.message)) {
    throw Object.assign(new Error('RATE_LIMIT'), { rateLimit: true });
  }
  // "No transactions found" is a clean empty result, not an error
  if (data.status === '0' && data.message === 'No transactions found') {
    return { rows: [], hasMore: false };
  }
  if (data.status !== '1' && !Array.isArray(data.result)) {
    throw new Error(data.message || String(data.result) || 'Etherscan error');
  }
  const rows = Array.isArray(data.result) ? data.result : [];
  // If we got a full page there may be more; if fewer, this is the last page
  return { rows, hasMore: rows.length >= ETHERSCAN_PAGE_SIZE };
}

/* ── Etherscan V2: paginate fully for one action ────────────────────────── */
/**
 * Returns:
 *   total:     total rows collected across all pages
 *   hashes:    Set<string> of unique tx hashes (to compute uniqueTransactionCount cross-action)
 *   truncated: true if pagination stopped before the last page was partial
 */
async function etherscanFetchAll(chainId, action, address, apiKey, maxRetries = 3) {
  let total     = 0;
  const hashes  = new Set();
  let page      = 1;

  while (page <= ETHERSCAN_MAX_PAGES) {
    let attempt = 0;
    let pageResult;

    while (attempt <= maxRetries) {
      try {
        await throttleEtherscan();
        pageResult = await etherscanFetchPage(chainId, action, address, apiKey, page);
        break; // success
      } catch (e) {
        if (e.rateLimit && attempt < maxRetries) {
          // Exponential backoff: 1 s, 2 s, 4 s
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
          attempt++;
          continue;
        }
        throw e; // exhausted retries or non-rate-limit error
      }
    }

    total += pageResult.rows.length;
    for (const row of pageResult.rows) {
      if (row.hash) hashes.add(row.hash.toLowerCase());
    }
    if (!pageResult.hasMore) break;
    page++;
  }

  // Conservative truncation: either we hit the page cap, OR total reached Etherscan's
  // documented 10 000-row limit per endpoint — in both cases we cannot claim completeness.
  const ETHERSCAN_PROVIDER_LIMIT = 10000;
  const truncated = page > ETHERSCAN_MAX_PAGES || total >= ETHERSCAN_PROVIDER_LIMIT;
  return { total, hashes, truncated };
}

/* ── Count ops for one EVM chain (txlist + tokentx + txlistinternal) ─────── */
/**
 * Returns per-category counts and a unified uniqueTransactionCount.
 *
 * Category semantics:
 *   txlist          → externalTxCount    — one entry per external transaction
 *   tokentx         → tokenTransferCount — one entry per ERC-20 Transfer event;
 *                     a tx that emits 3 token transfers appears 3 times here
 *   txlistinternal  → internalOperationCount — one entry per internal ETH call;
 *                     a tx with 2 internal calls appears 2 times here
 *
 * These categories are intentionally NOT deduplicated against each other:
 *   a tx in txlist that also emits a Transfer event represents TWO fiscal events
 *   (the native tx + the token movement). Classification happens in the report phase.
 *
 * totalEvents = externalTxCount + tokenTransferCount + internalOperationCount
 *   This is a count of FISCAL EVENTS across categories, not unique tx hashes.
 *
 * uniqueTransactionCount = |union of all tx hashes across all three endpoints|
 *   Useful for understanding "how many distinct txs are involved", but NOT the
 *   number of taxable events (one tx can generate many).
 *
 * truncatedEndpoints: string[] — each action name where the page limit was hit.
 *   If non-empty, coverage is 'partial' — we cannot claim a complete history.
 */
export async function countEtherscanOps(chainId, address, apiKey) {
  const actions = [
    { name: 'txlist',           label: 'externalTxCount'          },
    { name: 'tokentx',          label: 'tokenTransferCount'        },
    { name: 'txlistinternal',   label: 'internalOperationCount'    },
  ];

  const counts             = {};
  const truncatedEndpoints = [];
  const allHashes          = new Set();

  for (const { name, label } of actions) {
    const res       = await etherscanFetchAll(chainId, name, address, apiKey);
    counts[label]   = res.total;
    for (const h of res.hashes) allHashes.add(h);
    if (res.truncated) truncatedEndpoints.push(name);
  }

  const totalEvents            = (counts.externalTxCount || 0)
                               + (counts.tokenTransferCount || 0)
                               + (counts.internalOperationCount || 0);
  const uniqueTransactionCount = allHashes.size;
  const truncated              = truncatedEndpoints.length > 0;

  return {
    ...counts,
    totalEvents,
    uniqueTransactionCount,
    truncatedEndpoints,
    truncated,
  };
}

/* ── Scan one EVM network ────────────────────────────────────────────────── */
async function scanEvm(network, address, env) {
  const apiKey = env.ETHERSCAN_API_KEY;
  if (!apiKey) {
    return {
      network, ops: 0, status: 'not_configured', coverage: 'unavailable',
      error: 'ETHERSCAN_API_KEY not set in CF env',
    };
  }
  const chainId = ETHERSCAN_CHAIN[network];
  try {
    const result = await countEtherscanOps(chainId, address, apiKey);
    const { totalEvents, truncated, truncatedEndpoints, ...counts } = result;

    return {
      network,
      // ops: totalEvents for backward compat with the UI chip counter
      ops:      totalEvents,
      // counts: separate breakdown for informed display / audit
      counts:   {
        externalTxCount:        counts.externalTxCount,
        tokenTransferCount:     counts.tokenTransferCount,
        internalOperationCount: counts.internalOperationCount,
        totalEvents,
        uniqueTransactionCount: counts.uniqueTransactionCount,
      },
      status:   'done',
      coverage: truncated ? 'partial' : 'complete',
      ...(truncated ? {
        note: 'History truncated at limit for endpoint(s): ' + truncatedEndpoints.join(', ') +
              '. Full report will paginate further.',
        truncatedEndpoints,
      } : {}),
    };
  } catch (e) {
    if (e.rateLimit) {
      return { network, ops: 0, status: 'rate_limited', coverage: 'error',
        error: 'Rate limit reached — retry in a moment' };
    }
    return { network, ops: 0, status: 'failed', coverage: 'error',
      error: e.message.slice(0, 120) };
  }
}

/* ── Scan Arc Mainnet ────────────────────────────────────────────────────── */
/**
 * Arc Mainnet does not yet have a publicly documented transaction-history API
 * equivalent to Etherscan.
 * eth_getTransactionCount (nonce) is NOT a substitute for tx history:
 *   - it only counts outbound transactions (the nonce), never incoming transfers.
 *   - it is not a fiscal history.
 * We surface 'coming_soon' so the UI can inform the user without fabricating data.
 */
async function scanArc(_address, _env) {
  return {
    network:  'arc',
    ops:      0,
    status:   'coming_soon',
    coverage: 'unavailable',
    note:     'Arc Mainnet transaction-history API not yet publicly available. ' +
              'Full history support will be enabled once an indexer endpoint is documented.',
  };
}

/* ── Scan Solana ─────────────────────────────────────────────────────────── */
/**
 * Solana uses getSignaturesForAddress which returns at most 1 000 signatures per call
 * and requires before/until pagination for a full history.
 * Without SOLANA_RPC_URL the integration is not configured.
 * With it we return the first-page count as a lower-bound estimate (partial).
 * We never claim completeness from a single getSignaturesForAddress call.
 */
async function scanSolana(address, env) {
  const rpcUrl = env.SOLANA_RPC_URL || null;
  if (!rpcUrl) {
    return {
      network: 'solana', ops: 0, status: 'not_configured', coverage: 'unavailable',
      error: 'SOLANA_RPC_URL not set — add Helius or Alchemy Solana RPC to CF env',
    };
  }
  if (!isSafeUrl(rpcUrl)) {
    return { network: 'solana', ops: 0, status: 'failed', coverage: 'error',
      error: 'RPC URL blocked by SSRF guard' };
  }
  try {
    const resp = await fetch(rpcUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method:  'getSignaturesForAddress',
        params:  [address, { limit: 1000 }],
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message || 'Solana RPC error');
    const count = Array.isArray(data.result) ? data.result.length : 0;
    // A full page means there are likely more — mark partial
    const isPartial = count >= 1000;
    return {
      network:  'solana',
      ops:      count,
      status:   'done',
      coverage: isPartial ? 'partial' : 'complete',
      ...(isPartial ? { note: 'First 1 000 signatures returned — full history requires paginated scan' } : {}),
    };
  } catch (e) {
    return { network: 'solana', ops: 0, status: 'failed', coverage: 'error',
      error: e.message.slice(0, 120) };
  }
}

/* ── Main handler ────────────────────────────────────────────────────────── */
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (_) { return errResp('Invalid JSON'); }

  const { address, targetType, networks } = body;
  if (!address) return errResp('address required');

  const requested = Array.isArray(networks) && networks.length
    ? networks
    : ['arc', 'ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'solana'];

  const isEvm    = /^0x[0-9a-fA-F]{40}$/.test(address);
  const isSolana = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) && !isEvm;

  const results = [];

  for (const net of requested) {
    // Cache hit — use it, skip the API call
    const cached = fromCache(address, net);
    if (cached) { results.push(cached); continue; }

    let r;
    if (net === 'arc') {
      r = isEvm
        ? await scanArc(address, env)
        : { network: 'arc', ops: 0, status: 'not_supported', coverage: 'unavailable',
            error: 'Arc requires an EVM (0x…) address' };
    } else if (net === 'solana') {
      r = isSolana
        ? await scanSolana(address, env)
        : { network: 'solana', ops: 0, status: 'not_supported', coverage: 'unavailable',
            error: 'Solana requires a base-58 address' };
    } else if (ETHERSCAN_CHAIN[net] !== undefined) {
      r = isEvm
        ? await scanEvm(net, address, env)
        : { network: net, ops: 0, status: 'not_supported', coverage: 'unavailable',
            error: 'EVM networks require an 0x… address' };
    } else {
      r = { network: net, ops: 0, status: 'not_supported', coverage: 'unavailable',
        error: 'Unknown network: ' + net };
    }

    toCache(address, net, r);
    results.push(r);
  }

  return jsonResp({ ok: true, address, results });
}
