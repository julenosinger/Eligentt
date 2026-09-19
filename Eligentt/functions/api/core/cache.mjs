/**
 * Treasury Core API — Intelligent Cache (Phase 4)
 * ════════════════════════════════════════════════
 * Short-TTL response caching for READ-ONLY, non-financial endpoints ONLY:
 *   metrics, health, applications.
 *
 * NEVER caches: execute, intent creation, settlement, or real-time history —
 * those must always reflect live state. Best-effort + KV-optional; a cache miss
 * or KV failure simply falls through to a fresh computation.
 */
import { coreKv } from './store.mjs';

const CACHE_PREFIX = 'core:cache:';

// Only these endpoints are cacheable, with conservative TTLs (seconds).
export const CACHEABLE = Object.freeze({
  metrics: 10,
  health: 5,
  applications: 30,
});

export function isCacheable(name) {
  return Object.prototype.hasOwnProperty.call(CACHEABLE, name);
}

function keyFor(name, variant) {
  return CACHE_PREFIX + name + (variant ? ':' + variant : '');
}

export async function getCached(env, name, variant) {
  if (!isCacheable(name)) return null;
  const kv = coreKv(env);
  if (!kv || typeof kv.get !== 'function') return null;
  try {
    const raw = await kv.get(keyFor(name, variant));
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (entry.expiresAt && entry.expiresAt < Date.now()) return null;
    return entry.data;
  } catch (_) { return null; }
}

export async function setCached(env, name, variant, data) {
  if (!isCacheable(name)) return false;
  const kv = coreKv(env);
  if (!kv || typeof kv.put !== 'function') return false;
  const ttl = CACHEABLE[name];
  try {
    await kv.put(keyFor(name, variant), JSON.stringify({ data, expiresAt: Date.now() + ttl * 1000 }), { expirationTtl: ttl + 5 });
    return true;
  } catch (_) { return false; }
}

/** Wrap a compute fn with read-through caching (cacheable endpoints only). */
export async function withCache(env, name, variant, computeFn) {
  if (!isCacheable(name)) return { data: await computeFn(), cached: false };
  const hit = await getCached(env, name, variant);
  if (hit != null) return { data: hit, cached: true };
  const data = await computeFn();
  await setCached(env, name, variant, data);
  return { data, cached: false };
}
