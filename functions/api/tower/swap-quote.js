/**
 * Tower Exchange — swap quote proxy (server-side only).
 * ═══════════════════════════════════════════════════════════════════════
 * Guards the TOWER_API_KEY secret (never reaches the browser) and normalizes
 * Tower's response into the generic field names the frontend TowerAdapter expects
 * (expectedOut / minOut / calldata / to / spender / value / approval).
 *
 *   GET  /api/tower/swap-quote  → availability check (no secret exposed)
 *   POST /api/tower/swap-quote  → forward quote (and optional build-tx) to Tower
 *
 * Upstream (official Tower API — https://docs.tower.exchange):
 *   POST /api/public/swap/quote     → optimal swap quote
 *   POST /api/public/swap/build-tx  → unsigned swap tx (calldata + approval)
 * Auth: Authorization: Bearer <TOWER_API_KEY>
 */
const TOWER_BASE = 'https://www.tower.exchange/api/public';

const DEFAULT_ALLOWED_ORIGINS = 'https://elligente.pages.dev,https://elligentt.xyz,https://execdaat.xyz';

// Tower normalizes amounts to 18 decimals. Elligentt's token registry uses native
// decimals (USDC/EURC = 6, cirBTC = 8). We scale output amounts back to native
// decimals so the frontend's formatUnits(..., tOut.decimals) stays correct.
const TOWER_DECIMALS = 18;
const TOKEN_DECIMALS = {
  '0x3600000000000000000000000000000000000000': 6, // USDC
  '0x89b50855aa3be2f677cd6303cec089b5f319d72a': 6, // EURC
  '0xf0c4a4ce82a5746abaad9425360ab04fbba432bf': 8, // cirBTC
};

function nativeDecimals(tokenAddress) {
  return TOKEN_DECIMALS[String(tokenAddress || '').toLowerCase()] ?? TOWER_DECIMALS;
}

// Convert a Tower 18-decimal amount string to the token's native decimals.
function scaleToNative(raw, tokenAddress) {
  if (raw == null) return null;
  const dec = nativeDecimals(tokenAddress);
  let big;
  try { big = BigInt(String(raw)); } catch (_) { return null; }
  if (dec >= TOWER_DECIMALS) return big.toString();
  return (big / (10n ** BigInt(TOWER_DECIMALS - dec))).toString();
}

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

async function towerFetch(env, path, body) {
  const key = (env && env.TOWER_API_KEY) || '';
  if (!key) return { configured: false, status: 503, data: { success: false, error: 'Tower API key not configured' } };
  let resp;
  try {
    resp = await fetch(TOWER_BASE + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  } catch (e) {
    return { configured: true, status: 502, data: { success: false, error: 'Tower upstream unreachable: ' + (e.message || e) } };
  }
  const data = await resp.json().catch(() => ({}));
  return { configured: true, status: resp.status, data };
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.env, context.request) });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const available = !!(env && env.TOWER_API_KEY);
  return json({ ok: true, available, provider: 'tower' }, 200, env, request);
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

  const inputToken = body.inputToken;
  const outputToken = body.outputToken;
  const inputAmount = body.inputAmount;
  if (!inputToken || !outputToken || inputAmount == null) {
    return json({ ok: false, error: 'Missing inputToken/outputToken/inputAmount', code: 'MISSING_FIELDS' }, 400, env, request);
  }
  const slippageTolerance = body.slippageTolerance != null ? Number(body.slippageTolerance) : 50;
  const userAddress = isAddress(body.userAddress) ? String(body.userAddress).toLowerCase() : null;

  // ── 1. Optimal quote ──────────────────────────────────────────────
  const quoteRes = await towerFetch(env, '/swap/quote', { inputToken, outputToken, inputAmount, slippageTolerance });
  if (!quoteRes.configured) {
    return json({ ok: false, error: quoteRes.data.error, code: 'NO_KEY' }, 503, env, request);
  }
  if (quoteRes.status !== 200 || !quoteRes.data || quoteRes.data.success !== true || !quoteRes.data.data) {
    const code = quoteRes.status === 401 || quoteRes.status === 403 ? 'AUTH' : quoteRes.status === 429 ? 'RATE_LIMIT' : 'QUOTE_FAILED';
    return json({ ok: false, error: (quoteRes.data && quoteRes.data.error) || 'Tower quote failed', code }, 502, env, request);
  }
  const q = quoteRes.data.data;

  // Normalize to generic field names the frontend adapter consumes.
  const data = {
    inputToken: q.inputToken || null,
    outputToken: q.outputToken || null,
    inputAmount: q.inputAmount != null ? String(q.inputAmount) : null,
    expectedOut: scaleToNative(q.outputAmount, q.outputToken),
    minOut: scaleToNative(q.minOut, q.outputToken),
    priceImpact: q.priceImpact != null ? q.priceImpact : null,
    gasEstimate: q.gasEstimate != null ? String(q.gasEstimate) : null,
    feeBps: q.feeBps != null ? q.feeBps : null,
    dexId: q.dexId || null,
    dexName: q.dexName || null,
    route: q.route || null,
    calldata: null,
    to: null,
    spender: null,
    value: '0',
    approval: null,
  };

  // ── 2. Unsigned swap tx (only when a user address is present) ─────
  if (userAddress) {
    try {
      const txRes = await towerFetch(env, '/swap/build-tx', { quote: q, userAddress });
      if (txRes.configured && txRes.status === 200 && txRes.data && txRes.data.success === true && txRes.data.data && txRes.data.data.swap) {
        const s = txRes.data.data.swap;
        if (isAddress(s.to) && s.data && /^0x[0-9a-fA-F]+$/.test(s.data)) {
          data.calldata = s.data;
          data.to = String(s.to).toLowerCase();
          data.spender = String(s.to).toLowerCase(); // TowerSwapExecutor is the approve target
          data.value = s.value != null ? String(s.value) : '0';
          data.swapGasLimit = s.gasLimit != null ? String(s.gasLimit) : null;
        }
        data.approval = txRes.data.data.approval || null;
      }
    } catch (_) {
      // build-tx is optional — quote alone is still valid (execution falls back).
    }
  }

  return json({ ok: true, data }, 200, env, request);
}
