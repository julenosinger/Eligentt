/**
 * GET /api/core/v1/metrics — Platform Metrics (Treasury Core API, Phase 2 + 4)
 * ════════════════════════════════════════════════════════════════════════════
 * Aggregates the existing Ledger + Core intent store + latency samples into
 * platform metrics: Total Volume, TVL, Outstanding Liquidity, Pending Settlement,
 * P50/P95/P99, Average latency, Requests/min, Error Rate, Retry Count, Bridge &
 * Settlement throughput, Bridge Success Rate and per-application breakdown.
 * Read-only + short-TTL cached; no extra RPC.
 */
import { runCore, corePreflight } from '../../core/pipeline.mjs';
import { computeMetrics } from '../../core/metrics.mjs';
import { withCache } from '../../core/cache.mjs';

export const onRequestOptions = corePreflight;

export function onRequestGet(context) {
  return runCore(context, {
    method: 'GET',
    endpoint: '/api/core/v1/metrics',
    rateKind: 'metrics',
    permission: 'metrics:read',
  }, async (ctx) => {
    const url = new URL(ctx.request.url);
    const application = url.searchParams.get('application');
    const variant = (application || 'all').toUpperCase();
    const { data, cached } = await withCache(ctx.env, 'metrics', variant, () => computeMetrics(ctx.env, { application }));
    return { data: { ...data, _cached: cached } };
  });
}
