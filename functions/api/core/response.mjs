/**
 * Treasury Core API — Standardized Response Envelope (Phase 2)
 * ════════════════════════════════════════════════════════════
 * Every Core API response follows ONE consistent shape so future consumers
 * (ExecDaat and others) can integrate against a stable contract:
 *
 *   { success, requestId, correlationId, timestamp, version, data, errors }
 *
 * SECURITY: responses are masked — private keys, secrets, tokens, signatures and
 * attestations are NEVER emitted. See maskSensitive().
 *
 * This module adds NOTHING to the existing endpoints; it is only used by the new
 * /api/core/* surface.
 */

export const CORE_API_VERSION = 'v1';

const SENSITIVE_KEY_RE = /(privatekey|private_key|secret|mnemonic|seed|password|passphrase|token|authorization|signature|attestation|apikey|api_key|hmac|cookie|session|salt|hash)/i;

// Deep-mask sensitive fields anywhere in an object graph. Non-destructive.
export function maskSensitive(value, depth = 0) {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.map(v => maskSensitive(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = '***REDACTED***';
      } else {
        out[k] = maskSensitive(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

// Build the canonical envelope. `meta` carries requestId/correlationId/version.
export function buildEnvelope({ success, data, errors, meta }) {
  const m = meta || {};
  const errList = Array.isArray(errors) ? errors : (errors ? [errors] : []);
  return {
    success: !!success,
    requestId: m.requestId || null,
    correlationId: m.correlationId || null,
    timestamp: new Date().toISOString(),
    version: m.version || CORE_API_VERSION,
    data: success ? (data === undefined ? null : maskSensitive(data)) : null,
    errors: success ? [] : (errList.length ? errList : [{ code: 'ERROR', message: 'Unknown error' }]),
  };
}

// CORS for the Core API. Adds the headers consumers need for correlation + the
// (prepared, not-yet-enabled) auth schemes.
export function coreCors(request, env) {
  const allowed = ((env && env.ALLOWED_ORIGINS) || 'https://elligente.pages.dev')
    .split(',').map(s => s.trim()).filter(Boolean);
  const origin = (request && request.headers.get('Origin')) || '';
  const corsOrigin = allowed.includes(origin) ? origin : (allowed[0] || 'https://elligente.pages.dev');
  return {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key, X-Application-Token, X-Correlation-ID, X-Application-Version, X-Client-Version, X-Signature',
    'Access-Control-Expose-Headers': 'X-Correlation-ID, X-Request-ID',
    'Content-Type': 'application/json',
  };
}

export function jsonResponse(envelope, status, headers) {
  const h = { ...(headers || {}) };
  if (envelope && envelope.correlationId) h['X-Correlation-ID'] = envelope.correlationId;
  if (envelope && envelope.requestId) h['X-Request-ID'] = envelope.requestId;
  if (!h['Content-Type']) h['Content-Type'] = 'application/json';
  return new Response(JSON.stringify(envelope), { status: status || 200, headers: h });
}

export function ok(data, meta, status = 200, headers) {
  return jsonResponse(buildEnvelope({ success: true, data, meta }), status, headers);
}

export function fail(errors, meta, status = 400, headers) {
  return jsonResponse(buildEnvelope({ success: false, errors, meta }), status, headers);
}

// Typed error used across the pipeline. Carries an HTTP status + machine code.
export class CoreError extends Error {
  constructor(code, message, status = 400, field) {
    super(message || code);
    this.name = 'CoreError';
    this.code = code || 'ERROR';
    this.status = status;
    this.field = field || null;
  }
  toError() {
    const e = { code: this.code, message: this.message };
    if (this.field) e.field = this.field;
    return e;
  }
}
