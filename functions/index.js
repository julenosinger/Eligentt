/**
 * Cloudflare Pages Function — Unified Middleware
 * - Injects API keys into index.html
 * - Proxies sensitive Circle API calls (server-side key)
 *
 * Environment Variables required (set in CF Dashboard):
 *   WC_PROJECT_ID   — WalletConnect v2 Project ID (public)
 *   TEST_API_KEY    — Circle API key (sensitive)
 *   KIT_KEY         — Circle App Kit key (sensitive)
 */
export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  // ── API Proxy: /api/circle/* → Circle APIs (key stays on server) ──
  if (url.pathname.startsWith('/api/circle/')) {
    return handleCircleProxy(request, env, url);
  }

  // ── API Proxy: /api/iris/* → Circle Iris sandbox ──
  if (url.pathname.startsWith('/api/iris/')) {
    return handleIrisProxy(request, url);
  }

  // ── Intercept SPA routes for HTML injection ──
  const isApiPath = url.pathname.startsWith('/api/');
  const hasExtension = /\.\w+$/.test(url.pathname);
  const isSpaRoute = !isApiPath && !hasExtension;
  if (!isSpaRoute) {
    return next();
  }

  // ── Serve index.html with key injection ──
  const response = await next();
  let html = await response.text();

  const kitKey      = env.KIT_KEY      || '';
  const testApiKey  = env.TEST_API_KEY  || '';
  const wcProjectId = env.WC_PROJECT_ID || '';

  // Replace placeholders
  html = html.replaceAll('__WC_PROJECT_ID_PLACEHOLDER__',  wcProjectId);
  html = html.replaceAll('__KIT_KEY_PLACEHOLDER__',        kitKey);
  html = html.replaceAll('__TEST_API_KEY_PLACEHOLDER__',    testApiKey);

  return new Response(html, {
    status: response.status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Content-Security-Policy-Report-Only': "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' data: blob:; style-src * 'unsafe-inline'; img-src * data: blob:; connect-src * data: blob: wss:; font-src * data:; worker-src * blob:; report-uri /api/csp-report",
    },
  });
}

// ── Proxy: Circle API (key stays on server, never exposed to client) ──
async function handleCircleProxy(request, env, url) {
  const apiKey = env.TEST_API_KEY || env.KIT_KEY || '';
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'API key not configured' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Rewrite path: /api/circle/v1/... → https://api.circle.com/v1/...
  const circlePath = url.pathname.replace('/api/circle', '');
  const circleUrl = 'https://api.circle.com' + circlePath + url.search;

  try {
    const resp = await fetch(circleUrl, {
      method: request.method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: request.method !== 'GET' && request.method !== 'HEAD'
        ? await request.text() : undefined,
    });

    const data = await resp.text();
    return new Response(data, {
      status: resp.status,
      headers: {
        'Content-Type': resp.headers.get('Content-Type') || 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Circle API unavailable' }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ── Proxy: Circle Iris API (sandbox, pass-through for CCTP attestation) ──
async function handleIrisProxy(request, url) {
  const irisPath = url.pathname.replace('/api/iris', '');
  const irisUrl = 'https://iris-api-sandbox.circle.com' + irisPath + url.search;

  try {
    const resp = await fetch(irisUrl, { method: request.method });
    const data = await resp.text();
    return new Response(data, {
      status: resp.status,
      headers: {
        'Content-Type': resp.headers.get('Content-Type') || 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Iris API unavailable' }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }
}
