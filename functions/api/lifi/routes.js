/**
 * LI.FI — /advanced/routes proxy (server-side only).
 * ═══════════════════════════════════════════════════════════════════════
 * Forwards validated requests to https://li.quest/v1/advanced/routes
 * and returns ALL available routes so the UI can present a comparison.
 *
 *   GET  /api/lifi/routes  → availability check
 *   POST /api/lifi/routes  → fetch multiple routes from LI.FI
 *
 * Never exposes LIFI_API_KEY to the browser.
 */
const LIFI_BASE = 'https://li.quest/v1';
const DEFAULT_ALLOWED_ORIGINS = 'https://elligente.pages.dev,https://elligentttest.pages.dev,https://elligentt.xyz,https://execdaat.xyz,https://elligente-tower.pages.dev';

function allowedOrigins(env) {
  return ((env && env.ALLOWED_ORIGINS) || DEFAULT_ALLOWED_ORIGINS).split(',').map((s) => s.trim()).filter(Boolean);
}

function corsHeaders(env, request) {
  const origin = (request && request.headers && request.headers.get && request.headers.get('Origin')) || '';
  const allow = allowedOrigins(env).includes(origin) ? origin : allowedOrigins(env)[0] || '*';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, status, env, request) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders(env, request)),
  });
}

function isAddress(a) { return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a); }
function isChainId(n) { return Number.isFinite(Number(n)) && Number(n) > 0; }
function isAmountString(s) { return typeof s === 'string' && /^[0-9]+$/.test(s) && BigInt(s) > 0n; }

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.env, context.request) });
}

export async function onRequestGet(context) {
  return json({ ok: true, available: true, provider: 'lifi', endpoint: 'routes' }, 200, context.env, context.request);
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try { body = await request.json(); } catch (_) {
    return json({ ok: false, error: 'Invalid JSON', code: 'BAD_JSON' }, 400, env, request);
  }
  body = body || {};

  // Fail-closed validation
  if (!isChainId(body.fromChainId) || !isChainId(body.toChainId)) {
    return json({ ok: false, error: 'Invalid fromChainId/toChainId', code: 'INVALID_CHAIN' }, 400, env, request);
  }
  if (!isAddress(body.fromTokenAddress) || !isAddress(body.toTokenAddress)) {
    return json({ ok: false, error: 'Invalid fromTokenAddress/toTokenAddress', code: 'INVALID_TOKEN' }, 400, env, request);
  }
  if (!isAmountString(body.fromAmount)) {
    return json({ ok: false, error: 'Invalid fromAmount', code: 'INVALID_AMOUNT' }, 400, env, request);
  }
  if (!isAddress(body.fromAddress)) {
    return json({ ok: false, error: 'Invalid fromAddress', code: 'INVALID_ADDRESS' }, 400, env, request);
  }
  if (body.toAddress != null && !isAddress(body.toAddress)) {
    return json({ ok: false, error: 'Invalid toAddress', code: 'INVALID_ADDRESS' }, 400, env, request);
  }

  const slippage = (body.slippage != null && Number.isFinite(Number(body.slippage)) && Number(body.slippage) >= 0 && Number(body.slippage) <= 1)
    ? Number(body.slippage) : 0.005;

  const upstream_body = {
    fromChainId: Number(body.fromChainId),
    toChainId: Number(body.toChainId),
    fromTokenAddress: body.fromTokenAddress,
    toTokenAddress: body.toTokenAddress,
    fromAmount: body.fromAmount,
    fromAddress: body.fromAddress,
    toAddress: body.toAddress || body.fromAddress,
    options: {
      slippage: slippage,
      integrator: (typeof body.integrator === 'string' && body.integrator) ? body.integrator : 'elligentt',
      order: 'RECOMMENDED',
    },
  };

  const headers = { 'Content-Type': 'application/json' };
  const key = (env && env.LIFI_API_KEY) || '';
  if (key) headers['x-lifi-api-key'] = key;

  let upstream;
  try {
    upstream = await fetch(LIFI_BASE + '/advanced/routes', {
      method: 'POST',
      headers,
      body: JSON.stringify(upstream_body),
    });
  } catch (e) {
    return json({ ok: false, error: 'LI.FI upstream unreachable: ' + (e.message || e), code: 'UPSTREAM_UNAVAILABLE' }, 502, env, request);
  }

  if (upstream.status === 404) {
    return json({ ok: false, error: 'No LI.FI routes available for this transfer', code: 'NO_ROUTE' }, 404, env, request);
  }

  const data = await upstream.json().catch(() => null);
  if (upstream.status !== 200 || !data) {
    const code = (upstream.status === 401 || upstream.status === 403) ? 'AUTH'
      : upstream.status === 429 ? 'RATE_LIMIT' : 'ROUTES_FAILED';
    return json({ ok: false, error: (data && data.message) || 'LI.FI routes failed', code }, 502, env, request);
  }

  // data.routes is the array from LI.FI — pass through unmodified
  return json({ ok: true, routes: data.routes || [], count: (data.routes || []).length }, 200, env, request);
}
