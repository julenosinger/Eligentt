/**
 * LI.FI — cross-chain transfer status proxy (server-side only).
 * ═══════════════════════════════════════════════════════════════════════
 * Forwards validated status checks to https://li.quest/v1/status. Used to poll
 * a cross-chain LI.FI route after the source transaction is broadcast.
 *
 *   POST /api/lifi/status  → { txHash, bridge?, fromChain, toChain }
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

function isTxHash(h) {
  return typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h);
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

  if (!isTxHash(body.txHash)) {
    return json({ ok: false, error: 'Invalid txHash', code: 'INVALID_TX_HASH' }, 400, env, request);
  }

  const params = new URLSearchParams({ txHash: body.txHash });
  if (typeof body.bridge === 'string' && body.bridge) params.set('bridge', body.bridge);
  if (Number.isFinite(Number(body.fromChain))) params.set('fromChain', String(body.fromChain));
  if (Number.isFinite(Number(body.toChain))) params.set('toChain', String(body.toChain));

  const headers = { 'Content-Type': 'application/json' };
  const key = (env && env.LIFI_API_KEY) || '';
  if (key) headers['x-lifi-api-key'] = key;

  let upstream;
  try {
    upstream = await fetch(LIFI_BASE + '/status?' + params.toString(), { method: 'GET', headers });
  } catch (e) {
    return json({ ok: false, error: 'LI.FI upstream unreachable: ' + (e.message || e), code: 'UPSTREAM_UNAVAILABLE' }, 502, env, request);
  }

  const data = await upstream.json().catch(() => null);
  if (upstream.status !== 200 || !data) {
    return json({ ok: false, error: (data && data.message) || 'LI.FI status failed', code: 'STATUS_FAILED' }, 502, env, request);
  }

  return json({ ok: true, data }, 200, env, request);
}
