/**
 * Swap — OKX & Bitget connection hotfix (2.0.1).
 * Root cause: WC_PROJECT_ID was never injected (the placeholder was lost) and the
 * OKX/Bitget mobile path called connectWalletConnect() fire-and-forget without
 * feedback. These guards verify the corrected async flow and the injection fix.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const functionsIndex = fs.readFileSync(path.join(root, 'functions', 'index.js'), 'utf8');

function extractFn(name) {
  const re = new RegExp('function ' + name + '\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}');
  const m = html.match(re);
  return m ? m[0] : null;
}

// Extract a full async function body using brace matching (so `await` is kept
// with its `async` prefix and nested blocks are not truncated).
function extractAsyncFn(name) {
  const marker = 'function ' + name;
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const asyncStart = html.slice(start - 6, start).trim() === 'async' ? start - 6 : start;
  const braceStart = html.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(asyncStart, i + 1); }
  }
  return null;
}

// ── 1. WC_PROJECT_ID injection is restored ──────────────────────────────────
describe('WalletConnect Project ID injection', () => {
  it('index.html carries the placeholder (not an empty string)', () => {
    expect(html).toContain("wcProjectId:   '__WC_PROJECT_ID_PLACEHOLDER__'");
  });

  it('the Cloudflare Pages Function injects the real project id at runtime', () => {
    expect(functionsIndex).toContain("env.WC_PROJECT_ID");
    expect(functionsIndex).toContain("replaceAll('__WC_PROJECT_ID_PLACEHOLDER__', wcProjectId)");
  });

  it('WC_PROJECT_ID is read from the injected config', () => {
    expect(html).toContain("const WC_PROJECT_ID = (window.__ARC_PAY_CONFIG__?.wcProjectId) || ''");
  });
});

// ── 2. connectWalletConnect — source-aware feedback + empty-id guard ────────
describe('connectWalletConnect (async control + empty project id)', () => {
  it('accepts a source wallet and routes feedback to the tapped row', () => {
    const fn = extractFn('connectWalletConnect');
    expect(fn).toContain("sourceWallet === 'okx'");
    expect(fn).toContain("sourceWallet === 'bitget'");
    expect(fn).toContain('wm-desc-okx');
    expect(fn).toContain('wm-desc-bitget');
  });

  it('returns false + a clear error when WC_PROJECT_ID is empty (no silent fail)', async () => {
    const fn = extractAsyncFn('connectWalletConnect');
    expect(fn).toBeTruthy();
    const toasts = [];
    const errs = [];
    const ctx = {
      WC_PROJECT_ID: '',
      wcProvider: null,
      toast: (m) => toasts.push(m),
      _err: (...a) => errs.push(a.join(' ')),
      document: { getElementById: () => null },
      window: { _wcLoaded: true, EthereumProvider: { init: () => ({}) } },
      finalizeConnection: async () => {},
      setupProviderEvents: () => {},
    };
    vm.createContext(ctx);
    vm.runInContext(fn + '\nthis.__fn = connectWalletConnect;', ctx);
    const result = await ctx.__fn('okx');
    expect(result).toBe(false);
    expect(toasts.some((t) => t.includes('not configured'))).toBe(true);
    expect(errs.some((e) => e.includes('empty WC_PROJECT_ID'))).toBe(true);
  });

  it('returns false when the WC SDK is unavailable', async () => {
    const fn = extractAsyncFn('connectWalletConnect');
    const toasts = [];
    const ctx = {
      WC_PROJECT_ID: 'dummy',
      wcProvider: null,
      toast: (m) => toasts.push(m),
      _err: () => {},
      document: { getElementById: () => null },
      window: { _wcLoaded: true, EthereumProvider: null, WalletConnectProvider: null },
    };
    vm.createContext(ctx);
    vm.runInContext(fn + '\nthis.__fn = connectWalletConnect;', ctx);
    const result = await ctx.__fn('bitget');
    expect(result).toBe(false);
    expect(toasts.some((t) => t.includes('WalletConnect unavailable'))).toBe(true);
  });

  it('returns true after a successful connect (mocked provider)', async () => {
    const fn = extractAsyncFn('connectWalletConnect');
    const calls = [];
    const ctx = {
      WC_PROJECT_ID: 'dummy-project-id',
      wcProvider: null,
      toast: () => {},
      _err: () => {},
      document: { getElementById: () => null },
      window: { _wcLoaded: true, location: { origin: 'https://app.example' }, EthereumProvider: {
        init: async () => ({ connect: async () => { calls.push('connect'); return { accounts: ['0x1'] }; } }),
      } },
      finalizeConnection: async () => { calls.push('finalize'); },
      setupProviderEvents: () => { calls.push('events'); },
    };
    vm.createContext(ctx);
    vm.runInContext(fn + '\nthis.__fn = connectWalletConnect;', ctx);
    const result = await ctx.__fn('okx');
    expect(result).toBe(true);
    expect(calls).toContain('connect');
    expect(calls).toContain('finalize');
  });
});

// ── 3. connectOKX / connectBitget await the WC flow ─────────────────────────
describe('connectOKX / connectBitget async control', () => {
  it('connectOKX awaits connectWalletConnect on mobile', () => {
    const fn = extractFn('connectOKX');
    expect(fn).toContain('if (_connectingWallet) return');
    expect(fn).toContain("await connectWalletConnect('okx')");
    expect(fn).toContain('_connectingWallet = null');
  });

  it('connectBitget awaits connectWalletConnect on mobile', () => {
    const fn = extractFn('connectBitget');
    expect(fn).toContain("await connectWalletConnect('bitget')");
    expect(fn).toContain('_connectingWallet = null');
  });

  it('releases the duplicate-click lock in a finally block (success/error/cancel)', () => {
    const okx = extractFn('connectOKX');
    const bg = extractFn('connectBitget');
    expect(okx).toContain('finally');
    expect(bg).toContain('finally');
    expect(okx).toContain('_connectingWallet = null');
    expect(bg).toContain('_connectingWallet = null');
  });
});

// ── 4. No regression: existing wallets + no financial changes ───────────────
describe('no regression', () => {
  it('preserves the existing injected-wallet connectors', () => {
    for (const f of ['connectMetaMask', 'connectCoinbase', 'connectRabby', 'connectTrustWallet']) {
      expect(html).toContain('async function ' + f);
    }
  });

  it('preserves the generic WalletConnect QR flow', () => {
    expect(html).toContain('showQrModal:    true');
    expect(html).toContain('Scan QR with your mobile wallet…');
  });

  it('does not modify the swap engine or financial execution', () => {
    expect(html).toContain('async function executeSwap');
    expect(html).toContain('SwapAggregator');
  });

  it('keeps the mobile header de-duplication intact', () => {
    expect(html).toContain('#page-swap.swp-standard .swp-std-header .st-wallet-btn');
  });
});
