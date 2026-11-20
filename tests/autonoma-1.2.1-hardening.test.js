/**
 * Autonoma 1.2.1 — Streaming integrity, provider policy & usage accounting hardening.
 * Behavioral tests with mocked providers and Cloudflare-compatible test doubles.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { resolveProvider, generate, stream } from '../functions/api/_ai/orchestrator.js';
import { recordUsage, usageKey } from '../functions/api/_ai/usageLedger.js';

function makeKV() {
  const store = new Map();
  return {
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => { store.set(k, v); },
    delete: async (k) => { store.delete(k); },
    _store: store,
  };
}

function sseBody(parts) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(c) { for (const p of parts) c.enqueue(typeof p === 'string' ? encoder.encode(p) : p); c.close(); },
  });
}

afterEach(() => { vi.unstubAllGlobals(); });

// ── Provider policy (P0) ─────────────────────────────────────────────────────
describe('provider policy: flags are enforced before any request', () => {
  it('AUTONOMA_AI_ENABLED=false blocks even an explicit provider request', () => {
    const r = resolveProvider({ DEEPSEEK_API_KEY: 'x', AUTONOMA_AI_ENABLED: 'false' }, 'deepseek');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ai_disabled');
  });

  it('AUTONOMA_MULTI_PROVIDER_ENABLED=false blocks explicit non-deepseek', () => {
    const r = resolveProvider({ DEEPSEEK_API_KEY: 'x', OPENAI_API_KEY: 'y' }, 'openai');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('multi_provider_disabled');
  });

  it('no fallback on 500 when multi-provider disabled (generate)', async () => {
    const env = { DEEPSEEK_API_KEY: 'dk', OPENAI_API_KEY: 'ok' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 500 })));
    const out = await generate(env, { messages: [{ role: 'user', content: 'hi' }] });
    expect(out.ok).toBe(false);
    expect(out.code).toBe('provider_error');
  });
});

// ── Streaming usage metering (P0) ────────────────────────────────────────────
describe('streaming usage metering', () => {
  it('records confirmed usage from a streaming response', async () => {
    const kv = makeKV();
    const env = { DEEPSEEK_API_KEY: 'dk', AUTH_KV: kv };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sseBody([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n',
      'data: [DONE]\n\n',
    ]), { status: 200 })));
    const out = await stream(env, { requestId: 's1', userId: 'u1', messages: [{ role: 'user', content: 'hi' }] });
    expect(out.ok).toBe(true);
    await out.response.text(); // consume → flush → record
    const rec = JSON.parse(kv._store.get(usageKey('s1')));
    expect(rec.confirmed).toBe(true);
    expect(rec.status).toBe('confirmed');
    expect(rec.inputTokens).toBe(5);
    expect(rec.outputTokens).toBe(3);
  });

  it('records unknown_usage (estimate, unconfirmed) when no usage chunk', async () => {
    const kv = makeKV();
    const env = { DEEPSEEK_API_KEY: 'dk', AUTH_KV: kv };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sseBody([
      'data: {"choices":[{"delta":{"content":"hello world"}}]}\n\n',
      'data: [DONE]\n\n',
    ]), { status: 200 })));
    const out = await stream(env, { requestId: 's2', userId: 'u1', messages: [{ role: 'user', content: 'hello world' }] });
    await out.response.text();
    const rec = JSON.parse(kv._store.get(usageKey('s2')));
    expect(rec.confirmed).toBe(false);
    expect(rec.status).toBe('unknown_usage');
    expect(rec.outputTokens).toBeNull();
    expect(rec.inputTokens).toBeGreaterThan(0);
  });

  it('handles SSE events split across arbitrary chunks', async () => {
    const kv = makeKV();
    const env = { DEEPSEEK_API_KEY: 'dk', AUTH_KV: kv };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sseBody([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":7,"comple',
      'tion_tokens":2,"total_tokens":9}}\n\ndata: [DONE]\n\n',
    ]), { status: 200 })));
    const out = await stream(env, { requestId: 's3', userId: 'u1', messages: [{ role: 'user', content: 'hi' }] });
    await out.response.text();
    const rec = JSON.parse(kv._store.get(usageKey('s3')));
    expect(rec.confirmed).toBe(true);
    expect(rec.inputTokens).toBe(7);
    expect(rec.outputTokens).toBe(2);
  });

  it('preserves content pass-through (SSE compatibility)', async () => {
    const env = { DEEPSEEK_API_KEY: 'dk' };
    const raw = 'data: {"choices":[{"delta":{"content":"abc"}}]}\n\ndata: [DONE]\n\n';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sseBody([raw]), { status: 200 })));
    const out = await stream(env, { messages: [{ role: 'user', content: 'hi' }] });
    const text = await out.response.text();
    expect(text).toBe(raw);
  });
});

// ── Tool-call preservation across providers (P1) ─────────────────────────────
describe('tool-call preservation across providers', () => {
  const addr = '0x' + 'a'.repeat(40);

  it('Anthropic streaming preserves tool calls (not just text)', async () => {
    const env = { ANTHROPIC_API_KEY: 'ak', AUTONOMA_MULTI_PROVIDER_ENABLED: 'true' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      model: 'claude-3-5-haiku-latest',
      content: [{ type: 'tool_use', id: 't1', name: 'send', input: { to: addr, amount: 5 } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 2, output_tokens: 3 },
    }), { status: 200 })));
    const out = await stream(env, { provider: 'anthropic', messages: [{ role: 'user', content: 'send 5' }] });
    expect(out.ok).toBe(true);
    const text = await out.response.text();
    expect(text).toContain('tool_calls');
    expect(text).toContain('send');
    expect(text).toContain(addr);
  });

  it('OpenAI-compatible normalize preserves tool_calls (already covered; smoke)', async () => {
    const env = { OPENAI_API_KEY: 'ok', AUTONOMA_MULTI_PROVIDER_ENABLED: 'true' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      model: 'gpt-4o-mini',
      choices: [{ message: { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'balance', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200 })));
    const out = await generate(env, { provider: 'openai', messages: [{ role: 'user', content: 'balance' }] });
    expect(out.ok).toBe(true);
    expect(out.result.toolCalls[0].name).toBe('balance');
  });
});

// ── Usage ledger concurrency & provenance (P1) ───────────────────────────────
describe('usage ledger: concurrency & provenance', () => {
  it('detects requestId reuse across different users', async () => {
    const kv = makeKV();
    const env = { AUTH_KV: kv };
    await recordUsage(env, { requestId: 'r1', userId: 'u1', provider: 'deepseek', model: 'x', inputTokens: 1, outputTokens: 1 });
    const r2 = await recordUsage(env, { requestId: 'r1', userId: 'u2', provider: 'deepseek', model: 'x', inputTokens: 1, outputTokens: 1 });
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe('requestId_reused_by_other_user');
  });

  it('preserves null (unknown) token counts — never a confirmed zero', async () => {
    const kv = makeKV();
    const env = { AUTH_KV: kv };
    await recordUsage(env, { requestId: 'n1', userId: 'u1', provider: 'deepseek', model: 'x', inputTokens: null, outputTokens: null, confirmed: false, status: 'unknown_usage' });
    const rec = JSON.parse(kv._store.get(usageKey('n1')));
    expect(rec.inputTokens).toBeNull();
    expect(rec.outputTokens).toBeNull();
    expect(rec.confirmed).toBe(false);
    expect(rec.estimatedProviderCost).toBeNull();
  });

  it('returns no_kv when the KV binding is missing', async () => {
    const r = await recordUsage({}, { requestId: 'r', provider: 'deepseek', model: 'x', inputTokens: 1, outputTokens: 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no_kv');
  });
});
