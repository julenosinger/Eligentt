/**
 * Autonoma 3.0.2 — AI Provider HTTP 502 root-cause fix.
 * Behavioral tests for the error taxonomy + safe runtime diagnostics.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

function makeKV(records = {}) {
  const store = new Map(Object.entries(records));
  return {
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => { store.set(k, v); },
    delete: async (k) => { store.delete(k); },
    _store: store,
  };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const TOKEN = 'valid-token-0123456789abcdef0123456789abcdef';
function makeEnv(over = {}) {
  return Object.assign({
    DEEPSEEK_API_KEY: 'dk-secret',
    AUTH_KV: makeKV({
      ['session:' + TOKEN]: JSON.stringify({ userId: 'u1', email: 'a@b.com' }),
      'user:a@b.com': JSON.stringify({ circleWalletId: 'wallet-a', circleWalletAddress: '0xAAA' }),
    }),
    ALLOWED_ORIGINS: 'https://elligentttest.pages.dev',
  }, over);
}
function makeReq(body) {
  return {
    headers: { get: (h) => (h === 'Authorization' ? 'Bearer ' + TOKEN : (h === 'Origin' ? 'https://elligentttest.pages.dev' : '')) },
    json: async () => body || { messages: [{ role: 'user', content: 'hello' }] },
  };
}

async function post(env, body) {
  const { onRequestPost } = await import('../functions/api/autonoma2/chat.js');
  const resp = await onRequestPost({ request: makeReq(body), env });
  const text = await resp.text();
  return { status: resp.status, text };
}

// ── Error taxonomy ───────────────────────────────────────────────────────────
describe('AI provider error taxonomy (HTTP status mapping)', () => {
  it('maps upstream 401 → auth_error → 502', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 })));
    const r = await post(makeEnv());
    expect(r.status).toBe(502);
    expect(r.text).toContain('auth_error');
  });

  it('maps upstream 403 → auth_error → 502', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })));
    const r = await post(makeEnv());
    expect(r.status).toBe(502);
    expect(r.text).toContain('auth_error');
  });

  it('maps upstream 429 → rate_limited → 429 (not 502)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })));
    const r = await post(makeEnv());
    expect(r.status).toBe(429);
    expect(r.text).toContain('rate_limited');
  });

  it('maps upstream 500 → provider_error → 502', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const r = await post(makeEnv());
    expect(r.status).toBe(502);
    expect(r.text).toContain('provider_error');
  });

  it('maps a missing DeepSeek key (multi-provider ON, explicit provider) → provider_not_configured → 503', async () => {
    const r = await post(makeEnv({ DEEPSEEK_API_KEY: undefined, AUTONOMA_MULTI_PROVIDER_ENABLED: 'true' }), { messages: [{ role: 'user', content: 'hello' }], provider: 'deepseek' });
    expect(r.status).toBe(503);
    expect(r.text).toContain('provider_not_configured');
  });

  it('maps a missing DeepSeek key (multi-provider OFF) → no_provider → 503', async () => {
    const r = await post(makeEnv({ DEEPSEEK_API_KEY: undefined, AUTONOMA_MULTI_PROVIDER_ENABLED: undefined }), { messages: [{ role: 'user', content: 'hello' }], provider: 'deepseek' });
    expect(r.status).toBe(503);
    expect(r.text).toContain('no_provider');
  });

  it('maps network failure → network_error → 502', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { const e = new Error('ECONNREFUSED'); e.name = 'TypeError'; throw e; }));
    const r = await post(makeEnv());
    expect(r.status).toBe(502);
    expect(r.text).toContain('network_error');
  });

  it('maps a malformed (non-JSON) upstream response → malformed_response → 502', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>not json</html>', { status: 200 })));
    const r = await post(makeEnv());
    expect(r.status).toBe(502);
    expect(r.text).toContain('malformed_response');
  });

  it('maps timeout → 504 (AbortError)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }));
    const r = await post(makeEnv());
    expect(r.status).toBe(504);
    expect(r.text).toContain('timeout');
  });
});

// ── Safe structured diagnostics ──────────────────────────────────────────────
describe('safe runtime diagnostics (no sensitive data leakage)', () => {
  it('logs a structured key=value failure line with the internal code + upstream status', async () => {
    const logs = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')); });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 })));

    const r = await post(makeEnv());
    expect(r.status).toBe(502);

    const line = logs.find((l) => l.includes('autonoma_ai_failure'));
    expect(line).toBeTruthy();
    expect(line).toContain('provider=deepseek');
    expect(line).toContain('stage=upstream');
    expect(line).toContain('code=auth_error');
    expect(line).toContain('upstream_status=401');
    expect(line).toContain('request_id=');
    expect(line).toContain('duration_ms=');
  });

  it('never logs the API key, prompt, or raw provider body', async () => {
    const logs = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')); });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'invalid api key: dk-secret' } }), { status: 401 })));

    await post(makeEnv({ DEEPSEEK_API_KEY: 'dk-secret' }));
    const line = logs.find((l) => l.includes('autonoma_ai_failure'));
    expect(line).toBeTruthy();
    expect(line).not.toContain('dk-secret');       // key value never logged
    expect(line).not.toContain('invalid api key');  // raw body never logged
    expect(line).not.toContain('hello');            // prompt never logged
  });

  it('does not throw when console is unavailable', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => { throw new Error('no console'); });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 401 })));
    const r = await post(makeEnv()); // must not throw
    expect(r.status).toBe(502);
  });
});

// ── Success path (provider actually invoked, valid SSE) ─────────────────────
describe('provider success path', () => {
  it('returns a valid SSE text response for DeepSeek', async () => {
    let called = false;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/chat/completions')) {
        called = true;
        return new Response(JSON.stringify({ choices: [{ message: { content: 'Hi there!' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2 } }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }));
    const r = await post(makeEnv());
    expect(r.status).toBe(200);
    expect(called).toBe(true);
    expect(r.text).toContain('Hi there!');
    expect(r.text).toContain('[DONE]');
  });

  it('supports OpenAI when multi-provider is enabled', async () => {
    let url = '';
    vi.stubGlobal('fetch', vi.fn(async (u) => {
      url = String(u);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'from openai' }, finish_reason: 'stop' }] }), { status: 200 });
    }));
    const env = makeEnv({ OPENAI_API_KEY: 'ok', AUTONOMA_MULTI_PROVIDER_ENABLED: 'true' });
    const { onRequestPost } = await import('../functions/api/autonoma2/chat.js');
    const resp = await onRequestPost({ request: { headers: { get: (h) => (h === 'Authorization' ? 'Bearer ' + TOKEN : '') }, json: async () => ({ messages: [{ role: 'user', content: 'hi' }], provider: 'openai' }) }, env });
    expect(resp.status).toBe(200);
    expect(url).toContain('api.openai.com');
    expect(await resp.text()).toContain('from openai');
  });

  it('supports Claude (Anthropic) when multi-provider is enabled', async () => {
    let url = '';
    vi.stubGlobal('fetch', vi.fn(async (u) => {
      url = String(u);
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'from claude' }], stop_reason: 'end_turn' }), { status: 200 });
    }));
    const env = makeEnv({ ANTHROPIC_API_KEY: 'ok', AUTONOMA_MULTI_PROVIDER_ENABLED: 'true' });
    const { onRequestPost } = await import('../functions/api/autonoma2/chat.js');
    const resp = await onRequestPost({ request: { headers: { get: (h) => (h === 'Authorization' ? 'Bearer ' + TOKEN : '') }, json: async () => ({ messages: [{ role: 'user', content: 'hi' }], provider: 'anthropic' }) }, env });
    expect(resp.status).toBe(200);
    expect(url).toContain('api.anthropic.com');
    expect(await resp.text()).toContain('from claude');
  });
});
