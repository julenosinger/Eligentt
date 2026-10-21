/**
 * Cloudflare Pages Function — Ethereum Mainnet RPC proxy (read-only).
 * Route: POST /api/rpc/ethereum
 *
 * Symmetric to /api/rpc/arc and /api/rpc/polygon. Exists so the RWA Trade
 * Terminal can read ERC-20 balanceOf for RWA tokens on Ethereum without hitting
 * CORS restrictions when making direct eth_call from the browser.
 *
 * Read-only — eth_sendRawTransaction is intentionally excluded.
 * Timeout per upstream: 8 s.
 *
 * Ethereum Mainnet, chain 1 (0x1). // arc-studio-allow-onchain-literal
 */

const ETH_CHAIN_ID = '0x1'; // 1 // arc-studio-allow-onchain-literal

// Ethereum Mainnet public RPC endpoints — ordered by preference. // arc-studio-allow-onchain-literal
const UPSTREAMS = [
  'https://eth.llamarpc.com',              // arc-studio-allow-onchain-literal
  'https://rpc.ankr.com/eth',             // arc-studio-allow-onchain-literal
  'https://ethereum.publicnode.com',      // arc-studio-allow-onchain-literal
  'https://cloudflare-eth.com',           // arc-studio-allow-onchain-literal
];

// Read-only allowlist — no eth_sendRawTransaction.
const ALLOWED_METHODS = new Set([
  'eth_call',
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBalance',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_getCode',
  'eth_getLogs',
  'eth_gasPrice',
  'eth_getBlockByNumber',
  'eth_getTransactionByHash',
  'net_version',
]);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  let body;
  try {
    body = await context.request.json();
  } catch (_e) {
    return jsonError(-32700, 'Parse error', null, 400);
  }

  const requests = Array.isArray(body) ? body : [body];
  for (const req of requests) {
    if (!req || typeof req.method !== 'string') {
      return jsonError(-32600, 'Invalid request', req && req.id != null ? req.id : null, 400);
    }
    if (!ALLOWED_METHODS.has(req.method)) {
      return jsonError(-32601, `Method not allowed: ${req.method}`, req.id ?? null, 403);
    }
  }

  const payload = JSON.stringify(body);

  if (!Array.isArray(body) && body.method === 'eth_chainId') {
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: body.id ?? null, result: ETH_CHAIN_ID }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    );
  }

  let lastError = 'all upstreams failed';
  for (const upstream of UPSTREAMS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      let res;
      try {
        res = await fetch(upstream, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) { lastError = `HTTP ${res.status} from ${upstream}`; continue; }
      const text = await res.text();
      try { JSON.parse(text); } catch (_e) { lastError = `non-JSON from ${upstream}`; continue; }
      return new Response(text, {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    } catch (e) {
      lastError = e && e.message ? e.message : String(e);
    }
  }

  return jsonError(-32603, `Ethereum RPC unavailable: ${lastError}`, Array.isArray(body) ? null : (body.id ?? null), 502);
}

function jsonError(code, message, id, httpStatus) {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }),
    { status: httpStatus, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
  );
}
