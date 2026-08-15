/**
 * POOL EXECUTOR — safe direct-route swap execution (Phase 6).
 * ═══════════════════════════════════════════════════════════════════════════
 * Verifies direct-route-only execution: route discovery, canonical PoolEngine
 * quote, minOut (BigInt), fresh-state validation, quote expiry, token ordering,
 * exact swap ABI (no invented params), approval only when needed, balance
 * checks, user confirmation, receipt verification, duplicate-tx protection,
 * and the USDC/EURC vs USDC/cirBTC distinction. No network — mocked adapter.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const swapMathSrc = fs.readFileSync(path.join(root, 'shared', 'swapMath.js'), 'utf8');
const poolEngineSrc = fs.readFileSync(path.join(root, 'shared', 'poolEngine.js'), 'utf8');
const routerSrc = fs.readFileSync(path.join(root, 'shared', 'poolRouter.js'), 'utf8');
const executorSrc = fs.readFileSync(path.join(root, 'shared', 'poolExecutor.js'), 'utf8');

function load() {
  const win = {};
  new Function('window', swapMathSrc)(win);
  new Function('window', poolEngineSrc)(win);
  new Function('window', routerSrc)(win);
  new Function('window', executorSrc)(win);
  return win;
}
const w = load();
const PE = w.PoolEngine;
const Executor = w.PoolExecutor;

const USDC = '0x3600000000000000000000000000000000000000';
const EURC = '0x89b50855aa3be2f677cd6303cec089b5f319d72a';
const CIRBTC = '0xf0c4a4ce82a5746abaad9425360ab04fbba432bf';

function makeExecutor(opts = {}) {
  return Executor.createExecutor({
    poolEngine: PE,
    swapMath: w.SwapMath,
    ethers,
    ...opts,
  });
}

function seedUsdcEurc(updatedAt) {
  PE.updatePoolState('usdc-eurc', { reserveARaw: 1_000_000_000_000n, reserveBRaw: 1_080_000_000_000n, lpSupplyRaw: 1n, updatedAt: updatedAt != null ? updatedAt : Date.now() });
}
function seedUsdcCirbtc(updatedAt) {
  PE.updatePoolState('usdc-cirbtc', { reserveARaw: 7_000_000_000n, reserveBRaw: 20_000_000n, lpSupplyRaw: 1n, updatedAt: updatedAt != null ? updatedAt : Date.now() });
}

/** Mock adapter with recordable behavior. Approval updates allowance (stateful). */
function makeAdapter(overrides = {}) {
  const calls = { approve: 0, submit: 0 };
  let allowance = overrides.allowance === undefined ? 0n : overrides.allowance;
  return {
    calls,
    getWalletAddress: async () => (overrides.wallet === undefined ? '0xuser' : overrides.wallet),
    readBalance: async () => (overrides.balance === undefined ? 10_000_000_000n : overrides.balance),
    readAllowance: async () => allowance,
    approve: async () => { calls.approve++; allowance = 10_000_000_000_000n; return { hash: '0xapprove' }; },
    submitSwap: async () => { calls.submit++; return { hash: '0xswap' }; },
    waitForReceipt: async () => ({ status: overrides.receiptStatus === undefined ? 1 : overrides.receiptStatus }),
    confirm: async () => true,
    onSubmitted: () => {},
    onConfirmed: () => {},
    ...overrides,
  };
}

/* ════════════════════════════════════════════════════════════
   Route discovery (1/2/3/4)
   ════════════════════════════════════════════════════════════ */
describe('Direct route discovery', () => {
  it('discovers a direct USDC→EURC route', () => {
    seedUsdcEurc();
    const ex = makeExecutor();
    const r = ex.prepareDirectSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n });
    expect(r.ok).toBe(true);
    expect(r.quote.path ? r.quote.pools : r.quote.poolId).toBeDefined();
    expect(r.quote.poolId).toBe('usdc-eurc');
    expect(r.quote.tokenIn).toBe('USDC');
    expect(r.quote.tokenOut).toBe('EURC');
  });

  it('returns NO_ROUTE for an unsupported pair', () => {
    seedUsdcEurc();
    const ex = makeExecutor();
    const r = ex.prepareDirectSwap({ tokenIn: 'USDC', tokenOut: 'ETH', amountInRaw: 100n });
    expect(r.ok).toBe(false);
  });

  it('rejects a multi-hop route with MULTI_HOP_NOT_SUPPORTED', () => {
    seedUsdcEurc();
    seedUsdcCirbtc();
    // Inject a router that (hypothetically) returns a multi-hop shape.
    const ex = makeExecutor({
      router: {
        findBestRoute: () => ({ ok: true, bestRoute: { routeId: 'multi', path: ['USDC', 'EURC', 'cirBTC'], pools: ['usdc-eurc', 'usdc-cirbtc'], expectedOutRaw: 5n, minOutRaw: 4n, priceImpactBps: 10, feeBps: 40 } }),
      },
    });
    const r = ex.prepareDirectSwap({ tokenIn: 'USDC', tokenOut: 'cirBTC', amountInRaw: 100n });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('MULTI_HOP_NOT_SUPPORTED');
  });

  it('selects the best direct pool by highest output', () => {
    // Only one pool per pair on this testnet; verify the quote is canonical.
    seedUsdcEurc();
    const ex = makeExecutor();
    const r = ex.prepareDirectSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n });
    expect(r.quote.expectedOutRaw).toBe(PE.getAmountOut(100_000_000n, 1_000_000_000_000n, 1_080_000_000_000n, 10));
  });
});

/* ════════════════════════════════════════════════════════════
   Quote object + minOut + BigInt (5/6/20/21)
   ════════════════════════════════════════════════════════════ */
describe('Quote object + minOut', () => {
  it('minOutRaw is exact BigInt via SwapMath.calcMinOut', () => {
    seedUsdcEurc();
    const ex = makeExecutor();
    const r = ex.prepareDirectSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n, slippageBps: 50 });
    expect(r.quote.minOutRaw).toBe(w.SwapMath.calcMinOut(r.quote.expectedOutRaw, 50));
    expect(typeof r.quote.expectedOutRaw).toBe('bigint');
    expect(typeof r.quote.minOutRaw).toBe('bigint');
  });

  it('quote carries expiry and timestamps', () => {
    seedUsdcEurc();
    const ex = makeExecutor();
    const r = ex.prepareDirectSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n });
    expect(r.quote.quotedAt).toBeGreaterThan(0);
    expect(r.quote.expiresAt).toBeGreaterThan(r.quote.quotedAt);
  });

  it('quote expires after maxQuoteAgeMs', () => {
    seedUsdcEurc();
    const ex = makeExecutor({ maxQuoteAgeMs: 1000 });
    const r = ex.prepareDirectSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n });
    expect(ex.isQuoteExpired(r.quote, Date.now() + 2000)).toBe(true);
    expect(ex.isQuoteExpired(r.quote, Date.now())).toBe(false);
  });
});

/* ════════════════════════════════════════════════════════════
   Swap selector + arguments (16/17/18/19)
   ════════════════════════════════════════════════════════════ */
describe('Swap ABI verification', () => {
  it('selector is the verified 0x9f1d0f59', () => {
    const ex = makeExecutor();
    expect(ex.getSwapSelector()).toBe('0x9f1d0f59');
  });

  it('calldata is exactly swap(address,uint256,uint256) — no extra params', () => {
    const ex = makeExecutor();
    const enc = ex.encodeSwapCalldata('0xpool', USDC, 100_000_000n, 99_000_000n);
    expect(enc.ok).toBe(true);
    const iface = new ethers.Interface(['function swap(address tokenIn, uint256 amountIn, uint256 amountOutMin) returns (uint256 amountOut)']);
    const decoded = iface.decodeFunctionData('swap', enc.data);
    expect(decoded[0]).toBe(USDC);
    expect(decoded[1]).toBe(100_000_000n);
    expect(decoded[2]).toBe(99_000_000n);
    expect(enc.data.length).toBe(10 + 3 * 64); // selector + 3 args
  });

  it('does not invent deadline/amountAMin/amountBMin', () => {
    const ex = makeExecutor();
    const enc = ex.encodeSwapCalldata('0xpool', USDC, 1n, 1n);
    expect(enc.data).not.toContain('deadline');
    // only 3 arguments encoded (no 4th/5th)
    expect(enc.data.length).toBe(202); // 0x + 4-byte selector + 3*32-byte words
  });
});

/* ════════════════════════════════════════════════════════════
   Token ordering (13/14/15)
   ════════════════════════════════════════════════════════════ */
describe('Token ordering', () => {
  it('token0→token1 (USDC→EURC) quote is correct', () => {
    seedUsdcEurc();
    const ex = makeExecutor();
    const r = ex.prepareDirectSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n });
    expect(r.quote.expectedOutRaw).toBe(PE.getAmountOut(100_000_000n, 1_000_000_000_000n, 1_080_000_000_000n, 10));
  });

  it('token1→token0 (EURC→USDC) quote is correct (reversed reserves)', () => {
    seedUsdcEurc();
    const ex = makeExecutor();
    const r = ex.prepareDirectSwap({ tokenIn: 'EURC', tokenOut: 'USDC', amountInRaw: 100_000_000n });
    expect(r.quote.expectedOutRaw).toBe(PE.getAmountOut(100_000_000n, 1_080_000_000_000n, 1_000_000_000_000n, 10));
  });
});

/* ════════════════════════════════════════════════════════════
   Full execution flow (22-36)
   ════════════════════════════════════════════════════════════ */
describe('Direct swap execution flow', () => {
  it('full success: quote → approve → submit → receipt', async () => {
    seedUsdcEurc();
    const ex = makeExecutor();
    const adapter = makeAdapter({ allowance: 0n });
    const res = await ex.executeDirectSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n, adapter });
    expect(res.ok).toBe(true);
    expect(res.txHash).toBe('0xswap');
    expect(adapter.calls.approve).toBe(1); // allowance 0 → approval required
    expect(adapter.calls.submit).toBe(1);
  });

  it('does not approve when allowance is sufficient', async () => {
    seedUsdcEurc();
    const ex = makeExecutor();
    const adapter = makeAdapter({ allowance: 1_000_000_000_000n });
    const res = await ex.executeDirectSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n, adapter });
    expect(res.ok).toBe(true);
    expect(adapter.calls.approve).toBe(0);
  });

  it('blocks on insufficient balance', async () => {
    seedUsdcEurc();
    const ex = makeExecutor();
    const adapter = makeAdapter({ balance: 1n });
    const res = await ex.executeDirectSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n, adapter });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('INSUFFICIENT_BALANCE');
    expect(adapter.calls.submit).toBe(0);
  });

  it('blocks when wallet not connected', async () => {
    seedUsdcEurc();
    const ex = makeExecutor();
    const adapter = makeAdapter({ wallet: null });
    const res = await ex.executeDirectSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n, adapter });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('WALLET_NOT_CONNECTED');
  });

  it('reports SWAP_TRANSACTION_REVERTED on status 0', async () => {
    seedUsdcEurc();
    const ex = makeExecutor();
    const adapter = makeAdapter({ allowance: 1_000_000_000n, receiptStatus: 0 }); // sufficient allowance → no approval
    const res = await ex.executeDirectSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n, adapter });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('SWAP_TRANSACTION_REVERTED');
  });

  it('reports USER_REJECTED when confirmation declined', async () => {
    seedUsdcEurc();
    const ex = makeExecutor();
    const adapter = makeAdapter({ confirm: async () => false });
    const res = await ex.executeDirectSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n, adapter });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('USER_REJECTED');
    expect(adapter.calls.submit).toBe(0);
  });

  it('blocks expired quote before submit', async () => {
    seedUsdcEurc(Date.now() - 10 * 60 * 1000); // stale state
    const ex = makeExecutor();
    const adapter = makeAdapter({ allowance: 1n });
    const res = await ex.executeDirectSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n, adapter });
    expect(res.ok).toBe(false);
    expect(['ROUTES_STALE', 'QUOTE_UNAVAILABLE']).toContain(res.code);
    expect(adapter.calls.submit).toBe(0);
  });

  it('does NOT auto-resubmit when submission throws (duplicate protection)', async () => {
    seedUsdcEurc();
    const ex = makeExecutor();
    let submits = 0;
    const adapter = makeAdapter({ allowance: 1_000_000_000n }); // sufficient → reaches submit
    adapter.submitSwap = async () => { submits++; throw new Error('timeout'); };
    const res = await ex.executeDirectSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n, adapter });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('TRANSACTION_STATUS_UNKNOWN');
    expect(submits).toBe(1); // exactly one attempt, no retry
  });

  it('USDC/cirBTC direct swap executes', async () => {
    seedUsdcCirbtc();
    const ex = makeExecutor();
    const adapter = makeAdapter({ allowance: 1_000_000_000n });
    const res = await ex.executeDirectSwap({ tokenIn: 'USDC', tokenOut: 'cirBTC', amountInRaw: 100_000_000n, adapter });
    expect(res.ok).toBe(true);
    expect(res.quote.poolId).toBe('usdc-cirbtc');
  });
});

/* ════════════════════════════════════════════════════════════
   USDC/EURC execution limitation (33)
   ════════════════════════════════════════════════════════════ */
describe('USDC/EURC execution', () => {
  it('USDC/EURC executes via canonical PoolEngine quote (swap method exists)', () => {
    seedUsdcEurc();
    const ex = makeExecutor();
    const r = ex.prepareDirectSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n });
    expect(r.ok).toBe(true);
    // quote is canonical PoolEngine (no on-chain getAmountOut dependency)
    expect(r.quote.expectedOutRaw).toBe(PE.getAmountOut(100_000_000n, 1_000_000_000_000n, 1_080_000_000_000n, 10));
  });
});

/* ════════════════════════════════════════════════════════════
   No duplicate financial engine (27)
   ════════════════════════════════════════════════════════════ */
describe('No second AMM engine', () => {
  it('executor source contains no AMM/slippage/price-impact formulas', () => {
    expect(executorSrc).not.toMatch(/reserveIn \* reserveOut/);
    expect(executorSrc).not.toMatch(/amountIn \/ reserveIn/);
    expect(executorSrc).not.toMatch(/amountIn \* \(1 - fee\)/);
  });
  it('delegates minOut to SwapMath via the router (no inline slippage math)', () => {
    expect(executorSrc).not.toMatch(/\* \(1 - slippage/);
  });
});
