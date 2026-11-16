/**
 * GET /api/balance/etherscan
 * ═══════════════════════════════════════════════════════════════════════════
 * Server-side proxy for Etherscan V2 BALANCE reads (native + ERC-20).
 *
 * Why a proxy: ETHERSCAN_API_KEY must NEVER reach the browser. All Etherscan
 * traffic goes through this Cloudflare Pages Function so the key stays server-side.
 *
 * Endpoint:
 *   ?chainid=<1|42161|137>&address=<0x…>[&contractaddress=<0x…>]
 *
 *   - Native  (no contractaddress): module=account & action=balance
 *   - ERC-20  (contractaddress):    module=account & action=tokenbalance
 *
 * Free-tier eligibility (Phase 1.4):
 *   - Ethereum (1), Arbitrum (42161), Polygon (137)  → allowed.
 *   - Base (8453), Optimism (10), Arc (5042)         → NOT assumed free-tier;
 *     these ALWAYS use the RPC path and never call this endpoint.
 *
 * Rate limit: Etherscan free plan is ~5 req/s. This proxy throttles to ≤4 req/s
 * and shares the account quota with the tax scanner (which uses the same key).
 *
 * Safety:
 *   - Validates chainid, address and contractaddress.
 *   - Never interprets an Etherscan error/rate-limit as a confirmed zero —
 *     returns { ok:false } so the caller falls back to RPC.
 *   - Never logs or returns the API key.
 */
const ETHERSCAN_CHAIN = { 1: true, 42161: true, 137: true };

const ETHERSCAN_BASE = 'https://api.etherscan.io/v2/api';
const FETCH_TIMEOUT_MS = 12000;
const THROTTLE_MS = 250; // ≤4 req/s, shared with the tax scanner

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

const isAddr = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);

/* ── Global throttle (best-effort, per-isolate) ───────────────────────────── */
let _lastCall = 0;
async function throttle() {
  const wait = _lastCall + THROTTLE_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastCall = Date.now();
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const chainId = Number(url.searchParams.get('chainid'));
  const address = (url.searchParams.get('address') || '').trim();
  const contract = (url.searchParams.get('contractaddress') || '').trim();

  if (!ETHERSCAN_CHAIN[chainId]) {
    return json({ ok: false, error: 'unsupported_chain', chainid: chainId }, 400);
  }
  if (!isAddr(address)) {
    return json({ ok: false, error: 'invalid_address' }, 400);
  }
  if (contract && !isAddr(contract)) {
    return json({ ok: false, error: 'invalid_contractaddress' }, 400);
  }

  const apiKey = (env && env.ETHERSCAN_API_KEY) || '';
  if (!apiKey) {
    return json({ ok: false, error: 'ETHERSCAN_API_KEY not set in CF env' }, 500);
  }

  // Build the Etherscan V2 query. Native uses action=balance; ERC-20 uses
  // action=tokenbalance with the contract address.
  const params = new URLSearchParams({
    chainid: String(chainId),
    module: 'account',
    action: contract ? 'tokenbalance' : 'balance',
    address,
    tag: 'latest',
    apikey: apiKey,
  });
  if (contract) params.set('contractaddress', contract);

  const target = ETHERSCAN_BASE + '?' + params.toString();

  await throttle();

  let resp;
  try {
    resp = await fetch(target, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    return json({ ok: false, error: 'etherscan_fetch_failed' }, 502);
  }

  if (!resp.ok) {
    return json({ ok: false, error: 'etherscan_http_' + resp.status }, 502);
  }

  let data;
  try {
    data = await resp.json();
  } catch (_) {
    return json({ ok: false, error: 'etherscan_invalid_json' }, 502);
  }

  // Rate-limit signal → caller falls back to RPC (never a fake zero).
  if (data && data.message && /rate.?limit/i.test(data.message)) {
    return json({ ok: false, error: 'rate_limited' }, 429);
  }

  // A clean "0" balance is a valid result, but any other non-success status is
  // an error. result must be a numeric string.
  if (data && data.status === '1' && typeof data.result === 'string' && /^[0-9]+$/.test(data.result)) {
    return json({ ok: true, chainid: chainId, balance: data.result });
  }

  // "No transactions found" / empty → treat as zero only for balance action
  // (an account with no token balance). Otherwise surface the error.
  const msg = (data && data.message) || 'etherscan_error';
  if (/no (transactions|entries|records)/i.test(msg)) {
    return json({ ok: true, chainid: chainId, balance: '0' });
  }
  return json({ ok: false, error: msg.slice(0, 120) }, 502);
}
