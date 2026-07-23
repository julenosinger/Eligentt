/**
 * Treasury Core API — Replay Protection (Phase 4)
 * ═════════════════════════════════════════════════
 * Timestamp-window validation + single-use nonce cache. A signed request is only
 * accepted once and only within a tight time window (60s), defeating replay.
 */
import { coreKv } from './store.mjs';

export const MAX_SKEW_MS = 60000;      // 60s window
const NONCE_PREFIX = 'core:nonce:';
const NONCE_TTL_SECONDS = 120;         // 2x window

export function timestampValid(ts, now) {
  const n = now || Date.now();
  const t = typeof ts === 'number' ? ts : parseInt(ts, 10);
  if (!Number.isFinite(t)) return { valid: false, reason: 'invalid_timestamp' };
  const skew = Math.abs(n - t);
  if (skew > MAX_SKEW_MS) return { valid: false, reason: 'timestamp_out_of_window', skew };
  return { valid: true, skew };
}

/**
 * Consume a nonce. Returns { ok:true } the first time it is seen, and
 * { ok:false, reason:'replay' } on any repeat within the TTL.
 */
export async function consumeNonce(env, appId, nonce) {
  if (!nonce || typeof nonce !== 'string' || nonce.length < 8 || nonce.length > 128) {
    return { ok: false, reason: 'missing_nonce' };
  }
  const kv = coreKv(env);
  const key = NONCE_PREFIX + (appId || '?') + ':' + nonce;
  if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') {
    // No store → cannot guarantee single-use; allow but flag as unstored.
    return { ok: true, stored: false };
  }
  try {
    const seen = await kv.get(key);
    if (seen) return { ok: false, reason: 'replay' };
    await kv.put(key, '1', { expirationTtl: NONCE_TTL_SECONDS });
    return { ok: true, stored: true };
  } catch (_) {
    return { ok: true, stored: false };
  }
}
