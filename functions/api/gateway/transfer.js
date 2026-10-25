/**
 * CF Pages Function — /api/gateway/transfer
 *
 * POST:  Proxy to Circle Gateway /v1/transfer with atomic idempotence.
 * GET:   Query operation status by salt + depositor.
 * PATCH: No client-writable transitions as of Fase 2.2.
 *        All reconciliation (ambiguous→failed, accepted→confirmed/failed) requires
 *        POST /api/gateway/transfer/confirm (server-side RPC verification).
 *
 * ── OFFICIAL API SHAPE (Circle docs, Oct 2026) ─────────────────────────────
 *   POST https://gateway-api.circle.com/v1/transfer
 *   body:     array of { burnIntent:{...}, signature:"0x..." }
 *   response: array of { burnIntent:{...}, attestation:{payload,signature} }
 *
 * ── STATE MACHINE ────────────────────────────────────────────────────────────
 *   States: submitting | accepted | rejected | ambiguous | confirmed | failed
 *
 *   (none) → submitting            POST reserve
 *   submitting → accepted          Circle HTTP 2xx (internal)
 *   submitting → rejected          Circle HTTP 4xx definitive (internal; NOT 429, NOT 5xx)
 *   submitting → ambiguous         timeout / network error / HTTP 5xx / HTTP 429 (internal)
 *   accepted   → confirmed         on-chain verification (internal, future)
 *   accepted   → failed            verified mint failure (internal)
 *   ambiguous  → accepted          reconciliation confirms Circle accepted
 *   ambiguous  → rejected          reconciliation confirms Circle rejected
 *   ambiguous  → confirmed         /confirm verifies on-chain success
 *   ambiguous  → failed            /confirm verifies no on-chain activity
 *   confirmed / failed / rejected: TERMINAL — no further transitions
 *
 *   Client PATCH: NO transitions allowed (Fase 2.2).
 *   All state changes require server-side RPC verification via POST /confirm.
 *
 *   NOTE: 'rejected' means Circle returned a definitive 4xx. It is distinct from
 *   'failed' (mint failed or caller-verified failure) and from 'ambiguous'
 *   (Circle result unknown). 'rejected' operations may be retried with a NEW salt.
 *
 * ── ATOMICITY ────────────────────────────────────────────────────────────────
 *   Primary: GATEWAY_OP_LOCK Durable Object (one DO instance per salt).
 *            CF serializes all requests to same DO → reserve-then-forward is
 *            inherently race-free.
 *
 *   Fallback: GATEWAY_OPS_KV — ONLY in non-production environments.
 *             KV is NOT atomic. It is disabled in PROD because get()+put() is
 *             not a compare-and-swap. Setting env.GATEWAY_ENV='production'
 *             or CF_PAGES_ENV_NAME='production' disables KV fallback.
 *
 *   FAIL-SAFE: if no persistence layer is available, POST is BLOCKED.
 *
 * ── BATCH RESERVE / ROLLBACK ─────────────────────────────────────────────────
 *   For multi-item batches, ALL salts must be reserved before any forward.
 *   If any reservation fails, the already-reserved salts are rolled back to
 *   'failed' (not deleted — audit trail preserved). The forward is BLOCKED.
 *   Rollback itself uses tryUpdate('failed') — safe, idempotent.
 *
 * ── ISOLATION ────────────────────────────────────────────────────────────────
 *   GET + PATCH require ?salt= AND ?depositor=. Wrong depositor → 404.
 *   CLIENT PATCH: NO transitions allowed (Fase 2.2). Returns 400 for any status.
 *
 * ── SECURITY ─────────────────────────────────────────────────────────────────
 *   CORS exact-origin allowlist (env ALLOWED_ORIGINS extends defaults).
 *   sourceSigner in burnIntent.spec must match depositor (normalised).
 *   Body capped 64 KB. 18s server timeout (client uses 20s).
 *   Cache-Control: no-store everywhere.
 *   Never logs signatures, private keys, or attestation payloads.
 *
 * PENDING CONFIGURATION:
 *   kv_namespaces:   [{ binding:"GATEWAY_OPS_KV", id:"<your-id>" }]
 *   durable_objects: [{ binding:"GATEWAY_OP_LOCK", class_name:"GatewayOpLock",
 *                       script_name:"<worker-name>" }]
 *   Set env.GATEWAY_ENV='production' on the production Pages env.
 */

const GATEWAY_API  = 'https://gateway-api.circle.com';
const MAX_BODY_LEN = 65536;    // 64 KB
const TIMEOUT_MS   = 18000;    // 18s
const KV_TTL_SECS  = 604800;   // 7 days

// ── State machine ─────────────────────────────────────────────────────────────
// Client-writable transitions (PATCH): only ambiguous→failed
// Internal transitions: all others
const VALID_TRANSITIONS = {
  submitting: ['accepted', 'rejected', 'ambiguous'],
  accepted:   ['confirmed', 'failed'],
  rejected:   [],   // terminal — retry with new salt
  ambiguous:  ['accepted', 'rejected', 'failed', 'confirmed'],
  //           ↑ 'confirmed' added: /confirm can verify an ambiguous op succeeded
  confirmed:  [],   // terminal
  failed:     [],   // terminal
};

// Transitions the client may request via PATCH
// ── Rules (P0 — Fase 2.2) ──────────────────────────────────────────────────────
//   NONE. There are NO client-writable transitions.
//
//   ambiguous → failed:    REMOVED in Fase 2.2.
//                          A client asserting 'no on-chain activity' without
//                          independent server-side verification is unsafe:
//                          - The operation may have been accepted by Circle and minted.
//                          - Marking it 'failed' releases the salt slot and could be
//                          used to cover up a successful transfer the attacker wants
//                          to re-execute or claim failed for dispute purposes.
//                          Reconciliation of 'ambiguous' MUST go through
//                          POST /api/gateway/transfer/confirm (server verifies RPC).
//
//   accepted  → confirmed: ONLY via POST /api/gateway/transfer/confirm
//                          (server-side RPC receipt + chainId + calldata verification).
//   accepted  → failed:    ONLY via POST /api/gateway/transfer/confirm
//                          (server verifies revert on-chain before writing 'failed').
//   ambiguous → failed:    ONLY via POST /api/gateway/transfer/confirm
//                          (server verifies no activity on-chain before writing 'failed').
//
// The client MUST NOT be able to set any terminal state. ALL terminal transitions
// require server-side RPC verification.
const CLIENT_ALLOWED_TRANSITIONS = {
  // No client-writable transitions in Fase 2.2.
  // All reconciliation goes through POST /api/gateway/transfer/confirm.
};

// Transitions that the /confirm endpoint may set (server-side, after RPC verification)
const SERVER_CONFIRM_TRANSITIONS = new Set(['confirmed', 'failed']);

const TERMINAL_STATES = new Set(['confirmed', 'failed', 'rejected']);

function isValidTransition(from, to) {
  return (VALID_TRANSITIONS[from] || []).includes(to);
}

function isClientAllowed(from, to) {
  return (CLIENT_ALLOWED_TRANSITIONS[from] || []).includes(to);
}

function isProduction(env) {
  const e = (env && (env.GATEWAY_ENV || env.CF_PAGES_ENV_NAME || '')).toLowerCase();
  return e === 'production' || e === 'prod';
}

// ── CORS exact-origin allowlist ───────────────────────────────────────────────
function isAllowedOrigin(origin, env) {
  if (!origin) return true;
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

// ── Persistence layer abstraction ─────────────────────────────────────────────
//
// tryReserve:  claim a salt atomically.
//   { ok:true, record }                        — reserved
//   { ok:false, conflict:true, record }        — already exists
//   { ok:false, error:'persistence_unavailable' } — all layers down
//   { ok:false, error:string }                 — internal error
//
// tryRead:  read record. Returns null if not found.
// tryUpdate: update status with transition validation.
//   { ok:true }
//   { ok:false, error:'invalid_transition'|... }
// tryRollback: mark a reserved-but-unforwarded salt as 'failed' (rollback).
//   Best-effort, idempotent.

// Build headers for internal DO requests — includes the server-side secret.
// If DO_INTERNAL_SECRET is not configured, the DO returns 401 (fail-closed).
function doHeaders(env) {
  const h = { 'Content-Type': 'application/json' };
  if (env && env.DO_INTERNAL_SECRET) {
    h['X-DO-Internal-Secret'] = env.DO_INTERNAL_SECRET;
  }
  return h;
}

async function tryReserve(salt, record, env) {
  const doBinding = env && env.GATEWAY_OP_LOCK;
  const kvBinding = env && env.GATEWAY_OPS_KV;
  const prod      = isProduction(env);

  if (doBinding) {
    try {
      const doId   = doBinding.idFromName(salt);
      const doStub = doBinding.get(doId);
      const res    = await doStub.fetch('https://internal/reserve', {
        method:  'POST',
        headers: doHeaders(env),
        body:    JSON.stringify(record),
      });
      const body = await res.json();
      if (res.status === 401) return { ok: false, error: 'do_auth_failed' };
      if (res.status === 409) return { ok: false, record: body.record, conflict: true };
      if (!res.ok)            return { ok: false, error: 'do_reserve_failed' };
      return { ok: true, record: body.record };
    } catch(_) {
      // DO failed — fall through only if non-production
      if (prod) return { ok: false, error: 'do_unavailable_production' };
    }
  }

  // KV fallback — disabled in production (not atomic)
  if (kvBinding && !prod) {
    const kvKey = 'gw:op:' + salt;
    try {
      const existing = await kvBinding.get(kvKey, { type: 'json' });
      if (existing !== null) return { ok: false, record: existing, conflict: true };
      await kvBinding.put(kvKey, JSON.stringify(record), { expirationTtl: KV_TTL_SECS });
      return { ok: true, record };
    } catch(_) {
      return { ok: false, error: 'kv_reserve_failed' };
    }
  }

  if (prod && !doBinding) {
    return { ok: false, error: 'do_required_in_production' };
  }

  return { ok: false, error: 'persistence_unavailable' };
}

async function tryRead(salt, env) {
  const doBinding = env && env.GATEWAY_OP_LOCK;
  const kvBinding = env && env.GATEWAY_OPS_KV;

  if (doBinding) {
    try {
      const doId   = doBinding.idFromName(salt);
      const doStub = doBinding.get(doId);
      const res    = await doStub.fetch('https://internal/status', {
        headers: doHeaders(env),
      });
      if (res.status === 404) return null;
      if (res.status === 401) return null; // auth failed — treat as not-found for reads
      if (!res.ok) throw new Error('do_read_failed');
      const body = await res.json();
      return body.record || null;
    } catch(_) {}
  }

  if (kvBinding) {
    try {
      return await kvBinding.get('gw:op:' + salt, { type: 'json' });
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
        headers: doHeaders(env),
        body:    JSON.stringify(update),
      });
      const body = await res.json();
      if (res.status === 401) return { ok: false, error: 'do_auth_failed' };
      if (!res.ok) return { ok: false, error: body.error };
      return { ok: true };
    } catch(_) {
      return { ok: false, error: 'do_update_failed' };
    }
  }

  if (kvBinding) {
    const kvKey = 'gw:op:' + salt;
    try {
      const existing = await kvBinding.get(kvKey, { type: 'json' });
      if (!existing) return { ok: false, error: 'not_found' };
      if (!isValidTransition(existing.status, update.status)) {
        return { ok: false, error: 'invalid_transition' };
      }
      const updated = { ...existing, ...update, updatedAt: new Date().toISOString() };
      await kvBinding.put(kvKey, JSON.stringify(updated), { expirationTtl: KV_TTL_SECS });
      return { ok: true };
    } catch(_) {
      return { ok: false, error: 'kv_update_failed' };
    }
  }

  return { ok: false, error: 'persistence_unavailable' };
}

// Best-effort rollback for partial batch failures: mark salt as 'failed' so
// the audit trail is preserved and the DO slot is not left as 'submitting'
// indefinitely. Returns { ok, error? } so the caller knows whether rollback
// succeeded — but the forward is BLOCKED regardless of rollback outcome.
async function tryRollback(salt, env) {
  try {
    const r = await tryUpdate(salt, { status: 'failed', rollback: true }, env);
    if (!r.ok) return { ok: false, error: r.error, salt };
    return { ok: true, salt };
  } catch(e) {
    return { ok: false, error: e.message, salt };
  }
}

// ── POST /api/gateway/transfer ────────────────────────────────────────────────
export async function onRequestPost(ctx) {
  const { request, env } = ctx;

  const origin = request.headers.get('Origin') || '';
  if (!isAllowedOrigin(origin, env)) {
    return jsonResp({ error: 'forbidden' }, 403);
  }

  const ct = request.headers.get('Content-Type') || '';
  if (!ct.includes('application/json')) {
    return jsonResp({ error: 'content_type_required' }, 400);
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_LEN) {
    return jsonResp({ error: 'request_too_large' }, 413);
  }

  let body;
  try { body = JSON.parse(rawBody); } catch(_) {
    return jsonResp({ error: 'invalid_json' }, 400);
  }

  if (!Array.isArray(body) || body.length === 0) {
    return jsonResp({ error: 'requests_required' }, 400);
  }

  // ── Validate each item ────────────────────────────────────────────────────
  for (const item of body) {
    if (!item || typeof item !== 'object') {
      return jsonResp({ error: 'invalid_request_item' }, 400);
    }
    const bi   = item.burnIntent;
    const spec = bi && bi.spec;
    if (!bi || typeof bi !== 'object')   return jsonResp({ error: 'burnIntent_required' }, 400);
    if (!spec || typeof spec !== 'object') return jsonResp({ error: 'spec_required' }, 400);
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

  // ── Reserve ALL salts before any forward ─────────────────────────────────
  // If any reservation fails, roll back the already-reserved ones and BLOCK.
  const now      = new Date().toISOString();
  const reserved = [];

  for (const item of body) {
    const salt   = item.burnIntent.spec.salt;
    const signer = unpad(item.burnIntent.spec.sourceSigner);
    const record = {
      salt,
      depositor:   signer,
      status:      'submitting',
      submittedAt: now,
      srcDomain:   item.burnIntent.spec.sourceDomain  || null,
      dstDomain:   item.burnIntent.spec.destinationDomain || null,
    };

    const result = await tryReserve(salt, record, env);

    if (!result.ok) {
      // Roll back every salt already reserved in this batch.
      // Collect rollback failures so the caller can see which salts are stuck at 'submitting'.
      const rollbackFailures = [];
      for (const rs of reserved) {
        const rb = await tryRollback(rs, env);
        if (!rb.ok) rollbackFailures.push({ salt: rs, error: rb.error });
      }

      if (result.conflict) {
        return jsonResp({
          error:            'already_submitted',
          salt,
          status:           result.record ? result.record.status : 'submitted',
          submittedAt:      result.record ? result.record.submittedAt : null,
          depositor:        result.record ? result.record.depositor   : null,
          recoverable:      true,
          rollbackFailures: rollbackFailures.length ? rollbackFailures : undefined,
        }, 409);
      }

      const err = result.error || 'reserve_failed';
      const isPersistenceError = err.includes('unavailable') || err.includes('production');
      return jsonResp({
        error:            err,
        blocked:          true,
        rollbackFailures: rollbackFailures.length ? rollbackFailures : undefined,
      }, isPersistenceError ? 503 : 500);
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
    // Ambiguous — salts stay in persistence at 'submitting'; update to 'ambiguous'.
    // If the update fails, surface it (the salt stays at 'submitting', which still
    // blocks re-submission, but the caller must know the state is not recorded).
    const persistFailures = [];
    for (const item of body) {
      const up = await tryUpdate(item.burnIntent.spec.salt, { status: 'ambiguous' }, env);
      if (!up.ok) persistFailures.push({ salt: item.burnIntent.spec.salt, error: up.error });
    }
    return jsonResp({
      error:     isTimeout ? 'gateway_timeout' : 'gateway_unreachable',
      detail:    err.message,
      ambiguous: true,
      ...(persistFailures.length
        ? { persistenceWarning: true, failedSalts: persistFailures }
        : {}),
    }, isTimeout ? 504 : 502);
  }
  clearTimeout(timerId);

  // ── Update persistence: accepted (2xx), rejected (4xx definitive), or ambiguous (5xx/uncertain) ─
  //
  // CLASSIFICATION RULES (per Circle Gateway semantics):
  //   HTTP 2xx       → 'accepted'  — Circle confirmed it will process the intent
  //   HTTP 4xx       → 'rejected'  — definitive client error (bad intent, already used salt,
  //                                  invalid sig, etc.) — safe to retry with NEW salt
  //   HTTP 5xx       → 'ambiguous' — Circle internal error; result is UNKNOWN.
  //                                  Circle MAY have accepted internally before returning 5xx.
  //                                  Do NOT mark as 'rejected' — that would allow a new salt
  //                                  for an intent that may already be in-flight.
  //   429 (rate limit) → 'ambiguous' — similarly uncertain
  //
  // NEVER treat HTTP 5xx as a definitive rejection.
  function classifyHttpStatus(status) {
    if (status >= 200 && status < 300) return 'accepted';
    // 408 Request Timeout: the server may have processed the intent but failed to
    // respond in time — INDETERMINATE, never a definitive rejection.
    if (status === 408) return 'ambiguous';
    // 429 Rate Limit: INDETERMINATE (not a definitive rejection).
    if (status === 429) return 'ambiguous';
    if (status >= 400 && status < 500) return 'rejected'; // definitive client error
    return 'ambiguous'; // 5xx or anything unexpected
  }
  const newStatus = classifyHttpStatus(upRes.status);
  const persistFailures = [];
  for (const item of body) {
    const up = await tryUpdate(item.burnIntent.spec.salt,
      { status: newStatus, httpStatus: upRes.status }, env);
    if (!up.ok) persistFailures.push({ salt: item.burnIntent.spec.salt, error: up.error });
  }

  let parsed;
  try { parsed = JSON.parse(upBody); } catch(_) { parsed = { raw: upBody }; }

  // P0 — Circle responded but we could not persist the result. Do NOT present the
  // operation as concluded and do NOT discard the Circle response. Return an
  // explicit recoverable error that preserves the salt, original HTTP status, the
  // computed state, and the Circle response body for later reconciliation.
  if (persistFailures.length) {
    return jsonResp({
      error:          'persistence_failed_after_response',
      blocked:        true,
      recoverable:    true,
      httpStatus:     upRes.status,
      status:         newStatus,
      circleResponse: parsed,
      failedSalts:    persistFailures,
    }, 502);
  }

  return new Response(JSON.stringify(parsed), {
    status:  upRes.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// ── GET /api/gateway/transfer?salt=...&depositor=... ──────────────────────────
export async function onRequestGet(ctx) {
  const { request, env } = ctx;

  const origin = request.headers.get('Origin') || '';
  if (!isAllowedOrigin(origin, env)) return jsonResp({ error: 'forbidden' }, 403);

  const url       = new URL(request.url);
  const salt      = url.searchParams.get('salt');
  const depositor = url.searchParams.get('depositor');

  if (!salt || !/^0x[0-9a-fA-F]{64}$/.test(salt)) {
    return jsonResp({ error: 'salt_required' }, 400);
  }
  if (!depositor || !/^0x[0-9a-fA-F]{40}$/.test(depositor)) {
    return jsonResp({ error: 'depositor_required' }, 400);
  }

  const record = await tryRead(salt, env);
  if (!record)                                              return jsonResp({ error: 'not_found', salt }, 404);
  if (normAddr(record.depositor) !== normAddr(depositor))   return jsonResp({ error: 'not_found', salt }, 404);

  return jsonResp({ salt, ...record });
}

// ── PATCH /api/gateway/transfer?salt=...&depositor=... ────────────────────────
// Client-initiated reconciliation ONLY.
// Allowed transitions: ambiguous → failed
// All other transitions (submitting→accepted, accepted→confirmed, etc.) are
// internal-only and CANNOT be set by the client.
export async function onRequestPatch(ctx) {
  const { request, env } = ctx;

  const origin = request.headers.get('Origin') || '';
  if (!isAllowedOrigin(origin, env)) return jsonResp({ error: 'forbidden' }, 403);

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

  const toStatus = patch.status;

  // Validate that the requested status is a known state
  if (!VALID_TRANSITIONS.hasOwnProperty(toStatus) &&
      !TERMINAL_STATES.has(toStatus)) {
    return jsonResp({
      error:  'unknown_status',
      detail: 'Unknown status: ' + toStatus,
    }, 400);
  }

  // Fetch record and verify depositor
  const record = await tryRead(salt, env);
  if (!record)                                              return jsonResp({ error: 'not_found' }, 404);
  if (normAddr(record.depositor) !== normAddr(depositor))   return jsonResp({ error: 'not_found' }, 404);

  // Validate client-allowed transition
  if (!isClientAllowed(record.status, toStatus)) {
    return jsonResp({
      error:   'client_transition_not_allowed',
      from:    record.status,
      to:      toStatus,
      allowed: CLIENT_ALLOWED_TRANSITIONS[record.status] || [],
      detail:  'Allowed client transitions: ' +
               JSON.stringify(CLIENT_ALLOWED_TRANSITIONS),
    }, 400);
  }

  // No txHash required for client PATCH — the only allowed client transition is
  // ambiguous→failed, which does not involve on-chain evidence.
  // accepted→confirmed and accepted→failed require server-side RPC verification
  // via POST /api/gateway/transfer/confirm — they are NOT reachable here.
  const result = await tryUpdate(salt, { status: toStatus, txHash: null }, env);
  if (!result.ok) {
    if (result.error === 'invalid_transition') {
      return jsonResp({
        error:   'invalid_transition',
        current: record.status,
        detail:  "Cannot transition from '" + record.status + "' to '" + toStatus + "'.",
      }, 400);
    }
    return jsonResp({ error: result.error || 'update_failed' }, 500);
  }

  return jsonResp({ ok: true, salt, status: toStatus });
}

export async function onRequestPut()    { return jsonResp({ error: 'method_not_allowed' }, 405); }
export async function onRequestDelete() { return jsonResp({ error: 'method_not_allowed' }, 405); }

// ── POST /api/gateway/transfer/confirm ───────────────────────────────────────
// Server-side reconciliation: verifies a txHash on-chain via RPC before writing
// 'confirmed' or 'failed' to the operation record.
//
// Called by GatewaySpendService.execute() after receiving a mint receipt.
// Body: { salt, depositor, txHash, dstChainId }
//
// Verification steps (Fase 2.3):
//   1. Read the operation record and verify depositor isolation.
//   2. Validate txHash format and that the record is 'accepted' or 'ambiguous'.
//   3. Resolve per-chain RPC from env.GATEWAY_RPC_URLS[chainId] (no fallback).
//   4. Verify RPC is on the correct chain via eth_chainId.
//   5. Call eth_getTransactionByHash — primary source for 'input' (calldata).
//      Verify tx.hash === txHash (hash cross-check).
//      Verify tx.to === minterAddr.
//   6. Call eth_getTransactionReceipt — primary source for 'status'.
//      Verify receipt.status is exactly '0x1' (success) or '0x0' (revert).
//      null/undefined/other = inconclusive, preserve recoverable state.
//   7. Decode gatewayMint calldata from tx.input:
//      a. Verify function selector matches gatewayMint(bytes,bytes).
//      b. Extract attestationPayload bytes using ABI offset encoding.
//      c. Detect Attestation vs AttestationSet via magic bytes.
//      d. Locate salt at the documented offset in TransferSpec.
//      e. Compare extracted salt with the operation's recorded salt.
//   8. transaction.from is NOT validated — the caller may be the user, a
//      relayer, or Circle's Forwarding Service. The spec sets destinationCaller=0
//      to allow any caller by default. Salt linkage is the binding proof.
//   9. Write 'confirmed' (success) or 'failed' (revert) atomically.
//
// Error codes:
//   503 rpc_not_configured            — GATEWAY_RPC_URLS[chainId] missing
//   504 rpc_timeout                   — RPC call aborted
//   502 rpc_http_error                — RPC returned non-2xx
//   502 rpc_unreachable               — RPC threw (network/DNS)
//   502 rpc_chain_mismatch            — eth_chainId disagrees with dstChainId
//   404 tx_not_found                  — transaction not mined (pending or unknown hash)
//   422 tx_wrong_contract             — tx.to !== GatewayMinter
//   502 receipt_status_inconclusive   — receipt.status is null/undefined/malformed
//   422 calldata_selector_mismatch    — not a gatewayMint call
//   502 calldata_too_short            — payload shorter than minimum expected layout
//   502 attestation_payload_too_short — attestation bytes shorter than needed
//   502 attestation_magic_unknown     — first 4 bytes not a known Circle magic
//   422 tx_salt_mismatch              — salt not found at expected offset
//   502 persistence_failed_after_verify — verified on-chain but DB write failed
//
// All recoverable errors preserve 'accepted' or 'ambiguous' state. Only
// tx_wrong_contract and tx_salt_mismatch return non-recoverable 422.
//
// PENDING: env.GATEWAY_RPC_URLS (JSON: { "421614": "https://..." }) must be
// configured in CF Pages environment settings per destination chain.

// ── GatewayMinter addresses per chain (official Circle docs, verified) ───────
// Source: https://developers.circle.com/gateway/references/contract-addresses.md
// ONLY chains listed here are supported for /confirm. Unlisted chains → 422.
//
// Testnet (confirmed, same address on all testnet chains):
//   Arc Testnet (chainId 1777078 / domain 26), Arbitrum Sepolia (421614),
//   Base Sepolia (84532), ETH Sepolia (11155111), Avalanche Fuji (43113),
//   OP Sepolia (11155420), Polygon Amoy (80002), Sei Atlantic (713715),
//   Sonic Testnet (57054), Unichain Sepolia (1301), World Chain Sepolia (4801)
//
// Mainnet (confirmed in Circle docs, Oct 2026 — same address on all mainnet chains):
//   Arbitrum (42161), Arc (5042), Avalanche (43114), Base (8453),
//   Ethereum (1), HyperEVM (999), OP (10), Polygon PoS (137),
//   Sei (1329), Sonic (146), Unichain (130), World Chain (480)
//
// NOTE: Mainnet entries are enabled here per the confirmed Circle docs address.
//       GATEWAY_SPEND_BLOCKED=true in index.html prevents real execution until
//       all security validations are completed.
const GATEWAY_MINTER_TESTNET = '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B';
const GATEWAY_MINTER_MAINNET = '0x2222222d7164433c4C09B0b0D809a9b52C04C205';

const GATEWAY_MINTER_ADDRESSES = {
  // ── Testnet ───────────────────────────────────────────────────────────────
  421614:   GATEWAY_MINTER_TESTNET, // Arbitrum Sepolia
  84532:    GATEWAY_MINTER_TESTNET, // Base Sepolia
  11155111: GATEWAY_MINTER_TESTNET, // Ethereum Sepolia
  43113:    GATEWAY_MINTER_TESTNET, // Avalanche Fuji
  11155420: GATEWAY_MINTER_TESTNET, // OP Sepolia
  80002:    GATEWAY_MINTER_TESTNET, // Polygon Amoy
  713715:   GATEWAY_MINTER_TESTNET, // Sei Atlantic
  57054:    GATEWAY_MINTER_TESTNET, // Sonic Testnet
  1301:     GATEWAY_MINTER_TESTNET, // Unichain Sepolia
  4801:     GATEWAY_MINTER_TESTNET, // World Chain Sepolia
  1777078:  GATEWAY_MINTER_TESTNET, // Arc Testnet (domain 26)
  // ── Mainnet ───────────────────────────────────────────────────────────────
  42161:  GATEWAY_MINTER_MAINNET,  // Arbitrum
  5042:   GATEWAY_MINTER_MAINNET,  // Arc
  43114:  GATEWAY_MINTER_MAINNET,  // Avalanche
  8453:   GATEWAY_MINTER_MAINNET,  // Base
  1:      GATEWAY_MINTER_MAINNET,  // Ethereum
  999:    GATEWAY_MINTER_MAINNET,  // HyperEVM
  10:     GATEWAY_MINTER_MAINNET,  // OP
  137:    GATEWAY_MINTER_MAINNET,  // Polygon PoS
  1329:   GATEWAY_MINTER_MAINNET,  // Sei
  146:    GATEWAY_MINTER_MAINNET,  // Sonic
  130:    GATEWAY_MINTER_MAINNET,  // Unichain
  480:    GATEWAY_MINTER_MAINNET,  // World Chain
};

// ── gatewayMint ABI constants (from official Circle source) ───────────────────
// Source: https://github.com/circlefin/evm-gateway-contracts
//
// function gatewayMint(bytes memory attestationPayload, bytes memory signature)
//   Selector: keccak256("gatewayMint(bytes,bytes)")[0..3] = 0x9fb01cc5
//
// ABI calldata layout (bytes, big-endian):
//   [0..3]    selector              4 bytes  0x9fb01cc5
//   [4..35]   offset to param0     32 bytes  always 0x40 = 64 (standard ABI)
//   [36..67]  offset to param1     32 bytes  (after param0 data)
//   [68..99]  length of param0     32 bytes  byteLength of attestationPayload
//   [100..]   attestationPayload   variable
//
// Attestation binary layout (single, magic = 0xff6fb334):
//   [0..3]    magic                4 bytes  0xff6fb334
//   [4..35]   maxBlockHeight      32 bytes
//   [36..39]  transferSpecLength   4 bytes
//   [40..]    TransferSpec         variable
//
// TransferSpec binary layout at the above offset (within attestationPayload):
//   [0..3]    magic (0xca85def7)   4 bytes
//   [4..7]    version              4 bytes
//   ...
//   [304..335] salt               32 bytes  ← THE FIELD WE VERIFY
//
// Combined: salt is at attestationPayload byte offset (40 + 304) = 344
//           in calldata: byte 100 + 344 = 444
//
// AttestationSet layout (magic = 0x1e12db71):
//   [0..3]    magic                4 bytes  0x1e12db71
//   [4..7]    numAttestations      4 bytes
//   [8..]     attestations         variable (first starts at 8)
// Salt of first attestation in set: attestationPayload byte (8 + 40 + 304) = 352
//   in calldata: byte 100 + 352 = 452
const GATEWAY_MINT_SELECTOR         = '9fb01cc5'; // hex, no 0x prefix
const ATTESTATION_MAGIC             = 'ff6fb334';
const ATTESTATION_SET_MAGIC         = '1e12db71';
const TRANSFER_SPEC_SALT_IN_SPEC    = 304; // byte offset of salt within a TransferSpec blob
const ATTESTATION_SPEC_OFFSET       = 40;  // bytes before TransferSpec within a single Attestation
const ATTESTATION_SET_FIRST_OFFSET  = 8;   // bytes before first Attestation within an AttestationSet
// Minimum attestation payload sizes (bytes):
//   Single:  magic(4) + maxBlockHeight(32) + specLen(4) + TransferSpec(340+) = 380
//   Set:     magic(4) + numAttestations(4) + [first attestation 380+]        = 388
const MIN_PAYLOAD_BYTES_SINGLE      = 380;
const MIN_PAYLOAD_BYTES_SET         = 388;
// ABI safety bounds — prevents integer overflow / precision loss via crafted calldata.
// param0Offset from ABI head: must be ≤ 4096 to stay within Number.MAX_SAFE_INTEGER territory.
// payloadLen: must be ≤ 256 KB; realistic attestations are < 4 KB.
const ABI_MAX_PARAM_OFFSET          = 4096;   // bytes; param0Offset upper bound
const ABI_MAX_PAYLOAD_LEN           = 262144; // bytes; 256 KB upper bound on attestationPayload

export async function onRequestPostConfirm(ctx) {
  const { request, env } = ctx;

  const origin = request.headers.get('Origin') || '';
  if (!isAllowedOrigin(origin, env)) return jsonResp({ error: 'forbidden' }, 403);

  // Body size guard
  const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (contentLength > MAX_BODY_LEN) return jsonResp({ error: 'body_too_large' }, 413);

  const rawBody = await request.text().catch(() => '{}');
  let body;
  try { body = JSON.parse(rawBody); } catch(_) { return jsonResp({ error: 'invalid_json' }, 400); }

  const { salt, depositor, txHash, dstChainId } = body;

  // ── Validate inputs ───────────────────────────────────────────────────────
  if (!salt || !/^0x[0-9a-fA-F]{64}$/.test(salt))
    return jsonResp({ error: 'salt_required' }, 400);
  if (!depositor || !/^0x[0-9a-fA-F]{40}$/.test(depositor))
    return jsonResp({ error: 'depositor_required' }, 400);
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash))
    return jsonResp({ error: 'txhash_required' }, 400);
  const chainId = parseInt(dstChainId, 10);
  if (!chainId || isNaN(chainId))
    return jsonResp({ error: 'dstchainid_required' }, 400);

  // ── Verify GatewayMinter address is known for this chain ─────────────────
  const minterAddr = GATEWAY_MINTER_ADDRESSES[chainId];
  if (!minterAddr) {
    return jsonResp({
      error:   'chain_not_supported_for_confirm',
      chainId: chainId,
      detail:  'This chain does not have a verified GatewayMinter address in the confirmed Circle docs. ' +
               'Confirmation is blocked.',
    }, 422);
  }

  // ── Fetch operation record and verify depositor isolation ─────────────────
  const record = await tryRead(salt, env);
  if (!record)                                             return jsonResp({ error: 'not_found', salt }, 404);
  if (normAddr(record.depositor) !== normAddr(depositor))  return jsonResp({ error: 'not_found', salt }, 404);

  // Only 'accepted' or 'ambiguous' records can be reconciled.
  if (record.status !== 'accepted' && record.status !== 'ambiguous') {
    return jsonResp({
      error:   'not_reconcilable_state',
      current: record.status,
      detail:  "Only 'accepted' or 'ambiguous' operations can be reconciled. " +
               "Current state: '" + record.status + "'.",
    }, 409);
  }

  // ── Resolve per-chain RPC URL (no single-RPC fallback) ───────────────────
  let rpcUrl = null;
  if (env && env.GATEWAY_RPC_URLS) {
    try {
      const rpcMap = JSON.parse(env.GATEWAY_RPC_URLS);
      rpcUrl = rpcMap[String(chainId)] || null;
    } catch(_) {}
  }
  if (!rpcUrl) {
    return jsonResp({
      error:       'rpc_not_configured',
      chainId:     chainId,
      recoverable: true,
      detail:      'GATEWAY_RPC_URLS[' + chainId + '] is not configured. ' +
                   'Set GATEWAY_RPC_URLS (JSON map chainId→rpcUrl) in CF Pages environment settings.',
    }, 503);
  }

  // ── Helper: single JSON-RPC call with 10s timeout ─────────────────────────
  async function rpcCall(method, params) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(rpcUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal:  ctrl.signal,
      });
      if (!res.ok) throw Object.assign(new Error('rpc_http_error'), { httpStatus: res.status });
      const data = await res.json();
      if (data.error) throw Object.assign(new Error('rpc_error'), { detail: data.error.message || String(data.error) });
      return data.result;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Step 1: Verify RPC is on the correct chain via eth_chainId ────────────
  // Prevents a misconfigured GATEWAY_RPC_URLS entry from verifying on the wrong network.
  let rpcChainId;
  try {
    const chainIdHex = await rpcCall('eth_chainId', []);
    if (typeof chainIdHex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(chainIdHex)) {
      return jsonResp({
        error:       'rpc_chain_id_malformed',
        received:    chainIdHex,
        recoverable: true,
        detail:      'eth_chainId returned an unexpected value.',
      }, 502);
    }
    rpcChainId = parseInt(chainIdHex, 16);
  } catch(e) {
    const isTimeout = e && e.name === 'AbortError';
    return jsonResp({
      error:       isTimeout ? 'rpc_timeout' : (e.httpStatus ? 'rpc_http_error' : 'rpc_unreachable'),
      recoverable: true,
      detail:      e && e.message ? e.message : String(e),
    }, isTimeout ? 504 : 502);
  }
  if (rpcChainId !== chainId) {
    return jsonResp({
      error:           'rpc_chain_mismatch',
      expectedChainId: chainId,
      rpcChainId:      rpcChainId,
      recoverable:     true,
      detail:          'The RPC endpoint is on chainId ' + rpcChainId +
                       ' but the operation targets chainId ' + chainId +
                       '. Update GATEWAY_RPC_URLS[' + chainId + '] to the correct RPC.',
    }, 502);
  }

  // ── Step 2: Fetch transaction (primary source for calldata) ───────────────
  // eth_getTransactionByHash returns the 'input' field (the calldata).
  // eth_getTransactionReceipt does NOT guarantee 'input' — this is the P0 fix.
  let tx = null;
  try {
    tx = await rpcCall('eth_getTransactionByHash', [txHash]);
  } catch(e) {
    const isTimeout = e && e.name === 'AbortError';
    return jsonResp({
      error:       isTimeout ? 'rpc_timeout' : (e.httpStatus ? 'rpc_http_error' : 'rpc_unreachable'),
      recoverable: true,
      detail:      e && e.message ? e.message : String(e),
      ...(e.httpStatus ? { httpStatus: e.httpStatus } : {}),
    }, isTimeout ? 504 : 502);
  }

  // null = transaction not mined yet, or hash not found — INDETERMINATE
  if (!tx) {
    return jsonResp({
      error:       'tx_not_found',
      recoverable: true,
      detail:      'Transaction not found on-chain (not mined or unknown hash). ' +
                   'Operation remains recoverable.',
    }, 404);
  }

  // ── Step 3: Hash cross-check ──────────────────────────────────────────────
  // An RPC that returns a different hash is malformed or proxying incorrect data.
  const returnedHash = (tx.hash || '').toLowerCase();
  if (returnedHash !== txHash.toLowerCase()) {
    return jsonResp({
      error:       'tx_hash_mismatch',
      requested:   txHash,
      returned:    tx.hash,
      recoverable: true,
      detail:      'RPC returned a transaction whose hash does not match the requested txHash. ' +
                   'This indicates a malformed RPC response.',
    }, 502);
  }

  // ── Step 4: Verify transaction.to matches GatewayMinter ──────────────────
  // Use tx.to from eth_getTransactionByHash — the authoritative source.
  const txTo           = (tx.to || '').toLowerCase();
  const expectedMinter = minterAddr.toLowerCase();
  if (txTo !== expectedMinter) {
    return jsonResp({
      error:    'tx_wrong_contract',
      to:       tx.to,
      expected: minterAddr,
      detail:   'Transaction was not sent to the verified GatewayMinter contract. ' +
                'This transaction does not correspond to a Gateway mint.',
    }, 422);
  }

  // ── Step 5: Fetch receipt (primary source for status) ────────────────────
  // eth_getTransactionReceipt is the authoritative source for status.
  // A null receipt means the tx exists in mempool or was just included —
  // status is INDETERMINATE. Do not treat as failure.
  let receipt = null;
  try {
    receipt = await rpcCall('eth_getTransactionReceipt', [txHash]);
  } catch(e) {
    const isTimeout = e && e.name === 'AbortError';
    return jsonResp({
      error:       isTimeout ? 'rpc_timeout' : (e.httpStatus ? 'rpc_http_error' : 'rpc_unreachable'),
      recoverable: true,
      detail:      e && e.message ? e.message : String(e),
      ...(e.httpStatus ? { httpStatus: e.httpStatus } : {}),
    }, isTimeout ? 504 : 502);
  }

  if (!receipt) {
    // Transaction is known (eth_getTransactionByHash returned it) but receipt
    // is not yet available — still pending. INDETERMINATE.
    return jsonResp({
      error:       'tx_pending',
      recoverable: true,
      detail:      'Transaction is known but not yet mined (no receipt). ' +
                   'Operation remains recoverable. Retry after the next block.',
    }, 404);
  }

  // ── Step 5b: Cross-check receipt.transactionHash ──────────────────────────
  // Ensures the receipt corresponds to the requested transaction, not a
  // different one returned by a malformed or misconfigured RPC node.
  //
  // P0 (Fase 2.6): absence of transactionHash is NOT silently accepted.
  //   - Some RPC nodes omit transactionHash in the receipt object.
  //   - An absent field is indistinguishable from a node that returned the
  //     wrong receipt — we cannot confirm the receipt belongs to txHash.
  //   - Treat as inconclusive (recoverable) rather than silently passing.
  //   - The caller should retry with a node that returns transactionHash,
  //     or wait for the field to be populated.
  const receiptTxHashRaw = receipt.transactionHash || receipt.hash || null;
  if (!receiptTxHashRaw) {
    return jsonResp({
      error:       'receipt_tx_hash_absent',
      recoverable: true,
      detail:      'receipt.transactionHash (and receipt.hash) are absent. ' +
                   'Cannot confirm the receipt belongs to txHash=' + txHash + '. ' +
                   'Operation remains recoverable. Retry with an RPC that returns transactionHash.',
    }, 502);
  }
  const receiptTxHash = receiptTxHashRaw.toLowerCase();
  if (receiptTxHash !== txHash.toLowerCase()) {
    return jsonResp({
      error:       'receipt_tx_hash_mismatch',
      requested:   txHash,
      receiptHash: receiptTxHashRaw,
      recoverable: true,
      detail:      'receipt.transactionHash does not match the requested txHash. ' +
                   'The RPC returned a receipt for a different transaction.',
    }, 502);
  }

  // ── Step 5c: Cross-check blockNumber consistency ──────────────────────────
  // tx.blockNumber and receipt.blockNumber must agree when both are present.
  // A transaction from mempool (blockNumber = null) and a receipt is contradictory.
  const txBlockNum      = tx.blockNumber      != null ? String(tx.blockNumber)      : null;
  const receiptBlockNum = receipt.blockNumber != null ? String(receipt.blockNumber) : null;
  if (txBlockNum !== null && receiptBlockNum !== null && txBlockNum !== receiptBlockNum) {
    return jsonResp({
      error:             'block_number_mismatch',
      txBlockNumber:     tx.blockNumber,
      receiptBlockNumber: receipt.blockNumber,
      recoverable:       true,
      detail:            'tx.blockNumber (' + tx.blockNumber + ') does not match ' +
                         'receipt.blockNumber (' + receipt.blockNumber + '). ' +
                         'RPC response is inconsistent.',
    }, 502);
  }

  // ── Step 6: Verify receipt.status ────────────────────────────────────────
  // ONLY '0x1' (success) or '0x0' (revert) are accepted.
  // null/undefined/other = receipt is incomplete or malformed.
  // Do NOT treat an incomplete status as a revert.
  const statusHex = receipt.status;
  const txSuccess = (statusHex === '0x1' || statusHex === 1);
  const txRevert  = (statusHex === '0x0' || statusHex === 0);
  if (!txSuccess && !txRevert) {
    return jsonResp({
      error:       'receipt_status_inconclusive',
      status:      statusHex,
      recoverable: true,
      detail:      'Receipt status is absent or unexpected (' + JSON.stringify(statusHex) + '). ' +
                   'Cannot determine success or failure. Operation remains recoverable.',
    }, 502);
  }

  // ── Step 7: Decode gatewayMint calldata and verify salt ───────────────────
  //
  // gatewayMint(bytes attestationPayload, bytes signature)
  // Selector: 0x9fb01cc5 (keccak256("gatewayMint(bytes,bytes)")[0..3])
  //
  // The calldata is structured as standard ABI encoding:
  //   bytes 0..3:   selector
  //   bytes 4..67:  two 32-byte offsets (standard ABI dynamic params)
  //   bytes 68..99: length of attestationPayload (as uint256)
  //   bytes 100..:  attestationPayload data
  //
  // Inside attestationPayload (from Circle source code):
  //   Single Attestation (magic 0xff6fb334):
  //     bytes 0..3:   magic
  //     bytes 4..35:  maxBlockHeight (uint256)
  //     bytes 36..39: transferSpecLength (uint32)
  //     bytes 40..:   TransferSpec
  //   AttestationSet (magic 0x1e12db71):
  //     bytes 0..3:   magic
  //     bytes 4..7:   numAttestations (uint32)
  //     bytes 8..:    first Attestation (then others)
  //
  // TransferSpec layout (at its start offset):
  //   bytes 304..335: salt (bytes32)
  //
  // Salt absolute offset in calldata:
  //   Single:   100 + 40 + 304 = 444
  //   Set:      100 + 8 + 40 + 304 = 452
  //
  // We verify the salt at its DOCUMENTED FIXED OFFSET rather than a substring
  // search, which would pass for any transaction whose calldata happens to
  // contain the salt bytes anywhere. Fixed-offset verification is cryptographically
  // stronger: it proves the salt was placed in the TransferSpec.salt field of the
  // first attestation, which is the exact field that links the mint to this intent.
  //
  // We also do NOT validate transaction.from. Per the Circle docs and contracts:
  // - destinationCaller=0 means any address may call gatewayMint
  // - The Forwarding Service calls it on the user's behalf
  // - The salt+minterAddr+chainId binding IS the proof of linkage

  const inputHex = tx.input || tx.data || null;
  if (!inputHex || typeof inputHex !== 'string') {
    return jsonResp({
      error:       'calldata_absent',
      recoverable: true,
      detail:      'Transaction has no input data. Cannot verify salt binding.',
    }, 502);
  }

  // Strip 0x prefix and work in lowercase hex
  const calldata = inputHex.toLowerCase().replace(/^0x/, '');

  // ── P1: Safe ABI decoding — BigInt for all offsets and lengths ───────────
  //
  // Per Fase 2.6 spec: use BigInt for offsets and lengths to eliminate any
  // possibility of Number precision loss on crafted large values.
  // Explicit upper-bound guards are applied BEFORE any arithmetic:
  //   ABI_MAX_PARAM_OFFSET  (4096n bytes)   — param0Offset from the ABI head
  //   ABI_MAX_PAYLOAD_LEN   (262144n bytes) — declared length of attestationPayload
  //
  // All downstream index arithmetic converts back to Number only AFTER bounds
  // checks confirm the value is safe (well under Number.MAX_SAFE_INTEGER).

  const BIG_ABI_MAX_PARAM_OFFSET = BigInt(ABI_MAX_PARAM_OFFSET);
  const BIG_ABI_MAX_PAYLOAD_LEN  = BigInt(ABI_MAX_PAYLOAD_LEN);

  // Minimum calldata length: selector(4) + offset0(32) + offset1(32) + len0(32) = 100 bytes
  if (calldata.length < 200) {
    return jsonResp({
      error:       'calldata_too_short',
      length:      calldata.length / 2,
      recoverable: true,
      detail:      'Calldata is shorter than the minimum expected for gatewayMint.',
    }, 502);
  }

  // Verify selector
  const selector = calldata.slice(0, 8);
  if (selector !== GATEWAY_MINT_SELECTOR) {
    return jsonResp({
      error:    'calldata_selector_mismatch',
      selector: '0x' + selector,
      expected: '0x' + GATEWAY_MINT_SELECTOR,
      detail:   'Transaction does not call gatewayMint(bytes,bytes). ' +
                'This is not a GatewayMinter mint transaction.',
    }, 422);
  }

  // ABI-decode param0 offset (bytes 4..35 of calldata) — BigInt parse, bounded.
  // Standard ABI: param0Offset = 64 (two 32-byte slots). We read it rather than hardcoding.
  let param0OffsetBig;
  try { param0OffsetBig = BigInt('0x' + calldata.slice(8, 8 + 64)); }
  catch(_) { param0OffsetBig = null; }
  if (param0OffsetBig === null || param0OffsetBig > BIG_ABI_MAX_PARAM_OFFSET) {
    return jsonResp({
      error:        'abi_offset_out_of_bounds',
      param0Offset: param0OffsetBig === null ? 'unparseable' : String(param0OffsetBig),
      recoverable:  true,
      detail:       'ABI param0 offset exceeds safe bound (' + ABI_MAX_PARAM_OFFSET +
                    '). Rejecting to prevent precision loss.',
    }, 502);
  }
  // Safe to convert: value ≤ 4096, far below Number.MAX_SAFE_INTEGER.
  const param0Offset = Number(param0OffsetBig);

  // payloadLenOffset: hex index of the uint256 length word for attestationPayload.
  // (4 + param0Offset) bytes into calldata → ×2 for hex chars.
  const payloadLenOffset = (4 + param0Offset) * 2;
  if (calldata.length < payloadLenOffset + 64) {
    return jsonResp({
      error:       'calldata_too_short',
      recoverable: true,
      detail:      'Calldata is too short to read attestationPayload length.',
    }, 502);
  }

  // Read and bound-check payloadLen (BigInt) before any use.
  let payloadLenBig;
  try { payloadLenBig = BigInt('0x' + calldata.slice(payloadLenOffset, payloadLenOffset + 64)); }
  catch(_) { payloadLenBig = null; }
  if (payloadLenBig === null || payloadLenBig > BIG_ABI_MAX_PAYLOAD_LEN) {
    return jsonResp({
      error:       'abi_payload_len_out_of_bounds',
      payloadLen:  payloadLenBig === null ? 'unparseable' : String(payloadLenBig),
      recoverable: true,
      detail:      'Declared attestationPayload length exceeds safe bound (' +
                   ABI_MAX_PAYLOAD_LEN + '). Rejecting to prevent memory/precision issues.',
    }, 502);
  }
  // Safe to convert: value ≤ 262144, far below Number.MAX_SAFE_INTEGER.
  const payloadLen = Number(payloadLenBig);

  // payloadStart: hex index of the first byte of attestationPayload data.
  const payloadStart = payloadLenOffset + 64;

  // Verify the full declared payload is present in calldata (no truncation).
  if (calldata.length < payloadStart + payloadLen * 2) {
    return jsonResp({
      error:       'attestation_payload_truncated',
      payloadLen:  payloadLen,
      available:   (calldata.length - payloadStart) / 2,
      recoverable: true,
      detail:      'Calldata is truncated: declared attestationPayload length (' + payloadLen +
                   ' bytes) exceeds available bytes (' + ((calldata.length - payloadStart) / 2) + ').',
    }, 502);
  }

  // Extract the 4-byte magic at the start of attestationPayload.
  const payloadMagic = calldata.slice(payloadStart, payloadStart + 8);

  // ── P0.2: Magic-specific structure validation and salt extraction ─────────
  let saltOffsetInPayload;

  if (payloadMagic === ATTESTATION_MAGIC) {
    // Single Attestation layout:
    //   [0..3]    magic (0xff6fb334)
    //   [4..35]   maxBlockHeight (uint256, 32 bytes)
    //   [36..39]  transferSpecLength (uint32, 4 bytes)
    //   [40..]    TransferSpec
    // Salt is at: ATTESTATION_SPEC_OFFSET(40) + TRANSFER_SPEC_SALT_IN_SPEC(304) = 344
    if (payloadLen < MIN_PAYLOAD_BYTES_SINGLE) {
      return jsonResp({
        error:       'attestation_payload_too_short',
        payloadLen:  payloadLen,
        required:    MIN_PAYLOAD_BYTES_SINGLE,
        recoverable: true,
        detail:      'Single Attestation payload is shorter than the minimum ' +
                     MIN_PAYLOAD_BYTES_SINGLE + ' bytes.',
      }, 502);
    }
    saltOffsetInPayload = ATTESTATION_SPEC_OFFSET + TRANSFER_SPEC_SALT_IN_SPEC; // 344

  } else if (payloadMagic === ATTESTATION_SET_MAGIC) {
    // AttestationSet layout:
    //   [0..3]  magic (0x1e12db71)
    //   [4..7]  numAttestations (uint32)
    //   [8..]   attestations[]
    // Salt is in first attestation at: SET_FIRST_OFFSET(8) + SPEC_OFFSET(40) + SALT_IN_SPEC(304) = 352
    if (payloadLen < MIN_PAYLOAD_BYTES_SET) {
      return jsonResp({
        error:       'attestation_payload_too_short',
        payloadLen:  payloadLen,
        required:    MIN_PAYLOAD_BYTES_SET,
        recoverable: true,
        detail:      'AttestationSet payload is shorter than the minimum ' +
                     MIN_PAYLOAD_BYTES_SET + ' bytes.',
      }, 502);
    }
    // Read numAttestations from payload bytes 4..7 (BigInt, bounded to sane range).
    let numAttestationsBig;
    try { numAttestationsBig = BigInt('0x' + calldata.slice(payloadStart + 8, payloadStart + 16)); }
    catch(_) { numAttestationsBig = 0n; }
    if (numAttestationsBig < 1n || numAttestationsBig > 65535n) {
      return jsonResp({
        error:            'attestation_set_empty',
        numAttestations:  String(numAttestationsBig),
        recoverable:      true,
        detail:           'AttestationSet has numAttestations=' + String(numAttestationsBig) +
                          '. Cannot extract first attestation salt.',
      }, 502);
    }
    // Verify the first attestation's magic is present at payload offset [8..11].
    const firstAttesMagicHex = calldata.slice(payloadStart + 16, payloadStart + 24); // 4 bytes = 8 hex
    if (firstAttesMagicHex !== ATTESTATION_MAGIC) {
      return jsonResp({
        error:       'attestation_set_first_magic_unknown',
        magic:       '0x' + firstAttesMagicHex,
        recoverable: true,
        detail:      'First Attestation inside AttestationSet does not start with ' +
                     '0xff6fb334. Cannot safely decode salt.',
      }, 502);
    }
    saltOffsetInPayload = ATTESTATION_SET_FIRST_OFFSET + ATTESTATION_SPEC_OFFSET + TRANSFER_SPEC_SALT_IN_SPEC; // 352

  } else {
    return jsonResp({
      error:       'attestation_magic_unknown',
      magic:       '0x' + payloadMagic,
      recoverable: true,
      detail:      'attestationPayload does not start with a known Circle Gateway magic value. ' +
                   'Expected 0xff6fb334 (Attestation) or 0x1e12db71 (AttestationSet). ' +
                   'Cannot safely decode salt offset.',
    }, 502);
  }

  // Verify salt is within the declared payload bounds (not in padding or signature).
  const saltEndInPayload = saltOffsetInPayload + 32; // exclusive byte end of salt within payload
  if (saltEndInPayload > payloadLen) {
    return jsonResp({
      error:       'salt_outside_payload_bounds',
      saltEnd:     saltEndInPayload,
      payloadLen:  payloadLen,
      recoverable: true,
      detail:      'Salt field (' + saltOffsetInPayload + '–' + saltEndInPayload + ') extends ' +
                   'beyond the declared attestationPayload length (' + payloadLen + '). ' +
                   'Rejecting: salt would be in padding or adjacent data.',
    }, 502);
  }

  // Extract salt from the expected fixed offset (32 bytes = 64 hex chars).
  const saltHexOffset = payloadStart + saltOffsetInPayload * 2;
  if (calldata.length < saltHexOffset + 64) {
    // Should not be reachable given the checks above, but fail safe.
    return jsonResp({
      error:       'attestation_payload_too_short',
      recoverable: true,
      detail:      'attestationPayload is too short to read salt at expected offset ' +
                   saltOffsetInPayload + '.',
    }, 502);
  }

  const extractedSalt = calldata.slice(saltHexOffset, saltHexOffset + 64);
  const expectedSalt  = salt.toLowerCase().replace(/^0x/, '');

  if (extractedSalt !== expectedSalt) {
    return jsonResp({
      error:   'tx_salt_mismatch',
      detail:  'The salt at the expected offset in the attestation calldata does not match ' +
               'this operation\'s salt. This transaction does not correspond to this Gateway operation.',
    }, 422);
  }

  // ── Step 8: Write verified state atomically ───────────────────────────────
  const newStatus    = txSuccess ? 'confirmed' : 'failed';
  const updateResult = await tryUpdate(salt, {
    status:      newStatus,
    txHash:      txHash,
    blockNumber: receipt.blockNumber || null,
  }, env);

  if (!updateResult.ok) {
    return jsonResp({
      error:       'persistence_failed_after_verify',
      verified:    true,
      txSuccess:   txSuccess,
      txHash:      txHash,
      newStatus:   newStatus,
      detail:      updateResult.error,
      recoverable: true,
    }, 502);
  }

  return jsonResp({
    ok:          true,
    salt:        salt,
    status:      newStatus,
    txHash:      txHash,
    txSuccess:   txSuccess,
    blockNumber: receipt.blockNumber || null,
  });
}
