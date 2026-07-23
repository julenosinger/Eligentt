/**
 * GET /api/core/v1/applications — Application Registry (Treasury Core API, Phase 2)
 * ═════════════════════════════════════════════════════════════════════════════════
 * Read-only view of the internal Application Registry. Returns PUBLIC projections
 * only — application secrets are reduced to a fingerprint and never exposed.
 * Prepared for Phase 3; ELLIGENT is active, EXECDAAT/FUTURE_APP are "prepared".
 */
import { runCore, corePreflight } from '../../core/pipeline.mjs';
import { listApplications, publicApplication } from '../../core/registry.mjs';
import { withCache } from '../../core/cache.mjs';

export const onRequestOptions = corePreflight;

export function onRequestGet(context) {
  return runCore(context, {
    method: 'GET',
    endpoint: '/api/core/v1/applications',
    rateKind: 'request',
    permission: 'health:read',
  }, async (ctx) => {
    const { data, cached } = await withCache(ctx.env, 'applications', 'all', async () => {
      const apps = await listApplications(ctx.env);
      return { applications: apps.map(publicApplication) };
    });
    return { data: { ...data, _cached: cached } };
  });
}
