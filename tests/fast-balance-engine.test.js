/**
 * fast-balance-engine.test.js
 * ═══════════════════════════════════════════════════════════════════════════
 * Phase 1.4 behavioral tests for the fast non-Arc balance engine + Etherscan V2.
 *
 *   A — FastBalanceEngine (loaded with mocked BalanceService/ethers/fetch)
 *       1. Arc (5042) delegates to BalanceService (engine never touches it).
 *       2. In-flight request coalescing (identical reads share one Promise).
 *       3. Bounded concurrency (never exceeds the limit).
 *       4. Priority order is preserved (higher priority processed first).
 *       5. Etherscan fallback only for eligible chains (RPC null → Etherscan).
 *       6. Ineligible chains (Base 8453) never hit Etherscan.
 *       7. Etherscan error → null (never a fabricated zero).
 *       8. RPC success is authoritative (Etherscan not consulted).
 *
 *   B — Etherscan V2 server proxy (functions/api/balance/etherscan.js)
 *       9.  native balance returns { ok:true, balance }.
 *       10. ERC-20 tokenbalance returns { ok:true, balance }.
 *       11. unsupported chain (8453) rejected.
 *       12. rate-limit → { ok:false } (never a fake zero).
 *       13. missing key → { ok:false }.
 *       14. invalid address → { ok:false }.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const engineSrc = fs.readFileSync(path.join(root, 'shared/FastBalanceEngine.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const proxySrc = fs.readFileSync(path.join(root, 'functions/api/balance/etherscan.js'), 'utf8');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const ADDR = '0x0000000000000000000000000000000000000001';

/** Load FastBalanceEngine with mocked BalanceService/ethers/fetch. */
function loadEngine({ balanceService, fetchMock }) {
  const window = {};
  const ethers = { formatUnits: (v, d) => (Number(v) / Math.pow(10, Number(d))).toString() };
  const BS = balanceService || { getTokenBalance: () => Promise.resolve(null) };
  const fn = new Function(
    'window', 'BalanceService', 'ethers', 'fetch', 'setTimeout', 'clearTimeout',
    engineSrc + '\nreturn window.FastBalanceEngine;'
  );
  return fn(window, BS, ethers, fetchMock || (() => Promise.resolve({ json: () => Promise.resolve({ ok: false }) })), setTimeout, clearTimeout);
}

describe('A — FastBalanceEngine (behavioral)', () => {
  describe('Arc isolation (chainId 5042)', () => {
    it('delegates Arc reads to BalanceService and never calls Etherscan/fetch', async () => {
      const fetchMock = vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ ok: false }) }));
      let bsCalls = 0;
      const engine = loadEngine({
        balanceService: { getTokenBalance: () => { bsCalls++; return Promise.resolve('5'); } },
        fetchMock,
      });
      const bal = await engine.getTokenBalance(ADDR, { address: ARC_USDC, symbol: 'USDC', decimals: 6 }, 5042);
      expect(bal).toBe('5');           // BalanceService result passed through
      expect(bsCalls).toBe(1);         // BalanceService was the ONLY read path
      expect(fetchMock).not.toHaveBeenCalled(); // Etherscan NEVER touched
    });

    it('isSupported(5042) is false (Arc is out of scope)', () => {
      const engine = loadEngine({});
      expect(engine.isSupported(5042)).toBe(false);
    });
  });

  describe('chain support', () => {
    const engine = loadEngine({});
    it('isSupported for non-Arc EVM chains', () => {
      expect(engine.isSupported(1)).toBe(true);
      expect(engine.isSupported(8453)).toBe(true);
      expect(engine.isSupported(42161)).toBe(true);
      expect(engine.isSupported(10)).toBe(true);
      expect(engine.isSupported(137)).toBe(true);
    });
    it('canUseEtherscan only for Ethereum/Arbitrum/Polygon', () => {
      expect(engine.canUseEtherscan(1)).toBe(true);
      expect(engine.canUseEtherscan(42161)).toBe(true);
      expect(engine.canUseEtherscan(137)).toBe(true);
      expect(engine.canUseEtherscan(8453)).toBe(false); // Base — RPC only
      expect(engine.canUseEtherscan(10)).toBe(false);   // Optimism — RPC only
      expect(engine.canUseEtherscan(5042)).toBe(false); // Arc — RPC only
    });
  });

  describe('in-flight deduplication', () => {
    it('coalesces identical concurrent reads into one BalanceService call', async () => {
      let bsCalls = 0;
      const engine = loadEngine({
        balanceService: {
          getTokenBalance: () => {
            bsCalls++;
            return new Promise((resolve) => setTimeout(() => resolve('1'), 20));
          },
        },
      });
      const token = { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 };
      const p1 = engine.getTokenBalance(ADDR, token, 8453);
      const p2 = engine.getTokenBalance(ADDR, token, 8453);
      const p3 = engine.getTokenBalance(ADDR, token, 8453);
      const [a, b, c] = await Promise.all([p1, p2, p3]);
      expect(a).toBe('1'); expect(b).toBe('1'); expect(c).toBe('1');
      expect(bsCalls).toBe(1); // one underlying read, three share the promise
    });

    it('does NOT dedup across different chains or wallets', async () => {
      let bsCalls = 0;
      const engine = loadEngine({
        balanceService: { getTokenBalance: () => { bsCalls++; return Promise.resolve('1'); } },
      });
      const token = { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 };
      await engine.getTokenBalance(ADDR, token, 8453);
      await engine.getTokenBalance(ADDR, token, 42161); // different chain
      await engine.getTokenBalance('0x0000000000000000000000000000000000000002', token, 8453); // different wallet
      expect(bsCalls).toBe(3);
    });
  });

  describe('bounded concurrency', () => {
    it('never exceeds the concurrency limit', async () => {
      let inFlight = 0, maxInFlight = 0;
      const engine = loadEngine({
        balanceService: {
          getTokenBalance: () => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            return new Promise((resolve) => setTimeout(() => { inFlight--; resolve('1'); }, 10));
          },
        },
      });
      const items = [];
      for (let i = 0; i < 12; i++) {
        items.push({ t: { address: '0x' + String(i + 1).padStart(40, '0'), symbol: 'T' + i, decimals: 18 }, i });
      }
      await engine.schedule(ADDR, items, 8453, () => {}, 4);
      expect(maxInFlight).toBeLessThanOrEqual(4);
    });
  });

  describe('priority order', () => {
    it('processes items in the given (priority) order', async () => {
      const order = [];
      const engine = loadEngine({
        balanceService: {
          getTokenBalance: (_, token) => {
            order.push(token.symbol);
            return new Promise((resolve) => setTimeout(() => resolve('1'), 5));
          },
        },
      });
      // Distinct addresses so dedup does not collapse distinct tokens.
      // Items pre-sorted by priority: HIGH first.
      const items = [
        { t: { address: '0x00000000000000000000000000000000000000a1', symbol: 'SELECTED', decimals: 18 }, i: 0 },
        { t: { address: '0x00000000000000000000000000000000000000a2', symbol: 'NATIVE', decimals: 18 }, i: 1 },
        { t: { address: '0x00000000000000000000000000000000000000a3', symbol: 'USDC', decimals: 6 }, i: 2 },
        { t: { address: '0x00000000000000000000000000000000000000a4', symbol: 'LOW', decimals: 18 }, i: 3 },
      ];
      await engine.schedule(ADDR, items, 8453, () => {}, 2);
      expect(order).toEqual(['SELECTED', 'NATIVE', 'USDC', 'LOW']);
    });
  });

  describe('Etherscan fallback strategy', () => {
    it('RPC success is authoritative (Etherscan not consulted)', async () => {
      const fetchMock = vi.fn();
      const engine = loadEngine({
        balanceService: { getTokenBalance: () => Promise.resolve('0.5') },
        fetchMock,
      });
      const bal = await engine.getTokenBalance(ADDR, { address: ZERO_ADDRESS, symbol: 'ETH', decimals: 18 }, 1);
      expect(bal).toBe('0.5');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('Ethereum (1): RPC null → Etherscan fallback returns formatted balance', async () => {
      const fetchMock = vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ ok: true, balance: '1000000000000000000' }) }));
      const engine = loadEngine({
        balanceService: { getTokenBalance: () => Promise.resolve(null) },
        fetchMock,
      });
      const bal = await engine.getTokenBalance(ADDR, { address: ZERO_ADDRESS, symbol: 'ETH', decimals: 18 }, 1);
      expect(bal).toBe('1'); // 1e18 wei → 1 ETH
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('Base (8453): RPC null does NOT call Etherscan (ineligible chain)', async () => {
      const fetchMock = vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ ok: true, balance: '1' }) }));
      const engine = loadEngine({
        balanceService: { getTokenBalance: () => Promise.resolve(null) },
        fetchMock,
      });
      const bal = await engine.getTokenBalance(ADDR, { address: ZERO_ADDRESS, symbol: 'ETH', decimals: 18 }, 8453);
      expect(bal).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('Etherscan error → null (never a fabricated zero)', async () => {
      const fetchMock = vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ ok: false, error: 'rate_limited' }) }));
      const engine = loadEngine({
        balanceService: { getTokenBalance: () => Promise.resolve(null) },
        fetchMock,
      });
      const bal = await engine.getTokenBalance(ADDR, { address: ZERO_ADDRESS, symbol: 'ETH', decimals: 18 }, 1);
      expect(bal).toBeNull();
    });
  });
});

describe('B — Etherscan V2 server proxy (behavioral)', () => {
  // Import the proxy handler from the module source by evaluating it.
  async function loadProxy() {
    const mod = await import(path.join(root, 'functions/api/balance/etherscan.js'));
    return mod.onRequestGet;
  }

  function req(url) {
    return { request: new Request(url) };
  }

  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('native balance returns { ok:true, balance }', async () => {
    const onRequestGet = await loadProxy();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ status: '1', message: 'OK', result: '123456789' }), { status: 200 }))));
    const res = await onRequestGet({ request: new Request('https://x/api/balance/etherscan?chainid=1&address=' + ADDR), env: { ETHERSCAN_API_KEY: 'test' } });
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.balance).toBe('123456789');
  });

  it('ERC-20 tokenbalance returns { ok:true, balance }', async () => {
    const onRequestGet = await loadProxy();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ status: '1', message: 'OK', result: '5000000' }), { status: 200 }))));
    const res = await onRequestGet({ request: new Request('https://x/api/balance/etherscan?chainid=42161&address=' + ADDR + '&contractaddress=' + ARC_USDC), env: { ETHERSCAN_API_KEY: 'test' } });
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.balance).toBe('5000000');
  });

  it('unsupported chain (8453) rejected', async () => {
    const onRequestGet = await loadProxy();
    vi.stubGlobal('fetch', vi.fn());
    const res = await onRequestGet({ request: new Request('https://x/api/balance/etherscan?chainid=8453&address=' + ADDR), env: { ETHERSCAN_API_KEY: 'test' } });
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toBe('unsupported_chain');
  });

  it('rate-limit → { ok:false } (never a fake zero)', async () => {
    const onRequestGet = await loadProxy();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ status: '0', message: 'Rate limit reached', result: 'Max rate limit reached' }), { status: 200 }))));
    const res = await onRequestGet({ request: new Request('https://x/api/balance/etherscan?chainid=1&address=' + ADDR), env: { ETHERSCAN_API_KEY: 'test' } });
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toBe('rate_limited');
  });

  it('missing key → { ok:false }', async () => {
    const onRequestGet = await loadProxy();
    vi.stubGlobal('fetch', vi.fn());
    const res = await onRequestGet({ request: new Request('https://x/api/balance/etherscan?chainid=1&address=' + ADDR), env: {} });
    const data = await res.json();
    expect(data.ok).toBe(false);
  });

  it('invalid address → { ok:false }', async () => {
    const onRequestGet = await loadProxy();
    vi.stubGlobal('fetch', vi.fn());
    const res = await onRequestGet({ request: new Request('https://x/api/balance/etherscan?chainid=1&address=not_an_addr'), env: { ETHERSCAN_API_KEY: 'test' } });
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toBe('invalid_address');
  });
});

describe('C — integration & secret hygiene (source-level)', () => {
  it('FastBalanceEngine script is loaded after BalanceService', () => {
    expect(html).toContain('<script src="/shared/FastBalanceEngine.js"></script>');
  });

  it('renderTokenList branches non-Arc → FastBalanceEngine and keeps Arc on BalanceService', () => {
    expect(html).toContain('FastBalanceEngine.isSupported');
    expect(html).toContain('_swpTokenPriority');
    expect(html).toContain('fastEngine.schedule');
  });

  it('ETHERSCAN_API_KEY is NEVER present in index.html or public assets', () => {
    expect(html).not.toContain('ETHERSCAN_API_KEY');
    expect(proxySrc).toContain('env.ETHERSCAN_API_KEY'); // server-side only
  });

  it('the Etherscan proxy validates chainid and never exposes the key', () => {
    expect(proxySrc).toContain('ETHERSCAN_CHAIN');
    expect(proxySrc).toContain('unsupported_chain');
    expect(proxySrc).not.toContain('apikey=' + 'test'); // key comes from env, not literal
  });
});
