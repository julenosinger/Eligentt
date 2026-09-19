/**
 * AUTONOMA-6C — Session verification for the Circle signer endpoints.
 * ═══════════════════════════════════════════════════════════════════════
 * Reuses the EXISTING authentication mechanism (AUTH_KV session records created
 * by /api/auth/login, /api/auth/verify and read by /api/auth/session, /api/auth/sign).
 *
 * The session token travels in the HttpOnly `elligente_sid` cookie (preferred) or
 * as an `Authorization: Bearer <token>` header. It is NEVER read from localStorage,
 * the URL, or any client-supplied body field — the server resolves it from the
 * request only.
 *
 * FAIL-CLOSED: no token, no AUTH_KV binding, or no session record → not authorized.
 */

function extractToken(request) {
  try {
    const authHeader = (request.headers && request.headers.get && request.headers.get('Authorization')) || '';
    const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (bearer && bearer.length >= 32) return bearer;
    const cookieHeader = (request.headers && request.headers.get && request.headers.get('Cookie')) || '';
    const m = cookieHeader.match(/elligente_sid=([^;]+)/);
    return m ? m[1].trim() : '';
  } catch (_) {
    return '';
  }
}

/**
 * Resolve the authenticated session identity for a request.
 * @returns {Promise<{ok:true, userId, email, walletAddress, token} | {ok:false, reason, status}>}
 */
export async function verifySession(env, request) {
  const KV = env && env.AUTH_KV;
  if (!KV || typeof KV.get !== 'function') {
    return { ok: false, reason: 'session_store_unavailable', status: 503 };
  }

  const token = extractToken(request);
  if (!token || token.length < 32) {
    return { ok: false, reason: 'invalid_session', status: 401 };
  }

  let sessionRaw;
  try {
    sessionRaw = await KV.get('session:' + token);
  } catch (_) {
    return { ok: false, reason: 'session_store_error', status: 503 };
  }
  if (!sessionRaw) {
    return { ok: false, reason: 'invalid_session', status: 401 };
  }

  let session;
  try {
    session = JSON.parse(sessionRaw);
  } catch (_) {
    return { ok: false, reason: 'invalid_session', status: 401 };
  }
  if (!session || (!session.userId && !session.email)) {
    return { ok: false, reason: 'invalid_session', status: 401 };
  }

  return {
    ok: true,
    userId: session.userId || null,
    email: session.email || null,
    walletAddress: session.walletAddress || null,
    token,
  };
}
