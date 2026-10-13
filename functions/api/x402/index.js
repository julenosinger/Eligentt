/**
 * Cloudflare Pages Function — /api/x402
 * ═══════════════════════════════════════════════════════════════════════
 * Buyer-side x402 (HTTP 402 Payment Required) infrastructure for the Autonoma.
 *
 * This is the FIRST PHASE of the integration: discovery of payment
 * requirements, server-side validation, and the authorization surface.
 * Real USDC settlement is intentionally NOT wired yet — see `pay` below and
 * docs/x402-integration.md. There is no simulated payment anywhere.
 *
 * Routes (matched on URL path suffix `parts[3]`):
 *   GET  /api/x402/status     → integration state (no auth required)
 *   POST /api/x402/discover   → probe a URL, detect 402 + parse requirements
 *   POST /api/x402/prepare    → validate requirements + wallet + authorization
 *   POST /api/x402/pay        → FAIL-CLOSED (not enabled / not implemented)
 *
 * All Circle secrets stay server-side (context.env). Nothing here is ever
 * trusted from the client or from the AI model.
 */

import {
  parsePaymentRequired,
  normalizePaymentRequired,
  validateRequirement,
  requirementId,
  X402_NETWORKS,
  FACILITATOR_URL,
  X402_VERSION,
  readFlags,
  assertSafeTarget,
  HEADER_PAYMENT_REQUIRED,
} from './_x402.mjs';
import { verifySession } from '../agent-signer/_session.mjs';

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

function err(msg, status = 400, extra = {}) {
  return json(Object.assign({ ok: false, error: msg }, extra), status);
}

/* ── Session + per-user Circle wallet resolution ─────────────────────── */

function extractToken(request) {
  try {
    const authHeader = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (authHeader && authHeader.length >= 32) return authHeader;
    const cookie = request.headers.get('Cookie') || '';
    const m = cookie.match(/elligente_sid=([^;]+)/);
    return m ? m[1].trim() : '';
  } catch (_) { return ''; }
}

/**
 * Resolve the authenticated user's personal Circle wallet from AUTH_KV.
 * NEVER returns the platform CIRCLE_WALLET_* env values as a user identity.
 */
async function resolveUserWallet(env, request) {
  const KV = env && env.AUTH_KV;
  const apiKey = (env && env.CIRCLE_API_KEY) || '';
  const noWallet = { ok: true, apiKey, walletId: '', walletAddress: '', needsProvision: true, email: null, userId: null };

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
    if (raw) user = JSON.parse(raw);
  } catch (_) { user = null; }

  const walletId = (user && user.circleWalletId) || session.circleWalletId || '';
  const walletAddress = (user && user.circleWalletAddress) || session.circleWalletAddress || '';

  if (walletId && walletAddress) {
    return { ok: true, apiKey, walletId, walletAddress, needsProvision: false, email: session.email, userId: user && user.id };
  }
  return { ok: true, apiKey, walletId: '', walletAddress: '', needsProvision: true, email: session.email, userId: user && user.id };
}

/* ── Route handlers ──────────────────────────────────────────────────── */

async function handleStatus(env, request) {
  const flags = readFlags(env);
  const circleConfigured = !!(env && env.CIRCLE_API_KEY && env.CIRCLE_ENTITY_SECRET);

  const walletRes = await resolveUserWallet(env, request).catch(() => ({ needsProvision: true }));
  const walletProvisioned = !!(walletRes && !walletRes.needsProvision && walletRes.walletAddress);

  let state = 'disabled';
  let reason = 'x402 payments are disabled (Phase 1 — infrastructure only)';
  if (flags.enabled) {
    if (!circleConfigured) { state = 'pending_config'; reason = 'Circle credentials not configured'; }
    else if (!walletProvisioned) { state = 'pending_config'; reason = 'Circle AI Smart Wallet not provisioned for this user'; }
    else { state = 'available'; reason = 'x402 payments available'; }
  }

  return json({
    ok: true,
    version: X402_VERSION,
    enabled: flags.enabled,
    state,
    reason,
    facilitator: FACILITATOR_URL,
    circleConfigured,
    wallet: walletProvisioned
      ? { provisioned: true, address: walletRes.walletAddress }
      : { provisioned: false, address: null },
    maxUsd: flags.maxUsd,
    networks: Object.keys(X402_NETWORKS).map((caip) => ({
      caip,
      label: X402_NETWORKS[caip].label,
      chainId: X402_NETWORKS[caip].chainId,
      testnet: X402_NETWORKS[caip].testnet,
      eip3009Compatible: X402_NETWORKS[caip].eip3009Compatible,
    })),
  });
}

async function handleDiscover(env, request) {
  const flags = readFlags(env);

  // Discovery is a server-side outbound fetch — gate it behind a session and
  // SSRF protections so the endpoint cannot be abused as an open proxy.
  const session = await verifySession(env, request);
  if (!session.ok) return err('Unauthorized: ' + session.reason, session.status || 401);

  let body;
  try { body = await request.json(); } catch (_) { return err('Invalid JSON body', 400); }

  const target = body && typeof body.url === 'string' ? body.url.trim() : '';
  if (!target) return err('url is required', 400);

  const safe = assertSafeTarget(target, flags.allowedHosts);
  if (!safe.ok) return err('Target blocked: ' + safe.reason, 400);

  let resp;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    resp = await fetch(safe.url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'Accept': 'application/json, */*', 'User-Agent': 'Elligentt-x402/1.0' },
    });
    clearTimeout(timer);
  } catch (e) {
    return err('Discovery request failed: ' + (e && e.message ? e.message : e), 502);
  }

  const status = resp.status;
  const headerValue = resp.headers.get(HEADER_PAYMENT_REQUIRED) || '';
  let bodyText = '';
  try { bodyText = await resp.text(); } catch (_) { bodyText = ''; }

  if (status !== 402) {
    // Not an x402 payment request (or already authorized) — no requirements.
    return json({ ok: true, status, x402: false, resourceUrl: target, requirements: [] });
  }

  const parsed = parsePaymentRequired(headerValue, bodyText);
  if (!parsed.ok) {
    return json({
      ok: true,
      status,
      x402: true,
      resourceUrl: target,
      headerPresent: !!headerValue,
      parseError: parsed.reason,
      requirements: [],
    });
  }

  const normalized = normalizePaymentRequired(parsed.paymentRequired);
  if (!normalized.ok) {
    return json({ ok: true, status, x402: true, resourceUrl: target, parseError: normalized.reason, requirements: [] });
  }

  const requirements = normalized.requirements.map((req) => {
    const v = validateRequirement(req, { maxUsd: flags.maxUsd });
    return Object.assign({}, req, {
      id: requirementId(target, req),
      amountUsd: v.amountUsd,
      valid: v.ok,
      checks: v.checks,
    });
  });

  return json({
    ok: true,
    status,
    x402: true,
    resourceUrl: target,
    resource: normalized.resource,
    headerPresent: true,
    requirements,
  });
}

async function handlePrepare(env, request) {
  const flags = readFlags(env);

  const session = await verifySession(env, request);
  if (!session.ok) return err('Unauthorized: ' + session.reason, session.status || 401);

  let body;
  try { body = await request.json(); } catch (_) { return err('Invalid JSON body', 400); }

  const resourceUrl = body && typeof body.resourceUrl === 'string' ? body.resourceUrl.trim() : '';
  const req = body && body.requirement ? body.requirement : null;
  if (!resourceUrl) return err('resourceUrl is required', 400);
  if (!req || typeof req !== 'object') return err('requirement is required', 400);

  // Re-validate everything server-side — never trust the client or the model.
  const normalizedReq = {
    scheme: String(req.scheme || 'exact'),
    network: req.network || '',
    networkRaw: req.network || '',
    amount: String(req.amount != null ? req.amount : ''),
    asset: String(req.asset || ''),
    payTo: String(req.payTo || ''),
    maxTimeoutSeconds: Number(req.maxTimeoutSeconds) || 60,
    extra: Object.assign({}, req.extra),
  };

  const validation = validateRequirement(normalizedReq, { maxUsd: flags.maxUsd });

  const wallet = await resolveUserWallet(env, request);
  const checks = [
    { name: 'session', passed: session.ok, detail: session.ok ? 'authenticated' : 'no session' },
    { name: 'wallet', passed: !!wallet.walletAddress, detail: wallet.walletAddress ? wallet.walletAddress : 'Circle AI Smart Wallet not provisioned' },
    { name: 'payments_enabled', passed: flags.enabled, detail: flags.enabled ? 'enabled' : 'x402 payments disabled (Phase 1)' },
  ].concat(validation.checks);

  const blocked = checks.find((c) => !c.passed) || null;
  const intentId = requirementId(resourceUrl, normalizedReq);

  return json({
    ok: true,
    enabled: flags.enabled,
    intent: {
      id: intentId,
      status: blocked ? 'blocked' : 'ready',
      blockedReason: blocked ? blocked.detail : null,
      blockedCheck: blocked ? blocked.name : null,
      checks,
      resourceUrl,
      resource: body.resource || null,
      amountUsd: validation.amountUsd,
      network: validation.network ? validation.network.label : null,
      networkCaip: normalizedReq.network,
      asset: validation.asset,
      payTo: normalizedReq.payTo,
      maxTimeoutSeconds: normalizedReq.maxTimeoutSeconds,
      walletAddress: wallet.walletAddress || null,
    },
  });
}

function handlePay() {
  // Phase 1: no real settlement. There is no simulated payment, no fictional
  // facilitator, and no unsigned relay. This endpoint is intentionally inert
  // and fail-closed until network + EIP-3009 settlement compatibility is
  // confirmed (see docs/x402-integration.md).
  return err('x402 real payments are not enabled — settlement compatibility has not been confirmed', 503, {
    code: 'x402_not_enabled',
    phase: 1,
  });
}

/* ── Main handler ────────────────────────────────────────────────────── */

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(request.url);
  const parts = url.pathname.replace(/\/$/, '').split('/');
  // /api/x402/status → ['','api','x402','status']
  const action = parts[3] || 'status';

  try {
    if (request.method === 'GET') {
      if (action === 'status') return await handleStatus(env, request);
    }

    if (request.method === 'POST') {
      if (action === 'discover') return await handleDiscover(env, request);
      if (action === 'prepare') return await handlePrepare(env, request);
      if (action === 'pay') return handlePay();
    }

    return err('Not found', 404);
  } catch (e) {
    console.error('[x402] unhandled error:', e && e.message);
    return err((e && e.message) || 'Internal error', 500);
  }
}
