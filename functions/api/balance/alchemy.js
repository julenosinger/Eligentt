/**
 * POST /api/balance/alchemy
 * ═══════════════════════════════════════════════════════════════════════════
 * Server-side proxy for Alchemy BALANCE reads (native + ERC-20, incl. batching).
 *
 * Why a proxy: ALCHEMY_API_KEY must NEVER reach the browser. All Alchemy traffic
 * goes through this Cloudflare Pages Function so the key stays server-side and the
 * authenticated Alchemy URL is never exposed.
 *
 * Body (JSON):
 *   { chainid, address }                            → native eth_getBalance
 *   { chainid, address, contract }                  → single ERC-20 (backward-compatible)
 *   { chainid, address, contracts:[…] }             → BATCHED ERC-20 (Phase 1.4.3)
 *
 * Responses:
 *   native / single  → { ok:true, balance:"<decimal>" }
 *   batched          → { ok:true, balances:{ "<contract>":"<decimal>", … } }
 *
 * Allowlist (verified Alchemy mainnet endpoints): 1, 8453, 42161, 10, 137.
 * Arc (5042), Robinhood (4663) and HyperEVM (999) are deliberately NOT allowed.
 *
 * Safety:
 *   - No arbitrary RPC forwarding (only eth_getBalance / alchemy_getTokenBalances).
 *   - Strict body validation, allowlist, bounded contract count, dedup,
 *     bounded timeout and response-size guards.
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
const MAX_BODY_BYTES = 8192;
const MAX_RESPONSE_BYTES = 65536;
const MAX_CONTRACTS = 25;

// Sliding-window rate limit: ≤4 req/s.
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

  if (!ALCHEMY_NETWORKS[chainId]) {
    return json({ ok: false, error: 'unsupported_chain', chainid: chainId }, 400);
  }
  if (!isAddr(address)) {
    return json({ ok: false, error: 'invalid_address' }, 400);
  }

  // Resolve the ERC-20 contract list: single `contract` (backward-compatible)
  // or `contracts` array. Validate, lowercase and dedup.
  const contracts = [];
  const rawContracts = Array.isArray(body && body.contracts)
    ? body.contracts
    : (body && body.contract ? [body.contract] : []);
  for (const c of rawContracts) {
    const s = String(c || '').trim().toLowerCase();
    if (!s) continue;
    if (!isAddr(s)) return json({ ok: false, error: 'invalid_contract' }, 400);
    if (contracts.indexOf(s) === -1) contracts.push(s);
  }
  if (contracts.length > MAX_CONTRACTS) {
    return json({ ok: false, error: 'too_many_contracts', max: MAX_CONTRACTS }, 400);
  }

  const apiKey = (env && env.ALCHEMY_API_KEY) || '';
  if (!apiKey) {
    return json({ ok: false, error: 'ALCHEMY_API_KEY not set in CF env' }, 500);
  }

  if (!allowRequest()) {
    return json({ ok: false, error: 'rate_limited' }, 429);
  }

  const endpoint = ALCHEMY_NETWORKS[chainId] + '/' + apiKey;

  let rpc;
  if (contracts.length) {
    rpc = { jsonrpc: '2.0', id: 1, method: 'alchemy_getTokenBalances', params: [address, contracts] };
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

  if (data && data.error) {
    return json({ ok: false, error: 'rpc_error' }, 502);
  }

  const result = data && data.result;

  if (contracts.length) {
    // alchemy_getTokenBalances result: { address, tokenBalances:[{contractAddress, tokenBalance, error}] }
    const arr = result && Array.isArray(result.tokenBalances) ? result.tokenBalances : [];
    const balances = {};
    for (const c of contracts) {
      const entry = arr.find((t) => t && String(t.contractAddress).toLowerCase() === c);
      if (!entry || entry.error) continue; // per-token failure → omitted (never a fake zero)
      const dec = hexToDecimal(entry.tokenBalance);
      if (dec != null) balances[c] = dec;
    }
    // Backward compatibility: a single requested contract returns `balance`.
    if (contracts.length === 1) {
      const only = balances[contracts[0]];
      if (only == null) return json({ ok: false, error: 'token_balance_unavailable' }, 502);
      return json({ ok: true, chainid: chainId, balance: only });
    }
    return json({ ok: true, chainid: chainId, balances });
  }

  const dec = hexToDecimal(result);
  if (dec == null) return json({ ok: false, error: 'invalid_balance' }, 502);
  return json({ ok: true, chainid: chainId, balance: dec });
}
