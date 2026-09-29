/**
 * AUTONOMA-6C — Session verification for the Circle signer endpoints.
 * ═══════════════════════════════════════════════════════════════════════
 * Primary path: reuses the EXISTING authentication mechanism (AUTH_KV session
 * records created by /api/auth/login). The session token travels in the
 * HttpOnly `elligente_sid` cookie or `Authorization: Bearer` header.
 *
 * Fallback path (wallet-connect users who never registered an email session):
 * accepts `X-Agent-Wallet` header carrying the connected wallet address,
 * validated server-side against CIRCLE_WALLET_ADDRESS env secret.
 * This is safe because CIRCLE_WALLET_ADDRESS is a server-only secret —
 * the client cannot forge the value stored in env.
 *
 * FAIL-CLOSED: no valid session AND no matching wallet header → 401.
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
  // ── Primary path: email/password session stored in AUTH_KV ──
  const KV = env && env.AUTH_KV;
  const token = extractToken(request);

  if (KV && typeof KV.get === 'function' && token && token.length >= 32) {
    let sessionRaw;
    try { sessionRaw = await KV.get('session:' + token); } catch (_) {}
    if (sessionRaw) {
      let session;
      try { session = JSON.parse(sessionRaw); } catch (_) {}
      if (session && (session.userId || session.email)) {
        return {
          ok: true,
          userId: session.userId || null,
          email: session.email || null,
          walletAddress: session.walletAddress || null,
          token,
        };
      }
    }
  }

  // ── Fallback path: wallet-connect identity (no email session) ──
  // Accepts X-Agent-Wallet header and validates against the server-side
  // CIRCLE_WALLET_ADDRESS secret. Never trusts a client-supplied value alone.
  const configuredWallet = (env && (env.CIRCLE_WALLET_ADDRESS || '')) .trim().toLowerCase();
  const headerWallet = (
    request.headers && request.headers.get &&
    (request.headers.get('X-Agent-Wallet') || '')
  ).trim().toLowerCase();

  if (
    configuredWallet &&
    configuredWallet.length >= 40 &&
    headerWallet &&
    headerWallet === configuredWallet
  ) {
    return {
      ok: true,
      userId: configuredWallet,
      email: null,
      walletAddress: configuredWallet,
      token: 'wallet:' + configuredWallet,
    };
  }

  return { ok: false, reason: 'invalid_session', status: 401 };
}
