/**
 * Treasury Core API — Latency Sampling & Percentiles (Phase 4)
 * ═════════════════════════════════════════════════════════════
 * Keeps a small rolling window of recent request latencies (per endpoint and
 * global) in KV so the metrics endpoint can report P50/P95/P99, average latency,
 * requests/min and error rate WITHOUT any external APM. Best-effort + KV-optional.
 */
import { coreKv } from './store.mjs';

const LAT_PREFIX = 'core:lat:';
const WINDOW_MS = 5 * 60 * 1000;   // keep ~5 minutes of samples
const MAX_SAMPLES = 300;
const TTL_SECONDS = 600;

function key(scope) { return LAT_PREFIX + scope; }

export async function recordLatency(env, endpoint, ms, meta) {
  const kv = coreKv(env);
  if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') return false;
  const sample = { ms: Math.max(0, Math.round(ms) || 0), t: Date.now(), ok: !(meta && meta.error), status: (meta && meta.status) || null, retries: (meta && meta.retries) || 0 };
  for (const scope of ['global', 'ep:' + (endpoint || 'unknown')]) {
    try {
      const raw = await kv.get(key(scope));
      let arr = raw ? JSON.parse(raw) : [];
      arr.push(sample);
      const cutoff = Date.now() - WINDOW_MS;
      arr = arr.filter(s => s.t >= cutoff).slice(-MAX_SAMPLES);
      await kv.put(key(scope), JSON.stringify(arr), { expirationTtl: TTL_SECONDS });
    } catch (_) {}
  }
  return true;
}

export async function loadSamples(env, scope) {
  const kv = coreKv(env);
  if (!kv || typeof kv.get !== 'function') return [];
  try {
    const raw = await kv.get(key(scope || 'global'));
    const arr = raw ? JSON.parse(raw) : [];
    const cutoff = Date.now() - WINDOW_MS;
    return arr.filter(s => s.t >= cutoff);
  } catch (_) { return []; }
}

export function percentile(samples, p) {
  const vals = (samples || []).map(s => (typeof s === 'number' ? s : s.ms)).filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  if (!vals.length) return 0;
  const idx = Math.min(vals.length - 1, Math.max(0, Math.ceil((p / 100) * vals.length) - 1));
  return vals[idx];
}

export function summarize(samples, windowMs) {
  const list = samples || [];
  const now = Date.now();
  const win = windowMs || 60000;
  const recent = list.filter(s => s.t >= now - win);
  const total = list.length;
  const errors = list.filter(s => s.ok === false).length;
  const avg = total ? Math.round(list.reduce((a, s) => a + (s.ms || 0), 0) / total) : 0;
  const retries = list.reduce((a, s) => a + (s.retries || 0), 0);
  return {
    p50: percentile(list, 50),
    p95: percentile(list, 95),
    p99: percentile(list, 99),
    averageLatency: avg,
    requestsPerMin: recent.length,
    errorRate: total ? Math.round((errors / total) * 10000) / 100 : 0, // %
    retryCount: retries,
    sampleCount: total,
  };
}
