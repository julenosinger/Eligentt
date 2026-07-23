/**
 * Treasury Core API — Circuit Breaker (Phase 4)
 * ═══════════════════════════════════════════════
 * Protects the platform when a downstream dependency degrades (Circle, RPC,
 * Vault, Treasury, Relayer). State is kept in KV so it is shared across the
 * stateless Workers. When a dependency trips the breaker OPEN, dependent calls
 * fail fast with a standardized error instead of piling up — the Worker is NEVER
 * crashed and unrelated endpoints keep serving.
 *
 * States: closed → (failures ≥ threshold) → open → (after cooldown) → half_open
 *         half_open → success → closed | failure → open
 */
import { coreKv } from './store.mjs';

export const DEPENDENCIES = Object.freeze(['circle', 'rpc', 'vault', 'treasury', 'relayer']);

const CB_PREFIX = 'core:cb:';
const FAIL_THRESHOLD = 5;
const WINDOW_MS = 60000;      // failures counted within a rolling minute
const COOLDOWN_MS = 30000;    // time to wait before probing again
const TTL_SECONDS = 300;

function key(dep) { return CB_PREFIX + dep; }

function emptyState() { return { state: 'closed', failures: 0, windowStart: Date.now(), openedAt: null, lastError: null }; }

async function read(env, dep) {
  const kv = coreKv(env);
  if (!kv || typeof kv.get !== 'function') return emptyState();
  try {
    const raw = await kv.get(key(dep));
    return raw ? JSON.parse(raw) : emptyState();
  } catch (_) { return emptyState(); }
}

async function write(env, dep, state) {
  const kv = coreKv(env);
  if (!kv || typeof kv.put !== 'function') return;
  try { await kv.put(key(dep), JSON.stringify(state), { expirationTtl: TTL_SECONDS }); } catch (_) {}
}

/**
 * Check whether a call to `dep` is allowed right now.
 * @returns {Promise<{allowed:boolean, state:string, dependency:string, retryAfterMs?:number}>}
 */
export async function check(env, dep) {
  const now = Date.now();
  const s = await read(env, dep);
  if (s.state === 'open') {
    if (s.openedAt && (now - s.openedAt) >= COOLDOWN_MS) {
      // Cooldown elapsed → allow a single probe (half-open).
      await write(env, dep, { ...s, state: 'half_open' });
      return { allowed: true, state: 'half_open', dependency: dep };
    }
    return { allowed: false, state: 'open', dependency: dep, retryAfterMs: Math.max(0, COOLDOWN_MS - (now - (s.openedAt || now))) };
  }
  return { allowed: true, state: s.state, dependency: dep };
}

export async function recordSuccess(env, dep) {
  await write(env, dep, emptyState());
}

export async function recordFailure(env, dep, errMsg) {
  const now = Date.now();
  const s = await read(env, dep);
  let failures = s.failures || 0;
  let windowStart = s.windowStart || now;
  if (now - windowStart > WINDOW_MS) { failures = 0; windowStart = now; }
  failures += 1;
  const open = failures >= FAIL_THRESHOLD || s.state === 'half_open';
  const next = {
    state: open ? 'open' : 'closed',
    failures,
    windowStart,
    openedAt: open ? now : null,
    lastError: (errMsg || 'error').toString().slice(0, 120),
  };
  await write(env, dep, next);
  return next;
}

/** Snapshot all dependency breaker states (for the health endpoint). */
export async function snapshot(env) {
  const out = {};
  for (const dep of DEPENDENCIES) {
    const s = await read(env, dep);
    out[dep] = { state: s.state || 'closed', failures: s.failures || 0, openedAt: s.openedAt || null };
  }
  return out;
}

/**
 * Execute a dependency call guarded by the breaker. On disallowed → throws a
 * fail-fast marker. On success/failure updates the breaker. Never crashes.
 */
export async function guard(env, dep, fn) {
  const c = await check(env, dep);
  if (!c.allowed) {
    const e = new Error('CIRCUIT_OPEN:' + dep);
    e.circuitOpen = true;
    e.dependency = dep;
    e.retryAfterMs = c.retryAfterMs;
    throw e;
  }
  try {
    const value = await fn();
    await recordSuccess(env, dep);
    return value;
  } catch (e) {
    await recordFailure(env, dep, e && e.message);
    throw e;
  }
}
