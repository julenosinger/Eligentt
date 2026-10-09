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
 * personal wallet identity. When the user has no personal wallet yet, returns
 * a no-wallet sentinel so the frontend can show the provisioning CTA instead
 * of silently serving platform wallet data as the user's own.
 */
async function resolveUserWallet(env, request) {
  const KV = env.AUTH_KV;
  const apiKey = env.CIRCLE_API_KEY;

  // "No wallet" sentinel
  const noWallet = {
    apiKey,
    walletId: '',
    walletAddress: '',
    isPerUser: false,
    needsProvision: true,
  };

  if (!KV || typeof KV.get !== 'function') return noWallet;

  const token = extractToken(request);
  if (!token || token.length < 32) return noWallet;

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

  // Authenticated user, no personal wallet yet — return sentinel, never platform wallet.
  return { ...noWallet, userId: user && user.id, email: session.email };
}

// ─── Route handlers ──────────────────────────────────────────────────────────

async function handleStatus(env, request) {
  const creds = await resolveUserWallet(env, request);

  // No personal wallet — tell the frontend to prompt provisioning.
  // Never serve platform wallet data as the user's identity.
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
    }

    if (request.method === 'POST') {
      // Direct fund movement is disabled on this legacy surface. All financial
      // operations must go through the authorized agent-signer execution path.
      return err('Direct transfers are disabled — use the authorized agent-signer execution path', 403);
    }

    return err('Not found', 404);
  } catch (e) {
    console.error('[agent] unhandled error:', e && e.message);
    return err((e && e.message) || 'Internal error', 500);
  }
}
