/**
 * Autonoma 3.0 — Unified App Awareness & Read-Only Intelligence.
 * Behavioral tests for the read-only capability layer:
 *  - App Capability Manifest
 *  - Read-only tool executor (server-side, per-user ownership)
 *  - Trusted tool registry (read tools + JSON Schema validity)
 *  - Bounded read-tool orchestration loop (chat.js onRequestPost)
 *  - Frontend client-read bridge (contacts / queue / invoices / paymentLinks)
 *  - Anthropic tool_result conversion (provider compatibility)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  APP_CAPABILITIES, SERVER_READ_TOOLS, CLIENT_READ_TOOLS, READ_TOOL_IDS,
  isReadTool, getModule, capabilitySummary,
} from '../functions/api/_ai/capabilities.js';
import { executeReadTool, isServerReadTool, isClientReadTool } from '../functions/api/autonoma2/readTools.js';
import { TRUSTED_TOOLS, TRUSTED_TOOL_NAMES, resolveAuthorizedTools, resolveTools } from '../functions/api/_ai/trustedTools.js';
import { getProvider } from '../functions/api/_ai/providerRegistry.js';

const root = path.resolve(__dirname, '..');

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

// ── 1. App Capability Manifest ────────────────────────────────────────────────
describe('App Capability Manifest', () => {
  it('declares Recipients/Contacts as the P0 module with read tools', () => {
    const m = getModule('recipients');
    expect(m).toBeTruthy();
    expect(m.implemented).toBe(true);
    expect(m.readTools).toEqual(['contacts.list', 'contacts.search', 'contacts.get']);
  });

  it('distinguishes server-read vs client-read tools', () => {
    expect(SERVER_READ_TOOLS).toEqual(['balance', 'history', 'wallet_info']);
    expect(CLIENT_READ_TOOLS).toContain('contacts.list');
    expect(CLIENT_READ_TOOLS).toContain('queue.list');
    expect(CLIENT_READ_TOOLS).toContain('invoices.list');
    expect(CLIENT_READ_TOOLS).toContain('paymentLinks.list');
    // No overlap — a tool is either server-read or client-read, never both.
    for (const t of SERVER_READ_TOOLS) expect(CLIENT_READ_TOOLS).not.toContain(t);
  });

  it('isReadTool recognizes read tools but not write tools', () => {
    expect(isReadTool('balance')).toBe(true);
    expect(isReadTool('contacts.list')).toBe(true);
    expect(isReadTool('send')).toBe(false);
    expect(isReadTool('swap')).toBe(false);
  });

  it('capabilitySummary exposes metadata (no secrets)', () => {
    const s = capabilitySummary();
    expect(Array.isArray(s)).toBe(true);
    const ids = s.map((x) => x.id);
    expect(ids).toContain('recipients');
    const json = JSON.stringify(s);
    expect(json).not.toMatch(/api[_-]?key/i);
    expect(json).not.toMatch(/private[_-]?key/i);
  });

  it('marks unimplemented modules as metadata-only (never fake data)', () => {
    for (const m of APP_CAPABILITIES.modules) {
      if (m.implemented === false) {
        expect(Array.isArray(m.readTools || [])).toBe(true);
        expect(m.purpose).toBeTruthy();
      }
    }
  });
});

// ── 2. Trusted tool registry (read tools + JSON Schema) ──────────────────────
describe('trusted tool registry — read tools', () => {
  it('registers contacts + queue + invoices + paymentLinks read tools', () => {
    for (const n of ['contacts.list', 'contacts.search', 'contacts.get', 'queue.list', 'invoices.list', 'paymentLinks.list']) {
      expect(TRUSTED_TOOL_NAMES.has(n)).toBe(true);
    }
  });

  it('contacts.search requires query; contacts.get requires name', () => {
    const byName = Object.fromEntries(TRUSTED_TOOLS.map((t) => [t.function.name, t]));
    expect(byName['contacts.search'].function.parameters.required).toEqual(['query']);
    expect(byName['contacts.get'].function.parameters.required).toEqual(['name']);
    expect(byName['contacts.list'].function.parameters.required).toBeUndefined();
  });

  it('read tools are NOT classified as write tools (read-only enforcement)', () => {
    const r = resolveAuthorizedTools({ userId: 'u1' }, undefined);
    expect(r.writeTools).toContain('send');
    expect(r.writeTools).toContain('swap');
    for (const rt of READ_TOOL_IDS) {
      expect(r.writeTools).not.toContain(rt);
    }
  });

  it('rejects unauthenticated and unknown tool names', () => {
    expect(resolveAuthorizedTools(null, undefined).ok).toBe(false);
    const r = resolveAuthorizedTools({ userId: 'u1' }, [{ function: { name: 'contacts.drop' } }]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('unauthorized_tool');
  });

  it('resolveTools returns server-owned definitions, never client params', () => {
    const r = resolveTools([{ function: { name: 'contacts.search', description: 'HACK', parameters: { type: 'object', properties: { evil: { type: 'string' } }, required: ['evil'] } } }]);
    expect(r.ok).toBe(true);
    const c = r.tools.find((t) => t.function.name === 'contacts.search');
    expect(c.function.description).not.toContain('HACK');
    expect(c.function.parameters.properties).not.toHaveProperty('evil');
  });
});

// ── 3. Read-only tool executor (server-side) ─────────────────────────────────
describe('read-tool executor', () => {
  it('client-read tools return a clientSide marker (never executed server-side)', async () => {
    const r = await executeReadTool('contacts.list', {}, { userId: 'u1', email: 'a@b.com' }, { AUTH_KV: makeKV() });
    expect(r.clientSide).toBe(true);
    expect(r.tool).toBe('contacts.list');
  });

  it('isServerReadTool / isClientReadTool partition correctly', () => {
    expect(isServerReadTool('balance')).toBe(true);
    expect(isServerReadTool('contacts.list')).toBe(false);
    expect(isClientReadTool('contacts.list')).toBe(true);
    expect(isClientReadTool('send')).toBe(false);
  });

  it('balance resolves ONLY the authenticated user wallet (ownership isolation)', async () => {
    const kv = makeKV({
      'user:a@b.com': JSON.stringify({ circleWalletId: 'wallet-a', circleWalletAddress: '0xAAA' }),
      'user:c@d.com': JSON.stringify({ circleWalletId: 'wallet-c', circleWalletAddress: '0xCCC' }),
    });
    const env = { AUTH_KV: kv, CIRCLE_API_KEY: 'ck' };
    let fetchedUrl = null;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      fetchedUrl = url;
      return new Response(JSON.stringify({ data: { tokenBalances: [{ token: { symbol: 'USDC' }, amount: '500' }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));

    const r = await executeReadTool('balance', {}, { userId: 'uA', email: 'a@b.com' }, env);
    expect(r.ok).toBe(true);
    expect(fetchedUrl).toContain('wallet-a');
    expect(fetchedUrl).not.toContain('wallet-c');
    expect(r.data.balances).toHaveLength(1);
  });

  it('balance with no wallet returns needsProvision (no fabricated balance)', async () => {
    const kv = makeKV({ 'user:a@b.com': JSON.stringify({}) });
    const env = { AUTH_KV: kv, CIRCLE_API_KEY: 'ck' };
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('should not fetch'); }));
    const r = await executeReadTool('balance', {}, { userId: 'uA', email: 'a@b.com' }, env);
    expect(r.ok).toBe(true);
    expect(r.data.needsProvision).toBe(true);
    expect(r.data.balances).toEqual([]);
  });

  it('unknown tool is rejected (never executed)', async () => {
    const r = await executeReadTool('evil_tool', {}, { userId: 'u1', email: 'a@b.com' }, { AUTH_KV: makeKV() });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('unknown_read_tool');
  });

  it('wallet_info returns only the user identity (no secrets)', async () => {
    const kv = makeKV({ 'user:a@b.com': JSON.stringify({ circleWalletId: 'wallet-a', circleWalletAddress: '0xAAA' }) });
    const r = await executeReadTool('wallet_info', {}, { userId: 'uA', email: 'a@b.com' }, { AUTH_KV: kv });
    expect(r.ok).toBe(true);
    expect(r.data.walletId).toBe('wallet-a');
    expect(r.data.needsProvision).toBe(false);
    expect(JSON.stringify(r.data)).not.toMatch(/api[_-]?key/i);
  });
});

// ── 4. Bounded read-tool orchestration loop (chat.js onRequestPost) ──────────
describe('bounded read-tool orchestration loop', () => {
  const TOKEN = 'valid-token-0123456789abcdef0123456789abcdef';
  function validSessionEnv() {
    return {
      DEEPSEEK_API_KEY: 'dk',
      AUTH_KV: makeKV({
        ['session:' + TOKEN]: JSON.stringify({ userId: 'u1', email: 'a@b.com' }),
        'user:a@b.com': JSON.stringify({ circleWalletId: 'wallet-a', circleWalletAddress: '0xAAA' }),
      }),
      ALLOWED_ORIGINS: 'https://elligentttest.pages.dev',
    };
  }
  function makeReq(body) {
    return {
      headers: { get: (h) => (h === 'Authorization' ? 'Bearer ' + TOKEN : (h === 'Origin' ? 'https://elligentttest.pages.dev' : '')) },
      json: async () => body || { messages: [{ role: 'user', content: 'hello' }] },
    };
  }

  it('executes a server-read tool and returns a grounded final answer', async () => {
    let chatCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/chat/completions')) {
        chatCalls++;
        if (chatCalls === 1) {
          return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'balance', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }), { status: 200 });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: 'Your Circle Agent Wallet holds 500 USDC.', finish_reason: 'stop' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
      }
      if (String(url).includes('/wallets/')) {
        return new Response(JSON.stringify({ data: { tokenBalances: [{ token: { symbol: 'USDC' }, amount: '500' }] } }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }));

    const { onRequestPost } = await import('../functions/api/autonoma2/chat.js');
    const resp = await onRequestPost({ request: makeReq({ messages: [{ role: 'user', content: 'what is my balance?' }] }), env: validSessionEnv() });
    const text = await resp.text();
    expect(resp.status).toBe(200);
    expect(text).toContain('[DONE]');
    expect(text).toContain('Circle Agent Wallet');
    expect(chatCalls).toBe(2); // tool call → result → final answer
  });

  it('returns client-read tool calls to the frontend without executing them', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/chat/completions')) {
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'contacts.list', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }));

    const { onRequestPost } = await import('../functions/api/autonoma2/chat.js');
    const resp = await onRequestPost({ request: makeReq({ messages: [{ role: 'user', content: 'mostre meus contatos' }] }), env: validSessionEnv() });
    const text = await resp.text();
    expect(resp.status).toBe(200);
    expect(text).toContain('tool_calls');
    expect(text).toContain('contacts.list');
    expect(text).not.toContain('"content"'); // no final text — the client bridges it
  });

  it('rejects unauthorized tool names before execution', async () => {
    const { onRequestPost } = await import('../functions/api/autonoma2/chat.js');
    const resp = await onRequestPost({ request: makeReq({ messages: [{ role: 'user', content: 'hi' }], tools: [{ function: { name: 'contacts.drop' } }] }), env: validSessionEnv() });
    expect(resp.status).toBe(400);
    const text = await resp.text();
    expect(text).toContain('unauthorized_tool');
  });
});

// ── 5. Anthropic provider compatibility (tool_result round-trip) ─────────────
describe('Anthropic tool-result compatibility', () => {
  it('converts assistant tool_calls + tool results to Anthropic content blocks', () => {
    const anthropic = getProvider('anthropic');
    const req = anthropic.buildRequest({
      model: 'claude-3-5-haiku-latest',
      messages: [
        { role: 'user', content: 'balance' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'balance', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: JSON.stringify({ needsProvision: false, balances: [] }) },
      ],
      tools: [{ type: 'function', function: { name: 'balance', description: 'd', parameters: { type: 'object', properties: {} } } }],
      stream: false,
      toolChoice: 'auto',
    });
    const msgs = req.body.messages;
    expect(msgs).toHaveLength(3);
    // assistant message carries a tool_use block
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].content[0].type).toBe('tool_use');
    expect(msgs[1].content[0].name).toBe('balance');
    // tool result message carries a tool_result block
    expect(msgs[2].role).toBe('user');
    expect(msgs[2].content[0].type).toBe('tool_result');
    expect(msgs[2].content[0].tool_use_id).toBe('call_1');
  });
});

// ── 6. Frontend client-read bridge (index.html) ──────────────────────────────
describe('frontend client-read bridge', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

  it('registers the client-read tool allowlist', () => {
    for (const n of ['contacts.list', 'contacts.search', 'contacts.get', 'queue.list', 'invoices.list', 'paymentLinks.list']) {
      expect(html).toContain("'" + n + "'");
    }
  });

  it('bridges contacts from localStorage / RecipientResolver (no fabrication)', () => {
    expect(html).toContain('_autReadSurface');
    expect(html).toContain('RecipientResolver.all');
    expect(html).toContain("Store.load('contacts'");
    expect(html).toContain('Não encontrei nenhum contato');
  });

  it('handles partial-name / address search (contacts.search)', () => {
    expect(html).toContain('c.addr');
    expect(html).toContain("indexOf(q) !== -1");
  });

  it('keeps write-tool execution path intact (send/swap/bridge)', () => {
    expect(html).toContain("case 'send':");
    expect(html).toContain("case 'swap':");
    expect(html).toContain("case 'bridge':");
    expect(html).toContain('AgentCapabilityRouter.createSurface');
  });

  it('never executes model-supplied code (no eval/new Function in the bridge)', () => {
    const fn = html.slice(html.indexOf('function _autReadSurface'), html.indexOf('async function _autAiProcess'));
    expect(fn).not.toContain('eval(');
    expect(fn).not.toContain('new Function');
  });
});
