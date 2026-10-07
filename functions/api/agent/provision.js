/**
 * POST /api/agent/provision
 * ═══════════════════════════════════════════════════════════════════════
 * Provisions a per-user Circle developer-controlled wallet for authenticated
 * users who did not get one at registration (e.g. registered before this
 * feature was deployed, or when Circle was unavailable at signup time).
 *
 * Idempotent: if the user already has a Circle wallet, returns the existing one.
 *
 * Required: valid session (elligente_sid cookie or Authorization: Bearer).
 * Required secrets: CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET.
 * Optional secret: CIRCLE_WALLET_SET_ID (shared wallet set; if absent, a new
 *   wallet set is created per user — fine for low volume).
 */

import { createUserWallet } from '../agent-signer/_circle.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function extractToken(request) {
  const authHeader = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (authHeader && authHeader.length >= 32) return authHeader;
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/elligente_sid=([^;]+)/);
  return m ? m[1].trim() : '';
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== 'POST') {
    return json({ ok: false, error: 'Method not allowed' }, 405);
  }

  const KV = env.AUTH_KV;
  if (!KV) return json({ ok: false, error: 'AUTH_KV not configured' }, 503);

  const token = extractToken(request);
  if (!token || token.length < 32) return json({ ok: false, error: 'Unauthorized' }, 401);

  let session;
  try {
    const raw = await KV.get('session:' + token);
    if (!raw) return json({ ok: false, error: 'Session expired or invalid' }, 401);
    session = JSON.parse(raw);
  } catch (_) {
    return json({ ok: false, error: 'Session read error' }, 500);
  }

  if (!session || !session.email) return json({ ok: false, error: 'Unauthorized' }, 401);

  let user;
  try {
    const raw = await KV.get('user:' + session.email);
    if (!raw) return json({ ok: false, error: 'User not found' }, 404);
    user = JSON.parse(raw);
  } catch (_) {
    return json({ ok: false, error: 'User read error' }, 500);
  }

  // Idempotent: already has a Circle wallet
  if (user.circleWalletId && user.circleWalletAddress) {
    return json({
      ok: true,
      alreadyProvisioned: true,
      walletId: user.circleWalletId,
      address: user.circleWalletAddress,
    });
  }

  // Provision new Circle wallet
  let circleWallet;
  try {
    circleWallet = await createUserWallet(env, user.id);
  } catch (e) {
    console.error('[provision] Circle wallet creation failed:', e && e.message);
    return json({ ok: false, error: 'Circle wallet provisioning failed: ' + (e && e.message) }, 502);
  }

  user.circleWalletId = circleWallet.walletId;
  user.circleWalletAddress = circleWallet.address;

  try {
    await KV.put('user:' + session.email, JSON.stringify(user));
  } catch (e) {
    return json({ ok: false, error: 'Failed to save wallet: ' + (e && e.message) }, 500);
  }

  console.log('[provision] Circle wallet provisioned for user:', user.id, circleWallet.walletId);

  return json({
    ok: true,
    alreadyProvisioned: false,
    walletId: circleWallet.walletId,
    address: circleWallet.address,
  });
}
