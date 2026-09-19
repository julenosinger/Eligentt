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
    const { id, number, label, amount, feeAmount, recipient, recipientName, desc, token, chain, expiresAt } = body;

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
      token: token || 'USDC',
      chain: chain || 'Arc Testnet',
      chainId: RELAYER_CONFIG.ARC_CHAIN_ID,
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
