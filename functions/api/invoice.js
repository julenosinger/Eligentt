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

const TOKEN_RE = /^inv_[A-Za-z0-9_-]{6,64}$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: getCorsHeaders(context.request, context.env) });
}

function extractSessionToken(request) {
  const auth = request.headers.get('Authorization') || '';
  const bearer = auth.replace('Bearer ', '').trim();
  if (bearer && bearer.length >= 32) return bearer;
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/elligente_sid=([^;]+)/);
  return m ? m[1].trim() : '';
}

async function requireSession(request, env) {
  // If AUTH_KV is not configured, allow creation (unauthenticated install)
  if (!env.AUTH_KV) return null;
  const token = extractSessionToken(request);
  if (!token || token.length < 32) return 'Unauthorized — please log in';
  const raw = await env.AUTH_KV.get('session:' + token);
  if (!raw) return 'Session expired or invalid';
  return null; // ok
}

export async function onRequestPost(context) {
  const headers = getCorsHeaders(context.request, context.env);

  // Session-based authorization (graceful: skipped when AUTH_KV not configured)
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
    const { id, number, label, amount, feeAmount, recipient, recipientName, desc, token, chain, chainId: bodyChainId, expiresAt } = body;
    const chainId = bodyChainId;

    if (!id || !TOKEN_RE.test(id)) {
      return new Response(JSON.stringify({ error: 'Invalid invoice token' }), { status: 400, headers });
    }
    if (!recipient || !ADDR_RE.test(recipient)) {
      return new Response(JSON.stringify({ error: 'Invalid recipient address' }), { status: 400, headers });
    }

    const recipientAmount = parseFloat(amount);
    if (!(recipientAmount > 0)) {
      return new Response(JSON.stringify({ error: 'Invalid amount' }), { status: 400, headers });
    }

    let fee = parseFloat(feeAmount);
    if (!Number.isFinite(fee) || fee < 0) fee = 0;
    if (fee > recipientAmount) {
      return new Response(JSON.stringify({ error: 'Fee exceeds amount' }), { status: 400, headers });
    }

    const KV = context.env.PAYMENT_LINKS;
    if (!KV) return new Response(JSON.stringify({ error: 'Storage unavailable' }), { status: 503, headers });

    // Idempotency: never overwrite an already-paid invoice.
    const existingRaw = await KV.get(id);
    if (existingRaw) {
      const existing = JSON.parse(existingRaw);
      if (existing.status === 'Paid') {
        return new Response(JSON.stringify({ ok: true, link: existing, existed: true }), { status: 200, headers });
      }
    }

    const feeBps = RELAYER_CONFIG.INVOICE_FEE_BPS || 200;
    const amountRaw = ethers.parseUnits(recipientAmount.toFixed(6), 6);
    const feeRaw = ethers.parseUnits(fee.toFixed(6), 6);
    const totalAmount = parseFloat(ethers.formatUnits(amountRaw + feeRaw, 6));

    let expiry = 'never';
    let expiresAtIso = null;
    if (expiresAt) {
      const d = new Date(expiresAt);
      if (!isNaN(d.getTime())) { expiresAtIso = d.toISOString(); expiry = 'date'; }
    }

    // Resolve and validate destination chain against server-side registry.
    // Reject any chainId that is not in CHAIN_REGISTRY to prevent spoofing.
    const nameToId = RELAYER_CONFIG.CHAIN_NAME_TO_ID || {};
    const registry = RELAYER_CONFIG.CHAIN_REGISTRY || {};
    let resolvedChainId = RELAYER_CONFIG.ARC_CHAIN_ID; // default Arc Mainnet
    let resolvedChain = 'Arc Mainnet';
    if (chain && typeof chain === 'string' && nameToId[chain]) {
      resolvedChainId = nameToId[chain];
      resolvedChain = chain;
    } else if (chainId && registry[Number(chainId)]) {
      resolvedChainId = Number(chainId);
      resolvedChain = registry[resolvedChainId].name;
    }
    // Extra guard: if frontend sent a chainId that is not in our registry, reject it.
    if (chain && typeof chain === 'string' && chain !== 'Arc Mainnet' && !nameToId[chain]) {
      return new Response(JSON.stringify({ error: 'Unsupported destination chain: ' + chain }), { status: 400, headers });
    }

        const link = {
      id,
      kind: 'invoice',
      type: 'fixed',
      number: typeof number === 'string' ? number.slice(0, 64) : '',
      label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 120) : 'Invoice',
      recipientName: typeof recipientName === 'string' ? recipientName.slice(0, 120) : '',
      desc: typeof desc === 'string' ? desc.slice(0, 500) : '',
      amount: recipientAmount,
      feeAmount: fee,
      totalAmount,
      feeBps,
      feeReceiver: RELAYER_CONFIG.TREASURY_VAULT,
      recipient,
      token: (typeof token === 'string' && token.trim()) ? token.trim().toUpperCase() : 'USDC',
      chain: resolvedChain,
      chainId: resolvedChainId,
      expiry,
      expiresAt: expiresAtIso,
      status: 'Active',
      payments: 0,
      scans: 0,
      created: new Date().toISOString(),
      paidTx: null,
      paidBy: null,
      paidAt: null,
    };

    const ttl = expiresAtIso
      ? Math.max(Math.ceil((new Date(expiresAtIso).getTime() - Date.now()) / 1000) + 86400, 86400)
      : undefined;
    await KV.put(id, JSON.stringify(link), ttl ? { expirationTtl: ttl } : undefined);

    return new Response(JSON.stringify({ ok: true, link }), { status: 201, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Server error: ' + (e.message || '') }), { status: 500, headers });
  }
}
