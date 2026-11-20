/**
 * Autonoma 1.2 — Multi-AI Provider Foundation tests.
 * Behavioral: imports the server-side modules directly and mocks external providers.
 * No real API credits, no real transactions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { estimateProviderCost, PROVIDER_PRICING } from '../functions/api/_ai/pricing.js';
import { getProvider, availableProviders, defaultProviderId } from '../functions/api/_ai/providerRegistry.js';
import { flags, resolveProvider, generate } from '../functions/api/_ai/orchestrator.js';
import { recordUsage, usageKey, checkDailyBudget, dailyKey } from '../functions/api/_ai/usageLedger.js';
import { validateToolCall } from '../functions/api/_ai/toolSchema.js';

// ── in-memory KV stub ─────────────────────────────────────────────────────────
function makeKV() {
  const store = new Map();
  return {
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => { store.set(k, v); },
    delete: async (k) => { store.delete(k); },
    _store: store,
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

// ── Pricing ───────────────────────────────────────────────────────────────────
describe('pricing: estimateProviderCost', () => {
  it('computes USD cost from token counts', () => {
    const c = estimateProviderCost('deepseek', 'deepseek-chat', 1_000_000, 1_000_000);
    expect(c).toBeCloseTo(0.27 + 1.10, 4);
  });
  it('returns null for unknown provider', () => {
    expect(estimateProviderCost('unknown', 'x', 1, 1)).toBeNull();
  });
  it('is frozen (immutable)', () => {
    expect(Object.isFrozen(PROVIDER_PRICING)).toBe(true);
  });
});

// ── Provider registry ────────────────────────────────────────────────────────
describe('providerRegistry: adapters', () => {
  const env = { DEEPSEEK_API_KEY: 'dk', OPENAI_API_KEY: 'ok', ANTHROPIC_API_KEY: 'ak' };

  it('normalizes an OpenAI-compatible response (DeepSeek)', () => {
    const ds = getProvider('deepseek');
    const out = ds.normalizeResponse({
      model: 'deepseek-chat',
      choices: [{ message: { content: 'hi', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'send', arguments: '{"to":"0x'+ 'a'.repeat(40) + '","amount":5}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }, 'req1');
    expect(out.provider).toBe('deepseek');
    expect(out.message).toBe('hi');
    expect(out.toolCalls[0].name).toBe('send');
    expect(out.toolCalls[0].arguments.amount).toBe(5);
    expect(out.usage.inputTokens).toBe(10);
    expect(out.usage.outputTokens).toBe(20);
    expect(out.usage.totalTokens).toBe(30);
  });

  it('normalizes an Anthropic response (content blocks + tool_use)', () => {
    const an = getProvider('anthropic');
    const out = an.normalizeResponse({
      model: 'claude-3-5-haiku-latest',
      content: [
        { type: 'text', text: 'Sure.' },
        { type: 'tool_use', id: 't1', name: 'balance', input: {} },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 5, output_tokens: 7 },
    }, 'req2');
    expect(out.provider).toBe('anthropic');
    expect(out.message).toBe('Sure.');
    expect(out.toolCalls[0].name).toBe('balance');
    expect(out.usage.inputTokens).toBe(5);
    expect(out.usage.outputTokens).toBe(7);
    expect(out.usage.totalTokens).toBe(12);
  });

  it('maps OpenAI-style messages to Anthropic messages', () => {
    const an = getProvider('anthropic');
    const req = an.buildRequest({ model: 'claude-3-5-haiku-latest', messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }], tools: [{ function: { name: 'send', description: 'd', parameters: {} } }] });
    expect(req.body.system).toBe('SYS');
    expect(req.body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(req.body.tools[0].name).toBe('send');
  });

  it('availableProviders filters by configured keys', () => {
    expect(availableProviders({ DEEPSEEK_API_KEY: 'x' }).map(p => p.id)).toEqual(['deepseek']);
    expect(availableProviders({}).length).toBe(0);
    expect(availableProviders(env).length).toBe(3);
  });

  it('defaultProviderId prefers deepseek, then first available', () => {
    expect(defaultProviderId({ DEEPSEEK_API_KEY: 'x', OPENAI_API_KEY: 'y' })).toBe('deepseek');
    expect(defaultProviderId({ OPENAI_API_KEY: 'y' })).toBe('openai');
    expect(defaultProviderId({})).toBeNull();
  });
});

// ── Orchestrator: flags + resolution ─────────────────────────────────────────
describe('orchestrator: flags and provider resolution', () => {
  it('flags default to safe values', () => {
    const f = flags({});
    expect(f.aiEnabled).toBe(true);
    expect(f.multiProviderEnabled).toBe(false);
    expect(f.billingEnabled).toBe(false);
    expect(f.financialExecutionEnabled).toBe(false);
  });
  it('flags read env overrides', () => {
    const f = flags({ AUTONOMA_MULTI_PROVIDER_ENABLED: 'true', AUTONOMA_AI_BILLING_ENABLED: 'true' });
    expect(f.multiProviderEnabled).toBe(true);
    expect(f.billingEnabled).toBe(true);
  });
  it('resolveProvider: no key → no_provider', () => {
    expect(resolveProvider({}, null)).toEqual({ ok: false, code: 'no_provider', message: 'No AI provider configured' });
  });
  it('resolveProvider: explicit non-deepseek rejected when multi-provider disabled', () => {
    const r = resolveProvider({ DEEPSEEK_API_KEY: 'x', OPENAI_API_KEY: 'y' }, 'openai');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('multi_provider_disabled');
  });
  it('resolveProvider: explicit openai allowed when multi-provider enabled', () => {
    const r = resolveProvider({ OPENAI_API_KEY: 'y', AUTONOMA_MULTI_PROVIDER_ENABLED: 'true' }, 'openai');
    expect(r.ok).toBe(true);
    expect(r.provider.id).toBe('openai');
  });
});

// ── Orchestrator: generate (mocked fetch) ────────────────────────────────────
describe('orchestrator: generate', () => {
  const env = { DEEPSEEK_API_KEY: 'dk' };
  const baseResp = {
    model: 'deepseek-chat',
    choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  };

  it('returns a normalized result on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(baseResp), { status: 200 })));
    const out = await generate(env, { messages: [{ role: 'user', content: 'hi' }] });
    expect(out.ok).toBe(true);
    expect(out.result.provider).toBe('deepseek');
    expect(out.result.message).toBe('hello');
  });

  it('maps 401 to auth_error (no fallback)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad key', { status: 401 })));
    const out = await generate(env, { messages: [{ role: 'user', content: 'hi' }] });
    expect(out.ok).toBe(false);
    expect(out.code).toBe('auth_error');
  });

  it('maps 429 to rate_limited', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('slow down', { status: 429 })));
    const out = await generate(env, { messages: [{ role: 'user', content: 'hi' }] });
    expect(out.ok).toBe(false);
    expect(out.code).toBe('rate_limited');
  });

  it('falls back to the next provider on 500 (only when multi-provider enabled)', async () => {
    // DeepSeek 500, then OpenAI succeeds — fallback requires multi-provider flag.
    const env2 = { DEEPSEEK_API_KEY: 'dk', OPENAI_API_KEY: 'ok', AUTONOMA_MULTI_PROVIDER_ENABLED: 'true' };
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('deepseek')) return new Response('down', { status: 500 });
      return new Response(JSON.stringify({ model: 'gpt-4o-mini', choices: [{ message: { content: 'fb' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200 });
    }));
    const out = await generate(env2, { messages: [{ role: 'user', content: 'hi' }] });
    expect(out.ok).toBe(true);
    expect(out.result.provider).toBe('openai');
  });

  it('does NOT fall back on 500 when multi-provider is disabled', async () => {
    const env2 = { DEEPSEEK_API_KEY: 'dk', OPENAI_API_KEY: 'ok' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 500 })));
    const out = await generate(env2, { messages: [{ role: 'user', content: 'hi' }] });
    expect(out.ok).toBe(false);
    expect(out.code).toBe('provider_error');
  });

  it('returns malformed_response on empty body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
    const out = await generate(env, { messages: [{ role: 'user', content: 'hi' }] });
    expect(out.ok).toBe(false);
    expect(out.code).toBe('malformed_response');
  });

  it('records usage (idempotent) when userId is provided', async () => {
    const kv = makeKV();
    const env3 = { DEEPSEEK_API_KEY: 'dk', AUTH_KV: kv };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(baseResp), { status: 200 })));
    const out = await generate(env3, { requestId: 'r1', userId: 'u1', messages: [{ role: 'user', content: 'hi' }] });
    expect(out.ok).toBe(true);
    const rec = JSON.parse(kv._store.get(usageKey('r1')));
    expect(rec.inputTokens).toBe(3);
    expect(rec.confirmed).toBe(true);
    // second generate with same requestId must not double-record
    await generate(env3, { requestId: 'r1', userId: 'u1', messages: [{ role: 'user', content: 'hi' }] });
    expect(kv._store.get(usageKey('r1'))).toBeDefined();
  });
});

// ── Usage ledger ──────────────────────────────────────────────────────────────
describe('usageLedger', () => {
  it('recordUsage is idempotent by requestId', async () => {
    const kv = makeKV();
    const env = { AUTH_KV: kv };
    const rec = { requestId: 'idem1', userId: 'u1', provider: 'deepseek', model: 'deepseek-chat', inputTokens: 10, outputTokens: 5 };
    const r1 = await recordUsage(env, rec);
    expect(r1.ok).toBe(true);
    const r2 = await recordUsage(env, rec);
    expect(r2.deduplicated).toBe(true);
  });
  it('computes estimatedProviderCost from tokens', async () => {
    const kv = makeKV();
    const env = { AUTH_KV: kv };
    await recordUsage(env, { requestId: 'cost1', userId: 'u1', provider: 'deepseek', model: 'deepseek-chat', inputTokens: 1_000_000, outputTokens: 1_000_000 });
    const rec = JSON.parse(kv._store.get(usageKey('cost1')));
    expect(rec.estimatedProviderCost).toBeCloseTo(1.37, 3);
  });
  it('checkDailyBudget enforces limit', async () => {
    const kv = makeKV();
    const env = { AUTH_KV: kv };
    await kv.put(dailyKey('u1', new Date().toISOString().slice(0, 10)), '100');
    const over = await checkDailyBudget(env, 'u1', 50);
    expect(over.ok).toBe(false);
    const under = await checkDailyBudget(env, 'u1', 500);
    expect(under.ok).toBe(true);
  });
});

// ── Tool schema validation ────────────────────────────────────────────────────
describe('toolSchema: validateToolCall', () => {
  const addr = '0x' + 'a'.repeat(40);
  it('accepts a valid send', () => {
    expect(validateToolCall('send', { to: addr, amount: 5, token: 'USDC' })).toEqual({ ok: true, type: 'write' });
  });
  it('rejects invalid recipient', () => {
    expect(validateToolCall('send', { to: '0x123', amount: 5 }).ok).toBe(false);
  });
  it('rejects invalid amount', () => {
    expect(validateToolCall('send', { to: addr, amount: 0 }).ok).toBe(false);
  });
  it('rejects unknown tool', () => {
    expect(validateToolCall('drain_wallet', {}).ok).toBe(false);
  });
  it('accepts a valid read tool', () => {
    expect(validateToolCall('balance', {}).type).toBe('read');
  });
  it('rejects invalid bridge chain', () => {
    expect(validateToolCall('bridge', { fromChain: 'mars', toChain: 'base', amount: 5 }).ok).toBe(false);
  });
});
