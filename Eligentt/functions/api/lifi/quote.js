/**
 * LI.FI — quote proxy (server-side only).
 * ═══════════════════════════════════════════════════════════════════════
 * Guards the optional LIFI_API_KEY secret (never reaches the browser) and
 * forwards validated quote requests to the LI.FI API (https://li.quest/v1/quote).
 *
 *   GET  /api/lifi/quote  → availability check (no secret exposed)
 *   POST /api/lifi/quote  → forward a validated quote request to LI.FI
 *
 * Validation (fail-closed): every request must carry a valid chainId pair,
 * valid token addresses, a positive decimal amount string, a valid fromAddress,
 * and (optionally) a valid toAddress. Arbitrary upstream requests are rejected.
 *
 * LI.FI rate limits (no key): 200 req / 2h. With LIFI_API_KEY: 200 req / min.
 */
const LIFI_BASE = 'https://li.quest/v1';

const DEFAULT_ALLOWED_ORIGINS = 'https://elligente.pages.dev,https://elligentt.xyz,https://execdaat.xyz,https://elligente-tower.pages.dev';

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

function isAddress(a) {
  return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
}

function isChainId(n) {
  return Number.isFinite(Number(n)) && Number(n) > 0;
}

function isAmountString(s) {
  return typeof s === 'string' && /^[0-9]+$/.test(s) && BigInt(s) > 0n;
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.env, context.request) });
}

export async function onRequestGet(context) {
  const { env, request } = context;
  return json({ ok: true, available: true, provider: 'lifi' }, 200, env, request);
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ ok: false, error: 'Invalid JSON', code: 'BAD_JSON' }, 400, env, request);
  }
  body = body || {};

  // ── Fail-closed validation ────────────────────────────────────────────
  if (!isChainId(body.fromChain) || !isChainId(body.toChain)) {
    return json({ ok: false, error: 'Invalid fromChain/toChain', code: 'INVALID_CHAIN' }, 400, env, request);
  }
  if (!isAddress(body.fromToken) || !isAddress(body.toToken)) {
    return json({ ok: false, error: 'Invalid fromToken/toToken', code: 'INVALID_TOKEN' }, 400, env, request);
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

  // ── Build upstream query ──────────────────────────────────────────────
  const params = new URLSearchParams({
    fromChain: String(body.fromChain),
    toChain: String(body.toChain),
    fromToken: body.fromToken,
    toToken: body.toToken,
    fromAmount: body.fromAmount,
    fromAddress: body.fromAddress,
  });
  if (body.toAddress) params.set('toAddress', body.toAddress);
  if (body.slippage != null) {
    const s = Number(body.slippage);
    if (Number.isFinite(s) && s >= 0 && s <= 1) params.set('slippage', String(s));
  }
  if (typeof body.integrator === 'string' && body.integrator) params.set('integrator', body.integrator);

  const headers = { 'Content-Type': 'application/json' };
  const key = (env && env.LIFI_API_KEY) || '';
  if (key) headers['x-lifi-api-key'] = key;

  let upstream;
  try {
    upstream = await fetch(LIFI_BASE + '/quote?' + params.toString(), { method: 'GET', headers });
  } catch (e) {
    return json({ ok: false, error: 'LI.FI upstream unreachable: ' + (e.message || e), code: 'UPSTREAM_UNAVAILABLE' }, 502, env, request);
  }

  if (upstream.status === 404) {
    return json({ ok: false, error: 'No LI.FI route available for this transfer', code: 'NO_ROUTE' }, 404, env, request);
  }

  const data = await upstream.json().catch(() => null);
  if (upstream.status !== 200 || !data) {
    const code = upstream.status === 401 || upstream.status === 403 ? 'AUTH'
      : upstream.status === 429 ? 'RATE_LIMIT' : 'QUOTE_FAILED';
    return json({ ok: false, error: (data && data.message) || 'LI.FI quote failed', code }, 502, env, request);
  }

  return json({ ok: true, data }, 200, env, request);
}
