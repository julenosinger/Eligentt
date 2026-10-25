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
// Verification steps (Fase 2.2):
//   1. Read the operation record and verify depositor isolation.
//   2. Validate txHash format and that the record is 'accepted' or 'ambiguous'.
//   3. Resolve per-chain RPC from env.GATEWAY_RPC_URLS[chainId] (no fallback).
//   4. Verify RPC is on the correct chain via eth_chainId.
//   5. Call eth_getTransactionReceipt via RPC.
//   6. Verify receipt.to matches GatewayMinter for this chain.
//   7. Verify receipt.status is exactly '0x1' or '0x0' (null = inconclusive).
//   8. Verify salt appears in calldata (links tx to this specific operation).
//   9. Write 'confirmed' (success) or 'failed' (revert) atomically.
//
// If GATEWAY_RPC_URLS[chainId] is not configured → 503 recoverable.
// If RPC call fails, times out, or chainId mismatches → 502 recoverable.
// If receipt is null (tx pending), status inconclusive, or input absent → recoverable.
// Never trusts client-provided receipt, status, or success — always re-fetches.
//
// PENDING: env.GATEWAY_RPC_URLS (JSON: { "421614": "https://..." }) must be
// configured in CF Pages environment settings per destination chain.

// Canonical GatewayMinter addresses per chain (official Circle docs).
// ONLY chains listed here are supported. Unlisted chains → 422.
// NOTE: Mainnet addresses require confirmation at https://developers.circle.com/gateway
// before enabling for real funds. Entries marked [UNVERIFIED] must be confirmed.
const GATEWAY_MINTER_ADDRESSES = {
  // Testnet (confirmed in Circle docs):
  421614: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B', // Arbitrum Sepolia
  84532:  '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B', // Base Sepolia
  11155111:'0x0022222ABE238Cc2C7Bb1f21003F0a260052475B', // Ethereum Sepolia
  // Mainnet — [UNVERIFIED: confirm at developers.circle.com/gateway before enabling]
  // 5042:   '0x2222222d7164433c4C09B0b0D809a9b52C04C205', // Arc — BLOCKED pending verification
  // 1:      '0x2222222d7164433c4C09B0b0D809a9b52C04C205', // Ethereum — BLOCKED pending verification
  // 8453:   '0x2222222d7164433c4C09B0b0D809a9b52C04C205', // Base — BLOCKED pending verification
  // 42161:  '0x2222222d7164433c4C09B0b0D809a9b52C04C205', // Arbitrum — BLOCKED pending verification
};

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

  // Validate inputs
  if (!salt || !/^0x[0-9a-fA-F]{64}$/.test(salt))
    return jsonResp({ error: 'salt_required' }, 400);
  if (!depositor || !/^0x[0-9a-fA-F]{40}$/.test(depositor))
    return jsonResp({ error: 'depositor_required' }, 400);
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash))
    return jsonResp({ error: 'txhash_required' }, 400);
  const chainId = parseInt(dstChainId, 10);
  if (!chainId || isNaN(chainId))
    return jsonResp({ error: 'dstchainid_required' }, 400);

  // Check for GatewayMinter address on this chain
  const minterAddr = GATEWAY_MINTER_ADDRESSES[chainId];
  if (!minterAddr) {
    return jsonResp({
      error:   'chain_not_supported_for_confirm',
      chainId: chainId,
      detail:  'This chain does not have a verified GatewayMinter address. ' +
               'Confirmation is blocked until the address is confirmed in Circle docs.',
    }, 422);
  }

  // Fetch operation record and verify depositor
  const record = await tryRead(salt, env);
  if (!record)                                             return jsonResp({ error: 'not_found', salt }, 404);
  if (normAddr(record.depositor) !== normAddr(depositor))  return jsonResp({ error: 'not_found', salt }, 404);

  // Only 'accepted' or 'ambiguous' records can be confirmed/reconciled.
  // 'ambiguous' operations also route through /confirm for safe reconciliation.
  if (record.status !== 'accepted' && record.status !== 'ambiguous') {
    return jsonResp({
      error:   'not_reconcilable_state',
      current: record.status,
      detail:  "Only operations in 'accepted' or 'ambiguous' state can be reconciled. " +
               "Current state: '" + record.status + "'.",
    }, 409);
  }

  // ── Get RPC URL for the destination chain (per-chain only, no fallback) ────
  // P1 — Fase 2.2: GATEWAY_RPC_URL (single fallback) is removed.
  // Only GATEWAY_RPC_URLS[chainId] is accepted. This prevents a misconfigured
  // single-chain RPC from silently verifying receipts on the wrong network.
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

  // ── P1 (Fase 2.2): Verify RPC is on the correct chain via eth_chainId ─────
  // This prevents a misconfigured GATEWAY_RPC_URLS entry (e.g. Ethereum RPC
  // used for Arbitrum chainId) from confirming transactions on the wrong network.
  let rpcChainId;
  try {
    const chainIdHex = await rpcCall('eth_chainId', []);
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
      error:          'rpc_chain_mismatch',
      expectedChainId: chainId,
      rpcChainId:      rpcChainId,
      recoverable:     true,
      detail:          'The RPC endpoint is on chainId ' + rpcChainId +
                       ' but the operation targets chainId ' + chainId +
                       '. Update GATEWAY_RPC_URLS[' + chainId + '] to the correct RPC.',
    }, 502);
  }

  // ── Fetch transaction receipt ─────────────────────────────────────────────
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

  // Receipt is null = transaction not yet mined (or hash does not exist).
  // This is INDETERMINATE — not a proof of failure. Preserve ambiguous state.
  if (!receipt) {
    return jsonResp({
      error:       'tx_not_found',
      recoverable: true,
      detail:      'Transaction not found on-chain yet. It may be pending or the hash may be incorrect.',
    }, 404);
  }

  // ── P0.2 (Fase 2.2): Verify receipt fields ────────────────────────────────
  //
  // 1. to-address must match the GatewayMinter contract (case-insensitive)
  const receiptTo      = (receipt.to || '').toLowerCase();
  const expectedMinter = minterAddr.toLowerCase();
  if (receiptTo !== expectedMinter) {
    return jsonResp({
      error:    'tx_wrong_contract',
      to:       receipt.to,
      expected: minterAddr,
      detail:   'Transaction was not sent to the GatewayMinter contract.',
    }, 422);
  }

  // 2. receipt.status — ONLY '0x1' (success) or '0x0' (revert) are accepted.
  //    null / undefined / any other value = receipt is incomplete or malformed.
  //    Do NOT treat an incomplete receipt as a revert — that would incorrectly
  //    mark a successful operation as 'failed'.
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

  // 3. P0.3 (Fase 2.2): Verify calldata contains the operation's salt.
  //    GatewayMinter.gatewayMint(bytes attestation, bytes signature)
  //    The attestation payload from Circle encodes the BurnIntent, which includes
  //    the salt. We verify the salt appears in the calldata to prove this transaction
  //    corresponds to THIS operation and not a different mint.
  //
  //    LIMITATION: The exact ABI encoding of the attestation is Circle-internal.
  //    We verify the salt bytes appear somewhere in the calldata (hex substring match).
  //    This is a best-effort verification — an attacker would need to find another
  //    valid GatewayMinter transaction whose calldata happens to contain this salt,
  //    which is computationally infeasible for a random 32-byte salt.
  //
  //    If Circle publishes the attestation ABI, this can be upgraded to a full decode.
  //    If calldata is absent (receipt has no input), treat as inconclusive.
  const inputData   = receipt.input || receipt.data || null;
  const saltHex     = salt.toLowerCase().replace(/^0x/, '');
  if (inputData && typeof inputData === 'string') {
    const calldata = inputData.toLowerCase().replace(/^0x/, '');
    if (!calldata.includes(saltHex)) {
      return jsonResp({
        error:   'tx_salt_mismatch',
        detail:  'The transaction calldata does not contain this operation\'s salt. ' +
                 'This transaction does not correspond to this Gateway operation.',
      }, 422);
    }
  } else {
    // Input data absent — cannot verify salt binding.
    return jsonResp({
      error:       'receipt_input_absent',
      recoverable: true,
      detail:      'Receipt has no input data — cannot verify salt binding. ' +
                   'Operation remains recoverable.',
    }, 502);
  }

  const newStatus = txSuccess ? 'confirmed' : 'failed';

  // Write the verified state atomically
  const updateResult = await tryUpdate(salt, {
    status:  newStatus,
    txHash:  txHash,
    // Store verified block number for auditability
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
    ok:         true,
    salt:       salt,
    status:     newStatus,
    txHash:     txHash,
    txSuccess:  txSuccess,
    blockNumber: receipt.blockNumber || null,
  });
}
