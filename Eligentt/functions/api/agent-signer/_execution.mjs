/**
 * AUTONOMA-6C — Circle signer execution state: nonce lock, idempotency,
 * emergency pause and audit.
 * ═══════════════════════════════════════════════════════════════════════
 * Persistence reuses the existing KV store (core/store.mjs coreKv = CORE_KV ||
 * RATE_LIMIT_KV). All helpers are fail-closed where safety requires it and
 * best-effort where KV is purely observational (audit).
 *
 *   nonce lock     → prevents two concurrent broadcasts from using the same nonce.
 *   idempotency    → one executionId ⇒ at most one Circle transaction.
 *   emergency pause → a flag that blocks all Circle execution (no fallback).
 *   audit          → sanitized execution record (NEVER secrets).
 */

import { coreKv } from '../core/store.mjs';

const EXEC_PREFIX = 'agent:exec:';
const NONCE_PREFIX = 'agent:nonce:';
const AUDIT_PREFIX = 'agent:audit:';
const PAUSE_KEY = 'agent:signer:paused';

const NONCE_TTL_SECONDS = 300;   // reservation window
const EXEC_TTL_SECONDS = 86400;  // idempotency window (24h)

/* ── Emergency pause ─────────────────────────────────────────────── */
// Paused if AGENT_SIGNER_PAUSED === 'true' (env) OR a KV pause flag is set.
// Both are observable/auditable. When paused, the Circle signer FAILS CLOSED:
// it never falls back to the browser signer.
export async function isPaused(env) {
  const envPaused = env && String(env.AGENT_SIGNER_PAUSED || '').toLowerCase() === 'true';
  if (envPaused) return { paused: true, source: 'env' };

  const kv = coreKv(env);
  if (kv && typeof kv.get === 'function') {
    try {
      const raw = await kv.get(PAUSE_KEY);
      if (raw) {
        let rec = null;
        try { rec = JSON.parse(raw); } catch (_) { rec = { paused: true }; }
        if (rec && rec.paused) return { paused: true, source: 'kv', reason: rec.reason || null };
      }
    } catch (_) {}
  }
  return { paused: false, source: null };
}

export async function setPaused(env, paused, reason) {
  const kv = coreKv(env);
  if (kv && typeof kv.put === 'function') {
    try {
      if (paused) await kv.put(PAUSE_KEY, JSON.stringify({ paused: true, reason: reason || 'manual', at: Date.now() }));
      else await kv.put(PAUSE_KEY, JSON.stringify({ paused: false, at: Date.now() }));
      return true;
    } catch (_) { return false; }
  }
  return false;
}

/* ── Idempotency ─────────────────────────────────────────────────── */
export async function getExecution(env, executionId) {
  if (!executionId) return null;
  const kv = coreKv(env);
  if (!kv || typeof kv.get !== 'function') return null;
  try {
    const raw = await kv.get(EXEC_PREFIX + executionId);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

/* ── Nonce lock ──────────────────────────────────────────────────── */
// reserveNonce is get-then-put (KV has no atomic CAS). This is the same
// best-effort model the rest of the platform uses; combined with Circle's
// server-side idempotencyKey it still prevents a duplicate broadcast for the
// same execution. Returns acquired:true only when this executionId owns the nonce.
export async function reserveNonce(env, { walletAddress, chainId, nonce, executionId }) {
  const kv = coreKv(env);
  if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') {
    return { ok: false, reason: 'nonce_store_unavailable', status: 503 };
  }
  const w = String(walletAddress || '').toLowerCase();
  const key = NONCE_PREFIX + w + ':' + chainId + ':' + nonce;
  try {
    const existing = await kv.get(key);
    if (existing) {
      let owner = null;
      try { owner = JSON.parse(existing); } catch (_) { owner = { executionId: String(existing) }; }
      if (owner && owner.executionId === executionId) {
        return { ok: true, acquired: false, idempotent: true, key };
      }
      return { ok: false, reason: 'nonce_conflict', status: 409, key };
    }
    await kv.put(key, JSON.stringify({ executionId, at: Date.now() }), { expirationTtl: NONCE_TTL_SECONDS });
    return { ok: true, acquired: true, idempotent: false, key };
  } catch (_) {
    return { ok: false, reason: 'nonce_store_error', status: 503 };
  }
}

/* ── Execution record + audit ────────────────────────────────────── */
async function sha256Hex(str) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function recordExecution(env, entry) {
  const kv = coreKv(env);
  const record = Object.assign({}, entry, { updatedAt: Date.now() });
  if (kv && typeof kv.put === 'function') {
    try { await kv.put(EXEC_PREFIX + entry.executionId, JSON.stringify(record), { expirationTtl: EXEC_TTL_SECONDS }); } catch (_) {}
  }
  return record;
}

/**
 * Write a sanitized audit record. The caller MUST NOT pass secrets. Any
 * accidentally-present secret-shaped fields are stripped defensively here.
 */
export async function audit(env, entry) {
  const auditId = 'aud_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  const DANGEROUS = /(secret|api[_-]?key|private[_-]?key|mnemonic|seed|ciphertext|token|signature|proof)$/i;
  const sanitized = { auditId, timestamp: Date.now() };
  for (const k of Object.keys(entry || {})) {
    if (DANGEROUS.test(k)) continue;
    sanitized[k] = entry[k];
  }
  const kv = coreKv(env);
  if (kv && typeof kv.put === 'function') {
    try { await kv.put(AUDIT_PREFIX + auditId, JSON.stringify(sanitized), { expirationTtl: 2592000 }); } catch (_) {}
  }
  return sanitized;
}

export async function hashRequest(descriptor) {
  try {
    return await sha256Hex(JSON.stringify(descriptor));
  } catch (_) {
    return null;
  }
}
