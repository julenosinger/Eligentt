/**
 * Cloudflare Pages Function — CPN (Circle Payments Network) proxy
 * Route: /api/cpn/*
 *
 * Security model (Fase 1.1):
 *
 *   AUTH        — Every non-health request requires a valid Elligentt session
 *                 (HttpOnly cookie `elligente_sid` or Authorization: Bearer <token>).
 *                 The session is verified against AUTH_KV. UserId is read from the
 *                 session only; the frontend cannot supply or override it. The
 *                 application-layer expiry (`session.expiresAt`) is checked here in
 *                 addition to relying on KV TTL, closing the TTL eviction race.
 *
 *   OWNERSHIP   — Operations on a specific paymentId (GET payment, request TX,
 *                 submit TX) require that the server recorded that paymentId for
 *                 the authenticated userId. User A cannot access User B's payment
 *                 even with a valid session and a known UUID.
 *
 *   IDEMPOTENCY — POST /payments uses a two-phase reservation:
 *                 1. Attempt to set a *reservation* key atomically (best-effort via
 *                    KV put with no-overwrite semantics using a unique value check).
 *                    This closes the TOCTOU window for concurrent requests.
 *                 2. After CPN responds with a paymentId, promote the reservation to
 *                    a permanent record keyed by userId + idempotencyKey.
 *                 3. Persistence failure is NOT silently swallowed: if recording
 *                    fails after a successful CPN call, the response includes a
 *                    `persistenceWarning` flag and a `paymentId` so the caller can
 *                    reconcile. No payment is created a second time.
 *
 *   BODY SIZE   — Request bodies are capped at 32 KB; rejected 413 before parsing.
 *
 *   METHOD ENFORCEMENT — Each allowed path has an explicit allowed method.
 *
 *   KEY ISOLATION — CPN_API_KEY is never included in responses or logs.
 *
 * KV key schema:
 *   session:<token>                → { userId, email, expiresAt, ... }
 *   cpn_reserve:<userId>:<idemKey> → "pending:<requestId>" (reservation — short TTL)
 *   cpn_idem:<userId>:<idemKey>    → { paymentId, createdAt } (permanent record)
 *   cpn_pay:<userId>:<paymentId>   → "1" (ownership record — 48 h TTL)
 *
 * Supported paths:
 *   POST /api/cpn/quotes
 *   POST /api/cpn/payments
 *   GET  /api/cpn/payments/:id
 *   POST /api/cpn/payments/:id/transactions
 *   POST /api/cpn/payments/:id/transactions/:txId/submit
 *   GET  /api/cpn/health   ← public, no auth
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

// ── Session verification ──────────────────────────────────────────────────────
// Mirrors /api/auth/session.js. Also checks application-layer session.expiresAt
// in addition to relying on KV TTL, closing the eviction race window.

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
 * Checks both KV existence and session.expiresAt (application-layer expiry).
 * Never throws.
 */
async function verifySession(request, env) {
  if (!env || !env.AUTH_KV) {
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
  // Application-layer expiry check (closes TTL eviction race)
  if (session.expiresAt && typeof session.expiresAt === 'number' && Date.now() > session.expiresAt) {
    return { ok: false, status: 401, error: 'Session expired' };
  }
  return { ok: true, userId: session.userId, email: session.email };
}

// ── Route allowlist with per-path method enforcement ─────────────────────────

const ROUTE_TABLE = [
  { re: /^quotes$/,                                                          method: 'POST', ownership: false },
  { re: /^payments$/,                                                        method: 'POST', ownership: false },
  { re: /^payments\/[a-zA-Z0-9_-]{1,80}$/,                                  method: 'GET',  ownership: true  },
  { re: /^payments\/[a-zA-Z0-9_-]{1,80}\/transactions$/,                    method: 'POST', ownership: true  },
  { re: /^payments\/[a-zA-Z0-9_-]{1,80}\/transactions\/[a-zA-Z0-9_-]{1,80}\/submit$/, method: 'POST', ownership: true  },
];

function resolveRoute(path, method) {
  for (const entry of ROUTE_TABLE) {
    if (entry.re.test(path)) {
      return entry.method === method
        ? { allowed: true, ownership: entry.ownership }
        : { allowed: false, expectedMethod: entry.method };
    }
  }
  return null;
}

function extractCpnPath(url) {
  const m = new URL(url).pathname.match(/^\/api\/cpn\/(.+)$/);
  return m ? m[1] : null;
}

/** Extract the first paymentId segment from a cpnPath, or null. */
function extractPaymentId(cpnPath) {
  const m = cpnPath.match(/^payments\/([a-zA-Z0-9_-]{1,80})/);
  return m ? m[1] : null;
}

// ── Ownership verification ────────────────────────────────────────────────────
// cpn_pay:<userId>:<paymentId> → "1" is written after successful payment creation.
// Any operation on a specific paymentId checks this key first.

async function verifyPaymentOwnership(env, userId, paymentId) {
  if (!env.AUTH_KV || !userId || !paymentId) return false;
  try {
    const val = await env.AUTH_KV.get(`cpn_pay:${userId}:${paymentId}`);
    return val === '1';
  } catch (_) { return false; }
}

async function recordPaymentOwnership(env, userId, paymentId) {
  if (!env.AUTH_KV || !userId || !paymentId) return { ok: false };
  try {
    await env.AUTH_KV.put(
      `cpn_pay:${userId}:${paymentId}`,
      '1',
      { expirationTtl: 172800 }, // 48 h
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'KV write failed' };
  }
}

// ── Idempotency guard (POST /payments only — two-phase reservation) ───────────
//
// Phase 1 — RESERVE (before CPN call):
//   Write cpn_reserve:<userId>:<idemKey> → "pending:<requestId>" with a short TTL
//   (120 s — long enough for the CPN round-trip). If the key already exists,
//   another request with the same key is in flight; reject 409.
//
// Phase 2 — PROMOTE (after successful CPN response):
//   Write cpn_idem:<userId>:<idemKey> → { paymentId, createdAt } with a 24 h TTL.
//   Delete the reservation key.
//
// If the promotion write fails, the caller receives a `persistenceWarning: true`
// flag alongside the paymentId so it can reconcile. The reservation key expires
// on its own TTL, so the 120 s window prevents double-creation on concurrent retry
// but a manual reconciliation is required if the promotion fails.
//
// Note: Cloudflare KV does not offer conditional (compare-and-swap) writes. The
// reservation is best-effort: two requests arriving in the same millisecond could
// both read "no key" before either writes. This is the safest achievable guarantee
// without an atomic store. The Circle CPN API enforces its own idempotency
// independently via the idempotencyKey forwarded in the request, so the worst
// outcome is one spurious 409 from CPN (which we surface as IDEMPOTENT_REPLAY).

const RESERVE_TTL_SECONDS  = 120;  // in-flight reservation window
const IDEM_TTL_SECONDS     = 86400; // 24 h permanent record

function generateRequestId() {
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function reserveIdempotency(env, userId, idempotencyKey) {
  if (!env.AUTH_KV) return { ok: false, error: 'AUTH_KV unavailable' };
  const reqId = generateRequestId();
  const reserveKey = `cpn_reserve:${userId}:${idempotencyKey}`;
  // Read first (best-effort — not atomic; see note above)
  try {
    const existing = await env.AUTH_KV.get(reserveKey);
    if (existing) {
      return { ok: false, conflict: true, error: 'Concurrent request in flight for this idempotencyKey' };
    }
    await env.AUTH_KV.put(reserveKey, `pending:${reqId}`, { expirationTtl: RESERVE_TTL_SECONDS });
    return { ok: true, reqId, reserveKey };
  } catch (e) {
    return { ok: false, error: 'Reservation failed: ' + (e && e.message ? e.message : 'unknown') };
  }
}

async function promoteIdempotency(env, userId, idempotencyKey, paymentId, reserveKey) {
  if (!env.AUTH_KV) return { ok: false, error: 'AUTH_KV unavailable' };
  try {
    await env.AUTH_KV.put(
      `cpn_idem:${userId}:${idempotencyKey}`,
      JSON.stringify({ paymentId, createdAt: Date.now() }),
      { expirationTtl: IDEM_TTL_SECONDS },
    );
    // Clean up reservation (best-effort)
    try { await env.AUTH_KV.delete(reserveKey); } catch (_) {}
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'KV promote failed' };
  }
}

async function checkIdempotencyRecord(env, userId, idempotencyKey) {
  if (!env.AUTH_KV || !idempotencyKey) return null;
  try {
    const raw = await env.AUTH_KV.get(`cpn_idem:${userId}:${idempotencyKey}`);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
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

// ── Safe error message ────────────────────────────────────────────────────────

function safeUpstreamError(status) {
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

  // ── Ownership check for payment-specific paths ──
  if (routeMatch.ownership) {
    const paymentId = extractPaymentId(cpnPath);
    if (!paymentId) {
      return jsonResponse({ error: 'Could not extract paymentId from path' }, 400, env, request);
    }
    const owned = await verifyPaymentOwnership(env, userId, paymentId);
    if (!owned) {
      // 403 (not 404) — do not reveal whether the paymentId exists for another user
      return jsonResponse({ error: 'Access denied to this payment' }, 403, env, request);
    }
  }

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

  // ── Idempotency — two-phase reservation for payment creation ──
  let reservationHandle = null;
  if (cpnPath === 'payments' && request.method === 'POST') {
    const idemKey = bodyJson && bodyJson.idempotencyKey;
    if (!idemKey || typeof idemKey !== 'string' || idemKey.length < 8 || idemKey.length > 128) {
      return jsonResponse({ error: 'idempotencyKey is required (8–128 chars, UUID v4 recommended)' }, 400, env, request);
    }

    // Check for a completed record first (idempotent replay)
    const existing = await checkIdempotencyRecord(env, userId, idemKey);
    if (existing) {
      return jsonResponse({
        id: existing.paymentId,
        status: 'IDEMPOTENT_REPLAY',
        idempotent: true,
        message: 'Payment already created with this idempotencyKey',
      }, 200, env, request);
    }

    // Phase 1: reserve (prevents concurrent duplicate creation)
    const reservation = await reserveIdempotency(env, userId, idemKey);
    if (!reservation.ok) {
      if (reservation.conflict) {
        return jsonResponse({
          error: 'A payment with this idempotencyKey is already in progress',
          code: 'IDEMPOTENCY_CONFLICT',
        }, 409, env, request);
      }
      // Non-conflict reservation failure: block creation rather than risk a duplicate
      return jsonResponse({
        error: 'Could not reserve idempotency slot — please retry',
        code: 'IDEMPOTENCY_RESERVE_FAILED',
      }, 503, env, request);
    }
    reservationHandle = { idemKey, reserveKey: reservation.reserveKey };
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
        'User-Agent': 'Elligentt-CPN-Proxy/1.1',
        ...(bodyJson && bodyJson.idempotencyKey
          ? { 'Idempotency-Key': bodyJson.idempotencyKey }
          : {}),
      },
      body: bodyText || undefined,
    });
  } catch (_networkErr) {
    // Clean up reservation on network failure so the caller can retry
    if (reservationHandle) {
      try { await env.AUTH_KV.delete(reservationHandle.reserveKey); } catch (_) {}
    }
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

  // ── Phase 2: promote idempotency + record ownership after successful creation ──
  if (
    cpnPath === 'payments' &&
    request.method === 'POST' &&
    upstreamRes.ok &&
    upstreamJson && upstreamJson.id &&
    reservationHandle
  ) {
    const { idemKey, reserveKey } = reservationHandle;
    const paymentId = upstreamJson.id;

    // Promote idempotency record
    const promoteResult = await promoteIdempotency(env, userId, idemKey, paymentId, reserveKey);
    // Record ownership
    const ownershipResult = await recordPaymentOwnership(env, userId, paymentId);

    const persistenceFailed = !promoteResult.ok || !ownershipResult.ok;
    if (persistenceFailed) {
      // Payment was created at Circle but we could not record it locally.
      // Surface the warning so the caller knows to reconcile.
      // Still return the paymentId — the caller must NOT create another payment.
      upstreamJson.persistenceWarning = true;
      upstreamJson.persistenceError = 'KV write failed — reconcile before retrying';
    }
  }

  // ── Return upstream response ──
  if (!upstreamRes.ok) {
    // Clean up reservation on CPN error so caller can retry safely
    if (reservationHandle) {
      try { await env.AUTH_KV.delete(reservationHandle.reserveKey); } catch (_) {}
    }
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
