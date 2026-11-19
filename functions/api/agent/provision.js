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

  // Provision new Circle wallet — durable per-user state machine so concurrent
  // requests (double-click, multi-tab, OTP + explicit provision race, CF retry)
  // and ambiguous outcomes (Circle created but KV persist failed) resolve to ONE
  // logical wallet. The deterministic Circle idempotency key in createUserWallet
  // (derived from user.id) is the authoritative dedupe; this state machine adds
  // durable pending/done state + reconciliation and a fast 409 for in-flight
  // requests. It does NOT rely on KV atomicity (KV has no CAS).
  const stateKey = 'provision_state:' + user.id;

  // 1) Reconcile a prior completion whose user-record write failed.
  const stateRaw = await KV.get(stateKey);
  if (stateRaw) {
    let st = null;
    try { st = JSON.parse(stateRaw); } catch (_) {}
    if (st && st.status === 'done' && st.walletId && st.address) {
      if (!user.circleWalletId) {
        user.circleWalletId = st.walletId;
        user.circleWalletAddress = st.address;
        try { await KV.put('user:' + session.email, JSON.stringify(user)); } catch (_) {}
      }
      return json({ ok: true, alreadyProvisioned: true, walletId: st.walletId, address: st.address });
    }
    if (st && st.status === 'provisioning' && (Date.now() - (st.startedAt || 0)) < 120000) {
      return json({ ok: false, error: 'Wallet provisioning already in progress', inProgress: true }, 409);
    }
    // Stale 'provisioning' or 'ambiguous' → fall through. The deterministic
    // idempotency key makes the re-create below a get-or-create (no duplicate).
  }

  // 2) Mark provisioning (durable; TTL covers the slowest Circle attempt).
  await KV.put(stateKey, JSON.stringify({ status: 'provisioning', startedAt: Date.now() }), { expirationTtl: 600 });

  let circleWallet;
  try {
    circleWallet = await createUserWallet(env, user.id);
  } catch (e) {
    // Ambiguous: Circle may have created the wallet but the response is
    // inconclusive. Record 'ambiguous' — do NOT create a replacement wallet here.
    // A retry reuses the same deterministic idempotency key and reconciles.
    await KV.put(stateKey, JSON.stringify({ status: 'ambiguous', startedAt: Date.now(), error: String(e && e.message) }), { expirationTtl: 600 }).catch(() => {});
    console.error('[provision] Circle wallet creation failed:', e && e.message);
    return json({ ok: false, error: 'Circle wallet provisioning failed: ' + (e && e.message), reconcile: true }, 502);
  }

  user.circleWalletId = circleWallet.walletId;
  user.circleWalletAddress = circleWallet.address;

  // 3) Persist the durable 'done' state FIRST so a user-record write failure is
  //    still reconcilable, then persist the user record.
  await KV.put(stateKey, JSON.stringify({ status: 'done', walletId: circleWallet.walletId, address: circleWallet.address, doneAt: Date.now() }), { expirationTtl: 86400 }).catch(() => {});

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
