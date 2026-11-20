/**
 * Autonoma 1.2 — AI provider pricing configuration (server-side).
 * ═══════════════════════════════════════════════════════════════════════════════
 * Authoritative, server-side pricing used ONLY to compute `estimatedProviderCost`
 * for usage metering. These are ESTIMATES in USD per 1,000,000 tokens and are
 * NEVER used to charge the user or to settle Treasury revenue.
 *
 * Values are indicative (public list prices as of 2026). Update them here —
 * never in the browser — when provider pricing changes.
 */

export const PROVIDER_PRICING = Object.freeze({
  deepseek: Object.freeze({
    'deepseek-chat':      Object.freeze({ input: 0.27, output: 1.10 }),
    'deepseek-reasoner':  Object.freeze({ input: 0.55, output: 2.19 }),
  }),
  openai: Object.freeze({
    'gpt-4o-mini': Object.freeze({ input: 0.15, output: 0.60 }),
    'gpt-4o':      Object.freeze({ input: 2.50, output: 10.00 }),
  }),
  anthropic: Object.freeze({
    'claude-3-5-haiku-latest':  Object.freeze({ input: 0.80, output: 4.00 }),
    'claude-3-5-sonnet-latest': Object.freeze({ input: 3.00, output: 15.00 }),
  }),
});

/**
 * Estimate a provider cost in USD from token counts.
 * Returns null when the provider/model has no configured price.
 */
export function estimateProviderCost(provider, model, inputTokens, outputTokens) {
  const providerPrices = PROVIDER_PRICING[provider];
  if (!providerPrices) return null;
  const price = providerPrices[model] || providerPrices[Object.keys(providerPrices)[0]];
  if (!price) return null;
  const inputUsd  = (Number(inputTokens)  || 0) * price.input  / 1_000_000;
  const outputUsd = (Number(outputTokens) || 0) * price.output / 1_000_000;
  return Number((inputUsd + outputUsd).toFixed(8));
}
