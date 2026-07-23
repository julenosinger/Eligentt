/**
 * Treasury Core API — Correlation & Request IDs (Phase 2)
 * ═══════════════════════════════════════════════════════
 * Every request receives:
 *   - a requestId  (unique per HTTP request)
 *   - a correlationId (stable across the whole operation lifecycle: logs, ledger,
 *     settlement, bridge, history) — taken from the caller's X-Correlation-ID
 *     header when present so a consumer can trace an operation end-to-end, or
 *     generated when absent.
 */

function uuid() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch (_) {}
  // Fallback (non-crypto) — only used if randomUUID is unavailable.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function newRequestId() {
  return 'req_' + uuid();
}

export function newCorrelationId() {
  return 'cid_' + uuid();
}

// Read the caller's correlation id (sanitized) or mint a fresh one.
export function resolveCorrelationId(request) {
  let incoming = null;
  try {
    if (request && typeof request.headers?.get === 'function') {
      incoming = request.headers.get('X-Correlation-ID') || request.headers.get('X-Correlation-Id');
    }
  } catch (_) {}
  if (incoming && typeof incoming === 'string') {
    const clean = incoming.trim().replace(/[^\w.\-:]/g, '').slice(0, 128);
    if (clean) return clean;
  }
  return newCorrelationId();
}

// Build the meta object shared by the response envelope + logs.
export function buildMeta(request, version) {
  return {
    requestId: newRequestId(),
    correlationId: resolveCorrelationId(request),
    version: version || 'v1',
  };
}
