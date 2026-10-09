/**
 * Cloudflare Pages Function — /api/agent
 * Circle Developer-Controlled Wallets agent endpoint.
 * All Circle secrets stay server-side; never exposed to the browser.
 *
 * Routes (matched on URL path suffix):
 *   GET  /api/agent/status        → wallet info + balances (per-user)
 *   GET  /api/agent/balance       → token balances only (per-user)
 *   GET  /api/agent/transactions  → last 20 transactions (per-user)
 *
 * Per-user wallet resolution:
 *   1. Read session from AUTH_KV (cookie elligente_sid or Authorization: Bearer).
 *   2. Load user record from AUTH_KV to get user.circleWalletId / user.circleWalletAddress.
 *   3. If the user has no Circle wallet yet, fall back to the global
 *      CIRCLE_WALLET_ID / CIRCLE_WALLET_ADDRESS env secrets.
 *
 * NOTE: This surface is READ-ONLY. All financial execution must go through the
 * authorized agent-signer path (/api/agent-signer/authorize → /api/agent-signer/broadcast).
 *
 * Required Cloudflare Secrets:
 *   CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_WALLET_ID, CIRCLE_WALLET_ADDRESS
 */

const CIRCLE_BASE = 'https://api.circle.com/v1/w3s';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function err(msg, status = 400) {
  return json({ ok: false, error: msg }, status);
}

async function circleGet(path, apiKey) {
  const r = await fetch(`${CIRCLE_BASE}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Circle ${path} → ${r.status}: ${t}`);
  }
  return r.json();
}

// ─── Session + per-user wallet resolution ────────────────────────────────────

function extractToken(request) {
  const authHeader = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (authHeader && authHeader.length >= 32) return authHeader;
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/elligente_sid=([^;]+)/);
  return m ? m[1].trim() : '';
}

/**
 * Resolve the Circle walletId + walletAddress for the authenticated user.
 *
 * SECURITY RULE: the global CIRCLE_WALLET_ID / CIRCLE_WALLET_ADDRESS env
 * secrets are the PLATFORM wallet — they must NEVER be returned as a user's
 * personal wallet identity. Per-user routes (status, balance, transactions)
 * return { isPerUser: false, walletId: '', walletAddress: '' } when the user
 * has no personal wallet yet so the frontend knows to prompt for provisioning,
 * not to silently serve platform wallet data as the user's own.
 *
 * The platform wallet is available only to admin/internal operations that
 * explicitly pass { allowPlatformFallback: true }.
 */
async function resolveUserWallet(env, request, { allowPlatformFallback = false } = {}) {
  const KV = env.AUTH_KV;
  const apiKey = env.CIRCLE_API_KEY;

  // "No wallet" sentinel — tells callers the user has not provisioned yet.
  const noWallet = {
    apiKey,
    walletId: '',
    walletAddress: '',
    isPerUser: false,
    needsProvision: true,
  };

  // If AUTH_KV is not wired or no session token, we cannot identify the user.
  // Refuse to serve platform wallet data as a personal identity.
  if (!KV || typeof KV.get !== 'function') {
    if (allowPlatformFallback) {
      return {
        apiKey,
        walletId: env.CIRCLE_WALLET_ID || '',
        walletAddress: env.CIRCLE_WALLET_ADDRESS || '',
        isPerUser: false,
        isPlatform: true,
      };
    }
    return noWallet;
  }

  const token = extractToken(request);
  if (!token || token.length < 32) {
    if (allowPlatformFallback) {
      return {
        apiKey,
        walletId: env.CIRCLE_WALLET_ID || '',
        walletAddress: env.CIRCLE_WALLET_ADDRESS || '',
        isPerUser: false,
        isPlatform: true,
      };
    }
    return noWallet;
  }

  let session;
  try {
    const raw = await KV.get('session:' + token);
    if (!raw) return noWallet;
    session = JSON.parse(raw);
  } catch (_) { return noWallet; }

  if (!session || !session.email) return noWallet;

  let user;
  try {
    const raw = await KV.get('user:' + session.email);
    if (!raw) return noWallet;
    user = JSON.parse(raw);
  } catch (_) { return noWallet; }

  if (user && user.circleWalletId && user.circleWalletAddress) {
    return {
      apiKey,
      walletId: user.circleWalletId,
      walletAddress: user.circleWalletAddress,
      isPerUser: true,
      needsProvision: false,
      userId: user.id,
      email: session.email,
    };
  }

  // User authenticated but has no personal wallet yet.
  // Return the no-wallet sentinel — never the platform wallet.
  return { ...noWallet, userId: user && user.id, email: session.email };
}

// ─── Route handlers ──────────────────────────────────────────────────────────

async function handleStatus(env, request) {
  const creds = await resolveUserWallet(env, request);

  // No personal wallet yet — tell the frontend to show the "Create My Wallet" CTA.
  // Do NOT expose platform wallet data as the user's identity.
  if (!creds.walletId) {
    return json({
      ok: true,
      configured: !!(creds.apiKey),
      isPerUser: false,
      needsProvision: true,
      wallet: null,
      balances: [],
      walletAddress: null,
      address: null,
    });
  }

  if (!creds.apiKey) return err('Circle API not configured', 503);

  try {
    const [walletRes, balRes] = await Promise.all([
      circleGet(`/wallets/${creds.walletId}`, creds.apiKey),
      circleGet(`/wallets/${creds.walletId}/balances`, creds.apiKey),
    ]);

    const walletAddr = creds.walletAddress || walletRes.data?.wallet?.address || '';
    return json({
      ok: true,
      configured: true,
      wallet: walletRes.data?.wallet ?? walletRes.data,
      balances: balRes.data?.tokenBalances ?? [],
      walletAddress: walletAddr,
      address: walletAddr,
      isPerUser: creds.isPerUser || false,
      needsProvision: false,
    });
  } catch (e) {
    return err('Circle API error: ' + (e.message || e), 502);
  }
}

async function handleBalance(env, request) {
  const creds = await resolveUserWallet(env, request);

  // No personal wallet: return empty balances, never platform wallet data.
  if (!creds.walletId) {
    return json({
      ok: true,
      balances: [],
      address: null,
      isPerUser: false,
      needsProvision: true,
    });
  }
  if (!creds.apiKey) return err('Circle API not configured', 503);

  try {
    const balRes = await circleGet(`/wallets/${creds.walletId}/balances`, creds.apiKey);
    return json({
      ok: true,
      balances: balRes.data?.tokenBalances ?? [],
      address: creds.walletAddress,
      isPerUser: creds.isPerUser || false,
      needsProvision: false,
    });
  } catch (e) {
    return err('Circle API error: ' + (e.message || e), 502);
  }
}

async function handleTransactions(env, request) {
  const creds = await resolveUserWallet(env, request);

  // No personal wallet: return empty list, never platform wallet txs.
  if (!creds.walletId) {
    return json({
      ok: true,
      transactions: [],
      isPerUser: false,
      needsProvision: true,
    });
  }
  if (!creds.apiKey) return err('Circle API not configured', 503);

  try {
    const res = await circleGet(`/transactions?walletIds=${creds.walletId}&pageSize=20`, creds.apiKey);
    return json({
      ok: true,
      transactions: res.data?.transactions ?? [],
      isPerUser: true,
    });
  } catch (e) {
    return err('Circle API error: ' + (e.message || e), 502);
  }
}

// ─── Provision handler (POST /api/agent/provision) ────────────────────────────
// Idempotent: returns existing wallet if already provisioned.
// Requires valid session; refuses unauthenticated callers.

async function handleProvision(env, request) {
  const KV = env.AUTH_KV;
  if (!KV) return json({ ok: false, error: 'AUTH_KV not configured' }, 503);

  const token = extractToken(request);
  if (!token || token.length < 32) return json({ ok: false, error: 'Unauthorized' }, 401);

  let session;
  try {
    const raw = await KV.get('session:' + token);
    if (!raw) return json({ ok: false, error: 'Session expired or invalid' }, 401);
    session = JSON.parse(raw);
  } catch (_) { return json({ ok: false, error: 'Session read error' }, 500); }

  if (!session || !session.email) return json({ ok: false, error: 'Unauthorized' }, 401);

  let user;
  try {
    const raw = await KV.get('user:' + session.email);
    if (!raw) return json({ ok: false, error: 'User not found' }, 404);
    user = JSON.parse(raw);
  } catch (_) { return json({ ok: false, error: 'User read error' }, 500); }

  // Idempotent: already has a personal Circle wallet
  if (user.circleWalletId && user.circleWalletAddress) {
    // Verify wallet still exists on Circle before confirming
    const apiKey = env.CIRCLE_API_KEY;
    if (apiKey) {
      try {
        await circleGet(`/wallets/${user.circleWalletId}`, apiKey);
      } catch (_e) {
        // Circle returned an error — wallet may be invalid; allow re-provision below
        user.circleWalletId = null;
        user.circleWalletAddress = null;
      }
    }
    if (user.circleWalletId && user.circleWalletAddress) {
      return json({
        ok: true,
        alreadyProvisioned: true,
        walletId: user.circleWalletId,
        address: user.circleWalletAddress,
      });
    }
  }

  // Provision a new Circle wallet
  const { createUserWallet } = await import('../agent-signer/_circle.js');

  let circleWallet;
  try {
    circleWallet = await createUserWallet(env, user.id);
  } catch (e) {
    console.error('[provision] Circle wallet creation failed:', e && e.message);
    return json({ ok: false, error: 'Circle wallet provisioning failed: ' + (e && e.message) }, 502);
  }

  // Persist to KV
  user.circleWalletId = circleWallet.walletId;
  user.circleWalletAddress = circleWallet.address;
  try {
    await KV.put('user:' + session.email, JSON.stringify(user));
  } catch (e) {
    return json({ ok: false, error: 'Failed to save wallet to KV: ' + (e && e.message) }, 500);
  }

  console.log('[provision] Circle wallet provisioned for user:', user.id, circleWallet.walletId);

  return json({
    ok: true,
    alreadyProvisioned: false,
    walletId: circleWallet.walletId,
    address: circleWallet.address,
  });
}

// ─── Diag handler (GET /api/agent/diag) ──────────────────────────────────────
// Tests Circle API connectivity and provision flow step by step.
// Returns error details without exposing secret values.
async function handleDiag(env, request) {
  const steps = [];
  const apiKey = env.CIRCLE_API_KEY || '';
  const entitySecret = env.CIRCLE_ENTITY_SECRET || '';
  const kvOk = !!(env.AUTH_KV && typeof env.AUTH_KV.get === 'function');

  const apiKeyPrefix = apiKey ? apiKey.split(':')[0] : '';
  steps.push({ step: 'env_apiKey', ok: apiKey.length > 10, prefix: apiKeyPrefix, detail: apiKey ? 'set (len=' + apiKey.length + ', prefix=' + apiKeyPrefix + ')' : 'MISSING' });
  steps.push({ step: 'env_entitySecret', ok: entitySecret.length > 10, detail: entitySecret ? 'set (len=' + entitySecret.length + ')' : 'MISSING' });
  steps.push({ step: 'env_AUTH_KV', ok: kvOk, detail: kvOk ? 'bound' : 'NOT BOUND' });

  // Test Circle entity config endpoint
  try {
    const r = await fetch('https://api.circle.com/v1/w3s/config/entity/publicKey', {
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    });
    const d = await r.json().catch(() => ({}));
    // Probe all known shapes: data.publicKey, data.data.publicKey, publicKey
    const pubKey = (d && d.data && d.data.publicKey) || (d && d.publicKey) || null;
    const shape = JSON.stringify(Object.keys(d || {})) + ' data=' + JSON.stringify(Object.keys((d && d.data) || {}));
    steps.push({ step: 'circle_entity_config', ok: r.ok, status: r.status, pubKeyFound: !!pubKey, responseShape: shape, detail: r.ok ? ('pubKey=' + !!pubKey + ' len=' + (pubKey ? pubKey.length : 0)) : ((d && d.message) || r.status) });
  } catch (e) {
    steps.push({ step: 'circle_entity_config', ok: false, detail: e.message });
  }

  // Test session resolution
  const token = extractToken(request);
  steps.push({ step: 'session_token', ok: token.length >= 32, detail: token ? 'len=' + token.length : 'NOT SENT — user not logged in or token not forwarded' });

  if (kvOk && token.length >= 32) {
    try {
      const raw = await env.AUTH_KV.get('session:' + token);
      steps.push({ step: 'kv_session_lookup', ok: !!raw, detail: raw ? 'found' : 'NOT FOUND — session expired or wrong KV namespace' });
      if (raw) {
        const sess = JSON.parse(raw);
        const userRaw = await env.AUTH_KV.get('user:' + sess.email);
        steps.push({ step: 'kv_user_lookup', ok: !!userRaw, detail: userRaw ? 'found email=' + sess.email : 'user record missing' });
      }
    } catch (e) {
      steps.push({ step: 'kv_session_lookup', ok: false, detail: e.message });
    }
  }

  const allOk = steps.every(s => s.ok);
  return json({ ok: allOk, steps });
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url   = new URL(request.url);
  const parts = url.pathname.replace(/\/$/, '').split('/');
  // pathname = /api/agent/status  → parts = ['','api','agent','status']
  const action = parts[3] || 'status';

  try {
    if (request.method === 'GET') {
      if (action === 'status')       return await handleStatus(env, request);
      if (action === 'balance')      return await handleBalance(env, request);
      if (action === 'transactions') return await handleTransactions(env, request);
      if (action === 'diag')         return await handleDiag(env, request);
    }

    if (request.method === 'POST') {
      // POST /api/agent/provision — create a per-user Circle wallet (idempotent).
      if (action === 'provision') return await handleProvision(env, request);

      // All other POST operations (direct transfers, validate) are disabled.
      // Financial execution must go through /api/agent-signer/authorize → /api/agent-signer/broadcast.
      return err('Direct transfers are disabled — use the authorized agent-signer execution path', 403);
    }

    return err('Not found', 404);
  } catch (e) {
    console.error('[agent] unhandled error:', e && e.message);
    return err((e && e.message) || 'Internal error', 500);
  }
}
