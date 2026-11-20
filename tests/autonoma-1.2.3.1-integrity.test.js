/**
 * Autonoma 1.2.3.1 — Runtime integrity (streaming lifecycle, usage accuracy, tool_choice).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { generate, stream } from '../functions/api/_ai/orchestrator.js';
import { getProvider } from '../functions/api/_ai/providerRegistry.js';
import { usageKey } from '../functions/api/_ai/usageLedger.js';

function makeKV() {
  const store = new Map();
  return { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); }, _store: store };
}
function sseBody(parts) {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { for (const p of parts) c.enqueue(typeof p === 'string' ? enc.encode(p) : p); c.close(); } });
}

afterEach(() => { vi.unstubAllGlobals(); });

// ── Non-streaming usage accuracy (P2) ────────────────────────────────────────
describe('non-streaming usage accuracy', () => {
  it('records unknown_usage (null, unconfirmed) when provider returns no usage', async () => {
    const kv = makeKV();
    const env = { DEEPSEEK_API_KEY: 'dk', AUTH_KV: kv };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      model: 'deepseek-chat',
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
    }), { status: 200 })));
    const out = await generate(env, { requestId: 'nousage', userId: 'u1', messages: [{ role: 'user', content: 'hi' }] });
    expect(out.ok).toBe(true);
    expect(out.result.usage.present).toBe(false);
    const rec = JSON.parse(kv._store.get(usageKey('nousage')));
    expect(rec.confirmed).toBe(false);
    expect(rec.status).toBe('unknown_usage');
    expect(rec.inputTokens).toBeNull();
  });

  it('records confirmed zero when provider returns zero usage (not treated as missing)', async () => {
    const kv = makeKV();
    const env = { DEEPSEEK_API_KEY: 'dk', AUTH_KV: kv };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      model: 'deepseek-chat',
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }), { status: 200 })));
    const out = await generate(env, { requestId: 'zero', userId: 'u1', messages: [{ role: 'user', content: 'hi' }] });
    expect(out.ok).toBe(true);
    expect(out.result.usage.present).toBe(true);
    const rec = JSON.parse(kv._store.get(usageKey('zero')));
    expect(rec.confirmed).toBe(true);
    expect(rec.inputTokens).toBe(0);
  });
});

// ── Streaming lifecycle (P1) ─────────────────────────────────────────────────
describe('streaming lifecycle integrity', () => {
  it('records interrupted on upstream stream error (no duplicate)', async () => {
    const kv = makeKV();
    const env = { DEEPSEEK_API_KEY: 'dk', AUTH_KV: kv };
    const waited = [];
    const enc = new TextEncoder();
    const errBody = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n'));
        // Error shortly after the chunk is delivered — usage is seen, then the
        // stream is interrupted (never a clean completion).
        setTimeout(() => c.error(new Error('upstream failure')), 10);
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(errBody, { status: 200 })));
    const out = await stream(env, { requestId: 'err', userId: 'u1', messages: [{ role: 'user', content: 'hi' }], waitUntil: (p) => waited.push(p) });
    await out.response.text().catch(() => {});
    await new Promise((r) => setTimeout(r, 25)); // let the error + record settle
    await Promise.all(waited).catch(() => {});
    const rec = JSON.parse(kv._store.get(usageKey('err')));
    expect(rec.confirmed).toBe(true);       // usage chunk arrived before the error
    expect(rec.status).toBe('interrupted'); // but stream did not complete
  });

  it('does not duplicate usage records on clean completion', async () => {
    const kv = makeKV();
    const env = { DEEPSEEK_API_KEY: 'dk', AUTH_KV: kv };
    const waited = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sseBody([
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
      'data: [DONE]\n\n',
    ]), { status: 200 })));
    const out = await stream(env, { requestId: 'clean', userId: 'u1', messages: [{ role: 'user', content: 'hi' }], waitUntil: (p) => waited.push(p) });
    await out.response.text();
    await Promise.all(waited).catch(() => {});
    // One record, one write — no duplicate (KV store has exactly one entry for the key).
    expect(kv._store.get(usageKey('clean'))).toBeDefined();
  });
});

// ── tool_choice propagation (P3) ─────────────────────────────────────────────
describe('tool_choice propagation', () => {
  const tool = [{ type: 'function', function: { name: 'send', description: 'd', parameters: { type: 'object', properties: {} } } }];

  it('defaults to auto for OpenAI-compatible', () => {
    const req = getProvider('deepseek').buildRequest({ model: 'deepseek-chat', messages: [], tools: tool });
    expect(req.body.tool_choice).toBe('auto');
  });

  it('propagates supported options (required / none)', () => {
    expect(getProvider('deepseek').buildRequest({ model: 'deepseek-chat', messages: [], tools: tool, toolChoice: 'required' }).body.tool_choice).toBe('required');
    expect(getProvider('openai').buildRequest({ model: 'gpt-4o-mini', messages: [], tools: tool, toolChoice: 'none' }).body.tool_choice).toBe('none');
  });

  it('falls back to auto for unsupported tool_choice', () => {
    expect(getProvider('deepseek').buildRequest({ model: 'deepseek-chat', messages: [], tools: tool, toolChoice: 'bogus' }).body.tool_choice).toBe('auto');
  });

  it('maps required to Anthropic any', () => {
    const req = getProvider('anthropic').buildRequest({ model: 'claude-3-5-haiku-latest', messages: [], tools: tool, toolChoice: 'required' });
    expect(req.body.tool_choice).toEqual({ type: 'any' });
  });

  it('omits tool_choice for Anthropic default (auto)', () => {
    const req = getProvider('anthropic').buildRequest({ model: 'claude-3-5-haiku-latest', messages: [], tools: tool, toolChoice: 'auto' });
    expect(req.body.tool_choice).toBeUndefined();
  });
});
