/**
 * x402 frontend client tests (state machine + storage isolation).
 * ═══════════════════════════════════════════════════════════════════════
 * The client is a browser IIFE (shared/x402Client.js). These tests execute it
 * in a Node context with minimal browser globals (localStorage / sessionStorage
 * / document / fetch) and exercise the EXPOSED state-machine API:
 *
 *   1. Discovery does not throw (regression: undeclared `_lastPrepare`).
 *   2. A blocked/503 payment is NEVER marked as submitted.
 *   3. A legitimate retry is not blocked by a previous failure.
 *   4. History is isolated per authenticated user.
 *   5. No secrets are persisted (storage only ever holds display state).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => { map.clear(); },
    _map: map,
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientSrc = readFileSync(resolve(__dirname, '../shared/x402Client.js'), 'utf8');

const localStorageMock = makeStorage();
const sessionStorageMock = makeStorage();

globalThis.localStorage = localStorageMock;
globalThis.sessionStorage = sessionStorageMock;
globalThis.document = {
  readyState: 'complete',
  getElementById: () => null,
  createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {}, querySelector: () => null, innerHTML: '' }),
  head: { appendChild() {} },
  body: { appendChild() {} },
};
globalThis.fetch = vi.fn();

// Execute the IIFE once (attaches globalThis.X402).
new Function(clientSrc)();

const X402 = globalThis.X402;

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

function statusResponse(userId) {
  return jsonResponse({ ok: true, state: 'disabled', enabled: false, user: { id: userId || 'userA' }, wallet: { provisioned: true, address: '0x' + 'ab'.repeat(20) } }, 200);
}

beforeEach(() => {
  localStorageMock.clear();
  sessionStorageMock.clear();
  X402._setUserId(null);
  X402._setLastPrepare(null);
  globalThis.document.getElementById = () => null;
  globalThis.fetch.mockReset();
  globalThis.fetch.mockImplementation(async (url) => {
    const u = String(url);
    if (u.includes('/status')) return statusResponse('userA');
    if (u.includes('/pay')) return jsonResponse({ ok: false, error: 'x402 payments disabled', code: 'x402_not_enabled' }, 503);
    if (u.includes('/discover')) return jsonResponse({ ok: true, status: 200, x402: false, resourceUrl: 'https://api.example.com/x', requirements: [] }, 200);
    if (u.includes('/prepare')) return jsonResponse({ ok: true, enabled: false, intent: { id: 'x402_i', status: 'blocked', blockedReason: 'settlement not implemented', checks: [], amountUsd: 0.01 } }, 200);
    return jsonResponse({ ok: false, error: 'not found' }, 404);
  });
});

describe('x402 client (frontend state machine)', () => {
  it('discover flow does not throw (regression: undeclared _lastPrepare)', async () => {
    globalThis.document.getElementById = (id) => (id === 'x402-url' ? { value: 'https://api.example.com/x' } : null);
    await expect(X402._discover()).resolves.toBeUndefined();
    expect(X402._getDiscovery()).toBeTruthy();
  });

  it('does not mark a blocked (503) payment as submitted', async () => {
    X402._setUserId('userA');
    X402._setLastPrepare({ data: { resourceUrl: 'https://api.example.com/x', intent: { id: 'x402_i', amountUsd: 0.01 } } });
    await X402._pay();
    expect(X402.getSubmitted()).toEqual({});
    const h = X402.getHistory();
    expect(h.length).toBe(1);
    expect(h[0].status).toBe('blocked');
  });

  it('allows a legitimate retry after a blocking failure', async () => {
    X402._setUserId('userA');
    const intent = { data: { resourceUrl: 'https://api.example.com/x', intent: { id: 'x402_i', amountUsd: 0.01 } } };
    X402._setLastPrepare(intent);
    await X402._pay();
    // retry the same intent — must NOT be blocked by the earlier failure
    X402._setLastPrepare(intent);
    await X402._pay();
    expect(X402.getSubmitted()).toEqual({});
    expect(X402.getHistory().length).toBe(2);
    expect(X402.getHistory().every((e) => e.status === 'blocked')).toBe(true);
  });

  it('isolates history per authenticated user', async () => {
    X402._setUserId('userA');
    X402._setLastPrepare({ data: { resourceUrl: 'https://api.example.com/x', intent: { id: 'x402_a', amountUsd: 0.01 } } });
    await X402._pay();
    expect(X402.getHistory().length).toBe(1);

    X402._setUserId('userB');
    expect(X402.getHistory()).toEqual([]);

    X402._setUserId('userA');
    expect(X402.getHistory().length).toBe(1);
  });

  it('never persists secrets — history holds only display fields', async () => {
    X402._setUserId('userA');
    X402._setLastPrepare({ data: { resourceUrl: 'https://api.example.com/x', intent: { id: 'x402_s', amountUsd: 0.05 } } });
    await X402._pay();
    const serialized = localStorageMock._map.get('elligentt_x402_history_v1:userA') || '[]';
    // No private key / API key / secret markers anywhere in persisted state.
    expect(serialized).not.toMatch(/privateKey|apiKey|secret|mnemonic|seed/i);
  });
});
