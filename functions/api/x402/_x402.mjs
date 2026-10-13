/**
 * x402 — shared backend helpers (server-side only).
 * ═══════════════════════════════════════════════════════════════════════
 * Implements parsing / normalisation / validation for the x402 open payment
 * standard (https://docs.x402.org, protocol version 2) on the BUYER side.
 *
 * This module is NOT routed by Cloudflare Pages (leading underscore). It is
 * imported by functions/api/x402/index.js and by the vitest test suite.
 *
 * SECURITY MODEL
 *   - No Circle secrets, private keys or API keys live here or are ever
 *     returned to the browser. All such credentials stay in `context.env`.
 *   - Payment requirements returned by a resource server are NEVER trusted
 *     blindly: every field is validated here (scheme, CAIP-2 network, asset,
 *     payTo address, amount, timeout) and the network/asset compatibility is
 *     checked against an explicit table before a payment could ever proceed.
 *   - `PAYMENT-REQUIRED` (and `PAYMENT-RESPONSE`) headers are Base64-encoded
 *     JSON per the v2 spec; we decode defensively and fail-closed on garbage.
 *
 * x402 v2 spec reference:
 *   https://raw.githubusercontent.com/x402-foundation/x402/main/specs/x402-specification-v2.md
 */

export const X402_VERSION = 2;

// HTTP header names used by the protocol (v2).
export const HEADER_PAYMENT_REQUIRED = 'PAYMENT-REQUIRED';
export const HEADER_PAYMENT_SIGNATURE = 'PAYMENT-SIGNATURE';
export const HEADER_PAYMENT_RESPONSE = 'PAYMENT-RESPONSE';

export const SCHEME_EXACT = 'exact';

// Circle Facilitator Service (reference facilitator used by the `exact` scheme).
export const FACILITATOR_URL = 'https://x402.org/facilitator';

/**
 * Supported x402 networks (CAIP-2 → metadata).
 *
 * `eip3009Compatible` reflects whether we have CONFIRMED that the canonical USDC
 * asset on that network implements EIP-3009 `transferWithAuthorization` (the
 * mechanism used by the `exact` scheme). Arc Mainnet is marked `false` because
 * its USDC is a native precompile (`0x3600…0000`, native gas token = USDC), NOT
 * a standard ERC-20 with EIP-3009 support — this must be confirmed on-chain
 * before real payments can be enabled (see docs/x402-integration.md).
 */
export const X402_NETWORKS = Object.freeze({
  'eip155:84532': Object.freeze({ chainId: 84532, label: 'Base Sepolia', testnet: true, eip3009Compatible: true }),
  'eip155:8453':  Object.freeze({ chainId: 8453,  label: 'Base',         testnet: false, eip3009Compatible: true }),
  'eip155:137':   Object.freeze({ chainId: 137,   label: 'Polygon PoS',  testnet: false, eip3009Compatible: true }),
  'eip155:5042':  Object.freeze({ chainId: 5042,  label: 'Arc Mainnet',  testnet: false, eip3009Compatible: false }),
});

// Legacy slug → CAIP-2 mapping (some servers still advertise short slugs).
const NETWORK_SLUG_MAP = {
  'base-sepolia': 'eip155:84532',
  'base':         'eip155:8453',
  'polygon-pos':  'eip155:137',
  'polygon':      'eip155:137',
  'arc':          'eip155:5042',
  'arc-mainnet':  'eip155:5042',
};

/**
 * Trusted assets (explicit allowlist). An x402 requirement MUST reference one
 * of these exact contract addresses on its network; `extra.name` / `extra.version`
 * must match the EIP-712 domain; `decimals` fixes the amount interpretation.
 *
 * We NEVER trust `extra.name === "USDC"` alone — a malicious server could label
 * any token "USDC". The contract address + network + domain must all match a
 * known, EIP-3009-capable USDC deployment.
 *
 * Arc Mainnet (`eip155:5042`) is listed for completeness but is blocked at the
 * network level (`eip3009Compatible: false`) — its native USDC is a precompile,
 * NOT a standard EIP-3009 ERC-20.
 */
export const TRUSTED_ASSETS = Object.freeze({
  'eip155:84532': Object.freeze({ address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', symbol: 'USDC', decimals: 6, domainName: 'USDC', domainVersion: '2' }),
  'eip155:8453':  Object.freeze({ address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6, domainName: 'USDC', domainVersion: '2' }),
  'eip155:137':   Object.freeze({ address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', symbol: 'USDC', decimals: 6, domainName: 'USDC', domainVersion: '2' }),
  'eip155:5042':  Object.freeze({ address: '0x3600000000000000000000000000000000000000', symbol: 'USDC', decimals: 6, domainName: 'USDC', domainVersion: '2' }),
});

export const DEFAULT_MAX_USD = 25; // hard cap on a single x402 payment (Phase 1)

// Settlement is NOT implemented in Phase 1. This code-level flag guarantees the
// status endpoint can never claim payments are "available" while there is no
// real authorization → signing → verification → confirmation flow.
export const SETTLEMENT_IMPLEMENTED = false;

/* ── Base64 helpers (Workers runtime provides atob/btoa) ─────────────── */

function decodeB64(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const clean = value.trim();
    const bin = atob(clean);
    return new TextDecoder().decode(new Uint8Array([...bin].map((c) => c.charCodeAt(0))));
  } catch (_) {
    return null;
  }
}

/**
 * Parse a `PAYMENT-REQUIRED` header value (Base64-encoded JSON per v2) with a
 * JSON-body fallback for servers that return the requirements in the 402 body.
 * @returns {{ok:true, paymentRequired:object} | {ok:false, reason:string}}
 */
export function parsePaymentRequired(headerValue, bodyText) {
  const candidates = [];
  if (headerValue) {
    // v2: base64 JSON
    const decoded = decodeB64(headerValue);
    if (decoded) candidates.push(decoded);
    // be lenient: some stacks put raw JSON in the header
    candidates.push(String(headerValue));
  }
  if (bodyText) candidates.push(String(bodyText));

  for (const raw of candidates) {
    if (!raw) continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    // try a direct JSON object first
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return { ok: true, paymentRequired: obj };
    } catch (_) { /* fall through */ }
    // try extracting the first {...} JSON object from the text (defensive)
    const start = trimmed.indexOf('{');
    if (start !== -1) {
      const end = trimmed.lastIndexOf('}');
      if (end > start) {
        try {
          const obj = JSON.parse(trimmed.slice(start, end + 1));
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) return { ok: true, paymentRequired: obj };
        } catch (_) { /* fall through */ }
      }
    }
  }
  return { ok: false, reason: 'No parseable PaymentRequired object found' };
}

/* ── Address / network validation ────────────────────────────────────── */

export function isAddress(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/**
 * Normalise a network identifier to CAIP-2 `eip155:<chainId>`, accepting the
 * canonical form plus legacy short slugs. Returns null when unknown.
 */
export function normalizeNetwork(network) {
  if (typeof network !== 'string') return null;
  const n = network.trim();
  if (/^eip155:\d+$/.test(n)) return n;
  const mapped = NETWORK_SLUG_MAP[n.toLowerCase()];
  return mapped || null;
}

function asciiSafe(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.replace(/[^\x20-\x7e]/g, '').slice(0, maxLen);
}

/**
 * Normalise a raw `PaymentRequired` object into a list of candidate
 * `PaymentRequirements`, tolerant of the v1 field names still seen in the wild
 * (`maxAmountRequired` → `amount`, short network slugs → CAIP-2, `accepts`).
 *
 * @returns {{ok:true, resource:object|null, requirements:object[]} | {ok:false, reason:string}}
 */
export function normalizePaymentRequired(paymentRequired) {
  if (!paymentRequired || typeof paymentRequired !== 'object') {
    return { ok: false, reason: 'PaymentRequired is not an object' };
  }

  const x402Version = Number(paymentRequired.x402Version);
  if (!Number.isFinite(x402Version) || x402Version !== X402_VERSION) {
    return { ok: false, reason: 'unsupported or missing x402 version (expected ' + X402_VERSION + ')' };
  }

  const rawAccepts = Array.isArray(paymentRequired.accepts)
    ? paymentRequired.accepts
    : (Array.isArray(paymentRequired.paymentRequirements) ? paymentRequired.paymentRequirements : null);

  if (!rawAccepts) {
    return { ok: false, reason: 'PaymentRequired has no accepts[] array' };
  }

  const resource = paymentRequired.resource && typeof paymentRequired.resource === 'object'
    ? {
        url: asciiSafe(paymentRequired.resource.url, 2048),
        description: asciiSafe(paymentRequired.resource.description, 512),
        mimeType: asciiSafe(paymentRequired.resource.mimeType, 256),
        serviceName: asciiSafe(paymentRequired.resource.serviceName, 64),
      }
    : null;

  const requirements = [];
  for (const r of rawAccepts) {
    if (!r || typeof r !== 'object') continue;
    const network = normalizeNetwork(r.network);
    const amount = r.amount != null ? String(r.amount) : (r.maxAmountRequired != null ? String(r.maxAmountRequired) : '');
    const extra = r.extra && typeof r.extra === 'object' ? r.extra : {};
    requirements.push({
      scheme: String(r.scheme || SCHEME_EXACT),
      network,
      networkRaw: String(r.network || ''),
      amount,
      asset: String(r.asset || ''),
      payTo: String(r.payTo || ''),
      maxTimeoutSeconds: Number(r.maxTimeoutSeconds) || 60,
      extra: {
        assetTransferMethod: extra.assetTransferMethod || 'eip3009',
        name: String(extra.name || ''),
        version: String(extra.version || ''),
      },
    });
  }

  return { ok: true, resource, requirements };
}

/**
 * Validate a single `PaymentRequirements` entry. Returns structured checks so
 * the UI (and tests) can report exactly WHY a payment is blocked.
 */
export function validateRequirement(req, opts = {}) {
  const checks = [];
  const maxUsd = Number(opts.maxUsd) > 0 ? Number(opts.maxUsd) : DEFAULT_MAX_USD;
  const add = (name, passed, detail) => checks.push({ name, passed: !!passed, detail });

  add('scheme', req.scheme === SCHEME_EXACT, req.scheme === SCHEME_EXACT ? 'exact' : 'unsupported scheme "' + req.scheme + '"');

  const net = X402_NETWORKS[req.network];
  add('network_supported', !!net, net ? net.label : 'unsupported network "' + req.networkRaw + '"');

  const trusted = net ? TRUSTED_ASSETS[req.network] : null;

  if (net) {
    add('network_eip3009', net.eip3009Compatible, net.eip3009Compatible
      ? net.label + ' USDC supports EIP-3009'
      : net.label + ' EIP-3009 compatibility NOT confirmed — payments blocked');
  }

  // Asset contract address MUST be the trusted USDC address for this network.
  const assetAddr = String(req.asset || '').toLowerCase();
  add('asset_known', !!trusted && trusted.address.toLowerCase() === assetAddr,
    trusted
      ? (trusted.address.toLowerCase() === assetAddr
          ? trusted.symbol + ' (' + trusted.address + ')'
          : 'asset address not in trusted list for ' + net.label)
      : 'no trusted asset for this network');

  // EIP-712 domain name + version MUST match the trusted token deployment.
  const extraName = String((req.extra && req.extra.name) || '').toUpperCase();
  const extraVersion = String((req.extra && req.extra.version) || '');
  add('asset_domain_name', !!trusted && extraName === trusted.domainName,
    extraName === 'USDC' ? 'EIP-712 domain name "USDC"' : 'unsupported token name "' + (req.extra && req.extra.name) + '"');
  add('asset_domain_version', !!trusted && extraVersion === trusted.domainVersion,
    extraVersion === '2' ? 'EIP-712 domain version "2"' : 'unsupported domain version "' + extraVersion + '"');

  // Only the default `eip3009` transfer method is supported in Phase 1.
  const transferMethod = String((req.extra && req.extra.assetTransferMethod) || 'eip3009');
  add('asset_transfer_method', transferMethod === 'eip3009',
    transferMethod === 'eip3009' ? 'eip3009' : 'unsupported assetTransferMethod "' + transferMethod + '"');

  add('payto_valid', isAddress(req.payTo), isAddress(req.payTo) ? req.payTo : 'invalid recipient address');

  const decimals = (trusted && trusted.decimals) || 6;
  const amountBig = (() => { try { return BigInt(String(req.amount || '').trim()); } catch (_) { return null; } })();
  const amountUsd = amountBig !== null ? Number(amountBig) / Math.pow(10, decimals) : NaN;
  add('amount_valid', amountBig !== null && amountBig > 0n, amountBig !== null && amountBig > 0n
    ? (amountUsd.toFixed(2) + ' USDC')
    : 'invalid or non-positive amount');
  add('amount_within_max', amountBig !== null && amountUsd <= maxUsd, amountBig !== null && amountUsd <= maxUsd
    ? amountUsd.toFixed(2) + ' ≤ max ' + maxUsd.toFixed(2)
    : 'exceeds max authorized ' + maxUsd.toFixed(2) + ' USDC');

  const timeout = Number(req.maxTimeoutSeconds);
  add('timeout_valid', Number.isFinite(timeout) && timeout > 0 && timeout <= 3600,
    Number.isFinite(timeout) && timeout > 0 && timeout <= 3600 ? timeout + 's' : 'invalid timeout');

  const passed = checks.every((c) => c.passed);
  return {
    ok: passed,
    checks,
    amountUsd: Number.isFinite(amountUsd) ? amountUsd : null,
    network: net || null,
    asset: (trusted && trusted.symbol) || null,
    decimals,
  };
}

/* ── Deterministic requirement id (idempotency / dedup) ──────────────── */

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}

/**
 * Deterministic id for a normalized requirement + resource URL. Used by the
 * client to dedupe payments and to reconcile existing operations (never resend
 * a payment that was already submitted).
 */
export function requirementId(resourceUrl, requirement) {
  const canon = [
    String(resourceUrl || ''),
    String(requirement.scheme || ''),
    String(requirement.network || ''),
    String(requirement.amount || ''),
    String(requirement.asset || '').toLowerCase(),
    String(requirement.payTo || '').toLowerCase(),
    String(requirement.maxTimeoutSeconds || ''),
  ].join('|');
  return 'x402_' + fnv1a(canon);
}

/* ── SSRF guard for the discovery proxy ──────────────────────────────── */

const PRIVATE_IPV4_RE = /^(10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|100\.(6[4-9]|7\d|8\d|9\d|1[01]\d|12[0-7])\.|198\.1[89]\.|192\.0\.0\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|224\.|240\.)/;

/**
 * Best-effort SSRF guard for Cloudflare Workers (which exposes no DNS resolver).
 * Blocks loopback / private / link-local / reserved IP literals and obviously
 * internal hostnames. For strong protection in production, set X402_ALLOWED_HOSTS
 * to an explicit allowlist — see docs/x402-integration.md.
 */
export function assertSafeTarget(urlStr, allowedHosts = []) {
  let url;
  try { url = new URL(urlStr); } catch (_) { return { ok: false, reason: 'invalid URL' }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'only http/https targets are allowed' };
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (allowedHosts && allowedHosts.length) {
    const allowed = allowedHosts.map((h) => h.trim().toLowerCase()).filter(Boolean);
    if (allowed.length && !allowed.includes(host)) {
      return { ok: false, reason: 'host not in X402_ALLOWED_HOSTS allowlist' };
    }
    return { ok: true, url };
  }

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, reason: 'internal hostname blocked' };
  }

  // IPv6 literal (any form) — blocked outright for the discovery proxy, since a
  // legitimate x402 service is never an IPv6 literal and IPv4-mapped forms can
  // smuggle private/loopback addresses.
  if (host.includes(':')) {
    return { ok: false, reason: 'IPv6 literal targets are not allowed' };
  }

  // IPv4 literal — block loopback / private / link-local / reserved ranges.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    if (PRIVATE_IPV4_RE.test(host + '.') || host === '0.0.0.0' || host === '255.255.255.255') {
      return { ok: false, reason: 'private/loopback IP blocked' };
    }
  }

  return { ok: true, url };
}

export function parseAllowedHosts(env) {
  const raw = (env && env.X402_ALLOWED_HOSTS) || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Read the x402 feature flags from env. Everything defaults to OFF/fail-closed.
 */
export function readFlags(env) {
  return {
    enabled: String((env && env.X402_ENABLED) || 'false').toLowerCase() === 'true',
    maxUsd: (() => { const n = Number(env && env.X402_MAX_USD); return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_USD; })(),
    allowedHosts: parseAllowedHosts(env),
  };
}
