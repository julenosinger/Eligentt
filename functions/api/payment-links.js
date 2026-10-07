import { ethers } from 'ethers';
import { RELAYER_CONFIG } from './shared-config.mjs';
import { checkPaymentLimit } from './rate-limit.mjs';


function extractSessionToken(request) {
  const auth = request.headers.get('Authorization') || '';
  const bearer = auth.replace('Bearer ', '').trim();
  if (bearer && bearer.length >= 32) return bearer;
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/elligente_sid=([^;]+)/);
  return m ? m[1].trim() : '';
}

async function requireSession(request, env) {
  if (!env.AUTH_KV) return null;
  const token = extractSessionToken(request);
  if (!token || token.length < 32) return 'Unauthorized — please log in';
  const raw = await env.AUTH_KV.get('session:' + token);
  if (!raw) return 'Session expired or invalid';
  return null;
}

function getCorsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || 'https://elligente.pages.dev').split(',').map(s => s.trim());
  const origin = request.headers.get('Origin') || '';
  const corsOrigin = allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: getCorsHeaders(context.request, context.env) });
}

export async function onRequestPost(context) {
  const headers = getCorsHeaders(context.request, context.env);

  const authErr = await requireSession(context.request, context.env);
  if (authErr) {
    return new Response(JSON.stringify({ error: authErr }), { status: 401, headers });
  }

  const clientIP = context.request.headers.get('CF-Connecting-IP') || context.request.headers.get('X-Forwarded-For') || 'unknown';
  const rateCheck = await checkPaymentLimit(context.env.RATE_LIMIT_KV, clientIP);
  if (!rateCheck.allowed) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded', retryAfter: rateCheck.retryAfter }), {
      status: 429, headers: { ...headers, 'Retry-After': String(rateCheck.retryAfter) },
    });
  }

  try {
    const body = await context.request.json();
    const { label, amount, type, desc, recipient, token, chain, chainId: bodyChainId, expiry } = body;
    const chainId = bodyChainId;

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

    // Resolve destination chain against server-side registry.
    const nameToId = RELAYER_CONFIG.CHAIN_NAME_TO_ID || {};
    const registry = RELAYER_CONFIG.CHAIN_REGISTRY || {};
    let resolvedChainId = RELAYER_CONFIG.ARC_CHAIN_ID;
    let resolvedChain = 'Arc Mainnet';
    if (chain && typeof chain === 'string' && nameToId[chain]) {
      resolvedChainId = nameToId[chain];
      resolvedChain = chain;
    } else if (chainId && registry[Number(chainId)]) {
      resolvedChainId = Number(chainId);
      resolvedChain = registry[resolvedChainId].name;
    }
    if (chain && typeof chain === 'string' && chain !== 'Arc Mainnet' && !nameToId[chain]) {
      return new Response(JSON.stringify({ error: 'Unsupported destination chain: ' + chain }), { status: 400, headers });
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
      token: (typeof token === 'string' && token.trim()) ? token.trim().toUpperCase() : 'USDC',
      chain: resolvedChain,
      chainId: resolvedChainId,
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
