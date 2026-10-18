/**
 * Cloudflare Pages Function — CPN (Circle Payments Network) proxy
 * Route: /api/cpn/*
 *
 * Proxies requests to the Circle CPN API (https://api.circle.com/v2/cpn/*),
 * injecting the CPN_API_KEY secret server-side. The key is NEVER sent to the
 * browser.
 *
 * Supported paths (mirrors the CPN OFI workflow):
 *   POST /api/cpn/quotes
 *   POST /api/cpn/payments
 *   POST /api/cpn/payments/:id/transactions
 *   POST /api/cpn/payments/:id/transactions/:txId/submit
 *   GET  /api/cpn/payments/:id
 *   GET  /api/cpn/health
 *
 * Environment secrets (set via `wrangler pages secret put`):
 *   CPN_API_KEY  — Circle developer API key with CPN OFI access (required)
 *
 * Without CPN_API_KEY the proxy returns a clear 503. There is no mock mode.
 *
 * Reference: https://developers.circle.com/cpn/fiat-payouts
 */

const CPN_BASE_URL = 'https://api.circle.com/v2/cpn';

const DEFAULT_ALLOWED_ORIGINS =
  'https://elligente.pages.dev,https://elligentttest.pages.dev,https://elligentt.xyz,https://execdaat.xyz';

// ── CORS ────────────────────────────────────────────────────────────────────

function getAllowedOrigins(env) {
  return ((env && env.ALLOWED_ORIGINS) || DEFAULT_ALLOWED_ORIGINS)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsHeaders(env, request) {
  const origin =
    (request && request.headers && request.headers.get('Origin')) || '';
  const allowed = getAllowedOrigins(env);
  const allow = allowed.includes(origin) ? origin : allowed[0] || '*';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, status, env, request) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(env, request),
    },
  });
}

// ── Route extraction ────────────────────────────────────────────────────────

/**
 * Extract the CPN sub-path from the Cloudflare Pages request URL.
 * /api/cpn/quotes          → "quotes"
 * /api/cpn/payments/abc    → "payments/abc"
 */
function extractCpnPath(url) {
  const u = new URL(url);
  const match = u.pathname.match(/^\/api\/cpn\/(.+)$/);
  return match ? match[1] : null;
}

// ── Input sanitisation ──────────────────────────────────────────────────────

const ALLOWED_PATHS = [
  /^quotes$/,
  /^payments$/,
  /^payments\/[a-zA-Z0-9_-]{1,80}$/,
  /^payments\/[a-zA-Z0-9_-]{1,80}\/transactions$/,
  /^payments\/[a-zA-Z0-9_-]{1,80}\/transactions\/[a-zA-Z0-9_-]{1,80}\/submit$/,
  /^health$/,
];

function isAllowedPath(path) {
  if (!path) return false;
  return ALLOWED_PATHS.some((re) => re.test(path));
}

// ── Main handler ────────────────────────────────────────────────────────────

export async function onRequest(context) {
  const { env, request } = context;

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(env, request) });
  }

  // Health check — reports whether CPN_API_KEY is configured
  const cpnPath = extractCpnPath(request.url);
  if (cpnPath === 'health') {
    const hasKey = !!(env && env.CPN_API_KEY);
    return jsonResponse({ ok: true, configured: hasKey }, 200, env, request);
  }

  // Validate sub-path against allowlist (fail-closed)
  if (!cpnPath || !isAllowedPath(cpnPath)) {
    return jsonResponse(
      { error: 'CPN path not allowed', path: cpnPath },
      400,
      env,
      request,
    );
  }

  // Require CPN_API_KEY — no fallback, no mock
  const apiKey = env && env.CPN_API_KEY;
  if (!apiKey) {
    return jsonResponse(
      {
        error: 'CPN not configured',
        message:
          'CPN_API_KEY is not set. Circle Payments Network requires OFI onboarding ' +
          'before live payments can be processed. ' +
          'See https://developers.circle.com/cpn/fiat-payouts',
        code: 'CPN_NOT_CONFIGURED',
      },
      503,
      env,
      request,
    );
  }

  // Forward to Circle CPN API
  const upstreamUrl = CPN_BASE_URL + '/' + cpnPath;
  const method = request.method;

  let upstreamBody = null;
  if (method === 'POST') {
    try {
      upstreamBody = await request.text();
    } catch (_) {
      return jsonResponse({ error: 'Failed to read request body' }, 400, env, request);
    }
  }

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
        'User-Agent': 'Elligentt-CPN-Proxy/1.0',
      },
      body: upstreamBody || undefined,
    });
  } catch (networkErr) {
    return jsonResponse(
      { error: 'CPN upstream unreachable', detail: String(networkErr) },
      502,
      env,
      request,
    );
  }

  // Stream the CPN response body back to the client — status code preserved
  const upstreamText = await upstreamRes.text();
  let upstreamJson;
  try {
    upstreamJson = JSON.parse(upstreamText);
  } catch (_) {
    upstreamJson = { raw: upstreamText };
  }

  return jsonResponse(upstreamJson, upstreamRes.status, env, request);
}
