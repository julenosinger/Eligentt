/**
 * Cloudflare Pages Function — /api/agent
 * Circle Developer-Controlled Wallets agent endpoint.
 * All Circle secrets stay server-side; never exposed to the browser.
 *
 * Routes (matched on URL path suffix):
 *   GET  /api/agent/status        → wallet info + balances
 *   GET  /api/agent/balance       → token balances only
 *   GET  /api/agent/transactions  → last 20 transactions
 *   POST /api/agent/validate      → pre-flight transfer check
 *   POST /api/agent/transfer      → initiate USDC transfer
 *
 * Required Cloudflare Secrets:
 *   CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_WALLET_ID, CIRCLE_WALLET_ADDRESS
 * Optional env vars:
 *   AGENT_SIGNER_PAUSED=true  → blocks all transfer operations instantly
 *   AGENT_DEFAULT_BLOCKCHAIN  → e.g. "ARC" (default), "BASE", "ETH"
 *   AGENT_USDC_TOKEN_ADDRESS  → USDC contract address on the target chain
 *                               (leave unset to let Circle resolve it automatically)
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

async function circlePost(path, body, apiKey) {
  const r = await fetch(`${CIRCLE_BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.message || JSON.stringify(data));
  return data;
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

  const res = await circleGet(`/wallets/${walletId}/transactions?pageSize=20`, apiKey);
  return json({
    ok: true,
    transactions: res.data?.transactions ?? [],
  });
}

async function handleValidate(body, env) {
  const { to, amount } = body || {};
  if (!to || !amount) return err('Missing to or amount');
  if (!env.CIRCLE_WALLET_ID || !env.CIRCLE_API_KEY) return err('Circle agent not configured', 503);
  if (env.AGENT_SIGNER_PAUSED === 'true') return err('Agent signer is paused', 503);

  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return err('Invalid destination address');
  if (isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) return err('Invalid amount');

  const balRes = await circleGet(`/wallets/${env.CIRCLE_WALLET_ID}/balances`, env.CIRCLE_API_KEY);
  const balances = balRes.data?.tokenBalances ?? [];
  const usdc = balances.find(b => b.token?.symbol === 'USDC');
  const available = parseFloat(usdc?.amount ?? '0');

  if (available < parseFloat(amount)) {
    return err(`Insufficient balance: ${available} USDC available`);
  }

  return json({ ok: true, available, requested: parseFloat(amount) });
}

async function handleTransfer(body, env) {
  const { to, amount, tokenAddress, blockchain, idempotencyKey } = body || {};
  if (!to || !amount) return err('Missing to or amount');
  if (!env.CIRCLE_WALLET_ID || !env.CIRCLE_API_KEY || !env.CIRCLE_ENTITY_SECRET)
    return err('Circle agent not configured', 503);
  if (env.AGENT_SIGNER_PAUSED === 'true') return err('Agent signer is paused', 503);

  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return err('Invalid destination address');
  if (isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) return err('Invalid amount');

  const ikey = idempotencyKey || crypto.randomUUID();

  // USDC token address: use caller-supplied value, or env var, or omit to let Circle
  // resolve automatically by symbol+blockchain — never hardcode a contract address here.
  const resolvedTokenAddress = tokenAddress || env.AGENT_USDC_TOKEN_ADDRESS || undefined;

  const payload = {
    idempotencyKey: ikey,
    walletId: env.CIRCLE_WALLET_ID,
    destinationAddress: to,
    amounts: [amount.toString()],
    blockchain: blockchain || env.AGENT_DEFAULT_BLOCKCHAIN || 'ARC',
    feeLevel: 'MEDIUM',
    entitySecretCiphertext: env.CIRCLE_ENTITY_SECRET,
    // Only include tokenAddress when explicitly provided — Circle can resolve USDC by symbol
    ...(resolvedTokenAddress ? { tokenAddress: resolvedTokenAddress } : {}),
  };

  const result = await circlePost('/transactions/transfer', payload, env.CIRCLE_API_KEY);

  return json({
    ok: true,
    transactionId: result.data?.id,
    state: result.data?.state,
    idempotencyKey: ikey,
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
      const body = await request.json().catch(() => ({}));
      if (action === 'validate') return await handleValidate(body, env);
      if (action === 'transfer') return await handleTransfer(body, env);
    }

    return err('Unknown action', 404);
  } catch (e) {
    console.error('[agent]', e.message);
    return err(e.message, 500);
  }
}
