/**
 * Cloudflare Pages Function — CPN (Circle Payments Network) proxy
 * Route: /api/cpn/*
 *
 * Security model:
 *   AUTH  — Every non-health request requires a valid Elligentt session token
 *           (HttpOnly cookie `elligente_sid` or Authorization: Bearer <token>).
 *           Requests without a valid session are rejected 401 before any CPN
 *           call is made. The session is verified against AUTH_KV — the same
 *           store used by /api/auth/session. UserId is read from the session;
 *           the frontend cannot supply or override it.
 *
 *   IDEMPOTENCY — For payment-creation (POST /api/cpn/payments), the server
 *           records the client-supplied idempotencyKey in AUTH_KV under the
 *           authenticated userId. A second request with the same key returns
 *           the cached paymentId instead of creating a new payment. This
 *           prevents duplicate payments on retry / timeout.
 *
 *   BODY SIZE — Request bodies are capped at 32 KB. Oversized requests are
 *           rejected 413 before any upstream call.
 *
 *   METHOD ENFORCEMENT — Each allowed path has an explicit allowed method.
 *           A GET to a POST-only path (or vice-versa) is rejected 405.
 *
 *   LOGGING — No secrets, tokens, full account numbers, or full beneficiary
 *           data are logged. Only opaque ids, statuses, and paths are recorded.
 *
 *   KEY — CPN_API_KEY stays exclusively server-side; it is never included in
 *           response bodies or error messages.
 *
 * Supported paths (CPN OFI workflow):
 *   POST /api/cpn/quotes
 *   POST /api/cpn/payments
 *   GET  /api/cpn/payments/:id
 *   POST /api/cpn/payments/:id/transactions
 *   POST /api/cpn/payments/:id/transactions/:txId/submit
 *   GET  /api/cpn/health         ← public, no auth required
 *
 * Reference: https://developers.circle.com/cpn/fiat-payouts
 */

const CPN_BASE_URL = 'https://api.circle.com/v2/cpn';
const MAX_BODY_BYTES = 32 * 1024; // 32 KB

const DEFAULT_ALLOWED_ORIGINS =
  'https://elligente.pages.dev,https://elligentttest.pages.dev,https://elligentt.xyz,https://execdaat.xyz';

// ── CORS ─────────────────────────────────────────────────────────────────────

function getAllowedOrigins(env) {
  return ((env && env.ALLOWED_ORIGINS) || DEFAULT_ALLOWED_ORIGINS)
    .split(',').map((s) => s.trim()).filter(Boolean);
}

function corsHeaders(env, request) {
  const origin = (request && request.headers && request.headers.get('Origin')) || '';
  const allowed = getAllowedOrigins(env);
  const allow = allowed.includes(origin) ? origin : allowed[0] || '*';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function jsonResponse(data, status, env, request) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env, request) },
  });
}

// ── Session verification (mirrors /api/auth/session.js) ─────────────────────
// Reads the same AUTH_KV store; never trusts userId from the request body.

function extractSessionToken(request) {
  const authHeader = request.headers.get('Authorization') || '';
  const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (bearer && bearer.length >= 32) return bearer;
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/elligente_sid=([^;]+)/);
  return m ? m[1].trim() : '';
}

/**
 * Verify session and return { ok, userId, email } or { ok: false, status, error }.
 * Never throws — always returns a result object.
 */
async function verifySession(request, env) {
  if (!env || !env.AUTH_KV) {
    // AUTH_KV not wired: fail closed — do not allow unauthenticated access.
    return { ok: false, status: 503, error: 'Auth service unavailable' };
  }
  const token = extractSessionToken(request);
  if (!token || token.length < 32) {
    return { ok: false, status: 401, error: 'Session token required' };
  }
  let session;
  try {
    const raw = await env.AUTH_KV.get(`session:${token}`);
    if (!raw) return { ok: false, status: 401, error: 'Session expired or invalid' };
    session = JSON.parse(raw);
  } catch (_) {
    return { ok: false, status: 401, error: 'Session invalid' };
  }
  if (!session || !session.userId) {
    return { ok: false, status: 401, error: 'Session missing userId' };
  }
  return { ok: true, userId: session.userId, email: session.email };
}

// ── Route allowlist with per-path method enforcement ─────────────────────────

const ROUTE_TABLE = [
  { re: /^quotes$/,                                                          method: 'POST' },
  { re: /^payments$/,                                                        method: 'POST' },
  { re: /^payments\/[a-zA-Z0-9_-]{1,80}$/,                                  method: 'GET'  },
  { re: /^payments\/[a-zA-Z0-9_-]{1,80}\/transactions$/,                    method: 'POST' },
  { re: /^payments\/[a-zA-Z0-9_-]{1,80}\/transactions\/[a-zA-Z0-9_-]{1,80}\/submit$/, method: 'POST' },
];

function resolveRoute(path, method) {
  for (const entry of ROUTE_TABLE) {
    if (entry.re.test(path)) {
      return entry.method === method
        ? { allowed: true }
        : { allowed: false, expectedMethod: entry.method };
    }
  }
  return null; // path not found
}

function extractCpnPath(url) {
  const m = new URL(url).pathname.match(/^\/api\/cpn\/(.+)$/);
  return m ? m[1] : null;
}

// ── Idempotency guard (POST /payments only) ──────────────────────────────────
// Stored as: cpn_idem:<userId>:<idempotencyKey> → { paymentId, createdAt }
// TTL: 24 h (matching the maximum quote lifetime Circle allows).

const IDEM_TTL_SECONDS = 86400;

async function checkIdempotency(env, userId, idempotencyKey) {
  if (!env.AUTH_KV || !idempotencyKey) return null;
  try {
    const raw = await env.AUTH_KV.get(`cpn_idem:${userId}:${idempotencyKey}`);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

async function recordIdempotency(env, userId, idempotencyKey, paymentId) {
  if (!env.AUTH_KV || !idempotencyKey || !paymentId) return;
  try {
    await env.AUTH_KV.put(
      `cpn_idem:${userId}:${idempotencyKey}`,
      JSON.stringify({ paymentId, createdAt: Date.now() }),
      { expirationTtl: IDEM_TTL_SECONDS },
    );
  } catch (_) {}
}

// ── Body size guard ──────────────────────────────────────────────────────────

async function readBodySafe(request) {
  const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (contentLength > MAX_BODY_BYTES) return { ok: false, error: 'Request body too large' };
  let text;
  try { text = await request.text(); } catch (_) { return { ok: false, error: 'Failed to read request body' }; }
  if (text.length > MAX_BODY_BYTES) return { ok: false, error: 'Request body too large' };
  return { ok: true, text };
}

// ── Safe error message — never expose CPN_API_KEY or internal stack traces ───

function safeUpstreamError(status) {
  // Generic messages only; the actual CPN response body is passed through
  // but the key is never included.
  if (status === 401) return 'CPN authentication failed';
  if (status === 403) return 'CPN access denied — OFI onboarding required';
  if (status === 404) return 'CPN resource not found';
  if (status === 409) return 'CPN conflict — possible duplicate';
  if (status === 422) return 'CPN validation error';
  if (status === 429) return 'CPN rate limit exceeded';
  if (status >= 500)  return 'CPN upstream error';
  return 'CPN error ' + status;
}

// ── Main handler ─────────────────────────────────────────────────────────────

export async function onRequest(context) {
  const { env, request } = context;

  // ── CORS preflight ──
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(env, request) });
  }

  const cpnPath = extractCpnPath(request.url);

  // ── Public health check — no auth required ──
  if (cpnPath === 'health') {
    return jsonResponse({
      ok: true,
      configured: !!(env && env.CPN_API_KEY),
    }, 200, env, request);
  }

  // ── Route validation ──
  if (!cpnPath) {
    return jsonResponse({ error: 'Invalid CPN path' }, 400, env, request);
  }
  const routeMatch = resolveRoute(cpnPath, request.method);
  if (routeMatch === null) {
    return jsonResponse({ error: 'CPN path not allowed' }, 400, env, request);
  }
  if (!routeMatch.allowed) {
    return jsonResponse(
      { error: 'Method not allowed for this CPN path', allowed: routeMatch.expectedMethod },
      405, env, request,
    );
  }

  // ── Session authentication (fail closed) ──
  const session = await verifySession(request, env);
  if (!session.ok) {
    return jsonResponse({ error: session.error }, session.status, env, request);
  }
  const { userId } = session;

  // ── Require CPN_API_KEY ──
  const apiKey = env && env.CPN_API_KEY;
  if (!apiKey) {
    return jsonResponse({
      error: 'CPN not configured',
      message: 'CPN_API_KEY is not set. OFI onboarding required. See https://developers.circle.com/cpn/fiat-payouts',
      code: 'CPN_NOT_CONFIGURED',
    }, 503, env, request);
  }

  // ── Body read (POST only) with size guard ──
  let bodyText = null;
  let bodyJson = null;
  if (request.method === 'POST') {
    const bodyRead = await readBodySafe(request);
    if (!bodyRead.ok) return jsonResponse({ error: bodyRead.error }, 413, env, request);
    bodyText = bodyRead.text;
    try { bodyJson = JSON.parse(bodyText); } catch (_) {
      return jsonResponse({ error: 'Invalid JSON body' }, 400, env, request);
    }
  }

  // ── Idempotency guard for payment creation ──
  if (cpnPath === 'payments' && request.method === 'POST') {
    const idemKey = bodyJson && bodyJson.idempotencyKey;
    if (!idemKey || typeof idemKey !== 'string' || idemKey.length < 8 || idemKey.length > 128) {
      return jsonResponse({ error: 'idempotencyKey is required (8–128 chars)' }, 400, env, request);
    }
    // Check if this key was already used by this user
    const existing = await checkIdempotency(env, userId, idemKey);
    if (existing) {
      // Return the cached paymentId — do not create a second payment
      return jsonResponse({
        id: existing.paymentId,
        status: 'IDEMPOTENT_REPLAY',
        idempotent: true,
        message: 'Payment already created with this idempotencyKey',
      }, 200, env, request);
    }
  }

  // ── Forward to Circle CPN API ──
  const upstreamUrl = CPN_BASE_URL + '/' + cpnPath;
  let upstreamRes;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method: request.method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
        'User-Agent': 'Elligentt-CPN-Proxy/1.0',
        // Forward idempotency key to CPN (it independently enforces it too)
        ...(bodyJson && bodyJson.idempotencyKey
          ? { 'X-Idempotency-Key': bodyJson.idempotencyKey }
          : {}),
      },
      body: bodyText || undefined,
    });
  } catch (_networkErr) {
    // Do NOT stringify the network error — it may contain internal addresses
    return jsonResponse({ error: 'CPN upstream unreachable', code: 'NETWORK_ERROR' }, 502, env, request);
  }

  const upstreamText = await upstreamRes.text();
  let upstreamJson;
  try { upstreamJson = JSON.parse(upstreamText); }
  catch (_) { upstreamJson = { raw: upstreamText.slice(0, 200) }; }

  // ── Strip any accidental key echo from upstream response ──
  if (upstreamJson && typeof upstreamJson === 'object') {
    delete upstreamJson.apiKey;
    delete upstreamJson.api_key;
    delete upstreamJson.Authorization;
    delete upstreamJson.authorization;
  }

  // ── Record idempotency after successful payment creation ──
  if (
    cpnPath === 'payments' &&
    request.method === 'POST' &&
    upstreamRes.ok &&
    upstreamJson && upstreamJson.id
  ) {
    const idemKey = bodyJson && bodyJson.idempotencyKey;
    await recordIdempotency(env, userId, idemKey, upstreamJson.id);
  }

  // ── Return upstream response, replacing vague upstream errors with safe messages ──
  if (!upstreamRes.ok) {
    const errMsg = (upstreamJson && (upstreamJson.message || upstreamJson.error))
      || safeUpstreamError(upstreamRes.status);
    return jsonResponse(
      { error: errMsg, code: upstreamJson && upstreamJson.code },
      upstreamRes.status,
      env,
      request,
    );
  }

  return jsonResponse(upstreamJson, upstreamRes.status, env, request);
}
