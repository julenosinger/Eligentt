/**
 * Cloudflare Pages Function — Arbitrum One RPC proxy (read-only).
 * Route: POST /api/rpc/arbitrum
 *
 * Allows the RWA Trade Terminal to read ERC-20 balanceOf for RWA tokens
 * on Arbitrum without CORS restrictions from the browser.
 *
 * Read-only — eth_sendRawTransaction is intentionally excluded.
 * Timeout per upstream: 8 s.
 *
 * Arbitrum One, chain 42161 (0xa4b1). // arc-studio-allow-onchain-literal
 */

const ARB_CHAIN_ID = '0xa4b1'; // 42161 // arc-studio-allow-onchain-literal

// Arbitrum One public RPC endpoints — ordered by preference. // arc-studio-allow-onchain-literal
const UPSTREAMS = [
  'https://arb1.arbitrum.io/rpc',           // arc-studio-allow-onchain-literal
  'https://arbitrum.llamarpc.com',          // arc-studio-allow-onchain-literal
  'https://arbitrum.publicnode.com',        // arc-studio-allow-onchain-literal
  'https://rpc.ankr.com/arbitrum',         // arc-studio-allow-onchain-literal
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
      return jsonError(-32600, 'Invalid Request', req?.id ?? null, 400);
    }
    if (!ALLOWED_METHODS.has(req.method)) {
      return jsonError(-32601, `Method not allowed: ${req.method}`, req.id, 403);
    }
  }

  const upstream = await tryUpstreams(UPSTREAMS, body);
  if (!upstream.ok) {
    return jsonError(-32603, 'All upstream RPCs failed', null, 502);
  }

  const data = await upstream.json();
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

async function tryUpstreams(urls, body) {
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) return res;
    } catch (_e) { /* try next */ }
  }
  return { ok: false };
}

function jsonError(code, message, id, status) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
