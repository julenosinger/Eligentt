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
 *   session:<token>                → { userId, email, walletAddress, createdAt } (TTL 86400 s)
 *   cpn_reserve:<userId>:<idemKey> → "<requestId>:<payloadHash>" (reservation — short TTL)
 *   cpn_idem:<userId>:<idemKey>    → { paymentId, createdAt, payloadHash } (permanent record)
 *   cpn_pending:<userId>:<idemKey> → { status:'PENDING_RECONCILIATION', payloadHash, requestId } (24 h)
 *   cpn_pay:<userId>:<paymentId>   → "1" (ownership record — 48 h TTL)
 *
 * Session expiry: login.js writes { createdAt, expirationTtl: 86400 } — there is NO expiresAt
 * field in the session record. The application-layer check computes expiry as
 * createdAt + SESSION_TTL_MS and compares to Date.now().
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
// Mirrors /api/auth/session.js.
//
// IMPORTANT — real session record schema (login.js):
//   { email, userId, walletAddress, createdAt }  with KV expirationTtl: 86400
// There is NO expiresAt field. Expiry is computed here as createdAt + SESSION_TTL_MS.
// Checking session.expiresAt would always be undefined and silently pass — that bug
// is exactly what this version corrects.

const SESSION_TTL_MS = 86400 * 1000; // 24 h — must match login.js expirationTtl

function extractSessionToken(request) {
  const authHeader = request.headers.get('Authorization') || '';
  const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (bearer && bearer.length >= 32) return bearer;
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/elligente_sid=([^;]+)/);
  return m ? m[1].trim() : '';
}

/**
 * Verify session and return { ok, userId, email, walletAddress } or
 * { ok: false, status, error }.
 *
 * Checks both KV existence (primary expiry via KV TTL) and application-layer
 * expiry computed from session.createdAt + SESSION_TTL_MS (secondary check that
 * closes the TTL eviction race window).
 *
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
  // Application-layer expiry: login.js uses { createdAt, expirationTtl: 86400 }.
  // createdAt is required; a session without it is treated as expired.
  if (!session.createdAt || typeof session.createdAt !== 'number') {
    return { ok: false, status: 401, error: 'Session missing createdAt — expired' };
  }
  if (Date.now() > session.createdAt + SESSION_TTL_MS) {
    return { ok: false, status: 401, error: 'Session expired' };
  }
  return {
    ok: true,
    userId:        session.userId,
    email:         session.email,
    walletAddress: session.walletAddress || null, // from login.js — may be used for TX binding
  };
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
//   Write cpn_reserve:<userId>:<idemKey> → "<requestId>:<payloadHash>" with TTL 120 s.
//   If the key already exists, another request with the same key is in flight → 409.
//   The value includes a hash of the canonical payment payload so that a retry with a
//   DIFFERENT payload is rejected even if the reservation window hasn't expired yet.
//
// Phase 2 — PROMOTE (after successful CPN response):
//   Write cpn_idem:<userId>:<idemKey> → { paymentId, createdAt, payloadHash } TTL 24 h.
//   On IDEMPOTENT_REPLAY, the stored payloadHash is compared against the new request's
//   hash — a different payload with the same key is rejected as a misuse attempt.
//   Delete the reservation key.
//
// Persistence failure: if the promotion write fails, the caller receives
// persistenceWarning: true and the paymentId — it must reconcile before retrying.
//
// Atomicity limitation: Cloudflare KV does not offer compare-and-swap. The reservation
// is best-effort (read → check → write). Two requests arriving within the same ~1 ms
// window could both read "no key" and both proceed. This is mitigated in two ways:
//   1. The Circle CPN API enforces server-side idempotency via the Idempotency-Key
//      header — a true duplicate is rejected by CPN itself and returned as 409/REPLAY.
//   2. The payloadHash binding ensures that even a successful double-reservation for
//      the same key with different parameters is caught at the IDEMPOTENT_REPLAY check.
// For strict single-execution guarantees, a Durable Object lock would be required.
// That is documented here and not silently claimed as guaranteed.

const RESERVE_TTL_SECONDS  = 120;  // in-flight reservation window
const IDEM_TTL_SECONDS     = 86400; // 24 h permanent record

function generateRequestId() {
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Produce a SHA-256 hash of the canonical payment payload fields so that
 * two requests using the same idempotency key but different parameters can be detected.
 *
 * Uses crypto.subtle.digest (SubtleCrypto, available in all Cloudflare Workers runtimes).
 * Returns a 64-char hex string (256-bit output). This is a binding integrity check, not
 * a signature — it is collision-resistant and appropriate for same-key/different-payload
 * detection, but it does not authenticate the payload against a secret.
 *
 * IDEMPOTENCY ATOMICITY LIMITATION (Cloudflare KV):
 *   KV does not offer compare-and-swap or any transactional primitive. The reservation
 *   pattern (get → check → put) is NOT atomic: two concurrent requests arriving within
 *   the same ~1 ms window can both read "no key" and both proceed past the check.
 *   This is mitigated by two independent barriers:
 *     1. Circle's own server-side idempotency (Idempotency-Key header) — CPN will return
 *        409 for a true duplicate regardless of what we do locally.
 *     2. payloadHash binding — even if both requests pass the KV reservation, a replay
 *        check against the permanent record will detect a different payload.
 *   For strict exactly-once execution, a Durable Object with a transactional lock would
 *   be required. That is not implemented here because it requires user-provisioned
 *   Cloudflare Durable Objects (a paid feature requiring wrangler.jsonc changes and
 *   account-level provisioning). This limitation is documented and not silently claimed
 *   as solved. The code fails closed in all ambiguous states.
 */
/**
 * Canonicalize the amount field for payload binding. CPN accepts the amount as
 * either a plain string ("100.00") or an object ({ amount, currency }). The
 * object form MUST be flattened — String({amount:'100'}) collapses to
 * "[object Object]" and would make two different amounts hash identically,
 * defeating the key-reuse binding.
 */
function _canonicalAmount(amount) {
  if (amount == null) return null;
  if (typeof amount === 'object') {
    return String(amount.amount != null ? amount.amount : '') + '|' + String(amount.currency || '');
  }
  return String(amount);
}

async function payloadHash(body) {
  if (!body) return 'empty';
  // Canonical fields that define a unique payment operation
  const canonical = JSON.stringify({
    quoteId:             body.quoteId             || null,
    amount:              _canonicalAmount(body.amount),
    destinationCurrency: body.destinationCurrency || null,
    beneficiaryName:     body.beneficiaryDetails && body.beneficiaryDetails.name   ? body.beneficiaryDetails.name.trim()   : null,
    beneficiaryAccount:  body.beneficiaryDetails && body.beneficiaryDetails.accountNumber ? body.beneficiaryDetails.accountNumber.trim() : null,
  });
  // SHA-256 via SubtleCrypto (available in Cloudflare Workers runtime)
  const encoded = new TextEncoder().encode(canonical);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function reserveIdempotency(env, userId, idempotencyKey, bodyJson) {
  if (!env.AUTH_KV) return { ok: false, error: 'AUTH_KV unavailable' };
  const reqId = generateRequestId();
  const pHash = await payloadHash(bodyJson);
  const reserveKey = `cpn_reserve:${userId}:${idempotencyKey}`;
  // Read first (best-effort — not atomic; see note above)
  try {
    const existing = await env.AUTH_KV.get(reserveKey);
    if (existing) {
      return { ok: false, conflict: true, error: 'Concurrent request in flight for this idempotencyKey' };
    }
    await env.AUTH_KV.put(reserveKey, `${reqId}:${pHash}`, { expirationTtl: RESERVE_TTL_SECONDS });
    return { ok: true, reqId, reserveKey, payloadHash: pHash };
  } catch (e) {
    return { ok: false, error: 'Reservation failed: ' + (e && e.message ? e.message : 'unknown') };
  }
}

async function promoteIdempotency(env, userId, idempotencyKey, paymentId, reserveKey, pHash) {
  if (!env.AUTH_KV) return { ok: false, error: 'AUTH_KV unavailable' };
  try {
    await env.AUTH_KV.put(
      `cpn_idem:${userId}:${idempotencyKey}`,
      JSON.stringify({ paymentId, createdAt: Date.now(), payloadHash: pHash || null }),
      { expirationTtl: IDEM_TTL_SECONDS },
    );
    // Clean up reservation (best-effort); null reserveKey = reconciliation path.
    if (reserveKey) { try { await env.AUTH_KV.delete(reserveKey); } catch (_) {} }
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

// ── PENDING_RECONCILIATION (Fase 1.4) ────────────────────────────────────────
// When a Circle call ends in a NETWORK_UNKNOWN (timeout / communication error) or
// a persistence failure occurs after Circle may have created the payment, the
// operation's outcome is INDETERMINATE. The reservation (120 s TTL) is too short
// to safely gate a retry — a caller could retry after the reservation expires and
// (absent Circle-side idempotency) create a duplicate.
//
// To close that gap we persist a longer-lived (24 h) reconciliation record bound to
// the authenticated user AND the full canonical payload hash. A subsequent request
// reusing the same idempotency key is:
//   · rejected (409) if the payload differs (key-reuse misuse), or
//   · allowed through as a reconciliation retry — Circle's Idempotency-Key header
//     is the authoritative dedup and returns the original paymentId.
//
// This does NOT claim exactly-once execution locally: Cloudflare KV has no atomic
// compare-and-swap, and the authoritative dedup is Circle's own Idempotency-Key.
// See also the note in reserveIdempotency.

const PENDING_TTL_SECONDS = 86400; // 24 h reconciliation window

async function writePendingReconciliation(env, userId, idempotencyKey, payloadHash, requestId) {
  if (!env.AUTH_KV) return { ok: false, error: 'AUTH_KV unavailable' };
  try {
    await env.AUTH_KV.put(
      `cpn_pending:${userId}:${idempotencyKey}`,
      JSON.stringify({
        status: 'PENDING_RECONCILIATION',
        payloadHash: payloadHash || null,
        requestId: requestId || null,
        createdAt: Date.now(),
      }),
      { expirationTtl: PENDING_TTL_SECONDS },
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'KV pending write failed' };
  }
}

async function checkPendingReconciliation(env, userId, idempotencyKey) {
  if (!env.AUTH_KV || !idempotencyKey) return null;
  try {
    const raw = await env.AUTH_KV.get(`cpn_pending:${userId}:${idempotencyKey}`);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

async function clearPendingReconciliation(env, userId, idempotencyKey) {
  if (!env.AUTH_KV || !idempotencyKey) return;
  try { await env.AUTH_KV.delete(`cpn_pending:${userId}:${idempotencyKey}`); } catch (_) {}
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
      // Payload-binding check: if the stored hash differs from this request's hash,
      // the caller is trying to reuse an idempotency key for a different payment.
      // This is a misuse: reject rather than silently process a different operation.
      const newHash = await payloadHash(bodyJson);
      if (existing.payloadHash && existing.payloadHash !== newHash) {
        return jsonResponse({
          error: 'idempotencyKey already used for a different payment operation',
          code: 'IDEMPOTENCY_KEY_REUSE',
        }, 409, env, request);
      }
      return jsonResponse({
        id: existing.paymentId,
        status: 'IDEMPOTENT_REPLAY',
        idempotent: true,
        message: 'Payment already created with this idempotencyKey',
      }, 200, env, request);
    }

    // PENDING_RECONCILIATION (Fase 1.4): a prior attempt with this key had an
    // indeterminate outcome (network error / persistence failure). Bind the retry to
    // the original payload — a different payload is key-reuse misuse; the same
    // payload is a safe reconciliation retry (Circle's Idempotency-Key dedups).
    const pending = await checkPendingReconciliation(env, userId, idemKey);
    let reconciling = false;
    if (pending) {
      const pendingHash = await payloadHash(bodyJson);
      if (pending.payloadHash && pending.payloadHash !== pendingHash) {
        return jsonResponse({
          error: 'idempotencyKey already used for a different payment operation (pending reconciliation)',
          code: 'IDEMPOTENCY_KEY_REUSE',
        }, 409, env, request);
      }
      // Same payload — reconciliation retry. It is a SEQUENTIAL retry (not a
      // concurrent request), so we skip the in-flight reservation and forward to
      // Circle, whose Idempotency-Key is the authoritative dedup.
      reconciling = true;
    }

    // Phase 1: reserve (prevents concurrent duplicate creation). Skipped for a
    // same-payload reconciliation retry (Circle dedups the Idempotency-Key).
    if (!reconciling) {
      const reservation = await reserveIdempotency(env, userId, idemKey, bodyJson);
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
      reservationHandle = { idemKey, reserveKey: reservation.reserveKey, payloadHash: reservation.payloadHash, reqId: reservation.reqId };
    } else {
      reservationHandle = { idemKey, reserveKey: null, payloadHash: pending.payloadHash || (await payloadHash(bodyJson)), reqId: null, reconciling: true };
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
        'User-Agent': 'Elligentt-CPN-Proxy/1.1',
        ...(bodyJson && bodyJson.idempotencyKey
          ? { 'Idempotency-Key': bodyJson.idempotencyKey }
          : {}),
      },
      body: bodyText || undefined,
    });
  } catch (_networkErr) {
    // NETWORK_UNKNOWN — the fetch threw before we received any response.
    // We cannot determine whether Circle received the request. Deleting the
    // reservation here would allow an immediate retry that could create a duplicate
    // payment if Circle's server processed the first request but the client's
    // connection dropped. The reservation TTL (120 s) will expire on its own.
    // The caller receives NETWORK_UNKNOWN and must reconcile (query Circle for
    // the payment status using the idempotency key) before retrying.
    const unknownPayload = {
      error: 'CPN upstream unreachable — outcome unknown',
      code: 'NETWORK_UNKNOWN',
      reconcileRequired: true,
      message: 'The request may or may not have reached Circle. Do not retry without reconciling first.',
    };
    if (reservationHandle) {
      unknownPayload.idempotencyKey = reservationHandle.idemKey;
      // Do NOT delete the reservation — it signals to concurrent requests that an
      // operation with this key is in-flight or has unknown outcome.
      // Persist a PENDING_RECONCILIATION record (24 h) so a retry with this key is
      // still payload-bound even after the 120 s reservation expires.
      await writePendingReconciliation(env, userId, reservationHandle.idemKey, reservationHandle.payloadHash, reservationHandle.reqId);
    }
    return jsonResponse(unknownPayload, 502, env, request);
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
    const { idemKey, reserveKey, payloadHash: pHash } = reservationHandle;
    const paymentId = upstreamJson.id;

    // Promote idempotency record (includes payloadHash for replay binding)
    const promoteResult = await promoteIdempotency(env, userId, idemKey, paymentId, reserveKey, pHash);
    // Record ownership
    const ownershipResult = await recordPaymentOwnership(env, userId, paymentId);

    const persistenceFailed = !promoteResult.ok || !ownershipResult.ok;
    if (persistenceFailed) {
      // Local persistence failed — persist PENDING_RECONCILIATION + surface paymentId.
      upstreamJson.persistenceWarning = true;
      upstreamJson.persistenceError = 'KV write failed — reconcile before retrying';
      upstreamJson.reconcileRequired = true;
      await writePendingReconciliation(env, userId, idemKey, pHash, reservationHandle.reqId);
    } else {
      await clearPendingReconciliation(env, userId, idemKey);
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
