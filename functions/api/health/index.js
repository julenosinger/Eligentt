const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet(context) {
  const { env } = context;
  const rpcPrimary = env.ARC_RPC_URL || 'https://arc-testnet.drpc.org';
  const rpcFallback = env.ARC_RPC_FALLBACK || null;
  const startTime = Date.now();

  async function checkRPC(url) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const data = await resp.json();
      return {
        url,
        status: 'ok',
        blockNumber: parseInt(data.result, 16),
        latency: Date.now() - startTime,
      };
    } catch (e) {
      return { url, status: 'error', error: e.message, latency: Date.now() - startTime };
    }
  }

  const primary = await checkRPC(rpcPrimary);
  const fallback = rpcFallback ? await checkRPC(rpcFallback) : null;

  const kvBindings = [];
  if (env.AUTH_KV) kvBindings.push('AUTH_KV');
  if (env.PAYMENT_LINKS) kvBindings.push('PAYMENT_LINKS');
  if (env.RATE_LIMIT_KV) kvBindings.push('RATE_LIMIT_KV');

  const health = {
    status: primary.status === 'ok' ? 'ok' : (fallback?.status === 'ok' ? 'degraded' : 'error'),
    network: 'Arc Testnet',
    chainId: 5042002,
    rpc: {
      primary,
      fallback: fallback || { status: 'not_configured' },
    },
    services: {
      relayer: !!env.TURBO_RELAYER_PRIVATE_KEY,
      auth: !!env.AUTH_KV,
      payments: !!env.PAYMENT_LINKS,
      rateLimiting: !!env.RATE_LIMIT_KV,
    },
    kv: kvBindings,
    timestamp: new Date().toISOString(),
    uptime: Date.now() - startTime + 'ms',
    version: '4.0.0',
  };

  const statusCode = health.status === 'ok' ? 200 : health.status === 'degraded' ? 200 : 503;
  return new Response(JSON.stringify(health), { status: statusCode, headers: CORS });
}
