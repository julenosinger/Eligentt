/**
 * AUTONOMA-6B — Secure Signer Provider tests (unit + structural).
 * ═══════════════════════════════════════════════════════════════════════
 * Proves:
 *   - BrowserSigner is the DEFAULT and works unchanged (delegates to the
 *     single execution authority AgentScheduleExecutor).
 *   - CircleSigner is selectable via feature flag, FAIL-CLOSED when Circle is
 *     not configured, and NEVER silently falls back to the browser signer.
 *   - No Circle secret ever appears in client-side code.
 *   - The single broadcast authority invariant (AUTONOMA-1) is preserved:
 *     eth_sendRawTransaction remains ONLY inside shared/agentScheduleExecutor.js.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const providerSrc = fs.readFileSync(path.join(root, 'shared', 'secureSignerProvider.js'), 'utf8');
const executorSrc = fs.readFileSync(path.join(root, 'shared', 'agentScheduleExecutor.js'), 'utf8');
const srcHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function evalProvider(win) {
  const fn = new Function('window', providerSrc);
  fn.call(null, win);
  return win.SecureSignerProvider;
}

function makeWindow() {
  return {
    SecureSignerProvider: undefined,
    AUTONOMA_SIGNER_PROVIDER: undefined,
  };
}

const RCPT = '0x' + '11'.repeat(20);
const CIRCLE_ADDR = '0x' + '66'.repeat(20);

describe('AUTONOMA-6B — SecureSignerProvider (unit)', () => {
  beforeEach(() => {
    delete globalThis.AgentScheduleExecutor;
    delete globalThis.fetch;
    delete globalThis.localStorage;
    delete globalThis.window;
  });
  afterEach(() => {
    delete globalThis.AgentScheduleExecutor;
    delete globalThis.fetch;
    delete globalThis.localStorage;
  });

  it('browser is the DEFAULT provider', () => {
    const win = makeWindow();
    const p = evalProvider(win);
    expect(p.getMode()).toBe('browser');
    expect(p.isBrowserMode()).toBe(true);
    expect(p.isCircleMode()).toBe(false);
  });

  it('setMode switches browser <-> circle; invalid mode throws', () => {
    const win = makeWindow();
    const p = evalProvider(win);
    expect(p.setMode('circle')).toBe('circle');
    expect(p.isCircleMode()).toBe(true);
    expect(p.setMode('browser')).toBe('browser');
    expect(() => p.setMode('banana')).toThrow();
  });

  it('browser-mode broadcast delegates to AgentScheduleExecutor (single authority)', async () => {
    let delegated = 0;
    globalThis.AgentScheduleExecutor = {
      broadcast: async (s, pr, rawTx) => { delegated++; return '0x' + 'ab'.repeat(32); },
      nextNonce: async () => '0x0',
      waitReceipt: async () => ({ ok: true, receipt: { status: 1 } }),
    };
    const win = makeWindow();
    const p = evalProvider(win);
    const txHash = await p.broadcast({}, {}, { type: 2 });
    expect(txHash).toBe('0x' + 'ab'.repeat(32));
    expect(delegated).toBe(1);
  });

  it('browser-mode nextNonce delegates to AgentScheduleExecutor', async () => {
    globalThis.AgentScheduleExecutor = {
      broadcast: async () => '0x',
      nextNonce: async () => '0x2a',
      waitReceipt: async () => ({ ok: true }),
    };
    const win = makeWindow();
    const p = evalProvider(win);
    expect(await p.nextNonce({}, RCPT)).toBe('0x2a');
  });

  it('circle mode WITHOUT config FAILS-CLOSED (getSigner throws)', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ available: false, address: null }) });
    const win = makeWindow();
    const p = evalProvider(win);
    p.setMode('circle');
    await expect(p.getSigner()).rejects.toThrow(/not configured|unavailable/);
  });

  it('circle mode getSigner returns a remote stub with the server address (no key)', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).includes('/api/agent-signer/config')) {
        return { ok: true, json: async () => ({ available: true, address: CIRCLE_ADDR }) };
      }
      throw new Error('unexpected fetch ' + url);
    };
    const win = makeWindow();
    const p = evalProvider(win);
    p.setMode('circle');
    const signer = await p.getSigner();
    expect(signer.isRemote).toBe(true);
    expect(signer.address).toBe(CIRCLE_ADDR);
    expect(signer.privateKey).toBeUndefined();
  });

  it('circle-mode broadcast WITHOUT a structured request FAILS-CLOSED (no fallback)', async () => {
    globalThis.AgentScheduleExecutor = {
      broadcast: async () => { throw new Error('must not be called in circle mode'); },
    };
    const win = makeWindow();
    const p = evalProvider(win);
    p.setMode('circle');
    await expect(p.broadcast({}, {}, { type: 2 })).rejects.toThrow(/structured request|circle descriptor/);
  });

  it('circle-mode broadcast obtains an authorization proof then posts the structured request to the server', async () => {
    let authorizeBody = null;
    let broadcastBody = null;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/api/agent-signer/config')) {
        return { ok: true, json: async () => ({ available: true, address: CIRCLE_ADDR }) };
      }
      if (String(url).includes('/api/agent-signer/authorize')) {
        authorizeBody = JSON.parse(init.body);
        return { ok: true, json: async () => ({ ok: true, authorizationProof: 'proof.aaaa' }) };
      }
      if (String(url).includes('/api/agent-signer/broadcast')) {
        broadcastBody = JSON.parse(init.body);
        return { ok: true, json: async () => ({ ok: true, txHash: '0x' + 'cd'.repeat(32) }) };
      }
      throw new Error('unexpected fetch ' + url);
    };
    const win = makeWindow();
    const p = evalProvider(win);
    p.setMode('circle');
    const txHash = await p.broadcast({}, {}, { chainId: 5042002 }, {
      operation: 'payment',
      executionId: 'chat_1',
      circle: { type: 'transfer', tokenAddress: '0x3600000000000000000000000000000000000000', to: RCPT, amount: '1000000' },
    });
    expect(txHash).toBe('0x' + 'cd'.repeat(32));
    expect(authorizeBody.request.type).toBe('transfer');
    expect(authorizeBody.executionId).toBe('chat_1');
    expect(broadcastBody.authorizationProof).toBe('proof.aaaa');
    expect(broadcastBody.request.type).toBe('transfer');
    expect(broadcastBody.executionId).toBe('chat_1');
  });

  it('circle-mode broadcast FAILS-CLOSED when authorization is denied (no proof)', async () => {
    globalThis.AgentScheduleExecutor = {
      broadcast: async () => { throw new Error('browser fallback attempted'); },
    };
    globalThis.fetch = async (url) => {
      if (String(url).includes('/api/agent-signer/authorize')) {
        return { ok: true, json: async () => ({ ok: false, error: 'invalid_session' }) };
      }
      throw new Error('unexpected fetch ' + url);
    };
    const win = makeWindow();
    const p = evalProvider(win);
    p.setMode('circle');
    await expect(
      p.broadcast({}, {}, { chainId: 5042002 }, { circle: { type: 'transfer', tokenAddress: '0x1', to: RCPT, amount: '1' } })
    ).rejects.toThrow(/authorization denied/);
  });

  it('circle-mode broadcast propagates a server error (fail-closed, no browser fallback)', async () => {
    globalThis.AgentScheduleExecutor = {
      broadcast: async () => { throw new Error('browser fallback attempted'); },
    };
    globalThis.fetch = async (url) => {
      if (String(url).includes('/api/agent-signer/authorize')) {
        return { ok: true, json: async () => ({ ok: true, authorizationProof: 'proof.aaaa' }) };
      }
      if (String(url).includes('/api/agent-signer/broadcast')) {
        return { ok: true, json: async () => ({ ok: false, error: 'rejected by policy' }) };
      }
      throw new Error('unexpected fetch ' + url);
    };
    const win = makeWindow();
    const p = evalProvider(win);
    p.setMode('circle');
    await expect(
      p.broadcast({}, {}, { chainId: 5042002 }, { circle: { type: 'transfer', tokenAddress: '0x1', to: RCPT, amount: '1' } })
    ).rejects.toThrow(/broadcast failed/);
  });
});

describe('AUTONOMA-6B — structural invariants', () => {
  it('no Circle secret material in client-side code', () => {
    const clientFiles = [providerSrc, executorSrc, srcHtml];
    for (const src of clientFiles) {
      expect(src, 'no entity secret').not.toContain('CIRCLE_ENTITY_SECRET');
      expect(src, 'no circle api key').not.toContain('CIRCLE_API_KEY');
      expect(src, 'no entitySecret literal').not.toContain('entitySecretCiphertext');
    }
  });

  it('secureSignerProvider.js performs NO raw signing (no send/signTransaction literals)', () => {
    expect(providerSrc).not.toContain('eth_sendRawTransaction');
    expect(providerSrc).not.toContain('signer.signTransaction');
    expect(providerSrc).not.toContain('privateKey');
  });

  it('eth_sendRawTransaction remains ONLY inside agentScheduleExecutor.js (single authority)', () => {
    const sharedDir = path.join(root, 'shared');
    const files = new Set();
    for (const name of fs.readdirSync(sharedDir)) {
      if (!name.endsWith('.js')) continue;
      const c = fs.readFileSync(path.join(sharedDir, name), 'utf8');
      if (c.includes('eth_sendRawTransaction')) files.add('shared/' + name);
    }
    if (srcHtml.includes('eth_sendRawTransaction')) files.add('index.html');
    expect([...files]).toEqual(['shared/agentScheduleExecutor.js']);
  });

  it('agentScheduleExecutor keeps its single broadcast primitive + browser path', () => {
    expect(executorSrc).toContain('broadcast: _signAndSend');
    expect(executorSrc).toContain('signer.signTransaction(rawTx)');
    expect(executorSrc).toContain('SecureSignerProvider');
  });

  it('index.html loads SecureSignerProvider and keeps the execution-authority primitives', () => {
    expect(srcHtml).toContain('<script src="/shared/secureSignerProvider.js"></script>');
    expect(srcHtml).toContain('_agentBroadcast');
    expect(srcHtml).toContain('_agentNextNonce');
    expect(srcHtml).toContain('_agentWaitReceipt');
    expect(srcHtml).not.toContain('signer.signTransaction');
    expect(srcHtml).not.toContain('eth_sendRawTransaction');
  });

  it('_agentGetSigner is circle-aware and keeps the browser getSessionSigner path', () => {
    const start = srcHtml.indexOf('async function _agentGetSigner(');
    const end = srcHtml.indexOf('function _agentGetProvider(');
    const slice = srcHtml.slice(start, end);
    expect(slice).toContain('SecureSignerProvider');
    expect(slice).toContain('getSessionSigner');
    expect(slice).not.toContain('_agentGetPrivateKey');
  });
});
