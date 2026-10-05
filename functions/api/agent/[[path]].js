/**
 * Cloudflare Pages Function — /api/agent
 * Circle Developer-Controlled Wallets agent endpoint.
 * All Circle secrets stay server-side; never exposed to the browser.
 *
 * Routes (matched on URL path suffix):
 *   GET  /api/agent/status        → wallet info + balances
 *   GET  /api/agent/balance       → token balances only
 *   GET  /api/agent/transactions  → last 20 transactions
 *
 * NOTE: There is no direct transfer/validate endpoint here anymore. This
 * surface is READ-ONLY. All financial execution (transfer/swap/bridge/etc.)
 * must go through the authorized agent-signer path
 * (/api/agent-signer/authorize → /api/agent-signer/broadcast), which is the
 * ONLY surface allowed to move funds.
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

// ─── Route handlers ──────────────────────────────────────────────────────────

async function handleStatus(env) {
  const walletId = env.CIRCLE_WALLET_ID;
  const apiKey   = env.CIRCLE_API_KEY;
  if (!apiKey || !walletId) return err('Circle agent not configured', 503);

  const [walletRes, balRes] = await Promise.all([
    circleGet(`/wallets/${walletId}`, apiKey),
    circleGet(`/wallets/${walletId}/balances`, apiKey),
  ]);

  return json({
    ok: true,
    wallet: walletRes.data?.wallet ?? walletRes.data,
    balances: balRes.data?.tokenBalances ?? [],
    address: env.CIRCLE_WALLET_ADDRESS || walletRes.data?.wallet?.address,
  });
}

async function handleBalance(env) {
  const walletId = env.CIRCLE_WALLET_ID;
  const apiKey   = env.CIRCLE_API_KEY;
  if (!apiKey || !walletId) return err('Circle agent not configured', 503);

  const balRes = await circleGet(`/wallets/${walletId}/balances`, apiKey);
  return json({
    ok: true,
    balances: balRes.data?.tokenBalances ?? [],
    address: env.CIRCLE_WALLET_ADDRESS,
  });
}

async function handleTransactions(env) {
  const walletId = env.CIRCLE_WALLET_ID;
  const apiKey   = env.CIRCLE_API_KEY;
  if (!apiKey || !walletId) return err('Circle agent not configured', 503);

  const res = await circleGet(`/transactions?walletIds=${walletId}&pageSize=20`, apiKey);
  return json({
    ok: true,
    transactions: res.data?.transactions ?? [],
  });
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
      if (action === 'status')       return await handleStatus(env);
      if (action === 'balance')      return await handleBalance(env);
      if (action === 'transactions') return await handleTransactions(env);
    }

    if (request.method === 'POST') {
      // Direct fund movement is disabled on this legacy surface. All financial
      // operations must go through the authorized agent-signer execution path.
      return err('Direct transfers are disabled — use the authorized agent-signer execution path', 403);
    }

    return err('Unknown action', 404);
  } catch (e) {
    console.error('[agent]', e.message);
    return err(e.message, 500);
  }
}
