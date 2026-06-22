import { ethers } from 'ethers';
import { RELAYER_CONFIG } from './shared-config.mjs';
import { checkPaymentLimit } from './rate-limit.mjs';

function getCorsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || 'https://elligente.pages.dev').split(',').map(s => s.trim());
  const origin = request.headers.get('Origin') || '';
  const corsOrigin = allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: getCorsHeaders(context.request, context.env) });
}

export async function onRequestPost(context) {
  const headers = getCorsHeaders(context.request, context.env);

  const clientIP = context.request.headers.get('CF-Connecting-IP') || context.request.headers.get('X-Forwarded-For') || 'unknown';
  const rateCheck = await checkPaymentLimit(context.env.RATE_LIMIT_KV, clientIP);
  if (!rateCheck.allowed) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded', retryAfter: rateCheck.retryAfter }), {
      status: 429, headers: { ...headers, 'Retry-After': String(rateCheck.retryAfter) },
    });
  }

  try {
    const body = await context.request.json();
    const { label, amount, type, desc, recipient, token, chain, expiry } = body;

    if (!recipient || !/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
      return new Response(JSON.stringify({ error: 'Invalid recipient address' }), { status: 400, headers });
    }
    if (type !== 'open' && (!amount || amount <= 0)) {
      return new Response(JSON.stringify({ error: 'Invalid amount' }), { status: 400, headers });
    }

    const feeBps = RELAYER_CONFIG.PAYLINK_FEE_BPS || 200;
    let feeAmount = 0;
    let totalAmount = 0;

    if (type !== 'open' && amount > 0) {
      const amountRaw = ethers.parseUnits(String(amount), 6);
      const feeRaw = (amountRaw * BigInt(feeBps)) / 10000n;
      const totalRaw = amountRaw + feeRaw;
      feeAmount = parseFloat(ethers.formatUnits(feeRaw, 6));
      totalAmount = parseFloat(ethers.formatUnits(totalRaw, 6));
    }

    const id = 'pl_' + crypto.randomUUID();

    let expiresAt = null;
    if (expiry && expiry !== 'never') {
      const map = { '24h': 86400000, '7d': 604800000, '30d': 2592000000 };
      if (map[expiry]) expiresAt = new Date(Date.now() + map[expiry]).toISOString();
    }

    const link = {
      id,
      label: label || 'Payment',
      amount: parseFloat(amount) || 0,
      feeAmount,
      totalAmount,
      feeBps,
      feeReceiver: RELAYER_CONFIG.TREASURY_VAULT,
      type: type || 'fixed',
      desc: desc || '',
      recipient,
      token: token || 'USDC',
      chain: chain || 'Arc Testnet',
      chainId: RELAYER_CONFIG.ARC_CHAIN_ID,
      expiry: expiry || 'never',
      expiresAt,
      status: 'Active',
      payments: 0,
      scans: 0,
      created: new Date().toISOString(),
      paidTx: null,
      paidBy: null,
      paidAt: null,
    };

    const KV = context.env.PAYMENT_LINKS;
    if (KV) {
      const ttl = expiresAt ? Math.max(Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000) + 86400, 86400) : undefined;
      await KV.put(id, JSON.stringify(link), ttl ? { expirationTtl: ttl } : undefined);
    }

    return new Response(JSON.stringify({ ok: true, link }), { status: 201, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Server error: ' + (e.message || '') }), { status: 500, headers });
  }
}
