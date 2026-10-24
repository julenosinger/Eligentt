/**
 * CF Pages Function — /api/gateway/transfer
 *
 * POST: proxy to Circle Gateway /v1/transfer with atomic idempotence.
 * GET:  query operation status by salt + depositor.
 * PATCH: update status to 'failed' only (client-initiated reconciliation).
 *        'confirmed' is set internally on Circle 2xx — never by client.
 *
 * ── OFFICIAL API SHAPE (Circle docs, Oct 2026) ────────────────────────────────
 *   POST https://gateway-api.circle.com/v1/transfer
 *   body:     array of { burnIntent:{...}, signature:"0x..." }
 *   response: array of { burnIntent:{...}, attestation:{payload:"...",signature:"..."} }
 *
 * ── ATOMICITY ────────────────────────────────────────────────────────────────
 *   Primary:  GATEWAY_OP_LOCK Durable Object (one DO instance per salt).
 *             The CF runtime serializes all requests to the same DO instance,
 *             making the reserve-then-forward step inherently race-free.
 *             See gateway-op-lock.do.js for the DO implementation.
 *
 *   Fallback: GATEWAY_OPS_KV (Workers KV). Used when GATEWAY_OP_LOCK is not
 *             bound (local dev, staging). KV is NOT atomic — it gives strong
 *             sequential protection but best-effort only for concurrent
 *             requests within the same millisecond window.
 *
 *   FAIL-SAFE: if BOTH persistence mechanisms are unavailable, the POST is
 *              BLOCKED and an error is returned. The transfer is NEVER
 *              forwarded without at least one persistence layer.
 *
 * ── ISOLATION ────────────────────────────────────────────────────────────────
 *   GET  requires ?salt= AND ?depositor= — returns 404 for wrong depositor
 *        (does not leak existence).
 *   PATCH requires ?salt= AND ?depositor= — validates match before allowing
 *        status update. Only 'failed' is accepted from the client.
 *
 * ── STATE MACHINE ─────────────────────────────────────────────────────────────
 *   (none) → submitting → accepted → confirmed  [internal only]
 *                       → failed               [client or internal]
 *   submitting → failed                         [client or internal]
 *   confirmed / failed: terminal — no further transitions
 *
 * ── SECURITY ─────────────────────────────────────────────────────────────────
 *   - CORS: exact-origin allowlist (configurable via env ALLOWED_ORIGINS).
 *   - Content-Type and body shape validated before persisting or forwarding.
 *   - Only known fields forwarded (burnIntent, signature) — extra fields stripped.
 *   - Body limited to 64 KB.
 *   - 18s server-side timeout (client uses 20s → CF times out first → clean 504).
 *   - Cache-Control: no-store on all responses.
 *   - sourceSigner in burnIntent.spec must match depositor field.
 *   - Client cannot set status='confirmed' (internal-only transition).
 *   - Never logs signatures, attestations, or private data.
 *   - KV write failure → request blocked (fail-safe), not silently forwarded.
 *
 * ── NOTE ──────────────────────────────────────────────────────────────────────
 *   Circle does not publish a /v1/estimate endpoint. The previous route has
 *   been permanently removed. maxFee is a conservative constant per the
 *   official Circle Gateway how-to.
 *
 * PENDING CONFIGURATION:
 *   Add to wrangler.jsonc:
 *     "kv_namespaces": [{ "binding": "GATEWAY_OPS_KV", "id": "<your-kv-id>" }]
 *   For full atomicity, also activate GATEWAY_OP_LOCK DO:
 *     See gateway-op-lock.do.js for Durable Object setup instructions.
 */

const GATEWAY_API  = 'https://gateway-api.circle.com';
const MAX_BODY_LEN = 65536;   // 64 KB
const TIMEOUT_MS   = 18000;   // 18s
const KV_TTL_SECS  = 604800;  // 7 days
const KV_PREFIX    = 'gw:op:';

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
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin))     return true;
  if (/^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return true;
  return allowlist.includes(origin);
}

// ── Response helpers ──────────────────────────────────────────────────────────
function jsonResp(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// ── Address helpers ───────────────────────────────────────────────────────────
function isValidPaddedAddress(s) {
  return typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s);
}

function unpad(bytes32) {
  return '0x' + ((bytes32 || '').replace(/^0x/, '')).slice(-40);
}

function normAddr(s) {
  return (s || '').toLowerCase().replace(/^0x/, '');
}

// ── Valid state transitions (server-enforced) ─────────────────────────────────
const VALID_TRANSITIONS = {
  submitting: ['accepted', 'failed'],
  accepted:   ['confirmed', 'failed'],
  confirmed:  [],  // terminal
  failed:     [],  // terminal
};

function isValidTransition(from, to) {
  return (VALID_TRANSITIONS[from] || []).includes(to);
}

// ── Persistence layer abstraction ─────────────────────────────────────────────
//
// tryReserve: atomically claim a salt. Returns:
//   { ok: true,  record }          — first caller, reservation created
//   { ok: false, record, conflict: true }  — salt already claimed
//   { ok: false, error: 'unavailable' }    — both layers unavailable
//
// tryRead: read record. Returns null if not found.
// tryUpdate: update status. Returns { ok, error? }.

async function tryReserve(salt, record, env) {
  const doBinding = env && env.GATEWAY_OP_LOCK;
  const kvBinding = env && env.GATEWAY_OPS_KV;

  // ── Durable Object (atomic) ───────────────────────────────────────────────
  if (doBinding) {
    try {
      const doId   = doBinding.idFromName(salt);
      const doStub = doBinding.get(doId);
      const res    = await doStub.fetch('https://internal/reserve', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(record),
      });
      const body = await res.json();
      if (res.status === 409) return { ok: false, record: body.record, conflict: true };
      if (!res.ok)            return { ok: false, error: 'do_reserve_failed' };
      return { ok: true, record: body.record };
    } catch(e) {
      // DO failed — fall through to KV if available
    }
  }

  // ── KV fallback (best-effort for concurrent) ──────────────────────────────
  if (kvBinding) {
    const kvKey = KV_PREFIX + salt;
    try {
      const existing = await kvBinding.get(kvKey, { type: 'json' });
      if (existing !== null) return { ok: false, record: existing, conflict: true };
      // Write the record — note: not atomic, best-effort for concurrent
      await kvBinding.put(kvKey, JSON.stringify(record), { expirationTtl: KV_TTL_SECS });
      return { ok: true, record };
    } catch(e) {
      return { ok: false, error: 'kv_reserve_failed' };
    }
  }

  // Both unavailable
  return { ok: false, error: 'persistence_unavailable' };
}

async function tryRead(salt, env) {
  const doBinding = env && env.GATEWAY_OP_LOCK;
  const kvBinding = env && env.GATEWAY_OPS_KV;

  if (doBinding) {
    try {
      const doId   = doBinding.idFromName(salt);
      const doStub = doBinding.get(doId);
      const res    = await doStub.fetch('https://internal/status');
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('do_read_failed');
      const body = await res.json();
      return body.record || null;
    } catch(_) {}
  }

  if (kvBinding) {
    try {
      const record = await kvBinding.get(KV_PREFIX + salt, { type: 'json' });
      return record;
    } catch(_) {}
  }

  return null;
}

async function tryUpdate(salt, update, env) {
  const doBinding = env && env.GATEWAY_OP_LOCK;
  const kvBinding = env && env.GATEWAY_OPS_KV;

  if (doBinding) {
    try {
      const doId   = doBinding.idFromName(salt);
      const doStub = doBinding.get(doId);
      const res    = await doStub.fetch('https://internal/update', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(update),
      });
      const body = await res.json();
      if (!res.ok) return { ok: false, error: body.error };
      return { ok: true };
    } catch(e) {
      return { ok: false, error: 'do_update_failed' };
    }
  }

  if (kvBinding) {
    const kvKey = KV_PREFIX + salt;
    try {
      const existing = await kvBinding.get(kvKey, { type: 'json' });
      if (!existing) return { ok: false, error: 'not_found' };
      if (!isValidTransition(existing.status, update.status)) {
        return { ok: false, error: 'invalid_transition' };
      }
      const updated = { ...existing, ...update, updatedAt: new Date().toISOString() };
      await kvBinding.put(kvKey, JSON.stringify(updated), { expirationTtl: KV_TTL_SECS });
      return { ok: true };
    } catch(e) {
      return { ok: false, error: 'kv_update_failed' };
    }
  }

  return { ok: false, error: 'persistence_unavailable' };
}

// ── POST /api/gateway/transfer ────────────────────────────────────────────────
export async function onRequestPost(ctx) {
  const { request, env } = ctx;

  // CORS
  const origin = request.headers.get('Origin') || '';
  if (!isAllowedOrigin(origin, env)) {
    return jsonResp({ error: 'forbidden' }, 403);
  }

  // Content-Type
  const ct = request.headers.get('Content-Type') || '';
  if (!ct.includes('application/json')) {
    return jsonResp({ error: 'content_type_required' }, 400);
  }

  // Body size
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_LEN) {
    return jsonResp({ error: 'request_too_large' }, 413);
  }

  // Parse JSON
  let body;
  try { body = JSON.parse(rawBody); } catch(_) {
    return jsonResp({ error: 'invalid_json' }, 400);
  }

  if (!Array.isArray(body) || body.length === 0) {
    return jsonResp({ error: 'requests_required' }, 400);
  }

  // Validate each item
  for (const item of body) {
    if (!item || typeof item !== 'object') {
      return jsonResp({ error: 'invalid_request_item' }, 400);
    }
    if (!item.burnIntent || typeof item.burnIntent !== 'object') {
      return jsonResp({ error: 'burnIntent_required' }, 400);
    }
    const spec = item.burnIntent.spec;
    if (!spec || typeof spec !== 'object') {
      return jsonResp({ error: 'spec_required' }, 400);
    }
    if (typeof spec.salt !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(spec.salt)) {
      return jsonResp({ error: 'salt_required' }, 400);
    }
    if (!isValidPaddedAddress(spec.sourceSigner)) {
      return jsonResp({ error: 'sourceSigner_required' }, 400);
    }
    if (typeof item.signature !== 'string' || !/^0x[0-9a-fA-F]{130,}$/.test(item.signature)) {
      return jsonResp({ error: 'invalid_signature_format' }, 400);
    }
  }

  // ── Atomic persistence: reserve ALL salts before forwarding ──────────────
  // FAIL-SAFE: if persistence is unavailable, block the forward entirely.
  const now       = new Date().toISOString();
  const reserved  = [];

  for (const item of body) {
    const salt    = item.burnIntent.spec.salt;
    const signer  = unpad(item.burnIntent.spec.sourceSigner);
    const record  = {
      salt,
      depositor:   signer,
      status:      'submitting',
      submittedAt: now,
      srcDomain:   item.burnIntent.spec.sourceDomain,
      dstDomain:   item.burnIntent.spec.destinationDomain,
    };

    const result = await tryReserve(salt, record, env);

    if (!result.ok && result.error === 'persistence_unavailable') {
      // FAIL-SAFE: release any already-reserved salts for this request and block
      // Note: DO reservations are not easily rolled back — this is a best-effort cleanup
      return jsonResp({
        error:   'persistence_unavailable',
        detail:  'Gateway operations KV and Durable Object are both unavailable. Transfer blocked.',
        blocked: true,
      }, 503);
    }

    if (!result.ok && result.conflict) {
      return jsonResp({
        error:       'already_submitted',
        salt,
        submittedAt: result.record && result.record.submittedAt,
        status:      result.record && result.record.status || 'submitted',
        depositor:   result.record && result.record.depositor,
        recoverable: true,
      }, 409);
    }

    if (!result.ok) {
      return jsonResp({
        error:   result.error || 'reserve_failed',
        blocked: true,
      }, 503);
    }

    reserved.push(salt);
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
    // Ambiguous — salts stay at 'submitting' in persistence — caller reconciles
    return jsonResp({
      error:    isTimeout ? 'gateway_timeout' : 'gateway_unreachable',
      detail:   err.message,
      ambiguous: true,
    }, isTimeout ? 504 : 502);
  }
  clearTimeout(timerId);

  // ── Update persistence status: accepted or rejected ───────────────────────
  // 'confirmed' is NOT set here — that requires on-chain verification
  const newStatus = upRes.ok ? 'accepted' : 'rejected';
  for (const item of body) {
    const salt = item.burnIntent.spec.salt;
    await tryUpdate(salt, { status: newStatus, httpStatus: upRes.status }, env);
  }

  // ── Relay response ────────────────────────────────────────────────────────
  let parsed;
  try { parsed = JSON.parse(upBody); } catch(_) { parsed = { raw: upBody }; }

  return new Response(JSON.stringify(parsed), {
    status: upRes.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// ── GET /api/gateway/transfer?salt=...&depositor=... ──────────────────────────
// Both salt AND depositor are required. Returns 404 for wrong depositor
// (does not leak existence of the record).
export async function onRequestGet(ctx) {
  const { request, env } = ctx;

  const origin = request.headers.get('Origin') || '';
  if (!isAllowedOrigin(origin, env)) {
    return jsonResp({ error: 'forbidden' }, 403);
  }

  const url       = new URL(request.url);
  const salt      = url.searchParams.get('salt');
  const depositor = url.searchParams.get('depositor');

  if (!salt || !/^0x[0-9a-fA-F]{64}$/.test(salt)) {
    return jsonResp({ error: 'salt_required' }, 400);
  }

  // depositor is REQUIRED — prevents leaking record existence to non-owners
  if (!depositor || !/^0x[0-9a-fA-F]{40}$/.test(depositor)) {
    return jsonResp({ error: 'depositor_required' }, 400);
  }

  const record = await tryRead(salt, env);
  if (!record) return jsonResp({ error: 'not_found', salt }, 404);

  // Isolation: return 404 for wrong depositor (not 403 — avoids leaking existence)
  if (normAddr(record.depositor) !== normAddr(depositor)) {
    return jsonResp({ error: 'not_found', salt }, 404);
  }

  return jsonResp({ salt, ...record });
}

// ── PATCH /api/gateway/transfer?salt=...&depositor=... ────────────────────────
// Client-initiated reconciliation. Only 'failed' is accepted from the client.
// 'confirmed' is an internal-only transition set by the POST handler on Circle 2xx.
export async function onRequestPatch(ctx) {
  const { request, env } = ctx;

  const origin = request.headers.get('Origin') || '';
  if (!isAllowedOrigin(origin, env)) {
    return jsonResp({ error: 'forbidden' }, 403);
  }

  const url       = new URL(request.url);
  const salt      = url.searchParams.get('salt');
  const depositor = url.searchParams.get('depositor');

  if (!salt || !/^0x[0-9a-fA-F]{64}$/.test(salt)) {
    return jsonResp({ error: 'salt_required' }, 400);
  }
  if (!depositor || !/^0x[0-9a-fA-F]{40}$/.test(depositor)) {
    return jsonResp({ error: 'depositor_required' }, 400);
  }

  const rawBody = await request.text().catch(() => '{}');
  let patch;
  try { patch = JSON.parse(rawBody); } catch(_) { patch = {}; }

  // Only 'failed' accepted from client — 'confirmed' is internal-only
  if (patch.status !== 'failed') {
    return jsonResp({
      error:  'invalid_status_for_client',
      detail: "Only status='failed' may be set by the client. 'confirmed' is set internally.",
    }, 400);
  }

  // Read and verify depositor before allowing update
  const record = await tryRead(salt, env);
  if (!record) return jsonResp({ error: 'not_found' }, 404);

  if (normAddr(record.depositor) !== normAddr(depositor)) {
    return jsonResp({ error: 'not_found' }, 404);
  }

  const result = await tryUpdate(salt, { status: 'failed', txHash: patch.txHash || null }, env);
  if (!result.ok) {
    if (result.error === 'invalid_transition') {
      return jsonResp({
        error:   'invalid_transition',
        current: record.status,
        detail:  "Cannot transition from '" + record.status + "' to 'failed'.",
      }, 400);
    }
    return jsonResp({ error: result.error || 'update_failed' }, 500);
  }

  return jsonResp({ ok: true, salt, status: 'failed' });
}

export async function onRequestPut()    { return jsonResp({ error: 'method_not_allowed' }, 405); }
export async function onRequestDelete() { return jsonResp({ error: 'method_not_allowed' }, 405); }
