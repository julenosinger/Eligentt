/**
 * x402 — Circle Facilitator Service adapter (isolated, disabled-by-default transport)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Server-side transport for Circle's hosted x402 Facilitator Service, verified
 * against the official API (developers.circle.com/facilitator-service):
 *
 *   GET  /v1/facilitator/x402/supported   → capabilities (no auth)
 *   POST /v1/facilitator/x402/verify      → verify signed authorization (NON-settling)
 *   POST /v1/facilitator/x402/settle      → SETTLE (submits USDC transfer onchain)
 *   GET  /v1/facilitator/x402/status      → reconciliation
 *
 * Arc Mainnet: network `eip155:5042`, USDC `0x3600…0000`, schemes `exact` (+ `upto`),
 * decimals 6, EIP-3009 exact payload `{ signature, authorization }`.
 *
 * SECURITY / GATES:
 *   - `settle` is implemented as a transport method but is ALWAYS disabled in this
 *     phase (`settleEnabled()` returns false; the method refuses to call out). No
 *     facilitator settlement may execute.
 *   - `verify` is gated behind `X402_FACILITATOR_VERIFY=true` AND `CIRCLE_API_KEY`.
 *   - No Circle API key or credential is ever exposed to the browser.
 *   - Sensitive data (signatures, API keys) is never logged; only error codes.
 *   - Transport is injected (`transport`) for dependency-injection testing.
 */
const DEFAULT_BASE_URL = 'https://api.circle.com';
const VERIFY_PATH = '/v1/facilitator/x402/verify';
const SETTLE_PATH = '/v1/facilitator/x402/settle';
const SUPPORTED_PATH = '/v1/facilitator/x402/supported';
const STATUS_PATH = '/v1/facilitator/x402/status';

export const FACILITATOR_X402_VERSION = 2;

/* ── Configuration / gates ───────────────────────────────────────────── */

export function facilitatorBaseUrl(env) {
  return (env && env.FACILITATOR_BASE_URL) || DEFAULT_BASE_URL;
}

export function facilitatorConfigured(env) {
  return !!(env && env.CIRCLE_API_KEY);
}

/** Verification is safe (non-settling) but still gated behind explicit opt-in + credentials. */
export function verifyEnabled(env) {
  return !!(env && env.X402_FACILITATOR_VERIFY === 'true' && env.CIRCLE_API_KEY);
}

/** Settlement is NEVER enabled in this phase. */
export function settleEnabled() {
  return false;
}

/* ── Capabilities (GET /supported) ───────────────────────────────────── */

async function transportFetch(transport, url, init) {
  const fetchFn = transport || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  if (!fetchFn) throw new Error('no_transport');
  return fetchFn(url, init);
}

/**
 * Fetch facilitator capabilities. Returns `{ ok, data?, error? }`.
 * The /supported endpoint requires no auth; a timeout is enforced.
 */
export async function fetchSupported(env, transport) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const resp = await transportFetch(transport, facilitatorBaseUrl(env) + SUPPORTED_PATH, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    let data = null;
    try { data = await resp.json(); } catch (_) { data = null; }
    if (!resp.ok) return { ok: false, error: classifyError(resp.status, data) };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: (e && e.name === 'AbortError') ? 'network_timeout' : 'network_error' };
  }
}

/**
 * Normalize + validate a `/supported` response into a minimal capabilities model.
 * Returns `{ ok:true, capabilities }` or `{ ok:false, error }`.
 */
export function parseSupported(data) {
  if (!data || typeof data !== 'object') return { ok: false, error: 'malformed_response' };
  if (data.x402Version !== FACILITATOR_X402_VERSION) {
    return { ok: false, error: 'unsupported_protocol_version', x402Version: data.x402Version };
  }
  if (!Array.isArray(data.kinds)) return { ok: false, error: 'malformed_response' };
  const kinds = [];
  for (const k of data.kinds) {
    if (!k || typeof k !== 'object') continue;
    if (typeof k.scheme !== 'string' || typeof k.network !== 'string' || typeof k.asset !== 'string') {
      continue; // skip malformed kind entries
    }
    kinds.push({
      x402Version: k.x402Version,
      scheme: k.scheme,
      network: k.network,
      asset: String(k.asset).toLowerCase(),
      decimals: k.decimals,
      extra: k.extra || {},
    });
  }
  return {
    ok: true,
    capabilities: {
      x402Version: data.x402Version,
      kinds,
      extensions: Array.isArray(data.extensions) ? data.extensions : [],
      signers: data.signers || {},
    },
  };
}

/**
 * Verify a specific `(network, scheme, asset)` triple is supported. Pure.
 */
export function verifySupportedCapability(capabilities, { network, scheme, asset, decimals }) {
  if (!capabilities || !Array.isArray(capabilities.kinds)) {
    return { ok: false, reason: 'malformed_response' };
  }
  const match = capabilities.kinds.find((k) =>
    k.network === network &&
    k.scheme === scheme &&
    k.asset === String(asset).toLowerCase()
  );
  if (!match) {
    return { ok: false, reason: 'capability_unsupported' };
  }
  if (decimals != null && match.decimals != null && Number(match.decimals) !== Number(decimals)) {
    return { ok: false, reason: 'asset_decimals_mismatch' };
  }
  return { ok: true, kind: match };
}

/* ── Payment payload construction (x402 v2 `exact` / EIP-3009) ───────── */

export function buildPaymentRequirements(intent) {
  return {
    scheme: 'exact',
    network: intent.network,
    amount: intent.amountAtomic,           // exact atomic decimal string (never Number)
    asset: intent.assetAddress,
    payTo: intent.payTo,
    maxTimeoutSeconds: intent.maxTimeoutSeconds,
    extra: { name: 'USDC', version: '2', assetTransferMethod: 'eip3009' },
  };
}

/**
 * Build the x402 v2 PaymentPayload from the persisted AUTHORIZED intent. The
 * signed terms are taken from the intent's durable authorization fields — never
 * from browser input. `value` is the exact BigInt atomic amount.
 */
export function buildPaymentPayload(intent, opts = {}) {
  return {
    x402Version: FACILITATOR_X402_VERSION,
    resource: {
      url: intent.resourceUrl || '',
      description: opts.description || '',
      mimeType: opts.mimeType || 'application/json',
    },
    accepted: buildPaymentRequirements(intent),
    payload: {
      signature: intent.authorizationSignature,
      authorization: {
        from: intent.walletAddress,
        to: intent.payTo,
        value: intent.amountAtomic,
        validAfter: intent.authorizationValidAfter,
        validBefore: intent.authorizationValidBefore,
        nonce: intent.authorizationNonce,
      },
    },
    extensions: opts.paymentIdentifier
      ? { 'payment-identifier': { info: { required: true, id: opts.paymentIdentifier } } }
      : undefined,
  };
}

export function buildVerificationRequest(paymentPayload) {
  return {
    x402Version: FACILITATOR_X402_VERSION,
    paymentPayload,
    paymentRequirements: paymentPayload.accepted,
  };
}

/* ── Provider transport (POST /verify, POST /settle, GET /status) ────── */

function authHeaders(env) {
  const apiKey = (env && env.CIRCLE_API_KEY) || '';
  return apiKey ? { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
}

async function postFacilitator(env, path, body, transport, { allowSettle = false } = {}) {
  if (path === SETTLE_PATH && !allowSettle) {
    return { ok: false, error: 'settlement_disabled' };
  }
  if (!facilitatorConfigured(env)) return { ok: false, error: 'config_unavailable' };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const resp = await transportFetch(transport, facilitatorBaseUrl(env) + path, {
      method: 'POST',
      headers: authHeaders(env),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    let data = null;
    try { data = await resp.json(); } catch (_) { data = null; }
    if (!resp.ok) return { ok: false, error: classifyError(resp.status, data), status: resp.status };
    return { ok: true, status: resp.status, data };
  } catch (e) {
    return { ok: false, error: (e && e.name === 'AbortError') ? 'network_timeout' : 'network_error' };
  }
}

/**
 * Verify a signed authorization WITHOUT settling. Returns
 * `{ ok, isValid?, invalidReason?, payer?, data? }`.
 */
export async function verifyPayment(env, verificationRequest, transport) {
  const res = await postFacilitator(env, VERIFY_PATH, verificationRequest, transport);
  if (!res.ok) return res;
  const data = res.data && res.data.data ? res.data.data : res.data;
  if (!data || typeof data !== 'object') return { ok: false, error: 'malformed_response' };
  return {
    ok: true,
    isValid: !!data.isValid,
    invalidReason: data.invalidReason || null,
    payer: data.payer || null,
    data,
  };
}

/**
 * Settle a payment. ALWAYS DISABLED in this phase — never calls the provider.
 */
export async function settlePayment(env, body, transport) {
  return { ok: false, error: 'settlement_disabled' };
}

/**
 * Query payment status (read-only reconciliation). Gated behind credentials.
 */
export async function getPaymentStatus(env, paymentId, transport) {
  if (!facilitatorConfigured(env)) return { ok: false, error: 'config_unavailable' };
  if (typeof paymentId !== 'string' || !paymentId) return { ok: false, error: 'invalid_payment_id' };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const resp = await transportFetch(transport, facilitatorBaseUrl(env) + STATUS_PATH + '/' + encodeURIComponent(paymentId), {
      method: 'GET',
      headers: authHeaders(env),
      signal: controller.signal,
    });
    clearTimeout(timer);
    let data = null;
    try { data = await resp.json(); } catch (_) { data = null; }
    if (!resp.ok) return { ok: false, error: classifyError(resp.status, data), status: resp.status };
    return { ok: true, data: data && data.data ? data.data : data };
  } catch (e) {
    return { ok: false, error: (e && e.name === 'AbortError') ? 'network_timeout' : 'network_error' };
  }
}

/* ── Error classification (never log sensitive material) ─────────────── */

export function classifyError(status, data) {
  const reason = (data && (data.invalidReason || data.reason)) || null;
  if (status === 401) return 'auth_rejected';
  if (status === 403) return 'auth_rejected';
  if (status === 404) return 'capability_unsupported';
  if (status === 409) return reason ? String(reason) : 'credential_conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'temporarily_unavailable';
  return 'provider_rejected';
}
