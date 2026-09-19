/**
 * POST /api/core/v1/quote — Route Quote (Treasury Core API, Phase 2)
 * ══════════════════════════════════════════════════════════════════
 * Returns best route / bridge / ETA / fee / receive / provider / slippage /
 * liquidity for a token amount, using the EXISTING fee & route configuration
 * (no recalculation of financial logic, no on-chain calls).
 */
import { runCore, corePreflight } from '../../core/pipeline.mjs';
import { validateQuote } from '../../core/validation.mjs';
import { getQuote } from '../../core/quote-engine.mjs';

export const onRequestOptions = corePreflight;

export function onRequestPost(context) {
  return runCore(context, {
    method: 'POST',
    endpoint: '/api/core/v1/quote',
    rateKind: 'quote',
    permission: 'quote:read',
    validate: validateQuote,
  }, async (ctx) => {
    const q = getQuote(ctx.body);
    return { data: q };
  });
}
