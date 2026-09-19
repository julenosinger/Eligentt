/**
 * Treasury Core API — Audit Trail (Phase 2)
 * ══════════════════════════════════════════
 * Records one audit entry per Core API request. It captures operational metadata
 * ONLY — never request bodies, secrets, keys, tokens or signatures.
 *
 *   { requestId, correlationId, application, client, ip, userAgent, endpoint,
 *     method, intentId, status (http), result, latencyMs, timestamp, version }
 *
 * Best-effort + KV-optional. Stored under core:audit:* with retention TTL.
 */
import { coreKv, kvListJSON, AUDIT_PREFIX } from './store.mjs';

const AUDIT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function clientIp(request) {
  if (!request || typeof request.headers?.get !== 'function') return 'unknown';
  return request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')
    || 'unknown';
}

export function buildAuditEntry(fields) {
  const f = fields || {};
  const ua = f.userAgent ? String(f.userAgent).slice(0, 256) : null;
  return {
    requestId: f.requestId || null,
    correlationId: f.correlationId || null,
    application: f.application || 'ELLIGENT',
    client: f.client || 'default',
    ip: f.ip || 'unknown',
    userAgent: ua,
    endpoint: f.endpoint || null,
    method: f.method || null,
    intentId: f.intentId || null,
    status: typeof f.status === 'number' ? f.status : null,
    result: f.result || null,           // 'success' | 'error'
    errorCode: f.errorCode || null,
    latencyMs: typeof f.latencyMs === 'number' ? f.latencyMs : null,
    timestamp: f.timestamp || Date.now(),
    version: f.version || 'v1',
  };
}

export async function recordAudit(env, request, fields) {
  const entry = buildAuditEntry({
    ...fields,
    ip: (fields && fields.ip) || clientIp(request),
    userAgent: (fields && fields.userAgent) || (request && request.headers?.get && request.headers.get('User-Agent')),
  });
  const kv = coreKv(env);
  if (kv && typeof kv.put === 'function') {
    const key = `${AUDIT_PREFIX}${String(entry.timestamp).padStart(16, '0')}:${entry.requestId || Math.random().toString(16).slice(2)}`;
    try { await kv.put(key, JSON.stringify(entry), { expirationTtl: AUDIT_TTL_SECONDS }); } catch (_) {}
  }
  return entry;
}

export async function listAudit(env, limit) {
  return kvListJSON(coreKv(env), AUDIT_PREFIX, limit || 200);
}
