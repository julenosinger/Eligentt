/**
 * LI.FI — /advanced/stepTransaction proxy (server-side only).
 * ═══════════════════════════════════════════════════════════════════════
 * Called ONLY for the step selected by the user.
 * Forwards to https://li.quest/v1/advanced/stepTransaction and returns
 * the transactionRequest for that specific step.
 *
 *   POST /api/lifi/step-transaction  → get transactionRequest for a step
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

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.env, context.request) });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try { body = await request.json(); } catch (_) {
    return json({ ok: false, error: 'Invalid JSON', code: 'BAD_JSON' }, 400, env, request);
  }
  body = body || {};

  // The step object must be present
  if (!body.step || typeof body.step !== 'object') {
    return json({ ok: false, error: 'Missing step object', code: 'MISSING_STEP' }, 400, env, request);
  }

  // Basic sanity: step must have an id and action
  const step = body.step;
  if (!step.id || !step.action) {
    return json({ ok: false, error: 'Invalid step: missing id or action', code: 'INVALID_STEP' }, 400, env, request);
  }

  const headers = { 'Content-Type': 'application/json' };
  const key = (env && env.LIFI_API_KEY) || '';
  if (key) headers['x-lifi-api-key'] = key;

  let upstream;
  try {
    upstream = await fetch(LIFI_BASE + '/advanced/stepTransaction', {
      method: 'POST',
      headers,
      body: JSON.stringify({ step }),
    });
  } catch (e) {
    return json({ ok: false, error: 'LI.FI upstream unreachable: ' + (e.message || e), code: 'UPSTREAM_UNAVAILABLE' }, 502, env, request);
  }

  const data = await upstream.json().catch(() => null);
  if (upstream.status !== 200 || !data) {
    const code = (upstream.status === 401 || upstream.status === 403) ? 'AUTH'
      : upstream.status === 429 ? 'RATE_LIMIT' : 'STEP_TX_FAILED';
    return json({ ok: false, error: (data && data.message) || 'LI.FI stepTransaction failed', code }, 502, env, request);
  }

  // data is the step with transactionRequest populated
  return json({ ok: true, step: data }, 200, env, request);
}
