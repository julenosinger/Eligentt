/**
 * Autonoma 1.2.3 — Final security hardening (auth fail-closed, SSE boundaries,
 * JSON Schema, tool authorization, telemetry observability).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { stream } from '../functions/api/_ai/orchestrator.js';
import { usageKey } from '../functions/api/_ai/usageLedger.js';
import { resolveAuthorizedTools, resolveTools, TRUSTED_TOOLS, TRUSTED_TOOL_NAMES } from '../functions/api/_ai/trustedTools.js';

function makeKV() {
  const store = new Map();
  return { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); }, _store: store };
}
function sseBody(parts) {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { for (const p of parts) c.enqueue(typeof p === 'string' ? enc.encode(p) : p); c.close(); } });
}

afterEach(() => { vi.unstubAllGlobals(); });

// ── Auth fail-closed (P0) ────────────────────────────────────────────────────
describe('production auth fail-closed', () => {
  it('chat.js has no DEV_AUTH_BYPASS', () => {
    const s = fs.readFileSync(path.resolve(__dirname, '../functions/api/autonoma2/chat.js'), 'utf8');
    expect(s).not.toContain('DEV_AUTH_BYPASS');
  });
  it('chat.js fails closed when AUTH_KV missing', () => {
    const s = fs.readFileSync(path.resolve(__dirname, '../functions/api/autonoma2/chat.js'), 'utf8');
    const fn = s.slice(s.indexOf('async function requireSession'), s.indexOf('function errSSE'));
    expect(fn).toContain('Authentication service unavailable');
    expect(fn).not.toContain('DEV_AUTH_BYPASS');
    expect(fn).not.toContain("return { ok: true, user: null }");
  });
});

// ── SSE CRLF split + completion lifecycle (P1) ───────────────────────────────
describe('SSE CRLF split & completion lifecycle', () => {
  it('handles CRLF split between chunks', async () => {
    const kv = makeKV();
    const env = { DEEPSEEK_API_KEY: 'dk', AUTH_KV: kv };
    const enc = new TextEncoder();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}\r'));
        c.enqueue(enc.encode('\n\r\ndata: [DONE]\r\n\r\n'));
        c.close();
      },
    }), { status: 200 })));
    const out = await stream(env, { requestId: 'crlf-split', userId: 'u1', messages: [{ role: 'user', content: 'hi' }] });
    await out.response.text();
    const rec = JSON.parse(kv._store.get(usageKey('crlf-split')));
    expect(rec.inputTokens).toBe(8);
    expect(rec.status).toBe('confirmed'); // [DONE] seen
  });

  it('records interrupted when usage present but stream truncated (no DONE)', async () => {
    const kv = makeKV();
    const env = { DEEPSEEK_API_KEY: 'dk', AUTH_KV: kv };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sseBody([
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
    ]), { status: 200 })));
    const out = await stream(env, { requestId: 'interrupted', userId: 'u1', messages: [{ role: 'user', content: 'hi' }] });
    await out.response.text();
    const rec = JSON.parse(kv._store.get(usageKey('interrupted')));
    expect(rec.confirmed).toBe(true);   // provider reported usage
    expect(rec.status).toBe('interrupted'); // but no clean completion
  });

  it('preserves original bytes through CRLF split', async () => {
    const env = { DEEPSEEK_API_KEY: 'dk' };
    const part1 = 'data: {"choices":[{"delta":{"content":"hello"}}]}\r';
    const part2 = '\n\r\ndata: [DONE]\r\n\r\n';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sseBody([part1, part2]), { status: 200 })));
    const out = await stream(env, { messages: [{ role: 'user', content: 'hi' }] });
    expect(await out.response.text()).toBe(part1 + part2);
  });

  it('does not crash on a large (oversized) event', async () => {
    const env = { DEEPSEEK_API_KEY: 'dk' };
    const big = 'x'.repeat(5000);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sseBody(['data: ' + big + '\n\n', 'data: [DONE]\n\n']), { status: 200 })));
    const out = await stream(env, { messages: [{ role: 'user', content: 'hi' }] });
    const text = await out.response.text();
    expect(text).toContain('[DONE]');
  });
});

// ── JSON Schema validity (P1) ────────────────────────────────────────────────
describe('trusted tool JSON Schema validity', () => {
  it('all schemas are standard JSON Schema (top-level required, no per-property required)', () => {
    for (const t of TRUSTED_TOOLS) {
      const p = t.function.parameters;
      expect(p.type).toBe('object');
      expect(typeof p.properties).toBe('object');
      for (const key of Object.keys(p.properties)) {
        expect(p.properties[key]).not.toHaveProperty('required');
      }
      if (p.required) {
        expect(Array.isArray(p.required)).toBe(true);
        for (const r of p.required) expect(p.properties).toHaveProperty(r);
      }
    }
  });

  it('preserves all tool names and expected parameter names', () => {
    const byName = Object.fromEntries(TRUSTED_TOOLS.map((t) => [t.function.name, t]));
    expect(TRUSTED_TOOL_NAMES.has('send')).toBe(true);
    expect(byName.send.function.parameters.properties).toHaveProperty('to');
    expect(byName.send.function.parameters.properties).toHaveProperty('amount');
    expect(byName.send.function.parameters.required).toContain('to');
    expect(byName.swap.function.parameters.required).toEqual(['fromToken', 'toToken', 'amount']);
  });
});

// ── Server-side tool authorization (P1) ──────────────────────────────────────
describe('server-side tool authorization', () => {
  it('resolveAuthorizedTools rejects unauthenticated callers', () => {
    const r = resolveAuthorizedTools(null, undefined);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unauthenticated');
  });

  it('resolveAuthorizedTools returns tools + writeTools for an authenticated user', () => {
    const r = resolveAuthorizedTools({ userId: 'u1' }, undefined);
    expect(r.ok).toBe(true);
    expect(r.tools.length).toBeGreaterThan(0);
    expect(r.writeTools).toContain('send');
    expect(r.writeTools).toContain('swap');
    expect(r.writeTools).not.toContain('balance');
  });

  it('resolveAuthorizedTools still rejects unknown client tools', () => {
    const r = resolveAuthorizedTools({ userId: 'u1' }, [{ function: { name: 'evil_tool' } }]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('unauthorized_tool');
  });

  it('resolveTools returns server-owned definitions (never client params)', () => {
    const r = resolveTools([{ function: { name: 'send', description: 'HACK', parameters: { type: 'object', properties: { evil: { type: 'string' } }, required: ['evil'] } } }]);
    expect(r.ok).toBe(true);
    const send = r.tools.find((t) => t.function.name === 'send');
    expect(send.function.description).not.toContain('HACK');
    expect(send.function.parameters.properties).not.toHaveProperty('evil');
  });
});
