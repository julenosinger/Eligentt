/**
 * Treasury Core API — Alerts (Phase 4, STRUCTURE-ONLY)
 * ═════════════════════════════════════════════════════
 * Defines the alert event catalog and emits STRUCTURED alert events into the
 * logs/audit stream. It does NOT deliver alerts anywhere yet (no email/webhook/
 * pager) — Phase 4 only structures them so a future phase can wire delivery.
 *
 * SECURITY: alert payloads are metadata only — never secrets, keys or tokens.
 */
import { maskSensitive } from './response.mjs';

export const ALERT_TYPES = Object.freeze({
  ERROR_RATE_HIGH: 'error_rate_high',
  RPC_SLOW: 'rpc_slow',
  SETTLEMENT_DELAYED: 'settlement_delayed',
  VAULT_UNAVAILABLE: 'vault_unavailable',
  CIRCLE_UNAVAILABLE: 'circle_unavailable',
  RATE_LIMIT_EXCEEDED: 'rate_limit_exceeded',
  REPLAY_DETECTED: 'replay_detected',
  INVALID_SIGNATURE: 'invalid_signature',
  CIRCUIT_OPEN: 'circuit_open',
});

export const SEVERITY = Object.freeze({ INFO: 'info', WARNING: 'warning', CRITICAL: 'critical' });

const DEFAULT_SEVERITY = {
  [ALERT_TYPES.ERROR_RATE_HIGH]: SEVERITY.CRITICAL,
  [ALERT_TYPES.RPC_SLOW]: SEVERITY.WARNING,
  [ALERT_TYPES.SETTLEMENT_DELAYED]: SEVERITY.WARNING,
  [ALERT_TYPES.VAULT_UNAVAILABLE]: SEVERITY.CRITICAL,
  [ALERT_TYPES.CIRCLE_UNAVAILABLE]: SEVERITY.CRITICAL,
  [ALERT_TYPES.RATE_LIMIT_EXCEEDED]: SEVERITY.INFO,
  [ALERT_TYPES.REPLAY_DETECTED]: SEVERITY.WARNING,
  [ALERT_TYPES.INVALID_SIGNATURE]: SEVERITY.WARNING,
  [ALERT_TYPES.CIRCUIT_OPEN]: SEVERITY.CRITICAL,
};

export function buildAlert(type, fields) {
  return {
    scope: 'core_alert',
    type,
    severity: (fields && fields.severity) || DEFAULT_SEVERITY[type] || SEVERITY.INFO,
    timestamp: Date.now(),
    ...maskSensitive(fields || {}),
    delivered: false, // Phase 4: never delivered, only structured
  };
}

// Emit an alert event to the log stream (structured, no delivery).
export function emitAlert(type, fields) {
  const alert = buildAlert(type, fields);
  try { console.log(JSON.stringify(alert)); } catch (_) {}
  return alert;
}
