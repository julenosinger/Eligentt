/**
 * Autonoma 1.2 — AI Usage Ledger (server-side, KV-backed).
 * ═══════════════════════════════════════════════════════════════════════════════
 * Records AI usage for future Treasury monetization. METERING ONLY — this phase
 * never debits wallets, transfers USDC, or settles Treasury revenue.
 *
 * Invariants:
 *  - Idempotent: a given `requestId` is recorded exactly once.
 *  - Server-side: token counts and costs are computed here, never trusted from the client.
 *  - No conversation content is stored (only token counts + metadata).
 *  - `confirmed` distinguishes provider-confirmed usage from estimates.
 *  - An estimated provider cost is NEVER treated as settled Treasury revenue.
 */

import { estimateProviderCost } from './pricing.js';

const USAGE_PREFIX = 'ai_usage:';
const DAILY_PREFIX = 'ai_daily:';

export function usageKey(requestId) { return USAGE_PREFIX + requestId; }
export function dailyKey(userId, dateStr) { return DAILY_PREFIX + userId + ':' + dateStr; }

function dayStamp(d) {
  return (d || new Date()).toISOString().slice(0, 10);
}

/**
 * Record a usage entry (idempotent by requestId).
 * @param {object} env — Cloudflare env (env.AUTH_KV).
 * @param {object} record — { requestId, userId, provider, model, inputTokens,
 *   outputTokens, operationType, operationId, status, confirmed }
 */
export async function recordUsage(env, record) {
  const KV = env && env.AUTH_KV;
  if (!KV) return { ok: false, error: 'no_kv' };
  if (!record || !record.requestId) return { ok: false, error: 'requestId required' };

  const key = usageKey(record.requestId);

  // Best-effort idempotency. Cloudflare KV has NO atomic compare-and-swap: this
  // read-then-write is a heuristic dedup, NOT a financial guarantee. It is
  // TELEMETRY ONLY (see header note). We still detect requestId reuse across
  // different users/payloads so cross-account double-counting is surfaced.
  const existingRaw = await KV.get(key);
  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw);
      if (record.userId && existing.userId && existing.userId !== record.userId) {
        return { ok: false, error: 'requestId_reused_by_other_user', existingUserId: existing.userId };
      }
      return { ok: true, deduplicated: true };
    } catch (_) { /* fall through and overwrite */ }
  }

  // Token counts may be null (unknown/partial usage) — never coerce null to a
  // "confirmed 0". `confirmed` + `status` carry the provenance.
  const inputTokens  = record.inputTokens == null ? null : (Number(record.inputTokens) || 0);
  const outputTokens = record.outputTokens == null ? null : (Number(record.outputTokens) || 0);

  const estimatedProviderCost = record.estimatedProviderCost != null
    ? Number(record.estimatedProviderCost)
    : (inputTokens == null || outputTokens == null
      ? null
      : estimateProviderCost(record.provider, record.model, inputTokens, outputTokens));

  const rec = {
    requestId: record.requestId,
    userId: record.userId || null,
    provider: record.provider || null,
    model: record.model || null,
    inputTokens,
    outputTokens,
    estimatedProviderCost,
    operationType: record.operationType || 'chat',
    operationId: record.operationId || null,
    status: record.status || 'recorded',
    confirmed: !!record.confirmed,
    timestamp: Date.now(),
  };

  await KV.put(key, JSON.stringify(rec), { expirationTtl: 90 * 86400 });

  // Per-user daily token counter — APPROXIMATE telemetry only. KV is not atomic,
  // so concurrent updates can be lost. This is NOT a hard financial/billing limit.
  if (record.userId && inputTokens != null && outputTokens != null) {
    try {
      const dk = dailyKey(record.userId, dayStamp());
      const cur = parseInt(await KV.get(dk) || '0', 10) || 0;
      await KV.put(dk, String(cur + inputTokens + outputTokens), { expirationTtl: 48 * 3600 });
    } catch (_) { /* non-fatal */ }
  }

  return { ok: true, record: rec };
}

/**
 * Approximate per-user daily token counter. TELEMETRY ONLY — Cloudflare KV is not
 * atomic, so this counter can lose concurrent updates and must NOT be used as a
 * hard financial/billing limit. The orchestrator does not gate requests on this.
 * A proper atomic budget/reservation mechanism (Durable Object) is out of scope
 * for this phase.
 */
export async function checkDailyBudget(env, userId, limitTokens) {
  if (!userId || !Number.isFinite(Number(limitTokens)) || Number(limitTokens) <= 0) return { ok: true };
  const KV = env && env.AUTH_KV;
  if (!KV) return { ok: true };
  const cur = parseInt(await KV.get(dailyKey(userId, dayStamp())) || '0', 10) || 0;
  if (cur >= Number(limitTokens)) return { ok: false, used: cur, limit: Number(limitTokens) };
  return { ok: true, used: cur, limit: Number(limitTokens) };
}
