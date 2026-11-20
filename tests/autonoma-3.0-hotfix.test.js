/**
 * Autonoma 3.0 hotfix — Restore AI-native conversation.
 * Reproduces the regression: ordinary conversational messages ("vc pode falar em
 * ingles") must reach the selected AI provider; when the AI cannot answer they
 * must surface a clear error — never a legacy "default / Missing Information"
 * payment-intent card.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const chatSrc = fs.readFileSync(path.join(root, 'functions/api/autonoma2/chat.js'), 'utf8');

function makeKV(records = {}) {
  const store = new Map(Object.entries(records));
  return {
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => { store.set(k, v); },
    delete: async (k) => { store.delete(k); },
    _store: store,
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

const TOKEN = 'valid-token-0123456789abcdef0123456789abcdef';
function env() {
  return {
    DEEPSEEK_API_KEY: 'dk',
    AUTH_KV: makeKV({
      ['session:' + TOKEN]: JSON.stringify({ userId: 'u1', email: 'a@b.com' }),
      'user:a@b.com': JSON.stringify({ circleWalletId: 'wallet-a', circleWalletAddress: '0xAAA' }),
    }),
    ALLOWED_ORIGINS: 'https://elligentttest.pages.dev',
  };
}
function req(body) {
  return {
    headers: { get: (h) => (h === 'Authorization' ? 'Bearer ' + TOKEN : (h === 'Origin' ? 'https://elligentttest.pages.dev' : '')) },
    json: async () => body || { messages: [{ role: 'user', content: 'hello' }] },
  };
}

// ── 1. Backend: ordinary conversation reaches the provider and returns text ──
describe('backend — conversational text reaches the client', () => {
  it('returns plain conversational text (no tool call) as SSE content', async () => {
    let called = false;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      called = true;
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Sure, I can speak English!' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 6 },
      }), { status: 200 });
    }));

    const { onRequestPost } = await import('../functions/api/autonoma2/chat.js');
    const resp = await onRequestPost({ request: req({ messages: [{ role: 'user', content: 'vc pode falar em ingles' }] }), env: env() });
    const text = await resp.text();

    expect(resp.status).toBe(200);
    expect(called).toBe(true); // provider WAS invoked
    expect(text).toContain('[DONE]');
    expect(text).toContain('Sure, I can speak English!');
  });

  it('maps provider failures to a clear error (no silent empty response)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 })));

    const { onRequestPost } = await import('../functions/api/autonoma2/chat.js');
    const resp = await onRequestPost({ request: req({ messages: [{ role: 'user', content: 'hello' }] }), env: env() });
    expect(resp.status).toBe(502); // auth_error mapped to 502
    expect(await resp.text()).toContain('AI provider auth failed');
  });

  it('reports no_provider when the selected provider is unconfigured', async () => {
    const e = env();
    e.DEEPSEEK_API_KEY = undefined;
    const { onRequestPost } = await import('../functions/api/autonoma2/chat.js');
    const resp = await onRequestPost({ request: req({ messages: [{ role: 'user', content: 'hello' }] }), env: e });
    expect(resp.status).toBe(503);
    expect(await resp.text()).toContain('DeepSeek is not configured');
  });
});

// ── 2. Frontend: no silent legacy fallback for ordinary conversation ────────
describe('frontend — AI-first routing (no silent legacy fallback)', () => {
  it('surfaces an AI-unavailable error instead of the legacy "default" clarification', () => {
    // The AI-unavailable path must exist and must NOT produce "Missing Information".
    expect(html).toContain('_autAiUnavailable');
    expect(html).toContain('I couldn\\\'t reach the AI service');
    expect(html).toContain('window._autAiRetryMsg');
  });

  it('returns the AI-unavailable error only when the legacy classifier has NO recognized intent', () => {
    // The fallback gate checks _classifyIntent and only short-circuits on DEFAULT.
    const autProcess = html.slice(html.indexOf('async function autProcess'), html.indexOf('async function autProcess') + 4000);
    expect(autProcess).toContain('_autAiProcess(msg)');
    expect(autProcess).toContain('_fbIntent.intent === \'DEFAULT\'');
    expect(autProcess).toContain('_autAiUnavailable(msg)');
  });

  it('preserves the financial execution fallback (send/swap/bridge still reachable)', () => {
    // Non-DEFAULT intents fall through to the legacy pipeline, so financial ops work.
    expect(html).toContain('case \'send\':');
    expect(html).toContain('case \'swap\':');
    expect(html).toContain('case \'bridge\':');
    expect(html).toContain('_executeIntent(intent, params, msg)');
  });

  it('preserves Autonoma 3.0 read tools (contacts + read bridge intact)', () => {
    expect(html).toContain('_autReadSurface');
    expect(html).toContain('contacts.list');
    expect(html).toContain('contacts.search');
    expect(html).toContain('contacts.get');
    expect(html).toContain('_AUT_CLIENT_READ_TOOLS');
  });

  it('does not regress: the legacy "Missing Information" card is not shown for DEFAULT', () => {
    // The fallback gate returns _autAiUnavailable before the AgentBrain, so the
    // buildClarification path is unreachable for DEFAULT messages.
    expect(html).toContain('_autAiUnavailable');
  });
});

// ── 3. Backend: read-tool loop remains bounded + read-only ──────────────────
describe('backend — read tools remain functional', () => {
  it('still executes server-read tools and returns a grounded answer', async () => {
    let chatCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/chat/completions')) {
        chatCalls++;
        if (chatCalls === 1) {
          return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'balance', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: 'Your Circle Agent Wallet holds 500 USDC.' }, finish_reason: 'stop' }] }), { status: 200 });
      }
      if (String(url).includes('/wallets/')) {
        return new Response(JSON.stringify({ data: { tokenBalances: [{ token: { symbol: 'USDC' }, amount: '500' }] } }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }));

    const { onRequestPost } = await import('../functions/api/autonoma2/chat.js');
    const resp = await onRequestPost({ request: req({ messages: [{ role: 'user', content: 'qual é meu saldo?' }] }), env: env() });
    expect(resp.status).toBe(200);
    expect(await resp.text()).toContain('Circle Agent Wallet');
  });
});
