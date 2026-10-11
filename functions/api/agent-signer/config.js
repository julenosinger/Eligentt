/**
 * AUTONOMA-6B — GET /api/agent-signer/config
 * Returns PUBLIC Circle signer status (no secrets). Used by SecureSignerProvider
 * to fail-closed before enabling circle mode.
 */
import { isConfigured, getCredentials, getUserCredentials, json } from './_circle.js';
import { isPaused } from './_execution.mjs';
import { proofAvailable } from './_proof.mjs';
import { verifySession } from './_session.mjs';

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!isConfigured(env)) {
    return json({ ok: true, available: false, address: null, reason: 'circle_not_configured' }, 200, env, request);
  }

  // Try to resolve per-user credentials when a session is present.
  // Falls back to platform creds when unauthenticated or user has no personal wallet.
  let creds = getCredentials(env);
  try {
    const session = await verifySession(env, request);
    if (session.ok && session.email && env.AUTH_KV) {
      const raw = await env.AUTH_KV.get('user:' + session.email);
      if (raw) {
        const user = JSON.parse(raw);
        const userCreds = getUserCredentials(env, user);
        if (userCreds && userCreds.walletAddress && userCreds.isPerUser !== false) {
          creds = userCreds;
        }
      }
    }
  } catch (_) { /* fall through to platform creds */ }

  const pause = await isPaused(env);
  return json({
    ok: true,
    available: true,
    address: creds.walletAddress,
    walletId: creds.walletId,
    isPerUser: !!(creds.isPerUser),
    chainId: 5042,
    requiresAuthorization: true,
    authorizationProofAvailable: proofAvailable(env),
    paused: pause.paused,
  }, 200, env, request);
}
