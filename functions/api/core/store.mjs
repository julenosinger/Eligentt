/**
 * Treasury Core API — KV Store Helpers (Phase 2)
 * ═══════════════════════════════════════════════
 * Persistence for the Core API's OWN records (intent registry, audit, registry,
 * rate-usage). Data is namespaced by prefix and stored in a dedicated binding.
 *
 * KV STRATEGY (important for backward compatibility):
 *   coreKv = env.CORE_KV || env.RATE_LIMIT_KV || null
 * We deliberately do NOT reuse PAYMENT_LINKS here — the existing treasury/fees
 * endpoint list()s PAYMENT_LINKS, so writing Core data there could dilute that
 * scan. RATE_LIMIT_KV is only ever accessed by exact key, so prefixed Core data
 * there is safe and cannot affect any existing endpoint.
 *
 * All helpers are KV-OPTIONAL and best-effort: when no binding exists they no-op
 * rather than throwing, so the Core API degrades gracefully.
 */

export const INTENT_PREFIX = 'core:intent:';
export const AUDIT_PREFIX = 'core:audit:';
export const REGISTRY_PREFIX = 'core:registry:';
export const RATE_PREFIX = 'core:rate:';

export function coreKv(env) {
  if (!env) return null;
  return env.CORE_KV || env.RATE_LIMIT_KV || null;
}

// The KV that holds the Phase 1 accounting Ledger (ledger:* keys).
export function ledgerKv(env) {
  if (!env) return null;
  return env.LEDGER_KV || env.CORE_KV || env.RATE_LIMIT_KV || null;
}

export async function kvGetJSON(kv, key) {
  if (!kv || typeof kv.get !== 'function') return null;
  try {
    const raw = await kv.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

export async function kvPutJSON(kv, key, value, opts) {
  if (!kv || typeof kv.put !== 'function') return false;
  try {
    await kv.put(key, JSON.stringify(value), opts || {});
    return true;
  } catch (_) { return false; }
}

export async function kvListJSON(kv, prefix, limit) {
  if (!kv || typeof kv.list !== 'function' || typeof kv.get !== 'function') return [];
  const out = [];
  try {
    const listed = await kv.list({ prefix, limit: limit || 1000 });
    for (const k of (listed.keys || [])) {
      const v = await kvGetJSON(kv, k.name);
      if (v) out.push(v);
    }
  } catch (_) {}
  return out;
}

// ── Core intent registry (registration only — NOT the on-chain bridge) ────────
function intentKey(id) { return INTENT_PREFIX + id; }

export async function saveIntent(env, intent) {
  return kvPutJSON(coreKv(env), intentKey(intent.intentId), intent);
}

export async function getStoredIntent(env, id) {
  return kvGetJSON(coreKv(env), intentKey(id));
}

export async function listStoredIntents(env, limit) {
  return kvListJSON(coreKv(env), INTENT_PREFIX, limit);
}
