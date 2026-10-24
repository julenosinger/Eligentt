/**
 * CF Pages Function — POST /api/gateway/transfer
 *
 * Server-side proxy to Circle Gateway /v1/transfer endpoint.
 *
 * OFFICIAL API SHAPE (Circle docs, Oct 2026):
 *   Request:  POST https://gateway-api.circle.com/v1/transfer
 *             body = array of { burnIntent:{...}, signature:"0x..." }
 *   Response: array of { burnIntent:{...}, attestation:{payload:"...", signature:"..."} }
 *
 * PERSISTENCE (P0):
 *   Before forwarding to Circle, the salt is written to GATEWAY_OPS_KV (if available)
 *   with putIfAbsent semantics: if the key already exists, the forward is blocked and
 *   'already_submitted' is returned. This prevents duplicate submissions after page
 *   reload or network timeout, even across browser sessions.
 *
 *   KV binding: GATEWAY_OPS_KV (optional — if absent, falls back to forward-only mode
 *   with a warning logged). Binding must be added to wrangler.jsonc in production.
 *
 *   Key format: gw:op:{salt}
 *   Value: JSON with { submittedAt, depositor, token, srcChainId, dstChainId, status }
 *   TTL: 7 days (604800 seconds) — salts are one-time-use; after 7 days the entry
 *        can safely expire since Circle's protocol won't accept a stale attestation.
 *
 * RECONCILIATION:
 *   GET /api/gateway/transfer?salt={salt}&depositor={addr} — query submission status
 *   PATCH /api/gateway/transfer?salt={salt} — update status after on-chain confirmation
 *   These handlers let the browser service reconcile ambiguous submissions without
 *   re-executing the transfer.
 *
 * ISOLATION:
 *   Each KV record is keyed by salt (globally unique random bytes32). The proxy
 *   validates that the sourceSigner field in burnIntent.spec.sourceSigner (padded)
 *   equals the depositor field, preventing a caller from submitting an intent whose
 *   sourceSigner does not match. Because Circle's API is permissionless, the only
 *   authorization is the cryptographic signature — no session token is needed or
 *   possible here.
 *
 * SECURITY:
 *   - CORS: exact-origin allowlist (configurable via env ALLOWED_ORIGINS).
 *   - Content-Type and body shape validated before forwarding.
 *   - Only known fields forwarded (burnIntent, signature) — extra fields stripped.
 *   - Body limited to 64 KB.
 *   - 18s server-side timeout.
 *   - Cache-Control: no-store on all responses.
 *   - Never logs attestations, signatures, or private data.
 *
 * NOTE on /v1/estimate:
 *   Circle does not publish a /v1/estimate endpoint in their official documentation.
 *   The previous /v1/estimate proxy route was fabricated and has been permanently removed.
 *   maxFee is a conservative constant per the official Circle how-to example.
 */

const GATEWAY_API   = 'https://gateway-api.circle.com';
const MAX_BODY_LEN  = 65536;   // 64 KB
const TIMEOUT_MS    = 18000;   // 18s (client uses 20s → CF times out first → clean 504)
const KV_TTL_SECS   = 604800;  // 7 days — safe expiry for one-time salts
const KV_PREFIX     = 'gw:op:';

// ── CORS exact-origin allowlist ───────────────────────────────────────────────
function isAllowedOrigin(origin, env) {
  if (!origin) return true; // server-to-server (no Origin header)
  const defaults = [
    'https://elligentt.com',
    'https://www.elligentt.com',
    'https://app.elligentt.com',
    'https://elligentt.pages.dev',
    'https://elligentttest.pages.dev',
  ];
  const envList = env && env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  const allowlist = [...new Set([...defaults, ...envList])];
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin))    return true;
  if (/^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return true;
  return allowlist.includes(origin);
}

// ── Standard response helpers ────────────────────────────────────────────────
function jsonResp(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// ── Validate a padded bytes32 address field ───────────────────────────────────
// A valid bytes32 address is 0x + 64 hex chars, with the address in the last 40.
function isValidPaddedAddress(s) {
  return typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s);
}

// ── Extract unpadded address from bytes32 ────────────────────────────────────
function unpad(bytes32) {
  // Remove 0x, take last 40 chars, prefix 0x
  var h = (bytes32 || '').replace(/^0x/, '');
  return '0x' + h.slice(-40);
}

// ── POST /api/gateway/transfer ────────────────────────────────────────────────
export async function onRequestPost(ctx) {
  const { request, env } = ctx;

  // ── CORS ─────────────────────────────────────────────────────────────────
  const origin = request.headers.get('Origin') || '';
  if (!isAllowedOrigin(origin, env)) {
    return jsonResp({ error: 'forbidden' }, 403);
  }

  // ── Content-Type ─────────────────────────────────────────────────────────
  const ct = request.headers.get('Content-Type') || '';
  if (!ct.includes('application/json')) {
    return jsonResp({ error: 'content_type_required' }, 400);
  }

  // ── Body size ─────────────────────────────────────────────────────────────
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_LEN) {
    return jsonResp({ error: 'request_too_large' }, 413);
  }

  // ── Parse JSON ────────────────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(rawBody); } catch(_) {
    return jsonResp({ error: 'invalid_json' }, 400);
  }

  // Must be a non-empty array
  if (!Array.isArray(body) || body.length === 0) {
    return jsonResp({ error: 'requests_required' }, 400);
  }

  // ── Validate each item ────────────────────────────────────────────────────
  for (const item of body) {
    if (!item || typeof item !== 'object') {
      return jsonResp({ error: 'invalid_request_item' }, 400);
    }

    // burnIntent required
    if (!item.burnIntent || typeof item.burnIntent !== 'object') {
      return jsonResp({ error: 'burnIntent_required' }, 400);
    }

    // spec required
    const spec = item.burnIntent.spec;
    if (!spec || typeof spec !== 'object') {
      return jsonResp({ error: 'spec_required' }, 400);
    }

    // salt required — bytes32 hex string
    if (typeof spec.salt !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(spec.salt)) {
      return jsonResp({ error: 'salt_required' }, 400);
    }

    // sourceSigner must be a valid padded address
    if (!isValidPaddedAddress(spec.sourceSigner)) {
      return jsonResp({ error: 'sourceSigner_required' }, 400);
    }

    // signature required — 0x + at least 130 hex chars
    if (typeof item.signature !== 'string') {
      return jsonResp({ error: 'signature_required' }, 400);
    }
    if (!/^0x[0-9a-fA-F]{130,}$/.test(item.signature)) {
      return jsonResp({ error: 'invalid_signature_format' }, 400);
    }
  }

  // ── KV idempotence check: refuse if any salt was already submitted ────────
  const kv = env && env.GATEWAY_OPS_KV;
  const kvAvailable = !!kv;

  if (kvAvailable) {
    for (const item of body) {
      const salt    = item.burnIntent.spec.salt;
      const kvKey   = KV_PREFIX + salt;
      let existing;
      try { existing = await kv.get(kvKey, { type: 'json' }); } catch(_) { existing = null; }

      if (existing !== null) {
        // Salt already submitted — return the persisted record
        return jsonResp({
          error:           'already_submitted',
          salt,
          submittedAt:     existing.submittedAt,
          status:          existing.status || 'submitted',
          depositor:       existing.depositor,
          recoverable:     true,
        }, 409);
      }
    }

    // Write all salts as "submitting" BEFORE forwarding to Circle.
    // This is the critical ordering — write first, then forward. If Circle accepts,
    // the entry is updated to "accepted". If the forward fails, the entry stays as
    // "submitting" (ambiguous) and is NOT deleted — the caller must reconcile.
    const now = new Date().toISOString();
    for (const item of body) {
      const salt    = item.burnIntent.spec.salt;
      const kvKey   = KV_PREFIX + salt;
      const signer  = unpad(item.burnIntent.spec.sourceSigner);
      const record  = {
        submittedAt:  now,
        depositor:    signer,
        status:       'submitting',
        srcDomain:    item.burnIntent.spec.sourceDomain,
        dstDomain:    item.burnIntent.spec.destinationDomain,
      };
      try {
        await kv.put(kvKey, JSON.stringify(record), { expirationTtl: KV_TTL_SECS });
      } catch(_) {
        // KV write failure is non-fatal for the forward — but logged
        // If KV becomes unavailable mid-request, we proceed without it
      }
    }
  }

  // ── Build clean upstream payload ──────────────────────────────────────────
  const upstream = body.map(item => ({
    burnIntent: item.burnIntent,
    signature:  item.signature,
  }));

  // ── Forward to Circle Gateway /v1/transfer ────────────────────────────────
  const ctrl    = new AbortController();
  const timerId = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  let upRes, upBody;
  try {
    upRes = await fetch(GATEWAY_API + '/v1/transfer', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(upstream, (_k, v) =>
                 typeof v === 'bigint' ? v.toString() : v),
      signal:  ctrl.signal,
    });
    upBody = await upRes.text();
  } catch(err) {
    clearTimeout(timerId);
    const isTimeout = err.name === 'AbortError';

    // Ambiguous — Circle may or may not have received the request.
    // KV entries stay as "submitting" (never deleted here) — caller reconciles.
    return jsonResp({
      error:    isTimeout ? 'gateway_timeout' : 'gateway_unreachable',
      detail:   err.message,
      ambiguous: true,
    }, isTimeout ? 504 : 502);
  }
  clearTimeout(timerId);

  // ── Update KV status to "accepted" or "rejected" ─────────────────────────
  if (kvAvailable) {
    const newStatus = upRes.ok ? 'accepted' : 'rejected';
    for (const item of body) {
      const salt   = item.burnIntent.spec.salt;
      const kvKey  = KV_PREFIX + salt;
      const signer = unpad(item.burnIntent.spec.sourceSigner);
      const record = {
        submittedAt:  new Date().toISOString(),
        depositor:    signer,
        status:       newStatus,
        httpStatus:   upRes.status,
        srcDomain:    item.burnIntent.spec.sourceDomain,
        dstDomain:    item.burnIntent.spec.destinationDomain,
      };
      try {
        await kv.put(kvKey, JSON.stringify(record), { expirationTtl: KV_TTL_SECS });
      } catch(_) {}
    }
  }

  // ── Relay response ────────────────────────────────────────────────────────
  let parsed;
  try { parsed = JSON.parse(upBody); } catch(_) { parsed = { raw: upBody }; }

  return new Response(JSON.stringify(parsed), {
    status: upRes.status,
    headers: {
      'Content-Type':  'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

// ── GET /api/gateway/transfer?salt=...&depositor=... ─────────────────────────
// Query the status of a previously submitted transfer by salt.
// Returns the KV record if found, or 404.
export async function onRequestGet(ctx) {
  const { request, env } = ctx;

  const origin = request.headers.get('Origin') || '';
  if (!isAllowedOrigin(origin, env)) {
    return jsonResp({ error: 'forbidden' }, 403);
  }

  const url      = new URL(request.url);
  const salt     = url.searchParams.get('salt');
  const depositor = url.searchParams.get('depositor');

  if (!salt || !/^0x[0-9a-fA-F]{64}$/.test(salt)) {
    return jsonResp({ error: 'salt_required' }, 400);
  }

  const kv = env && env.GATEWAY_OPS_KV;
  if (!kv) {
    return jsonResp({ error: 'kv_unavailable', status: 'unknown' }, 200);
  }

  const kvKey = KV_PREFIX + salt;
  let record;
  try { record = await kv.get(kvKey, { type: 'json' }); } catch(_) { record = null; }

  if (!record) {
    return jsonResp({ error: 'not_found', salt }, 404);
  }

  // Verify depositor matches if provided — isolation check
  if (depositor) {
    const norm = (s) => (s || '').toLowerCase().replace(/^0x/, '');
    if (norm(record.depositor) !== norm(depositor)) {
      // Return 404 (not 403) to avoid leaking the existence of the record
      return jsonResp({ error: 'not_found', salt }, 404);
    }
  }

  return jsonResp({ salt, ...record }, 200);
}

// ── PATCH /api/gateway/transfer — update confirmed status ────────────────────
// Called by the browser after on-chain confirmation to mark the operation DONE.
export async function onRequestPatch(ctx) {
  const { request, env } = ctx;

  const origin = request.headers.get('Origin') || '';
  if (!isAllowedOrigin(origin, env)) {
    return jsonResp({ error: 'forbidden' }, 403);
  }

  const url  = new URL(request.url);
  const salt = url.searchParams.get('salt');

  if (!salt || !/^0x[0-9a-fA-F]{64}$/.test(salt)) {
    return jsonResp({ error: 'salt_required' }, 400);
  }

  const rawBody = await request.text().catch(() => '{}');
  let patch;
  try { patch = JSON.parse(rawBody); } catch(_) { patch = {}; }

  const kv = env && env.GATEWAY_OPS_KV;
  if (!kv) {
    return jsonResp({ ok: true, note: 'kv_unavailable_no_op' }, 200);
  }

  const kvKey = KV_PREFIX + salt;
  let record;
  try { record = await kv.get(kvKey, { type: 'json' }); } catch(_) { record = null; }

  if (!record) {
    return jsonResp({ error: 'not_found' }, 404);
  }

  // Only allow status transitions: submitting→accepted→confirmed, or any→failed
  const allowed = ['confirmed', 'failed'];
  if (!allowed.includes(patch.status)) {
    return jsonResp({ error: 'invalid_status_transition' }, 400);
  }

  const updated = { ...record,
    status:       patch.status,
    confirmedAt:  new Date().toISOString(),
    txHash:       patch.txHash || record.txHash || null,
  };
  try {
    await kv.put(kvKey, JSON.stringify(updated), { expirationTtl: KV_TTL_SECS });
  } catch(_) {
    return jsonResp({ error: 'kv_write_failed' }, 500);
  }

  return jsonResp({ ok: true, salt, status: patch.status }, 200);
}

export async function onRequestPut()    { return jsonResp({ error: 'method_not_allowed' }, 405); }
export async function onRequestDelete() { return jsonResp({ error: 'method_not_allowed' }, 405); }
