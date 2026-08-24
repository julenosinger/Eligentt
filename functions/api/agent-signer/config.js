/**
 * AUTONOMA-6B — GET /api/agent-signer/config
 * Returns PUBLIC Circle signer status (no secrets). Used by SecureSignerProvider
 * to fail-closed before enabling circle mode.
 */
import { isConfigured, getCredentials, json } from './_circle.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!isConfigured(env)) {
    return json({ ok: true, available: false, address: null, reason: 'circle_not_configured' }, 200, env, request);
  }
  const creds = getCredentials(env);
  return json({
    ok: true,
    available: true,
    address: creds.walletAddress,
    walletId: creds.walletId,
    chainId: 5042002,
  }, 200, env, request);
}
