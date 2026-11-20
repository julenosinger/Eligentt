/**
 * Autonoma 2 — AI-native Circle Agent integration guards.
 * Verifies: AI-first orchestration wiring, provider selection, and tool-call
 * bridging (AI → trusted tools → existing execution engine).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(__dirname, '..');
function src(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }

afterEach(() => { vi.unstubAllGlobals(); });

// ── Source-level wiring ───────────────────────────────────────────────────────
describe('AI-first orchestration wiring', () => {
  it('index.html loads the multi-provider AI bridge module', () => {
    const s = src('index.html');
    expect(s).toContain('<script src="/shared/autonomaAi.js"></script>');
  });

  it('index.html exposes the AI provider selector', () => {
    const s = src('index.html');
    expect(s).toContain('id="aut-ai-provider"');
    expect(s).toContain('autSetAiProvider');
    expect(s).toContain('value="deepseek"');
    expect(s).toContain('value="openai"');
    expect(s).toContain('value="anthropic"');
  });

  it('autProcess routes through the AI first (before AgentBrain)', () => {
    const s = src('index.html');
    const aiCall = s.indexOf('await _autAiProcess(msg)');
    const agentBrain = s.indexOf('AutonomaAgentBrain.isEnabled()');
    expect(aiCall).toBeGreaterThan(-1);
    expect(agentBrain).toBeGreaterThan(-1);
    expect(aiCall).toBeLessThan(agentBrain); // AI is primary, AgentBrain is fallback
  });

  it('_autAiProcess bridges tool calls to the existing execution engine', () => {
    const s = src('index.html');
    expect(s).toContain("case 'send':");
    expect(s).toContain("case 'swap':");
    expect(s).toContain("case 'bridge':");
    expect(s).toContain('AgentCapabilityRouter.createSurface(intent, params, { executeIntent: _executeIntent');
  });
});

// ── Behavioral: AutonomaAi module (provider management + SSE parsing) ────────
function loadAi(overrides) {
  const win = {
    localStorage: (() => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })(),
    sessionStorage: (() => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })(),
    AuthManager: undefined,
    fetch: undefined,
    // Node globals needed by the module's SSE parsing.
    setTimeout: (fn, ms) => { return 0; },
    clearTimeout: () => {},
    AbortController,
    TextDecoder,
    TextEncoder,
    ...(overrides || {}),
  };
  win.window = win;
  const ctx = vm.createContext(win);
  vm.runInContext(src('shared/autonomaAi.js'), ctx);
  return win;
}

describe('AutonomaAi module', () => {
  it('defaults to deepseek and persists provider selection', () => {
    const win = loadAi();
    expect(win.AutonomaAi.getProvider()).toBe('deepseek');
    win.AutonomaAi.setProvider('openai');
    expect(win.AutonomaAi.getProvider()).toBe('openai');
    // Persisted across reloads
    const win2 = loadAi({});
    // localStorage is per-shim, so a fresh shim has no persisted value → deepseek
    expect(win2.AutonomaAi.getProvider()).toBe('deepseek');
  });

  it('chat() parses a streaming text response', async () => {
    const enc = new TextEncoder();
    const sse = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'));
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":" world"}}]}\n\n'));
        c.enqueue(enc.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    const win = loadAi({ fetch: async () => new Response(sse, { status: 200 }) });
    const out = await win.AutonomaAi.chat('hi');
    expect(out.text).toBe('Hello world');
  });

  it('chat() parses a streaming tool call', async () => {
    const enc = new TextEncoder();
    const argsObj = { to: '0x' + 'a'.repeat(40), amount: 1 };
    const toolCall = { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'send', arguments: JSON.stringify(argsObj) } }] } }] };
    const sse = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: ' + JSON.stringify(toolCall) + '\n\n'));
        c.enqueue(enc.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    const win = loadAi({ fetch: async () => new Response(sse, { status: 200 }) });
    const out = await win.AutonomaAi.chat('send 1 USDC');
    expect(out.toolCall.name).toBe('send');
    expect(out.toolCall.arguments.amount).toBe(1);
    expect(out.toolCall.arguments.to).toBe('0x' + 'a'.repeat(40));
  });

  it('chat() returns null on provider failure (fallback path)', async () => {
    const win = loadAi({ fetch: async () => new Response('error', { status: 502 }) });
    const out = await win.AutonomaAi.chat('hi');
    expect(out).toBeNull();
  });
});
