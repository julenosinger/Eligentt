/**
 * Treasury Core API — Rate Limit (Phase 2, RECORD-ONLY)
 * ══════════════════════════════════════════════════════
 * Prepares rate-limit infrastructure per Application + Client + endpoint. In THIS
 * phase it ONLY RECORDS usage — it NEVER blocks a request. The returned object
 * reports usage and whether the (informational) limit would have been exceeded so
 * Phase 3 can flip a flag to start enforcing.
 *
 * Windows are per-minute counters in KV with a short TTL. Best-effort + KV-optional.
 */
import { coreKv, RATE_PREFIX } from './store.mjs';
import { DEFAULT_RATE_LIMITS } from './registry.mjs';

const WINDOW_SECONDS = 60;

function windowKey(application, client, endpoint) {
  const minute = Math.floor(Date.now() / (WINDOW_SECONDS * 1000));
  return `${RATE_PREFIX}${application}:${client}:${endpoint}:${minute}`;
}

function limitFor(appRecord, kind) {
  const limits = (appRecord && appRecord.rateLimits) || DEFAULT_RATE_LIMITS;
  if (kind === 'intent') return limits.intentsPerMin ?? DEFAULT_RATE_LIMITS.intentsPerMin;
  if (kind === 'bridge') return limits.bridgePerMin ?? DEFAULT_RATE_LIMITS.bridgePerMin;
  return limits.requestsPerMin ?? DEFAULT_RATE_LIMITS.requestsPerMin;
}

/**
 * Record one unit of usage. NEVER blocks (blocked is always false this phase).
 * @returns {Promise<{blocked:boolean, exceeded:boolean, count:number, limit:number, kind:string, enforced:boolean}>}
 */
export async function recordUsage(env, { application, client, endpoint, kind }) {
  const app = String(application || 'ELLIGENT').toUpperCase();
  const cli = String(client || 'default');
  const ep = String(endpoint || 'request');
  const useKind = kind || 'request';
  const kv = coreKv(env);
  let count = 1;
  if (kv && typeof kv.get === 'function' && typeof kv.put === 'function') {
    const key = windowKey(app, cli, ep);
    try {
      const raw = await kv.get(key);
      count = (raw ? parseInt(raw, 10) : 0) + 1;
      await kv.put(key, String(count), { expirationTtl: WINDOW_SECONDS + 10 });
    } catch (_) { count = 1; }
  }
  // Limit is resolved from the app record if provided (via env-less path), else
  // the default. The caller may pass a pre-resolved record on env._appRecord.
  const appRecord = env && env._appRecord;
  const limit = limitFor(appRecord, useKind);
  return {
    blocked: false,            // Phase 2: never blocks
    enforced: false,           // enforcement disabled this phase
    exceeded: count > limit,   // informational only
    count,
    limit,
    kind: useKind,
    window: WINDOW_SECONDS,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4 — Effective, per-endpoint rate limiting (per Application / Client / IP).
// Controlled by the RATE_LIMIT_MODE flag: off | record | enforce.
// Limits are generous and per-app configurable, so authorized traffic under
// normal operation is never affected.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_ENDPOINT_LIMITS = Object.freeze({
  request: 240,
  intent: 60,
  quote: 120,
  execute: 10,
  history: 120,
  metrics: 120,
  health: 240,
});

export function endpointLimit(appRecord, kind) {
  const rl = (appRecord && appRecord.rateLimits) || {};
  const map = {
    request: rl.requestsPerMin,
    intent: rl.intentsPerMin,
    execute: rl.bridgePerMin != null ? rl.bridgePerMin : rl.executePerMin,
    quote: rl.quotePerMin,
    history: rl.historyPerMin,
    metrics: rl.metricsPerMin,
    health: rl.healthPerMin,
  };
  const v = map[kind];
  return (typeof v === 'number' && v > 0) ? v : (DEFAULT_ENDPOINT_LIMITS[kind] || DEFAULT_ENDPOINT_LIMITS.request);
}

var _coreMemFallback = new Map();

async function incr(kv, k) {
  if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') {
    var now = Date.now();
    var fb = _coreMemFallback.get(k);
    if (!fb || (now - fb.windowStart) > (WINDOW_SECONDS * 1000)) { fb = { count: 0, windowStart: now }; }
    fb.count++;
    _coreMemFallback.set(k, fb);
    return fb.count;
  }
  try {
    const raw = await kv.get(k);
    const count = (raw ? parseInt(raw, 10) : 0) + 1;
    await kv.put(k, String(count), { expirationTtl: WINDOW_SECONDS + 10 });
    return count;
  } catch (_) { return 1; }
}

/**
 * Apply rate limiting for a request across Application / Client / IP dimensions.
 * Respects RATE_LIMIT_MODE: 'off' (skip), 'record' (never block), 'enforce'
 * (block over-limit with 429 semantics).
 *
 * @returns {Promise<{allowed:boolean, blocked:boolean, exceeded:boolean, mode:string,
 *   kind:string, limit:number, dimensions:object, retryAfter:number}>}
 */
export async function applyRateLimit(env, opts) {
  const o = opts || {};
  const mode = (o.mode || 'enforce').toLowerCase();
  const kind = o.kind || 'request';
  const limit = endpointLimit(o.appRecord, kind);

  if (mode === 'off') {
    return { allowed: true, blocked: false, exceeded: false, mode, kind, limit, dimensions: {}, retryAfter: 0 };
  }

  const kv = coreKv(env);
  const minute = Math.floor(Date.now() / (WINDOW_SECONDS * 1000));
  const app = String(o.application || 'ELLIGENT').toUpperCase();
  const client = String(o.client || 'default');
  const ip = o.ip || 'unknown';

  const dims = {
    application: await incr(kv, `${RATE_PREFIX}app:${app}:${kind}:${minute}`),
    client: await incr(kv, `${RATE_PREFIX}cli:${app}:${client}:${kind}:${minute}`),
    ip: ip !== 'unknown' ? await incr(kv, `${RATE_PREFIX}ip:${ip}:${kind}:${minute}`) : 0,
  };

  const exceeded = dims.application > limit || dims.client > limit || (dims.ip && dims.ip > limit);
  const blocked = mode === 'enforce' && !!exceeded;

  return {
    allowed: !blocked,
    blocked,
    exceeded: !!exceeded,
    mode,
    kind,
    limit,
    dimensions: dims,
    retryAfter: blocked ? WINDOW_SECONDS : 0,
  };
}
