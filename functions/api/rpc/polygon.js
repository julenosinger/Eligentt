/**
 * Cloudflare Pages Function — Polygon Mainnet RPC proxy.
 * Route: POST /api/rpc/polygon
 *
 * Symmetric to /api/rpc/arc. Exists so that the Arc→Polygon CCTP mint
 * (receiveMessage on Polygon's MessageTransmitterV2) can succeed even when
 * the browser cannot reach polygon-rpc.com directly (CORS / connectivity).
 *
 * eth_sendRawTransaction is allowed so that kit.retry() can submit
 * receiveMessage on Polygon from the browser.
 *
 * Polygon Mainnet, chain 137 (0x89). // arc-studio-allow-onchain-literal
 */

const POLYGON_CHAIN_ID = '0x89'; // 137 // arc-studio-allow-onchain-literal

// Polygon Mainnet RPC endpoints — ordered by preference. // arc-studio-allow-onchain-literal
const UPSTREAMS = [
  'https://polygon-rpc.com',                    // arc-studio-allow-onchain-literal
  'https://polygon-bor-rpc.publicnode.com',     // arc-studio-allow-onchain-literal
  'https://1rpc.io/matic',                      // arc-studio-allow-onchain-literal
  'https://polygon.llamarpc.com',               // arc-studio-allow-onchain-literal
  'https://rpc-mainnet.matic.quiknode.pro',     // arc-studio-allow-onchain-literal
];

const ALLOWED_METHODS = new Set([
  'eth_call',
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBalance',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_getCode',
  'eth_getLogs',
  'eth_sendRawTransaction',
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

  // eth_chainId shortcut — no upstream call needed.
  if (!Array.isArray(body) && body.method === 'eth_chainId') {
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: body.id ?? null, result: POLYGON_CHAIN_ID }),
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

  return jsonError(-32603, `Polygon RPC unavailable: ${lastError}`, Array.isArray(body) ? null : (body.id ?? null), 502);
}

function jsonError(code, message, id, httpStatus) {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }),
    { status: httpStatus, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
  );
}
