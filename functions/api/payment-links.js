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
// Absent AUTH_KV in production = 503, never open access.
// DEV_AUTH_BYPASS=true is the only explicit dev opt-out.
async function requireSession(request, env) {
  if (!env.AUTH_KV) {
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
    const { label, amount, type, desc, recipient, token, chain, chainId: bodyChainId, expiry } = body;

    if (!recipient || !/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
      return new Response(JSON.stringify({ error: 'Invalid recipient address' }), { status: 400, headers });
    }
    if (type !== 'open' && (!amount || amount <= 0)) {
      return new Response(JSON.stringify({ error: 'Invalid amount' }), { status: 400, headers });
    }

    const feeBps = RELAYER_CONFIG.PAYLINK_FEE_BPS || 200;
    let feeAmount = 0;
    let totalAmount = 0;

    // Resolve decimals from CHAIN_REGISTRY using the destination token.
    // Must come before fee math so both use the same precision.
    const _plTokenSym = (typeof token === 'string' && token.trim()) ? token.trim().toUpperCase() : 'USDC';
    // resolvedChainId is computed below — derive decimals after resolution.
    // We do a forward-read here using the raw bodyChainId/chain; resolution re-runs below.
    const _plRegistry  = RELAYER_CONFIG.CHAIN_REGISTRY || {};
    const _plNameToId  = RELAYER_CONFIG.CHAIN_NAME_TO_ID || {};
    const _plTmpChainId = (chain && _plNameToId[chain]) ? _plNameToId[chain]
      : (bodyChainId && _plRegistry[Number(bodyChainId)] ? Number(bodyChainId) : RELAYER_CONFIG.ARC_CHAIN_ID);
    const _plChainEntry = _plRegistry[_plTmpChainId];
    const _plTokenEntry = _plChainEntry ? (_plChainEntry.tokens[_plTokenSym] || _plChainEntry.tokens['USDC']) : null;
    const _plDecimals   = _plTokenEntry ? _plTokenEntry.decimals : 6;

    if (type !== 'open' && amount > 0) {
      const amountRaw = ethers.parseUnits(String(parseFloat(amount).toFixed(_plDecimals)), _plDecimals);
      const feeRaw    = (amountRaw * BigInt(feeBps)) / 10000n;
      const totalRaw  = amountRaw + feeRaw;
      feeAmount   = parseFloat(ethers.formatUnits(feeRaw, _plDecimals));
      totalAmount = parseFloat(ethers.formatUnits(totalRaw, _plDecimals));
    }

    // Resolve destination chain against server-side registry.
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

    const id = 'pl_' + crypto.randomUUID();

    let expiresAt = null;
    if (expiry && expiry !== 'never') {
      const map = { '24h': 86400000, '7d': 604800000, '30d': 2592000000 };
      if (map[expiry]) expiresAt = new Date(Date.now() + map[expiry]).toISOString();
    }

    const link = {
      id,
      // OWNERSHIP fields — server-side only, never from client body.
      userId:      auth.user ? auth.user.userId    : null,
      ownerEmail:  auth.user ? auth.user.email     : null,
      ownerWallet: auth.user ? (auth.user.walletAddress || null) : null,
      createdBy:   auth.user ? auth.user.userId    : 'anonymous',
      label:       label || 'Payment',
      amount:      parseFloat(amount) || 0,
      feeAmount,
      totalAmount,
      feeBps,
      feeReceiver: RELAYER_CONFIG.TREASURY_VAULT,
      type:        type || 'fixed',
      desc:        desc || '',
      recipient,
      token:       _plTokenSym,
      tokenDecimals: _plDecimals,
      chain:       resolvedChain,
      chainId:     resolvedChainId,
      expiry:      expiry || 'never',
      expiresAt,
      status:      'Active',
      payments:    0,
      scans:       0,
      created:     new Date().toISOString(),
      paidTx:      null,
      paidBy:      null,
      paidAt:      null,
    };

    const KV = context.env.PAYMENT_LINKS;
    if (!KV) return new Response(JSON.stringify({ error: 'Storage unavailable' }), { status: 503, headers });

    const ttl = expiresAt
      ? Math.max(Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000) + 86400, 86400)
      : undefined;
    await KV.put(id, JSON.stringify(link), ttl ? { expirationTtl: ttl } : undefined);

    return new Response(JSON.stringify({ ok: true, link: _publicView(link) }), { status: 201, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Server error' }), { status: 500, headers });
  }
}

// Strip ALL internal ownership/server fields from client response.
// userId, ownerEmail, ownerWallet, createdBy are server-side only.
function _publicView(link) {
  // eslint-disable-next-line no-unused-vars
  const { ownerEmail, ownerWallet, userId, createdBy, ...pub } = link;
  return pub;
}
