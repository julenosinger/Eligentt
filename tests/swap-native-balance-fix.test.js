/**
 * swap-native-balance-fix.test.js
 * ═══════════════════════════════════════════════════════════════════════════
 * BEHAVIORAL tests for the P0/P1 swap token balance fix.
 *
 * Unlike the source-level regression suites, this file EXECUTES the real
 * classification logic extracted from index.html and shared/BalanceService.js:
 *
 *   Group A — EVM networks
 *     1–4  ETH native positive on Base/Arbitrum/Ethereum/Optimism.
 *     5    WETH → ERC-20 (never native).
 *     6    USDC ERC-20 → ERC-20.
 *     7    RPC failure returns null (never a fake zero).
 *     8    Render-generation guard prevents cross-chain balance mixing.
 *
 *   Group B — Arc Mainnet protection
 *     Arc stays USDC-native; ETH is never Arc's gas token; the 0x3600…0000 USDC
 *     interface remains ERC-20 (6 decimals) and is never auto-converted to native.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const svc  = fs.readFileSync(path.join(root, 'shared/BalanceService.js'), 'utf8');
const chainsCfg = fs.readFileSync(path.join(root, 'config/chains.js'), 'utf8');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ETH_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const ARC_USDC      = '0x3600000000000000000000000000000000000000';

// ── Minimal chain registry (nativeCurrency mirrors config/chains.js) ─────────
const CHAIN_REGISTRY = {
  5042:  { chainId: 5042,  nativeCurrency: { name: 'USDC',  symbol: 'USDC',  decimals: 18 }, tokens: { USDC: { address: ARC_USDC, decimals: 6 } } },
  1:     { chainId: 1,     nativeCurrency: { name: 'Ether', symbol: 'ETH',   decimals: 18 }, tokens: {} },
  8453:  { chainId: 8453,  nativeCurrency: { name: 'Ether', symbol: 'ETH',   decimals: 18 }, tokens: {} },
  42161: { chainId: 42161, nativeCurrency: { name: 'Ether', symbol: 'ETH',   decimals: 18 }, tokens: {} },
  10:    { chainId: 10,    nativeCurrency: { name: 'Ether', symbol: 'ETH',   decimals: 18 }, tokens: {} },
  137:   { chainId: 137,   nativeCurrency: { name: 'MATIC', symbol: 'MATIC',  decimals: 18 }, tokens: {} },
};

/** Brace-matched function-source extractor. */
function extractFn(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(marker + ' not found');
  let depth = 0, i = start, entered = false;
  while (i < src.length) {
    if (src[i] === '{') { depth++; entered = true; }
    else if (src[i] === '}') { depth--; if (entered && depth === 0) { i++; break; } }
    i++;
  }
  return src.slice(start, i);
}

/** Build the real _swpTokenIsNative from index.html. */
function buildTokenIsNative() {
  const src = extractFn(html, 'function _swpTokenIsNative(t, chainId)');
  const fn = new Function('CHAIN_REGISTRY', src + '\nreturn _swpTokenIsNative;');
  return fn(CHAIN_REGISTRY);
}

/** Build the real BalanceService._resolveTokenMeta from BalanceService.js. */
function buildResolveTokenMeta() {
  const src = extractFn(svc, 'function _resolveTokenMeta(chain, chainId, token)');
  const fn = new Function('ZERO_ADDRESS', 'ETH_SENTINEL', 'getTokenAddressForChain', 'getTokenDecimals',
    src + '\nreturn _resolveTokenMeta;');
  return fn(ZERO_ADDRESS, ETH_SENTINEL, () => null, () => null);
}

/** Build the real _swpTokBal (picker display formatter) from index.html. */
function buildTokBal() {
  const src = extractFn(html, 'function _swpTokBal(v)');
  const fn = new Function(src + '\nreturn _swpTokBal;');
  return fn();
}

// ═════════════════════════════════════════════════════════════════════════════
// GROUP A — EVM networks (native ETH)
// ═════════════════════════════════════════════════════════════════════════════
describe('Group A — _swpTokenIsNative (native ETH on EVM networks)', () => {
  const isNative = buildTokenIsNative();

  it('Base (8453): zero-address ETH → native', () => {
    expect(isNative({ address: ZERO_ADDRESS, symbol: 'ETH' }, 8453)).toBe(true);
  });
  it('Arbitrum (42161): zero-address ETH → native', () => {
    expect(isNative({ address: ZERO_ADDRESS, symbol: 'ETH' }, 42161)).toBe(true);
  });
  it('Ethereum (1): zero-address ETH → native', () => {
    expect(isNative({ address: ZERO_ADDRESS, symbol: 'ETH' }, 1)).toBe(true);
  });
  it('Optimism (10): zero-address ETH → native', () => {
    expect(isNative({ address: ZERO_ADDRESS, symbol: 'ETH' }, 10)).toBe(true);
  });
  it('Polygon (137): zero-address MATIC → native (MATIC config preserved)', () => {
    expect(isNative({ address: ZERO_ADDRESS, symbol: 'MATIC' }, 137)).toBe(true);
  });

  it('WETH (real contract address) → ERC-20, NOT native', () => {
    expect(isNative({ address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH' }, 8453)).toBe(false);
  });
  it('ETHx (real contract address) → ERC-20, NOT native', () => {
    expect(isNative({ address: '0x0000000000000000000000000000000000000001', symbol: 'ETHx' }, 8453)).toBe(false);
  });
  it('USDC ERC-20 (real contract address) → ERC-20, NOT native', () => {
    expect(isNative({ address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC' }, 8453)).toBe(false);
  });

  it('missing address + native symbol → native', () => {
    expect(isNative({ symbol: 'ETH' }, 8453)).toBe(true);
  });
  it('missing address + non-native symbol → NOT native (never guess)', () => {
    expect(isNative({ symbol: 'FOO' }, 8453)).toBe(false);
  });
  it('zero address + non-native symbol → NOT native (symbol must match)', () => {
    expect(isNative({ address: ZERO_ADDRESS, symbol: 'FOO' }, 8453)).toBe(false);
  });
  it('sentinel 0xeee…e + native symbol → native', () => {
    expect(isNative({ address: ETH_SENTINEL, symbol: 'ETH' }, 8453)).toBe(true);
  });
  it('sentinel 0xeee…e + non-native symbol → NOT native (sentinel needs correct context)', () => {
    expect(isNative({ address: ETH_SENTINEL, symbol: 'WETH' }, 8453)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GROUP B — Arc Mainnet protection (USDC native, never ETH)
// ═════════════════════════════════════════════════════════════════════════════
describe('Group B — Arc Mainnet protection', () => {
  const isNative = buildTokenIsNative();

  it('Arc chainId remains 5042', () => {
    expect(chainsCfg).toContain('ARC_CHAIN_ID:         5042');
  });
  it('Arc nativeCurrency remains USDC (18 native decimals)', () => {
    expect(chainsCfg).toContain("nativeCurrency:{name:'USDC',symbol:'USDC',decimals:18}");
  });
  it('Arc USDC interface 0x3600…0000 remains ERC-20 with 6 decimals', () => {
    expect(chainsCfg).toContain("USDC:{address:'0x3600000000000000000000000000000000000000',decimals:6}");
  });
  it('ETH is NEVER classified native on Arc (Arc native is USDC)', () => {
    expect(isNative({ address: ZERO_ADDRESS, symbol: 'ETH' }, 5042)).toBe(false);
    expect(isNative({ address: ETH_SENTINEL, symbol: 'ETH' }, 5042)).toBe(false);
  });
  it('Arc USDC interface (0x3600…0000) is ERC-20, never auto-converted to native', () => {
    expect(isNative({ address: ARC_USDC, symbol: 'USDC' }, 5042)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BalanceService._resolveTokenMeta (behavioral — the native/ERC-20 split)
// ═════════════════════════════════════════════════════════════════════════════
describe('BalanceService._resolveTokenMeta (behavioral)', () => {
  const meta = buildResolveTokenMeta();

  it('zero-address ETH on Base → isNative true', () => {
    const m = meta({ nativeCurrency: { symbol: 'ETH' }, tokens: {} }, 8453, { address: ZERO_ADDRESS, symbol: 'ETH', decimals: 18 });
    expect(m.isNative).toBe(true);
  });
  it('sentinel ETH → isNative true', () => {
    const m = meta({ nativeCurrency: { symbol: 'ETH' }, tokens: {} }, 8453, { address: ETH_SENTINEL, symbol: 'ETH', decimals: 18 });
    expect(m.isNative).toBe(true);
  });
  it('real-address token (WETH) → isNative false (balanceOf)', () => {
    const m = meta({ nativeCurrency: { symbol: 'ETH' }, tokens: {} }, 8453, { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18 });
    expect(m.isNative).toBe(false);
  });
  it('Arc USDC 0x3600…0000 → isNative false, decimals 6 preserved', () => {
    const m = meta({ nativeCurrency: { symbol: 'USDC', decimals: 18 }, tokens: { USDC: { address: ARC_USDC, decimals: 6 } } }, 5042, { address: ARC_USDC, symbol: 'USDC', decimals: 6 });
    expect(m.isNative).toBe(false);
    expect(m.decimals).toBe(6);
  });
  it('missing address + native symbol → isNative true', () => {
    const m = meta({ nativeCurrency: { symbol: 'ETH' }, tokens: {} }, 8453, { symbol: 'ETH' });
    expect(m.isNative).toBe(true);
  });
  it('missing address + non-native symbol → isNative false', () => {
    const m = meta({ nativeCurrency: { symbol: 'ETH' }, tokens: {} }, 8453, { symbol: 'FOO' });
    expect(m.isNative).toBe(false);
  });
  // ── Unification: native markers now require the chain's native symbol ──────
  it('zero-address ETH on Arc → isNative false (Arc native is USDC, never ETH)', () => {
    const m = meta({ nativeCurrency: { symbol: 'USDC', decimals: 18 }, tokens: {} }, 5042, { address: ZERO_ADDRESS, symbol: 'ETH', decimals: 18 });
    expect(m.isNative).toBe(false);
  });
  it('zero-address FOO on Base → isNative false (fail closed on unknown symbol)', () => {
    const m = meta({ nativeCurrency: { symbol: 'ETH' }, tokens: {} }, 8453, { address: ZERO_ADDRESS, symbol: 'FOO', decimals: 18 });
    expect(m.isNative).toBe(false);
  });
  it('sentinel 0xeee…e with WETH symbol → isNative false (sentinel needs correct context)', () => {
    const m = meta({ nativeCurrency: { symbol: 'ETH' }, tokens: {} }, 8453, { address: ETH_SENTINEL, symbol: 'WETH', decimals: 18 });
    expect(m.isNative).toBe(false);
  });
  it('zero-address USDC on Arc → isNative true (Arc native gas is USDC)', () => {
    const m = meta({ nativeCurrency: { symbol: 'USDC', decimals: 18 }, tokens: {} }, 5042, { address: ZERO_ADDRESS, symbol: 'USDC', decimals: 18 });
    expect(m.isNative).toBe(true);
  });
  it('symbol-only "USDC" on Arc resolves to the ERC-20 interface (0x3600…0000), not native', () => {
    const m = meta({ nativeCurrency: { symbol: 'USDC', decimals: 18 }, tokens: { USDC: { address: ARC_USDC, decimals: 6 } } }, 5042, 'USDC');
    expect(m.isNative).toBe(false);
    expect(m.address.toLowerCase()).toBe(ARC_USDC);
    expect(m.decimals).toBe(6);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BalanceService.getTokenBalance end-to-end (behavioral)
// Native → getBalance; ERC-20 → balanceOf; RPC failure → null (never fake zero).
// ═════════════════════════════════════════════════════════════════════════════
describe('BalanceService.getTokenBalance — native vs ERC-20 vs failure', () => {
  function loadBalanceService({ provider }) {
    const window = {
      ElligenteChains: {
        CHAIN_REGISTRY: {
          5042: { chainId: 5042, rpc: 'https://rpc.arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, tokens: { USDC: { address: ARC_USDC, decimals: 6 } } },
          8453: { chainId: 8453, rpc: 'https://rpc.base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, tokens: { USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 } } },
        },
      },
    };
    const ethers = {
      JsonRpcProvider: function () {},
      Contract: function () {
        return { balanceOf: provider.balanceOf };
      },
      formatUnits: (v, d) => (Number(v) / Math.pow(10, Number(d))).toString(),
    };
    const fn = new Function(
      'window', 'ethers', 'console', 'setTimeout', 'clearTimeout', 'getChainById', 'getCachedProvider', 'getTokenAddressForChain', 'getTokenDecimals',
      svc + '\nreturn window.BalanceService;'
    );
    return fn(window, ethers, { warn() {}, log() {} }, setTimeout, clearTimeout, () => null, () => provider, () => null, () => null);
  }

  it('reads native ETH on Base via provider.getBalance (not balanceOf)', async () => {
    const calls = [];
    const provider = {
      getBalance: async () => { calls.push('getBalance'); return 1000000000000000000n; },
      balanceOf: async () => { calls.push('balanceOf'); return 0n; },
    };
    const BS = loadBalanceService({ provider });
    const bal = await BS.getTokenBalance('0x0000000000000000000000000000000000000001', { address: ZERO_ADDRESS, symbol: 'ETH', decimals: 18 }, 8453);
    expect(bal).toBe('1');
    expect(calls).toEqual(['getBalance']);
  });

  it('reads ERC-20 USDC on Arc via balanceOf (not getBalance)', async () => {
    const calls = [];
    const provider = {
      getBalance: async () => { calls.push('getBalance'); return 0n; },
      balanceOf: async () => { calls.push('balanceOf'); return 5000000n; }, // 5.000000 USDC
    };
    const BS = loadBalanceService({ provider });
    const bal = await BS.getTokenBalance('0x0000000000000000000000000000000000000001', { address: ARC_USDC, symbol: 'USDC', decimals: 6 }, 5042);
    expect(bal).toBe('5');
    expect(calls).toEqual(['balanceOf']);
  });

  it('RPC failure returns null (never a fake "0.0000")', async () => {
    const provider = {
      getBalance: async () => { throw new Error('RPC offline'); },
      balanceOf: async () => { throw new Error('RPC offline'); },
    };
    const BS = loadBalanceService({ provider });
    const bal = await BS.getTokenBalance('0x0000000000000000000000000000000000000001', { address: ZERO_ADDRESS, symbol: 'ETH', decimals: 18 }, 8453);
    expect(bal).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Render-generation guard (rapid chain switch must not mix balances)
// ═════════════════════════════════════════════════════════════════════════════
describe('Group A #8 — render-generation guard', () => {
  it('renderTokenList bumps _tokRenderGen and bails on stale async results', () => {
    const renderSrc = extractFn(html, 'async function renderTokenList(filterText)');
    expect(html).toContain('let _tokRenderGen = 0');
    expect(renderSrc).toContain('const gen = ++_tokRenderGen');
    // Both the per-row DOM update and the re-sort must be guarded.
    expect(renderSrc).toContain('if (gen !== _tokRenderGen) return');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Precision & display safety (behavioral) — _swpTokBal
// ═════════════════════════════════════════════════════════════════════════════
describe('Precision — _swpTokBal display formatter (behavioral)', () => {
  const fmt = buildTokBal();

  it('null/undefined → "—" (unavailable, never a fake zero)', () => {
    expect(fmt(null)).toBe('—');
    expect(fmt(undefined)).toBe('—');
  });
  it('NaN → "—" (invalid artifact, never shown as a number)', () => {
    expect(fmt(NaN)).toBe('—');
    expect(fmt('not-a-number')).toBe('—');
  });
  it('Infinity → "—" (invalid artifact)', () => {
    expect(fmt(Infinity)).toBe('—');
    expect(fmt('Infinity')).toBe('—');
  });
  it('negative → "—" (invalid artifact, never a misleading value)', () => {
    expect(fmt(-1)).toBe('—');
    expect(fmt('-0.5')).toBe('—');
  });
  it('confirmed zero → "0.0000" (distinguishable from unavailable)', () => {
    expect(fmt('0')).toBe('0.0000');
    expect(fmt('0.0')).toBe('0.0000');
    expect(fmt(0)).toBe('0.0000');
  });
  it('tiny positive below 0.0001 → "<0.0001" (never rounded to a fake zero)', () => {
    expect(fmt('0.00001')).toBe('<0.0001');
    expect(fmt('0.00009')).toBe('<0.0001');
  });
  it('normal positive → 4-decimal display', () => {
    expect(fmt('0.0111')).toBe('0.0111');
    expect(fmt('5')).toBe('5.0000');
    expect(fmt('1.234567')).toBe('1.2346');
  });
  it('the threshold boundary 0.0001 itself is shown as-is (not "<")', () => {
    expect(fmt('0.0001')).toBe('0.0001');
  });
});
