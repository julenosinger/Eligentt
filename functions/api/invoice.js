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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };
}

const TOKEN_RE = /^inv_[A-Za-z0-9_-]{6,64}$/;
const ADDR_RE  = /^0x[0-9a-fA-F]{40}$/;

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

// SECURITY — FAIL CLOSED:
// If AUTH_KV is absent in production, reject ALL mutations.
// We detect "dev-only" mode via an explicit opt-in env flag (DEV_AUTH_BYPASS=true).
// Never expose internals in the error response.
async function requireSession(request, env) {
  if (!env.AUTH_KV) {
    // Allow unauthenticated only when DEV_AUTH_BYPASS is explicitly set.
    if (env.DEV_AUTH_BYPASS === 'true') return { ok: true, user: null };
    return { ok: false, status: 503, error: 'Authentication service unavailable' };
  }
  const token = extractSessionToken(request);
  if (!token || token.length < 32) {
    return { ok: false, status: 401, error: 'Unauthorized — please log in' };
  }
  const raw = await env.AUTH_KV.get('session:' + token);
  if (!raw) {
    return { ok: false, status: 401, error: 'Session expired or invalid' };
  }
  let session;
  try { session = JSON.parse(raw); } catch (_) {
    return { ok: false, status: 401, error: 'Session corrupt' };
  }
  if (!session.userId || !session.email) {
    return { ok: false, status: 401, error: 'Session invalid' };
  }
  return { ok: true, user: session };
}

export async function onRequestPost(context) {
  const headers = getCorsHeaders(context.request, context.env);

  const auth = await requireSession(context.request, context.env);
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: auth.error }), { status: auth.status, headers });
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
    // OWNERSHIP: if this ID already exists and belongs to a different user, reject.
    const existingRaw = await KV.get(id);
    if (existingRaw) {
      const existing = JSON.parse(existingRaw);
      // Ownership check: any existing record (with OR without a userId) blocks creation.
      // A null/missing userId means legacy/orphan — never reassign silently.
      // Rules: existing.userId matches current user → idempotent (allow if not Paid).
      //        existing.userId differs → conflict.
      //        existing.userId absent  → conflict (legacy orphan, cannot assume ownership).
      const ownerId = auth.user ? auth.user.userId : null;
      const recordOwner = existing.userId || null;
      if (recordOwner !== ownerId) {
        // Different user or legacy record without owner — deny.
        return new Response(JSON.stringify({ error: 'Invoice ID conflict' }), { status: 409, headers });
      }
      if (existing.status === 'Paid') {
        return new Response(JSON.stringify({ ok: true, link: _publicView(existing), existed: true }), { status: 200, headers });
      }
    }

    const feeBps = RELAYER_CONFIG.INVOICE_FEE_BPS || 200;

    let expiry = 'never';
    let expiresAtIso = null;
    if (expiresAt) {
      const d = new Date(expiresAt);
      if (!isNaN(d.getTime())) { expiresAtIso = d.toISOString(); expiry = 'date'; }
    }

    // Resolve and validate destination chain against server-side registry.
    const nameToId = RELAYER_CONFIG.CHAIN_NAME_TO_ID || {};
    const registry  = RELAYER_CONFIG.CHAIN_REGISTRY || {};
    let resolvedChainId = RELAYER_CONFIG.ARC_CHAIN_ID;
    let resolvedChain   = 'Arc Mainnet';
    if (chain && typeof chain === 'string' && nameToId[chain]) {
      resolvedChainId = nameToId[chain];
      resolvedChain   = chain;
    } else if (bodyChainId && registry[Number(bodyChainId)]) {
      resolvedChainId = Number(bodyChainId);
      resolvedChain   = registry[resolvedChainId].name;
    }
    if (chain && typeof chain === 'string' && chain !== 'Arc Mainnet' && !nameToId[chain]) {
      return new Response(JSON.stringify({ error: 'Unsupported destination chain' }), { status: 400, headers });
    }

    // Resolve decimals AFTER chain resolution so resolvedChainId is correct.
    // Default to 6 (USDC/EURC) when token or chain is not in the registry.
    const _tokenSym   = (typeof token === 'string' && token.trim()) ? token.trim().toUpperCase() : 'USDC';
    const _chainEntry = registry[resolvedChainId];
    const _tokenEntry = _chainEntry ? (_chainEntry.tokens[_tokenSym] || _chainEntry.tokens['USDC']) : null;
    const _decimals   = _tokenEntry ? _tokenEntry.decimals : 6;

    const amountRaw   = ethers.parseUnits(recipientAmount.toFixed(_decimals), _decimals);
    const feeRaw      = ethers.parseUnits(fee.toFixed(_decimals), _decimals);
    const totalAmount = parseFloat(ethers.formatUnits(amountRaw + feeRaw, _decimals));

    const link = {
      id,
      kind: 'invoice',
      type: 'fixed',
      // OWNERSHIP fields — server-side, never from client body.
      userId:      auth.user ? auth.user.userId    : null,
      ownerEmail:  auth.user ? auth.user.email     : null,
      ownerWallet: auth.user ? (auth.user.walletAddress || null) : null,
      createdBy:   auth.user ? auth.user.userId    : 'anonymous',
      number:      typeof number === 'string' ? number.slice(0, 64) : '',
      label:       typeof label === 'string' && label.trim() ? label.trim().slice(0, 120) : 'Invoice',
      recipientName: typeof recipientName === 'string' ? recipientName.slice(0, 120) : '',
      desc:        typeof desc === 'string' ? desc.slice(0, 500) : '',
      amount:      recipientAmount,
      feeAmount:   fee,
      totalAmount,
      feeBps,
      feeReceiver: RELAYER_CONFIG.TREASURY_VAULT,
      recipient,
      token:       _tokenSym,
      tokenDecimals: _decimals,
      chain:       resolvedChain,
      chainId:     resolvedChainId,
      expiry,
      expiresAt:   expiresAtIso,
      status:      'Active',
      payments:    0,
      scans:       0,
      created:     new Date().toISOString(),
      paidTx:      null,
      paidBy:      null,
      paidAt:      null,
    };

    const ttl = expiresAtIso
      ? Math.max(Math.ceil((new Date(expiresAtIso).getTime() - Date.now()) / 1000) + 86400, 86400)
      : undefined;
    await KV.put(id, JSON.stringify(link), ttl ? { expirationTtl: ttl } : undefined);

    return new Response(JSON.stringify({ ok: true, link: _publicView(link) }), { status: 201, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Server error' }), { status: 500, headers });
  }
}

// Strip ALL internal ownership/server fields before sending to client.
// userId, ownerEmail, ownerWallet, createdBy are server-side only.
function _publicView(link) {
  // eslint-disable-next-line no-unused-vars
  const { ownerEmail, ownerWallet, userId, createdBy, ...pub } = link;
  return pub;
}
