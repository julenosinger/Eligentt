/**
 * alchemy-balance.test.js
 * ═══════════════════════════════════════════════════════════════════════════
 * Phase 1.4.2 behavioral tests for the Alchemy balance proxy + P7 defect fixes.
 *
 *   A — Alchemy proxy (functions/api/balance/alchemy.js)
 *       1.  native eth_getBalance → decimal balance.
 *       2.  ERC-20 alchemy_getTokenBalances → decimal balance.
 *       3.  unsupported chains (5042 Arc, 4663 Robinhood, 999 HyperEVM) rejected.
 *       4.  missing key → error.
 *       5.  invalid address/contract → error.
 *       6.  rate-limit → 429.
 *       7.  JSON-RPC error → error (never a fake zero).
 *
 *   B — FastBalanceEngine Alchemy integration (feature flag)
 *       8.  flag disabled (default) → Alchemy not called, RPC used.
 *       9.  flag enabled + eligible → Alchemy primary, RPC fallback.
 *       10. Alchemy failure → RPC fallback.
 *       11. Arc (5042) → Alchemy NEVER called, even with flag enabled.
 *
 *   C — P7 defect fixes
 *       12. Etherscan native (zero-address) → action=balance (no contractaddress).
 *       13. Dedup key distinguishes native vs ERC-20 (and decimals).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const engineSrc = fs.readFileSync(path.join(root, 'shared/FastBalanceEngine.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const ADDR = '0x0000000000000000000000000000000000000001';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ARC_USDC = '0x3600000000000000000000000000000000000000';

function loadEngine({ balanceService, fetchMock, windowExtras }) {
  const window = Object.assign({}, windowExtras || {});
  const ethers = { formatUnits: (v, d) => (Number(v) / Math.pow(10, Number(d))).toString() };
  const BS = balanceService || { getTokenBalance: () => Promise.resolve(null) };
  const fn = new Function(
    'window', 'BalanceService', 'ethers', 'fetch', 'setTimeout', 'clearTimeout',
    engineSrc + '\nreturn window.FastBalanceEngine;'
  );
  return fn(window, BS, ethers, fetchMock || (() => Promise.resolve({ json: () => Promise.resolve({ ok: false }) })), setTimeout, clearTimeout);
}

async function loadProxy() {
  return (await import(path.join(root, 'functions/api/balance/alchemy.js'))).onRequestPost;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('A — Alchemy proxy (behavioral)', () => {
  it('native eth_getBalance returns decimal balance', async () => {
    const onRequestPost = await loadProxy();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xde0b6b3a7640000' }), { status: 200 }))));
    const res = await onRequestPost({ request: new Request('https://x/api/balance/alchemy', { method: 'POST', body: JSON.stringify({ chainid: 8453, address: ADDR }) }), env: { ALCHEMY_API_KEY: 'test' } });
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.balance).toBe('1000000000000000000'); // 1e18 wei
  });

  it('ERC-20 alchemy_getTokenBalances returns decimal balance', async () => {
    const onRequestPost = await loadProxy();
    const result = { address: ADDR, tokenBalances: [{ contractAddress: ARC_USDC, tokenBalance: '0x4c4b40', error: null }] };
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 }))));
    const res = await onRequestPost({ request: new Request('https://x/api/balance/alchemy', { method: 'POST', body: JSON.stringify({ chainid: 42161, address: ADDR, contract: ARC_USDC }) }), env: { ALCHEMY_API_KEY: 'test' } });
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.balance).toBe('5000000'); // 0x4c4b40 = 5000000
  });

  it('rejects Arc (5042), Robinhood (4663) and HyperEVM (999)', async () => {
    const onRequestPost = await loadProxy();
    vi.stubGlobal('fetch', vi.fn());
    for (const chainid of [5042, 4663, 999]) {
      const res = await onRequestPost({ request: new Request('https://x/api/balance/alchemy', { method: 'POST', body: JSON.stringify({ chainid, address: ADDR }) }), env: { ALCHEMY_API_KEY: 'test' } });
      const data = await res.json();
      expect(data.ok).toBe(false);
      expect(data.error).toBe('unsupported_chain');
    }
  });

  it('missing key → error', async () => {
    const onRequestPost = await loadProxy();
    vi.stubGlobal('fetch', vi.fn());
    const res = await onRequestPost({ request: new Request('https://x/api/balance/alchemy', { method: 'POST', body: JSON.stringify({ chainid: 1, address: ADDR }) }), env: {} });
    const data = await res.json();
    expect(data.ok).toBe(false);
  });

  it('invalid address and contract → error', async () => {
    const onRequestPost = await loadProxy();
    vi.stubGlobal('fetch', vi.fn());
    const badAddr = await onRequestPost({ request: new Request('https://x/api/balance/alchemy', { method: 'POST', body: JSON.stringify({ chainid: 1, address: 'nope' }) }), env: { ALCHEMY_API_KEY: 'test' } });
    expect((await badAddr.json()).error).toBe('invalid_address');
    const badContract = await onRequestPost({ request: new Request('https://x/api/balance/alchemy', { method: 'POST', body: JSON.stringify({ chainid: 1, address: ADDR, contract: 'nope' }) }), env: { ALCHEMY_API_KEY: 'test' } });
    expect((await badContract.json()).error).toBe('invalid_contract');
  });

  it('JSON-RPC error → error (never a fake zero)', async () => {
    const onRequestPost = await loadProxy();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } }), { status: 200 }))));
    const res = await onRequestPost({ request: new Request('https://x/api/balance/alchemy', { method: 'POST', body: JSON.stringify({ chainid: 1, address: ADDR }) }), env: { ALCHEMY_API_KEY: 'test' } });
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.balance).toBeUndefined();
  });

  it('batched ERC-20 (contracts array) → { ok, balances } with exact decimals + per-token isolation', async () => {
    const onRequestPost = await loadProxy();
    const C1 = '0x00000000000000000000000000000000000000aa';
    const C2 = '0x00000000000000000000000000000000000000bb';
    const C3 = '0x00000000000000000000000000000000000000cc';
    const result = { address: ADDR, tokenBalances: [
      { contractAddress: C1, tokenBalance: '0x4c4b40', error: null },   // 5000000
      { contractAddress: C2, tokenBalance: '0x0', error: null },       // 0 (confirmed zero)
      { contractAddress: C3, tokenBalance: '0x0', error: { code: -32000, message: 'boom' } }, // per-token error → omitted
    ] };
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 }))));
    const res = await onRequestPost({ request: new Request('https://x/api/balance/alchemy', { method: 'POST', body: JSON.stringify({ chainid: 8453, address: ADDR, contracts: [C1, C2, C3] }) }), env: { ALCHEMY_API_KEY: 'test' } });
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.balances[C1]).toBe('5000000');   // exact decimal
    expect(data.balances[C2]).toBe('0');          // confirmed zero preserved
    expect(data.balances[C3]).toBeUndefined();    // per-token error omitted (not fake zero)
  });

  it('batched request deduplicates + bounds contract count', async () => {
    const onRequestPost = await loadProxy();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { address: ADDR, tokenBalances: [] } }), { status: 200 }))));
    const many = Array.from({ length: 30 }, (_, i) => '0x' + String(i + 1000).padStart(40, '0'));
    const tooMany = await onRequestPost({ request: new Request('https://x/api/balance/alchemy', { method: 'POST', body: JSON.stringify({ chainid: 1, address: ADDR, contracts: many }) }), env: { ALCHEMY_API_KEY: 'test' } });
    expect((await tooMany.json()).error).toBe('too_many_contracts');
  });

  // Rate-limit is intentionally LAST: it exhausts the per-isolate sliding window,
  // so the tests above (which assert ok:true) run before the cap is reached.
  it('rate-limit → 429', async () => {
    const onRequestPost = await loadProxy();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x0' }), { status: 200 }))));
    const env = { ALCHEMY_API_KEY: 'test' };
    let last;
    for (let i = 0; i < 6; i++) {
      last = await onRequestPost({ request: new Request('https://x/api/balance/alchemy', { method: 'POST', body: JSON.stringify({ chainid: 1, address: ADDR }) }), env });
    }
    const data = await last.json();
    expect(data.ok).toBe(false);
    expect(data.error).toBe('rate_limited');
  });
});

describe('B — FastBalanceEngine Alchemy integration (feature flag)', () => {
  it('flag disabled (default): Alchemy NOT called, RPC used', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ ok: true, balance: '1' }) }));
    let rpcCalls = 0;
    const engine = loadEngine({ balanceService: { getTokenBalance: () => { rpcCalls++; return Promise.resolve('2'); } }, fetchMock });
    const bal = await engine.getTokenBalance(ADDR, { address: ZERO_ADDRESS, symbol: 'ETH', decimals: 18 }, 8453);
    expect(bal).toBe('2');            // RPC result
    expect(rpcCalls).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled(); // no Alchemy/Etherscan
  });

  it('flag enabled + eligible: Alchemy primary, returns formatted balance', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ ok: true, balance: '1000000000000000000' }) }));
    let rpcCalls = 0;
    const engine = loadEngine({ balanceService: { getTokenBalance: () => { rpcCalls++; return Promise.resolve('9'); } }, fetchMock, windowExtras: { ALCHEMY_BALANCE_ENABLED: true } });
    const bal = await engine.getTokenBalance(ADDR, { address: ZERO_ADDRESS, symbol: 'ETH', decimals: 18 }, 8453);
    expect(bal).toBe('1');            // 1e18 wei → 1 ETH (Alchemy)
    expect(fetchMock).toHaveBeenCalled(); // Alchemy hit
    expect(rpcCalls).toBe(0);         // RPC not needed
  });

  it('Alchemy failure → RPC fallback', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ ok: false, error: 'rate_limited' }) }));
    let rpcCalls = 0;
    const engine = loadEngine({ balanceService: { getTokenBalance: () => { rpcCalls++; return Promise.resolve('3'); } }, fetchMock, windowExtras: { ALCHEMY_BALANCE_ENABLED: true } });
    const bal = await engine.getTokenBalance(ADDR, { address: ZERO_ADDRESS, symbol: 'ETH', decimals: 18 }, 8453);
    expect(bal).toBe('3');            // RPC fallback
    expect(rpcCalls).toBe(1);
  });

  it('Arc (5042): Alchemy NEVER called, even with flag enabled', async () => {
    const fetchMock = vi.fn();
    const engine = loadEngine({ balanceService: { getTokenBalance: () => Promise.resolve('5') }, fetchMock, windowExtras: { ALCHEMY_BALANCE_ENABLED: true } });
    const bal = await engine.getTokenBalance(ADDR, { address: ARC_USDC, symbol: 'USDC', decimals: 6 }, 5042);
    expect(bal).toBe('5');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('C — P7 defect fixes (source-level)', () => {
  it('Etherscan native detection: zero-address uses action=balance, not contractaddress', () => {
    expect(engineSrc).toContain('_isNativeToken(token)');
    expect(engineSrc).toContain("if (!isNative) url += '&contractaddress='");
  });

  it('dedup key uses canonical token identity (native vs ERC-20 + decimals)', () => {
    expect(engineSrc).toContain("return 'native'");
    expect(engineSrc).toContain("_tokenAddr(token) + '::' + _tokenDecimals(token)");
  });

  it('priority uses canonical address, not symbol-only matching', () => {
    expect(html).toContain('function _swpTokId(t)');
    expect(html).toContain('Never cross-chain symbol matching');
  });
});
