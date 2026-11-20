/**
 * Autonoma 1.2.2 — Provider isolation, SSE integrity & security hardening.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { resolveProvider, flags, generate, stream } from '../functions/api/_ai/orchestrator.js';
import { resolveTools, TRUSTED_SYSTEM_PROMPT, TRUSTED_TOOL_NAMES } from '../functions/api/_ai/trustedTools.js';
import { recordUsage, usageKey } from '../functions/api/_ai/usageLedger.js';

function makeKV() {
  const store = new Map();
  return { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); }, _store: store };
}
function sseBody(parts) {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { for (const p of parts) c.enqueue(typeof p === 'string' ? enc.encode(p) : p); c.close(); } });
}

afterEach(() => { vi.unstubAllGlobals(); });

// ── Provider isolation (P0) ──────────────────────────────────────────────────
describe('provider isolation', () => {
  it('AI disabled blocks explicit deepseek', () => {
    const r = resolveProvider({ DEEPSEEK_API_KEY: 'x', AUTONOMA_AI_ENABLED: 'false' }, 'deepseek');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ai_disabled');
  });

  it('multi-provider disabled: explicit openai rejected', () => {
    const r = resolveProvider({ DEEPSEEK_API_KEY: 'x', OPENAI_API_KEY: 'y' }, 'openai');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('multi_provider_disabled');
  });

  it('multi-provider disabled: explicit anthropic rejected', () => {
    const r = resolveProvider({ DEEPSEEK_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' }, 'anthropic');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('multi_provider_disabled');
  });

  it('AUTONOMA_DEFAULT_PROVIDER=openai cannot bypass multi-provider disabled', () => {
    const r = resolveProvider({ DEEPSEEK_API_KEY: 'x', OPENAI_API_KEY: 'y', AUTONOMA_DEFAULT_PROVIDER: 'openai' }, null);
    expect(r.ok).toBe(true);
    expect(r.provider.id).toBe('deepseek'); // still deepseek-only
  });

  it('missing DeepSeek key returns no_provider (never falls back to openai)', () => {
    const r = resolveProvider({ OPENAI_API_KEY: 'y' }, null);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('no_provider');
  });

  it('invalid explicit provider id is rejected (not silently defaulted)', () => {
    const r = resolveProvider({ DEEPSEEK_API_KEY: 'x', AUTONOMA_MULTI_PROVIDER_ENABLED: 'true' }, 'bogus');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('invalid_provider');
  });

  it('invalid model is rejected (not silently substituted)', async () => {
    const env = { DEEPSEEK_API_KEY: 'x' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
    const out = await generate(env, { model: 'not-a-real-model', messages: [{ role: 'user', content: 'hi' }] });
    expect(out.ok).toBe(false);
    expect(out.code).toBe('invalid_model');
  });

  it('multi-provider enabled: explicit openai resolves', () => {
    const r = resolveProvider({ OPENAI_API_KEY: 'y', AUTONOMA_MULTI_PROVIDER_ENABLED: 'true' }, 'openai');
    expect(r.ok).toBe(true);
    expect(r.provider.id).toBe('openai');
  });
});

// ── SSE parser integrity (P0) ────────────────────────────────────────────────
describe('SSE parser integrity', () => {
  const usageEvt = 'data: {"choices":[],"usage":{"prompt_tokens":6,"completion_tokens":4,"total_tokens":10}}\n\n';

  it('handles CRLF line endings', async () => {
    const kv = makeKV();
    const env = { DEEPSEEK_API_KEY: 'dk', AUTH_KV: kv };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sseBody([
      'data: {"choices":[{"delta":{"content":"x"}}]}\r\n\r\n',
      usageEvt.replace(/\n/g, '\r\n'),
      'data: [DONE]\r\n\r\n',
    ]), { status: 200 })));
    const out = await stream(env, { requestId: 'crlf', userId: 'u1', messages: [{ role: 'user', content: 'hi' }] });
    await out.response.text();
    expect(JSON.parse(kv._store.get(usageKey('crlf'))).inputTokens).toBe(6);
  });

  it('handles multiple events in one chunk', async () => {
    const kv = makeKV();
    const env = { DEEPSEEK_API_KEY: 'dk', AUTH_KV: kv };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sseBody([
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"choices":[{"delta":{"content":"b"}}]}\n\n' + usageEvt + 'data: [DONE]\n\n',
    ]), { status: 200 })));
    const out = await stream(env, { requestId: 'multi', userId: 'u1', messages: [{ role: 'user', content: 'hi' }] });
    await out.response.text();
    expect(JSON.parse(kv._store.get(usageKey('multi'))).inputTokens).toBe(6);
  });

  it('preserves original bytes pass-through', async () => {
    const env = { DEEPSEEK_API_KEY: 'dk' };
    const raw = 'data: {"choices":[{"delta":{"content":"héllo"}}]}\n\ndata: [DONE]\n\n';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sseBody([raw]), { status: 200 })));
    const out = await stream(env, { messages: [{ role: 'user', content: 'hi' }] });
    expect(await out.response.text()).toBe(raw);
  });

  it('records unknown_usage when DONE missing (truncated)', async () => {
    const kv = makeKV();
    const env = { DEEPSEEK_API_KEY: 'dk', AUTH_KV: kv };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sseBody([
      'data: {"choices":[{"delta":{"content":"truncated"}}]}\n\n',
    ]), { status: 200 })));
    const out = await stream(env, { requestId: 'trunc', userId: 'u1', messages: [{ role: 'user', content: 'hi' }] });
    await out.response.text();
    const rec = JSON.parse(kv._store.get(usageKey('trunc')));
    expect(rec.confirmed).toBe(false);
    expect(rec.status).toBe('unknown_usage');
  });

  it('handles comment lines and multi-line data without crashing', async () => {
    const env = { DEEPSEEK_API_KEY: 'dk' };
    const raw = ': keep-alive\ndata: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sseBody([raw]), { status: 200 })));
    const out = await stream(env, { messages: [{ role: 'user', content: 'hi' }] });
    expect(await out.response.text()).toBe(raw);
  });
});

// ── Non-blocking persistence (P1) ────────────────────────────────────────────
describe('non-blocking usage persistence (waitUntil)', () => {
  it('schedules the record via waitUntil', async () => {
    const kv = makeKV();
    const env = { DEEPSEEK_API_KEY: 'dk', AUTH_KV: kv };
    const waited = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sseBody([
      'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}\n\n',
      'data: [DONE]\n\n',
    ]), { status: 200 })));
    const out = await stream(env, { requestId: 'w1', userId: 'u1', messages: [{ role: 'user', content: 'hi' }], waitUntil: (p) => waited.push(p) });
    await out.response.text();
    expect(waited.length).toBe(1);
    await Promise.all(waited);
    expect(JSON.parse(kv._store.get(usageKey('w1'))).inputTokens).toBe(2);
  });
});

// ── Server-authoritative prompts & tools (P1) ────────────────────────────────
describe('server-authoritative prompts & tools', () => {
  it('trusted tool names match the execution allowlist intent', () => {
    for (const n of ['balance', 'history', 'wallet_info', 'routes', 'schedules', 'send', 'swap', 'bridge', 'create_invoice', 'create_schedule', 'create_payment_link']) {
      expect(TRUSTED_TOOL_NAMES.has(n)).toBe(true);
    }
  });

  it('resolveTools rejects an unknown tool name', () => {
    const r = resolveTools([{ function: { name: 'steal_all_funds', description: 'x', parameters: {} } }]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('unauthorized_tool');
  });

  it('resolveTools ignores client definitions (returns trusted definition)', () => {
    const r = resolveTools([{ function: { name: 'send', description: 'MALICIOUS REDEFINITION', parameters: { type: 'object', properties: { evil: { type: 'string' } } } } }]);
    expect(r.ok).toBe(true);
    const send = r.tools.find((t) => t.function.name === 'send');
    expect(send.function.description).not.toContain('MALICIOUS');
    expect(send.function.parameters.properties).not.toHaveProperty('evil');
  });

  it('TRUSTED_SYSTEM_PROMPT is non-empty and owned server-side', () => {
    expect(TRUSTED_SYSTEM_PROMPT).toContain('Autonoma 2');
  });
});

// ── Usage ledger input validation (P1) ───────────────────────────────────────
describe('usage ledger input validation', () => {
  it('accepts valid non-negative integers', async () => {
    const kv = makeKV();
    const r = await recordUsage({ AUTH_KV: kv }, { requestId: 'v1', provider: 'deepseek', model: 'x', inputTokens: 10, outputTokens: 5 });
    expect(r.ok).toBe(true);
  });

  it('rejects negative token counts', async () => {
    const kv = makeKV();
    const r = await recordUsage({ AUTH_KV: kv }, { requestId: 'neg', provider: 'deepseek', model: 'x', inputTokens: -5, outputTokens: 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_token_count');
  });

  it('rejects fractional token counts', async () => {
    const kv = makeKV();
    const r = await recordUsage({ AUTH_KV: kv }, { requestId: 'frac', provider: 'deepseek', model: 'x', inputTokens: 1.5, outputTokens: 1 });
    expect(r.ok).toBe(false);
  });

  it('rejects NaN / Infinity / malformed strings', async () => {
    const kv = makeKV();
    expect((await recordUsage({ AUTH_KV: kv }, { requestId: 'nan', provider: 'deepseek', model: 'x', inputTokens: NaN, outputTokens: 1 })).ok).toBe(false);
    expect((await recordUsage({ AUTH_KV: kv }, { requestId: 'inf', provider: 'deepseek', model: 'x', inputTokens: Infinity, outputTokens: 1 })).ok).toBe(false);
    expect((await recordUsage({ AUTH_KV: kv }, { requestId: 'str', provider: 'deepseek', model: 'x', inputTokens: '12abc', outputTokens: 1 })).ok).toBe(false);
  });

  it('ignores client-supplied estimated cost (computes server-side)', async () => {
    const kv = makeKV();
    await recordUsage({ AUTH_KV: kv }, { requestId: 'cost', provider: 'deepseek', model: 'deepseek-chat', inputTokens: 1000000, outputTokens: 1000000, estimatedProviderCost: 999999 });
    const rec = JSON.parse(kv._store.get(usageKey('cost')));
    expect(rec.estimatedProviderCost).not.toBe(999999); // client value ignored
    expect(rec.estimatedProviderCost).toBeCloseTo(1.37, 2);
  });
});
