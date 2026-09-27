/**
 * Cloudflare Pages Function — Arc Mainnet RPC proxy.
 * Route: POST /api/rpc/arc
 *
 * Why this exists: browsers cannot reach Arc RPC directly (CORS / connectivity).
 * This same-origin proxy fans out to the ordered fallback list and returns the
 * first valid JSON-RPC 200 response. eth_sendRawTransaction is allowed so that
 * kit.retry() can submit receiveMessage on Arc from the browser.
 *
 * Allowlisted methods only — no admin/debug RPCs.
 * Timeout per upstream: 8 s.
 *
 * Upstream endpoints are the official Arc Mainnet RPC endpoints from
 * https://docs.arc.io/arc/references/rpc-endpoints and
 * https://docs.arc.io/arc/tools/node-providers
 * All Arc Mainnet, chain 5042. // arc-studio-allow-onchain-literal
 */

const ARC_CHAIN_ID = '0x13b2'; // 5042 // arc-studio-allow-onchain-literal

// Official Arc Mainnet RPC endpoints — ordered by preference. // arc-studio-allow-onchain-literal
const UPSTREAMS = [
  'https://rpc.mainnet.arc.io',           // arc-studio-allow-onchain-literal
  'https://rpc.drpc.mainnet.arc.io',      // arc-studio-allow-onchain-literal
  'https://rpc.quicknode.mainnet.arc.io', // arc-studio-allow-onchain-literal
  'https://rpc.blockdaemon.mainnet.arc.io', // arc-studio-allow-onchain-literal
  'https://arc-rpc.publicnode.com',       // arc-studio-allow-onchain-literal
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

  // Validate method allowlist (batch and single).
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
      JSON.stringify({ jsonrpc: '2.0', id: body.id ?? null, result: ARC_CHAIN_ID }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    );
  }

  // Fan through upstreams in order, return first valid 200.
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
      // Verify it is valid JSON before forwarding.
      try { JSON.parse(text); } catch (_e) { lastError = `non-JSON from ${upstream}`; continue; }
      return new Response(text, {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    } catch (e) {
      lastError = e && e.message ? e.message : String(e);
    }
  }

  // All upstreams exhausted — return JSON-RPC error so the Kit can handle it.
  return jsonError(-32603, `Arc RPC unavailable: ${lastError}`, Array.isArray(body) ? null : (body.id ?? null), 502);
}

function jsonError(code, message, id, httpStatus) {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }),
    { status: httpStatus, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
  );
}
