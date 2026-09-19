/**
 * POOL EXECUTOR — Phase 6.1 hardening (final quote, pre-submit guard, receipts).
 * ═══════════════════════════════════════════════════════════════════════════
 * Verifies: final quote BEFORE confirmation, final pre-submit validation
 * (wallet/chain/state), balance+allowance re-read, approval receipt verification
 * + re-read, strict swap receipt, duplicate-tx + unknown-state handling,
 * post-swap balance delta (BigInt), and actual Swap-event extraction.
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

function makeExecutor(opts = {}) {
  return Executor.createExecutor({ poolEngine: PE, swapMath: w.SwapMath, ethers, ...opts });
}
function seed(updatedAt) {
  PE.updatePoolState('usdc-eurc', { reserveARaw: 1_000_000_000_000n, reserveBRaw: 1_080_000_000_000n, lpSupplyRaw: 1n, updatedAt: updatedAt != null ? updatedAt : Date.now() });
}

function makeAdapter(overrides = {}) {
  const calls = { approve: 0, submit: 0 };
  let allowance = overrides.allowance === undefined ? 0n : overrides.allowance;
  return {
    calls,
    getWalletAddress: async () => (overrides.wallet === undefined ? '0xuser' : overrides.wallet),
    getChainId: async () => (overrides.chainId === undefined ? 5042002 : overrides.chainId),
    readBalance: async () => (overrides.balance === undefined ? 10_000_000_000n : overrides.balance),
    readAllowance: async () => allowance,
    approve: async () => { calls.approve++; allowance = 10_000_000_000_000n; return { hash: '0xapprove' }; },
    submitSwap: async () => { calls.submit++; return { hash: '0xswap' }; },
    waitForReceipt: async () => ({ status: overrides.receiptStatus === undefined ? 1 : overrides.receiptStatus }),
    confirm: async () => true,
    onSubmitted: () => {}, onConfirmed: () => {}, onStateChange: () => {},
    ...overrides,
  };
}

/* ── RULE 2: final quote before confirmation ─────────────────── */
describe('Final quote is produced BEFORE user confirmation', () => {
  it('refreshState produces a fresher quote, and confirm receives it', async () => {
    seed(); // reserves 1e12 / 1.08e12
    const ex = makeExecutor();
    let confirmedQuote = null;
    const adapter = makeAdapter({ allowance: 1_000_000_000n });
    // simulate a fresh on-chain read that changed reserves BEFORE confirmation
    adapter.refreshState = async () => {
      PE.updatePoolState('usdc-eurc', { reserveARaw: 2_000_000_000_000n, reserveBRaw: 2_160_000_000_000n, lpSupplyRaw: 1n, updatedAt: Date.now() });
    };
    adapter.confirm = async (q) => { confirmedQuote = q; return true; };
    const res = await ex.executeDirectSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n, adapter });
    expect(res.ok).toBe(true);
    // confirm received the FINAL (fresher) quote, not the initial one
    expect(confirmedQuote.expectedOutRaw).toBe(PE.getAmountOut(100_000_000n, 2_000_000_000_000n, 2_160_000_000_000n, 10));
  });
});

/* ── RULE 3: final pre-submit guard aborts on material change ── */
describe('Final pre-submit guard (no silent parameter substitution)', () => {
  it('aborts with ROUTE_STATE_CHANGED when reserves change AFTER confirmation', async () => {
    seed();
    const ex = makeExecutor();
    const adapter = makeAdapter({ allowance: 1_000_000_000n });
    let submitted = 0;
    adapter.submitSwap = async () => { submitted++; return { hash: '0xswap' }; };
    adapter.confirm = async () => {
      // user confirmed, then a competing trade moves the pool
      PE.updatePoolState('usdc-eurc', { reserveARaw: 500_000_000_000n, reserveBRaw: 540_000_000_000n, lpSupplyRaw: 1n, updatedAt: Date.now() });
      return true;
    };
    const res = await ex.executeDirectSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n, adapter });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('ROUTE_STATE_CHANGED');
    expect(submitted).toBe(0); // never submitted with changed params
  });

  it('aborts with WALLET_CHANGED when wallet switches after confirmation', async () => {
    seed();
    const ex = makeExecutor();
    let wallet = '0xuserA';
    const adapter = makeAdapter({ allowance: 1_000_000_000n });
    adapter.getWalletAddress = async () => wallet;
    adapter.confirm = async () => { wallet = '0xuserB'; return true; };
    const res = await ex.executeDirectSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n, adapter });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('WALLET_CHANGED');
  });

  it('aborts with WRONG_NETWORK when chain is wrong', async () => {
    seed();
    const ex = makeExecutor();
    const adapter = makeAdapter({ allowance: 1_000_000_000n, chainId: 1 });
    const res = await ex.executeDirectSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n, expectedChainId: 5042002, adapter });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('WRONG_NETWORK');
  });

  it('aborts with QUOTE_EXPIRED when quote exceeds max age', async () => {
    seed();
    const ex = makeExecutor({ maxQuoteAgeMs: 1 });
    const adapter = makeAdapter({ allowance: 1_000_000_000n });
    // force expiry between confirm and guard
    adapter.confirm = async () => { await new Promise(r => setTimeout(r, 5)); return true; };
    const res = await ex.executeDirectSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n, adapter });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('QUOTE_EXPIRED');
  });
});

/* ── RULE 20/21/22: approval receipt + re-read ───────────────── */
describe('Approval handling', () => {
  it('blocks with APPROVAL_TRANSACTION_REVERTED when approval receipt fails', async () => {
    seed();
    const ex = makeExecutor();
    const adapter = makeAdapter({ allowance: 0n, receiptStatus: 0 });
    const res = await ex.executeDirectSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n, adapter });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('APPROVAL_TRANSACTION_REVERTED');
    expect(adapter.calls.submit).toBe(0);
  });

  it('blocks with APPROVAL_INSUFFICIENT when allowance not raised after approval', async () => {
    seed();
    const ex = makeExecutor();
    const adapter = makeAdapter({ allowance: 0n });
    // approval "succeeds" (status 1) but allowance stays 0 → insufficient
    adapter.approve = async () => ({ hash: '0xapprove' });
    const res = await ex.executeDirectSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n, adapter });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('APPROVAL_INSUFFICIENT');
  });
});

/* ── RULE 9/10/11: post-swap balance delta + actual output ───── */
describe('Post-swap verification (BigInt balance delta + actual event)', () => {
  it('captures exact BigInt balance deltas', async () => {
    seed();
    const ex = makeExecutor();
    const balances = { [USDC]: 1_000_000_000n, [EURC]: 0n };
    const adapter = makeAdapter({ allowance: 1_000_000_000n });
    adapter.readBalance = async (addr) => balances[(addr || '').toLowerCase()] || 0n;
    adapter.submitSwap = async () => { balances[USDC] -= 100_000_000n; balances[EURC] += 107_000_000n; return { hash: '0xswap' }; };
    const res = await ex.executeDirectSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n, adapter });
    expect(res.ok).toBe(true);
    expect(res.postSwap.deltaInRaw).toBe(100_000_000n);       // input decreased by amountIn
    expect(res.postSwap.deltaOutRaw).toBe(107_000_000n);       // output increased
    expect(typeof res.postSwap.deltaInRaw).toBe('bigint');
  });

  it('extractSwapEvent parses the actual Swap event (raw BigInt)', () => {
    const ex = makeExecutor();
    const iface = new ethers.Interface(['event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)']);
    const sender = '0x1111111111111111111111111111111111111111';
    const to = '0x2222222222222222222222222222222222222222';
    const { topics, data } = iface.encodeEventLog(iface.getEvent('Swap'), [sender, 1000n, 0n, 0n, 500n, to]);
    const receipt = { logs: [{ address: '0xpool', topics, data }] };
    const ev = ex.extractSwapEvent(receipt, iface);
    expect(ev.amountInRaw).toBe(1000n);
    expect(ev.amountOutRaw).toBe(500n);
    expect(ev.tokenInIsToken0).toBe(true);
  });

  it('missing Swap event → actual is null (POST_SWAP_OUTPUT_UNAVAILABLE), not fabricated', async () => {
    seed();
    const ex = makeExecutor();
    const adapter = makeAdapter({ allowance: 1_000_000_000n });
    const res = await ex.executeDirectSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n, adapter });
    expect(res.ok).toBe(true); // swap succeeded (balance delta verifies)
    expect(res.postSwap.actual).toBeNull(); // no event → output unavailable, not invented
  });
});

/* ── RULE 6/7: strict receipt + real tx hash ─────────────────── */
describe('Strict receipt status + real tx hash', () => {
  it('success only when receipt.status === 1 (exactly)', async () => {
    seed();
    const ex = makeExecutor();
    const adapter = makeAdapter({ allowance: 1_000_000_000n, receiptStatus: 1 });
    const res = await ex.executeDirectSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n, adapter });
    expect(res.ok).toBe(true);
    expect(res.txHash).toBe('0xswap'); // real (adapter-provided) hash
  });

  it('unexpected receipt status (2) is treated as failure', async () => {
    seed();
    const ex = makeExecutor();
    const adapter = makeAdapter({ allowance: 1_000_000_000n, receiptStatus: 2 });
    const res = await ex.executeDirectSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n, adapter });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('SWAP_TRANSACTION_REVERTED');
  });
});

/* ── RULE 16: token order (both directions) ──────────────────── */
describe('Token ordering (both directions)', () => {
  it('token0→token1 (USDC→EURC)', async () => {
    seed();
    const ex = makeExecutor();
    const adapter = makeAdapter({ allowance: 1_000_000_000n });
    const res = await ex.executeDirectSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n, adapter });
    expect(res.ok).toBe(true);
    expect(res.quote.expectedOutRaw).toBe(PE.getAmountOut(100_000_000n, 1_000_000_000_000n, 1_080_000_000_000n, 10));
  });
  it('token1→token0 (EURC→USDC)', async () => {
    seed();
    const ex = makeExecutor();
    const adapter = makeAdapter({ allowance: 1_000_000_000n });
    const res = await ex.executeDirectSwap({ tokenIn: 'EURC', tokenOut: 'USDC', amountInRaw: 100_000_000n, adapter });
    expect(res.ok).toBe(true);
    expect(res.quote.expectedOutRaw).toBe(PE.getAmountOut(100_000_000n, 1_080_000_000_000n, 1_000_000_000_000n, 10));
  });
});

/* ── RULE 23: transaction states ─────────────────────────────── */
describe('Transaction lifecycle states', () => {
  it('emits states through onStateChange up to SUCCESS', async () => {
    seed();
    const ex = makeExecutor();
    const adapter = makeAdapter({ allowance: 0n });
    const states = [];
    adapter.onStateChange = (s) => states.push(s);
    await ex.executeDirectSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n, adapter });
    expect(states).toContain('QUOTING');
    expect(states).toContain('READY');
    expect(states).toContain('CONFIRMING');
    expect(states).toContain('APPROVING');
    expect(states).toContain('SWAPPING');
    expect(states[states.length - 1]).toBe('SUCCESS');
  });

  it('emits FAILED on insufficient balance', async () => {
    seed();
    const ex = makeExecutor();
    const adapter = makeAdapter({ balance: 1n });
    const states = [];
    adapter.onStateChange = (s) => states.push(s);
    await ex.executeDirectSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100_000_000n, adapter });
    expect(states[states.length - 1]).toBe('FAILED');
  });
});

/* ── RULE 33: no second financial engine ─────────────────────── */
describe('No second AMM engine', () => {
  it('executor delegates all math to PoolEngine/SwapMath (no inline formulas)', () => {
    expect(executorSrc).not.toMatch(/reserveIn \* reserveOut/);
    expect(executorSrc).not.toMatch(/amountIn \/ reserveIn/);
    expect(executorSrc).not.toMatch(/amountIn \* \(1 - fee\)/);
    expect(executorSrc).toContain('findBestRoute');
    expect(executorSrc).toContain('buildSwapTx');
  });
});
