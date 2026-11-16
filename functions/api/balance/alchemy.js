/**
 * POST /api/balance/alchemy
 * ═══════════════════════════════════════════════════════════════════════════
 * Server-side proxy for Alchemy BALANCE reads (native + ERC-20).
 *
 * Why a proxy: ALCHEMY_API_KEY must NEVER reach the browser. All Alchemy traffic
 * goes through this Cloudflare Pages Function so the key stays server-side and the
 * authenticated Alchemy URL is never exposed.
 *
 * Body (JSON): { chainid, address, contract? }
 *   - Native  (no contract): eth_getBalance                    → { ok:true, balance }
 *   - ERC-20  (contract):    alchemy_getTokenBalances (single) → { ok:true, balance }
 *
 * Allowlist (verified Alchemy mainnet endpoints):
 *   1     → eth-mainnet.g.alchemy.com
 *   8453  → base-mainnet.g.alchemy.com
 *   42161 → arb-mainnet.g.alchemy.com
 *   10    → opt-mainnet.g.alchemy.com
 *   137   → polygon-mainnet.g.alchemy.com
 *
 * Arc (5042), Robinhood (4663) and HyperEVM (999) are deliberately NOT in the
 * allowlist: Arc is protected (never routed through Alchemy) and Robinhood/
 * HyperEVM are not production swap networks.
 *
 * Safety:
 *   - No arbitrary RPC forwarding (only eth_getBalance / alchemy_getTokenBalances).
 *   - Strict body validation, allowlist, bounded timeout, response-size guard.
 *   - Rate-limited (sliding window) below the account limit.
 *   - Never logs the API key; never returns a fabricated zero on failure.
 */
const ALCHEMY_NETWORKS = {
  1:     'https://eth-mainnet.g.alchemy.com/v2',
  8453:  'https://base-mainnet.g.alchemy.com/v2',
  42161: 'https://arb-mainnet.g.alchemy.com/v2',
  10:    'https://opt-mainnet.g.alchemy.com/v2',
  137:   'https://polygon-mainnet.g.alchemy.com/v2',
};

const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 4096;
const MAX_RESPONSE_BYTES = 16384;

// Sliding-window rate limit: ≤4 req/s (shared with Etherscan traffic budget).
const RATE_WINDOW_MS = 1000;
const RATE_MAX = 4;
let _window = [];

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

const isAddr = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);

function allowRequest() {
  const now = Date.now();
  _window = _window.filter((ts) => now - ts < RATE_WINDOW_MS);
  if (_window.length >= RATE_MAX) return false;
  _window.push(now);
  return true;
}

// Hex ("0x…") → decimal string (exact integer precision, BigInt).
function hexToDecimal(hex) {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]*$/.test(hex)) return null;
  try { return BigInt(hex).toString(); } catch (_) { return null; }
}

export async function onRequestPost({ request, env }) {
  // Body-size guard.
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: 'payload_too_large' }, 413);
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const chainId = Number(body && body.chainid);
  const address = String((body && body.address) || '').trim();
  const contract = (body && body.contract) ? String(body.contract).trim() : '';

  if (!ALCHEMY_NETWORKS[chainId]) {
    return json({ ok: false, error: 'unsupported_chain', chainid: chainId }, 400);
  }
  if (!isAddr(address)) {
    return json({ ok: false, error: 'invalid_address' }, 400);
  }
  if (contract && !isAddr(contract)) {
    return json({ ok: false, error: 'invalid_contract' }, 400);
  }

  const apiKey = (env && env.ALCHEMY_API_KEY) || '';
  if (!apiKey) {
    return json({ ok: false, error: 'ALCHEMY_API_KEY not set in CF env' }, 500);
  }

  if (!allowRequest()) {
    return json({ ok: false, error: 'rate_limited' }, 429);
  }

  const endpoint = ALCHEMY_NETWORKS[chainId] + '/' + apiKey;

  // Native → eth_getBalance; ERC-20 → alchemy_getTokenBalances (single contract).
  let rpc;
  if (contract) {
    rpc = {
      jsonrpc: '2.0', id: 1,
      method: 'alchemy_getTokenBalances',
      params: [address, [contract]],
    };
  } else {
    rpc = { jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] };
  }

  let resp;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rpc),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (_) {
    return json({ ok: false, error: 'alchemy_fetch_failed' }, 502);
  }

  if (!resp.ok) {
    return json({ ok: false, error: 'alchemy_http_' + resp.status }, 502);
  }

  let text;
  try {
    text = await resp.text();
    if (text.length > MAX_RESPONSE_BYTES) return json({ ok: false, error: 'response_too_large' }, 502);
  } catch (_) {
    return json({ ok: false, error: 'alchemy_read_failed' }, 502);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    return json({ ok: false, error: 'alchemy_invalid_json' }, 502);
  }

  // JSON-RPC error → unavailable (never a fabricated zero).
  if (data && data.error) {
    return json({ ok: false, error: 'rpc_error' }, 502);
  }

  const result = data && data.result;

  if (contract) {
    // alchemy_getTokenBalances result: { address, tokenBalances:[{contractAddress, tokenBalance, error}] }
    const arr = result && Array.isArray(result.tokenBalances) ? result.tokenBalances : null;
    const entry = arr && arr.find((t) => t && String(t.contractAddress).toLowerCase() === contract.toLowerCase());
    if (!entry || entry.error) {
      return json({ ok: false, error: 'token_balance_unavailable' }, 502);
    }
    const dec = hexToDecimal(entry.tokenBalance);
    if (dec == null) return json({ ok: false, error: 'invalid_balance' }, 502);
    return json({ ok: true, chainid: chainId, balance: dec });
  }

  // eth_getBalance result: hex string.
  const dec = hexToDecimal(result);
  if (dec == null) return json({ ok: false, error: 'invalid_balance' }, 502);
  return json({ ok: true, chainid: chainId, balance: dec });
}
