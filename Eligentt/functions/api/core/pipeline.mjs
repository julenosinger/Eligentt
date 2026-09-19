/**
 * Treasury Core API — Request Pipeline (Phase 2 + Phase 4 hardening)
 * ═══════════════════════════════════════════════════════════════════
 * The single orchestration path shared by every /api/core/* endpoint:
 *
 *   WAF → correlation → CORS → method → parse →
 *   auth (HMAC / internal) → replay(built into auth) → authorization →
 *   rate-limit (enforce) → validation →
 *   business (existing engine, breaker-guarded) →
 *   ledger → latency → audit → alerts → standardized response
 *
 * Backward compatible: with default flags, internal traffic behaves exactly as in
 * Phase 2. Hardening is layered on via feature flags and never duplicates or
 * alters the existing Treasury Engine.
 */
import { buildEnvelope, jsonResponse, CoreError } from './response.mjs';
import { resolveCors } from './cors.mjs';
import { buildMeta } from './correlation.mjs';
import { boundLogger, STAGES } from './logger.mjs';
import { getFlags } from './flags.mjs';
import { verifyAccess } from './service-auth.mjs';
import { getApplication, APP_STATUS } from './registry.mjs';
import { resolveApplicationContext } from '../application-context.mjs';
import { applyRateLimit } from './rate-limit.mjs';
import { recordAudit } from './audit.mjs';
import { inspectRequest } from './waf.mjs';
import { recordLatency } from './latency.mjs';
import { emitAlert, ALERT_TYPES } from './alerts.mjs';
import * as breaker from './circuit-breaker.mjs';

// CORS preflight helper for endpoints (strict allowlist, never "*").
export function corePreflight(context) {
  return new Response(null, { status: 204, headers: resolveCors(context.request, context.env) });
}

function clientIp(request) {
  try { return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown'; } catch (_) { return 'unknown'; }
}

// Breaker facade passed to business handlers so dependency calls fail fast when a
// downstream (rpc/circle/vault/treasury/relayer) is degraded. No-ops when the
// CIRCUIT_BREAKER flag is off.
function makeBreaker(env, enabled) {
  return {
    enabled,
    async guard(dep, fn) {
      if (!enabled) return fn();
      return breaker.guard(env, dep, fn);
    },
  };
}

export async function runCore(context, opts, business) {
  const { request, env, params } = context;
  const o = opts || {};
  const started = Date.now();
  const flags = getFlags(env);
  const meta = buildMeta(request, o.version || 'v1');
  const headers = { ...resolveCors(request, env) };
  const logger = boundLogger(meta);
  const log = (stage, fields) => { if (flags.observability) logger.log(stage, fields); };
  const endpoint = o.endpoint || (() => { try { return new URL(request.url).pathname; } catch (_) { return 'unknown'; } })();
  const ip = clientIp(request);

  let application = 'ELLIGENT';
  let client = 'default';
  let httpStatus = 200;
  let result = 'success';
  let errorCode = null;
  let intentId = null;

  try {
    log(STAGES.REQUEST, { endpoint, method: request.method, ip });

    // ── WAF sanity ──
    const waf = inspectRequest(request);
    if (!waf.ok) throw new CoreError(waf.code, waf.message, waf.status);

    // ── Method guard ──
    if (o.method && request.method !== o.method) {
      throw new CoreError('METHOD_NOT_ALLOWED', 'Method not allowed', 405);
    }

    // ── Parse body (POST/PUT) ──
    let rawBody = '';
    let body = {};
    if (request.method === 'POST' || request.method === 'PUT') {
      try {
        rawBody = await request.text();
        body = rawBody ? JSON.parse(rawBody) : {};
      } catch (_) {
        throw new CoreError('INVALID_JSON', 'Request body must be valid JSON', 400);
      }
    }

    // ── Authentication (HMAC service-to-service OR internal) ──
    // Public endpoints (e.g. health monitoring) skip auth entirely but still pass
    // WAF, CORS, rate-limit, validation and audit.
    let access;
    let appRecord;
    if (o.public) {
      const pubCtx = resolveApplicationContext(body, env, request);
      application = pubCtx.application || application;
      client = pubCtx.client || client;
      access = { ok: true, method: 'public', application, context: pubCtx };
      appRecord = await getApplication(env, application);
      log(STAGES.AUTH, { application, method: 'public', ok: true, public: true });
    } else {
      access = await verifyAccess(request, env, { rawBody, body });
      application = access.application || application;
      client = (access.context && access.context.client) || client;
      log(STAGES.AUTH, { application, client, method: access.method, ok: access.ok });
      if (!access.ok) {
        // Structured alerts for security-relevant auth outcomes (no delivery).
        if (access.code === 'AUTH_REPLAY') emitAlert(ALERT_TYPES.REPLAY_DETECTED, { application, endpoint });
        else if (access.code === 'AUTH_SIGNATURE') emitAlert(ALERT_TYPES.INVALID_SIGNATURE, { application, endpoint });
        throw new CoreError(access.code || 'AUTH_FAILED', access.reason || 'Authentication failed', access.status || 401);
      }

      // ── Authorization (registry status + permission) ──
      appRecord = access.appRecord || await getApplication(env, application);
      const isInternalElligent = access.method === 'internal' && appRecord.applicationId === 'ELLIGENT';
      if (!isInternalElligent && appRecord.status !== APP_STATUS.ACTIVE) {
        throw new CoreError('APP_NOT_ACTIVE', 'Application "' + application + '" is not active', 403);
      }
      if (o.permission && Array.isArray(appRecord.permissions) && !appRecord.permissions.includes(o.permission)) {
        throw new CoreError('FORBIDDEN', 'Missing permission: ' + o.permission, 403);
      }
      log(STAGES.AUTHORIZATION, { application, status: appRecord.status, permission: o.permission || null, authMode: access.method });
    }

    // ── Rate limit (effective, per Application/Client/IP) ──
    const rl = await applyRateLimit(env, { application, client, ip, kind: o.rateKind || 'request', appRecord, mode: flags.rateLimitMode });
    log(STAGES.RATE_LIMIT, { application, kind: rl.kind, limit: rl.limit, exceeded: rl.exceeded, blocked: rl.blocked, mode: rl.mode });
    if (rl.blocked) {
      emitAlert(ALERT_TYPES.RATE_LIMIT_EXCEEDED, { application, client, endpoint, kind: rl.kind, limit: rl.limit });
      headers['Retry-After'] = String(rl.retryAfter || 60);
      throw new CoreError('RATE_LIMITED', 'Rate limit exceeded for ' + rl.kind, 429);
    }

    // ── Validation ──
    if (typeof o.validate === 'function') {
      const source = (request.method === 'POST' || request.method === 'PUT') ? body : new URL(request.url).searchParams;
      const v = o.validate(source, params);
      if (!v.valid) {
        log(STAGES.VALIDATION, { ok: false });
        return finalize(false, null, v.errors, 422);
      }
      body = v.value != null ? v.value : body;
      log(STAGES.VALIDATION, { ok: true });
    }

    // ── Business handler (reuses existing engine/services; breaker-guarded) ──
    const ctx = {
      env, request, params: params || {}, body, rawBody,
      application, client,
      appContext: access.context,
      appRecord,
      correlationId: meta.correlationId,
      requestId: meta.requestId,
      authMethod: access.method,
      rateLimit: rl,
      breaker: makeBreaker(env, flags.circuitBreaker),
      flags, meta, log: logger, ip,
      // Expose the Worker context so business handlers can schedule background
      // work (e.g. the Turbo Bridge settlement/reimbursement) without blocking
      // the response. No-op safe: waitUntil may be undefined outside CF runtime.
      execution: context,
      waitUntil: (context && typeof context.waitUntil === 'function')
        ? (p) => { try { context.waitUntil(p); } catch (_) {} }
        : null,
    };
    const outcome = await business(ctx);
    const data = outcome && outcome.data !== undefined ? outcome.data : outcome;
    if (outcome && outcome.status) httpStatus = outcome.status;
    if (outcome && outcome.headers) Object.assign(headers, outcome.headers);
    if (data && data.intentId) intentId = data.intentId;

    return finalize(true, data, [], httpStatus);
  } catch (e) {
    // Circuit-open → standardized 503 (never crash the Worker).
    if (e && e.circuitOpen) {
      emitAlert(ALERT_TYPES.CIRCUIT_OPEN, { dependency: e.dependency, endpoint });
      if (e.retryAfterMs) headers['Retry-After'] = String(Math.ceil(e.retryAfterMs / 1000));
      const ce = new CoreError('CIRCUIT_OPEN', 'Dependency temporarily unavailable: ' + e.dependency, 503);
      result = 'error'; errorCode = ce.code;
      log(STAGES.ERROR, { code: ce.code, dependency: e.dependency });
      return finalize(false, null, [ce.toError()], ce.status);
    }
    const ce = e instanceof CoreError ? e : new CoreError('INTERNAL_ERROR', (e && e.message) || 'Internal error', 500);
    result = 'error';
    errorCode = ce.code;
    log(STAGES.ERROR, { code: ce.code, status: ce.status, message: ce.message });
    return finalize(false, null, [ce.toError()], ce.status);
  }

  function finalize(success, data, errors, status) {
    httpStatus = status;
    if (!success) result = 'error';
    const envelope = buildEnvelope({ success, data, errors, meta });
    log(STAGES.RESPONSE, { status, success });

    const latencyMs = Date.now() - started;

    // Latency sampling (best-effort; feeds metrics percentiles).
    try {
      const pL = recordLatency(env, endpoint, latencyMs, { status, error: !success });
      if (context.waitUntil && pL && typeof pL.then === 'function') context.waitUntil(pL);
    } catch (_) {}

    // Audit (flag-gated; no sensitive data).
    if (flags.audit) {
      try {
        const pA = recordAudit(env, request, {
          requestId: meta.requestId,
          correlationId: meta.correlationId,
          application, client, endpoint,
          method: request.method,
          intentId,
          status,
          result,
          errorCode,
          latencyMs,
          version: meta.version,
        });
        if (context.waitUntil && pA && typeof pA.then === 'function') context.waitUntil(pA);
      } catch (_) {}
    }

    return jsonResponse(envelope, status, headers);
  }
}
