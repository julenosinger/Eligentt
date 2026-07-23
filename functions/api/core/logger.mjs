/**
 * Treasury Core API — Structured Logging (Phase 2)
 * ═════════════════════════════════════════════════
 * COMPLEMENTS (never replaces) the existing logs. Emits structured, safe events
 * that trace a request through the pipeline stages:
 *
 *   request → validation → ledger → treasury → settlement → response
 *
 * SECURITY: payloads are masked; secrets/keys/tokens/signatures are never logged.
 */
import { maskSensitive } from './response.mjs';

export const STAGES = Object.freeze({
  REQUEST: 'request',
  AUTH: 'auth',
  AUTHORIZATION: 'authorization',
  VALIDATION: 'validation',
  RATE_LIMIT: 'rate_limit',
  LEDGER: 'ledger',
  TREASURY: 'treasury',
  SETTLEMENT: 'settlement',
  RESPONSE: 'response',
  ERROR: 'error',
});

export function coreLog(stage, fields) {
  try {
    const safe = maskSensitive(fields || {});
    console.log(JSON.stringify({ scope: 'core_api', stage, timestamp: Date.now(), ...safe }));
  } catch (_) {}
}

// A logger bound to a single request's correlation/request ids.
export function boundLogger(meta) {
  const base = { correlationId: meta && meta.correlationId, requestId: meta && meta.requestId };
  return {
    log(stage, fields) { coreLog(stage, { ...base, ...(fields || {}) }); },
  };
}
