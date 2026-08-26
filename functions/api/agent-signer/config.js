/**
 * AUTONOMA-6B — GET /api/agent-signer/config
 * Returns PUBLIC Circle signer status (no secrets). Used by SecureSignerProvider
 * to fail-closed before enabling circle mode.
 */
import { isConfigured, getCredentials, json } from './_circle.js';
import { isPaused } from './_execution.mjs';
import { proofAvailable } from './_proof.mjs';

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!isConfigured(env)) {
    return json({ ok: true, available: false, address: null, reason: 'circle_not_configured' }, 200, env, request);
  }
  const creds = getCredentials(env);
  const pause = await isPaused(env);
  return json({
    ok: true,
    available: true,
    address: creds.walletAddress,
    walletId: creds.walletId,
    chainId: 5042002,
    requiresAuthorization: true,
    authorizationProofAvailable: proofAvailable(env),
    paused: pause.paused,
  }, 200, env, request);
}
