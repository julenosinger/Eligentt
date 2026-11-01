/**
 * POST /api/tax/scan
 * Counts transactions per network for a given address.
 *
 * Required CF env vars:
 *   ETHERSCAN_API_KEY  — Etherscan V2 key (covers ETH/Base/Arb/OP/Polygon via chainid param)
 *   SOLANA_RPC_URL     — optional; Helius/Alchemy Solana RPC
 *   ARC_RPC_URL        — optional; Arc Mainnet RPC (tx history API TBD)
 *
 * Returns: { ok, results: [{ network, ops, status, error? }] }
 *   status: 'done' | 'not_configured' | 'not_supported' | 'coming_soon' | 'rate_limited' | 'failed'
 *
 * Rate limit: Etherscan free plan ≈5 req/s total.
 * We serialise EVM calls and throttle to max 4 req/s with exponential backoff on 429/rate-limit.
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
  // Evict if cache grows too large
  if (SCAN_CACHE.size > 500) {
    const oldest = [...SCAN_CACHE.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) SCAN_CACHE.delete(oldest[0]);
  }
}

/* ── Throttle: min gap between Etherscan calls = 250ms (4 req/s) ─────────── */
let _lastEtherscanCall = 0;
async function throttleEtherscan() {
  const gap = 250; // ms between calls
  const wait = _lastEtherscanCall + gap - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastEtherscanCall = Date.now();
}

/* ── Etherscan V2: fetch one action, return array of results ─────────────── */
async function etherscanFetch(chainId, action, address, apiKey, page = 1) {
  // arc-studio-allow-onchain-literal
  const url = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=account&action=${action}&address=${encodeURIComponent(address)}&startblock=0&endblock=99999999&page=${page}&offset=100&sort=asc&apikey=${apiKey}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const data = await resp.json();
  // Rate-limit signal
  if (data.message && /rate limit/i.test(data.message)) {
    const err = new Error('RATE_LIMIT');
    err.rateLimit = true;
    throw err;
  }
  // "No transactions found" is not an error — return empty
  if (data.status === '0' && data.message === 'No transactions found') return [];
  if (data.status !== '1' && !Array.isArray(data.result)) {
    throw new Error(data.message || data.result || 'Etherscan error');
  }
  return Array.isArray(data.result) ? data.result : [];
}

/* ── Fetch total op count for one EVM chain via Etherscan V2 ─────────────── */
async function countEtherscanOps(chainId, address, apiKey, retries = 2) {
  const actions = ['txlist', 'tokentx', 'txlistinternal'];
  let total = 0;
  for (const action of actions) {
    let attempt = 0;
    while (attempt <= retries) {
      try {
        await throttleEtherscan();
        const rows = await etherscanFetch(chainId, action, address, apiKey);
        total += rows.length;
        break; // success — next action
      } catch (e) {
        if (e.rateLimit && attempt < retries) {
          // Exponential backoff: 500ms, 1000ms, …
          await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
          attempt++;
          continue;
        }
        if (e.rateLimit) throw Object.assign(new Error('RATE_LIMIT'), { rateLimit: true });
        throw e;
      }
    }
  }
  return total;
}

/* ── Scan one EVM network ────────────────────────────────────────────────── */
async function scanEvm(network, address, env) {
  const apiKey = env.ETHERSCAN_API_KEY;
  if (!apiKey) {
    return { network, ops: 0, status: 'not_configured',
      error: 'ETHERSCAN_API_KEY not set in CF env' };
  }
  const chainId = ETHERSCAN_CHAIN[network];
  try {
    const ops = await countEtherscanOps(chainId, address, apiKey);
    return { network, ops, status: 'done' };
  } catch (e) {
    if (e.rateLimit) return { network, ops: 0, status: 'rate_limited', error: 'Rate limit — retry in a moment' };
    return { network, ops: 0, status: 'failed', error: e.message.slice(0, 120) };
  }
}

/* ── Scan Arc Mainnet ────────────────────────────────────────────────────── */
async function scanArc(address, env) {
  // Arc explorer tx-history API not yet publicly documented.
  // Use eth_getTransactionCount as a best-effort nonce count (outbound only).
  const rpcUrl = env.ARC_RPC_URL || null;
  if (!rpcUrl) {
    return { network: 'arc', ops: 0, status: 'coming_soon',
      error: 'Arc tx-history API not yet available — set ARC_RPC_URL to enable nonce scan' };
  }
  if (!isSafeUrl(rpcUrl)) return { network: 'arc', ops: 0, status: 'failed', error: 'RPC URL blocked' };
  try {
    const resp = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: [address, 'latest'] }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await resp.json();
    const nonce = data.result ? parseInt(data.result, 16) : 0;
    return { network: 'arc', ops: nonce, status: nonce > 0 ? 'done' : 'done',
      note: 'Outbound tx count only (full tx-history API coming soon)' };
  } catch (e) {
    return { network: 'arc', ops: 0, status: 'coming_soon',
      error: 'Arc tx-history API not yet available' };
  }
}

/* ── Scan Solana ─────────────────────────────────────────────────────────── */
async function scanSolana(address, env) {
  const rpcUrl = env.SOLANA_RPC_URL || null;
  if (!rpcUrl) {
    return { network: 'solana', ops: 0, status: 'not_configured',
      error: 'SOLANA_RPC_URL not set — add Helius or Alchemy Solana RPC to CF env' };
  }
  if (!isSafeUrl(rpcUrl)) return { network: 'solana', ops: 0, status: 'failed', error: 'RPC URL blocked' };
  try {
    const resp = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress',
        params: [address, { limit: 1000 }] }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await resp.json();
    const ops = Array.isArray(data.result) ? data.result.length : 0;
    return { network: 'solana', ops, status: 'done' };
  } catch (e) {
    return { network: 'solana', ops: 0, status: 'failed', error: e.message.slice(0, 120) };
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

  // Run EVM scans SERIALLY (respect throttle) — Arc and Solana can run alongside
  const results = [];

  for (const net of requested) {
    // Check cache first
    const cached = fromCache(address, net);
    if (cached) { results.push(cached); continue; }

    let r;
    if (net === 'arc') {
      r = isEvm
        ? await scanArc(address, env)
        : { network: 'arc', ops: 0, status: 'not_supported', error: 'EVM-only network' };
    } else if (net === 'solana') {
      r = isSolana
        ? await scanSolana(address, env)
        : { network: 'solana', ops: 0, status: 'not_supported', error: 'Solana address required' };
    } else if (ETHERSCAN_CHAIN[net] !== undefined) {
      r = isEvm
        ? await scanEvm(net, address, env)
        : { network: net, ops: 0, status: 'not_supported', error: 'EVM address required' };
    } else {
      r = { network: net, ops: 0, status: 'not_supported', error: 'Unknown network' };
    }

    toCache(address, net, r);
    results.push(r);
  }

  return jsonResp({ ok: true, address, results });
}
