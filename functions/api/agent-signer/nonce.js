/**
 * AUTONOMA-6B — POST /api/agent-signer/nonce
 * Returns the pending nonce for the Circle wallet on a given chain.
 * FAIL-CLOSED: returns 503 if Circle is not configured.
 */
import { isConfigured, json, err, fetchNonce } from './_circle.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!isConfigured(env)) {
    return err('Circle signer not configured', 503, env, request);
  }
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return err('Invalid JSON body', 400, env, request);
  }
  const chainId = Number(body.chainId) || 5042002;
  try {
    const nonce = await fetchNonce(env, chainId, body.address || null);
    return json({ ok: true, nonce }, 200, env, request);
  } catch (e) {
    return err('Nonce unavailable: ' + (e.message || e), 502, env, request);
  }
}
