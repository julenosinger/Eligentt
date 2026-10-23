/**
 * swap-chain-sync.test.js
 * Targeted tests for swpSyncToActiveChain — Swap Standard network synchronization.
 * Verifies the function exists, resets chain/token/quote state correctly, and is
 * registered on chainChanged / WALLET_CONNECTED / WALLET_SWITCHED.
 * These are structural (static code analysis) tests — no live chain calls.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');

// ── helpers ──────────────────────────────────────────────────────────────────

/** Extract up to `size` chars starting at the first occurrence of `anchor`. */
function blockAt(text, anchor, size = 2000) {
  const idx = text.indexOf(anchor);
  if (idx === -1) return '';
  return text.slice(idx, idx + size);
}

/** Extract the body of a named function (from `function name(` to its closing `}`). */
function fnBlock(text, name, size = 3000) {
  return blockAt(text, 'function ' + name + '(', size);
}

// ── N1: function exists and is properly structured ───────────────────────────
describe('swpSyncToActiveChain — existence and structure', () => {
  const syncFn = fnBlock(html, 'swpSyncToActiveChain', 3000);

  it('N1.1: function is defined', () => {
    expect(syncFn).not.toBe('');
    expect(syncFn).toContain('function swpSyncToActiveChain(');
  });

  it('N1.2: guard variable _swpSyncChainLast declared', () => {
    expect(html).toContain('_swpSyncChainLast');
  });

  it('N1.3: reads activeChainId with fallback to 5042', () => {
    expect(syncFn).toContain('activeChainId');
    expect(syncFn).toContain('5042');
  });

  it('N1.4: idempotent — returns early when chainId unchanged', () => {
    expect(syncFn).toContain('_swpSyncChainLast');
    expect(syncFn).toContain('return');
  });
});

// ── N2: chain IDs reset ───────────────────────────────────────────────────────
describe('swpSyncToActiveChain — chain ID reset', () => {
  const syncFn = fnBlock(html, 'swpSyncToActiveChain', 3000);

  it('N2.1: sets SWP.fromChainId to active chain', () => {
    expect(syncFn).toContain('SWP.fromChainId = cid');
  });

  it('N2.2: sets SWP.toChainId to active chain', () => {
    expect(syncFn).toContain('SWP.toChainId   = cid');
  });
});

// ── N3: token objects cleared ─────────────────────────────────────────────────
describe('swpSyncToActiveChain — token objects cleared', () => {
  const syncFn = fnBlock(html, 'swpSyncToActiveChain', 3000);

  it('N3.1: clears SWP.tokenInObj', () => {
    expect(syncFn).toContain('SWP.tokenInObj  = null');
  });

  it('N3.2: clears SWP.tokenOutObj', () => {
    expect(syncFn).toContain('SWP.tokenOutObj = null');
  });
});

// ── N4: quote state invalidation ─────────────────────────────────────────────
describe('swpSyncToActiveChain — quote state invalidation', () => {
  const syncFn = fnBlock(html, 'swpSyncToActiveChain', 3000);

  it('N4.1: clears SWP.lastQuote', () => {
    expect(syncFn).toContain('SWP.lastQuote');
    expect(syncFn).toContain('= null');
  });

  it('N4.2: clears SWP.aggQuotes', () => {
    expect(syncFn).toContain('SWP.aggQuotes');
  });

  it('N4.3: increments _swapQuoteSeq to invalidate in-flight callbacks', () => {
    expect(syncFn).toContain('_swapQuoteSeq++');
  });

  it('N4.4: clears quoteTimer', () => {
    expect(syncFn).toContain('SWP.quoteTimer');
    expect(syncFn).toContain('clearTimeout');
  });
});

// ── N5: default pair selection ────────────────────────────────────────────────
describe('swpSyncToActiveChain — default token pair selection', () => {
  const syncFn = fnBlock(html, 'swpSyncToActiveChain', 3000);

  it('N5.1: calls swapAvailableTokens with the new chain', () => {
    expect(syncFn).toContain('swapAvailableTokens(cid)');
  });

  it('N5.2: prefers USDC as from-token', () => {
    expect(syncFn).toContain("'USDC'");
  });

  it('N5.3: prefers EURC on Arc (5042)', () => {
    expect(syncFn).toContain('5042');
    expect(syncFn).toContain("'EURC'");
  });

  it('N5.4: prefers ETH on non-Arc chains', () => {
    expect(syncFn).toContain("'ETH'");
  });

  it('N5.5: updates SWP.tokenInIdx', () => {
    expect(syncFn).toContain('SWP.tokenInIdx');
  });

  it('N5.6: updates SWP.tokenOutIdx', () => {
    expect(syncFn).toContain('SWP.tokenOutIdx');
  });
});

// ── N6: UI update calls ───────────────────────────────────────────────────────
describe('swpSyncToActiveChain — UI update calls', () => {
  const syncFn = fnBlock(html, 'swpSyncToActiveChain', 3000);

  it('N6.1: calls applySwapTokens', () => {
    expect(syncFn).toContain('applySwapTokens()');
  });

  it('N6.2: calls swpSyncStdHeader', () => {
    expect(syncFn).toContain('swpSyncStdHeader()');
  });

  it('N6.3: clears swap-amount-out', () => {
    expect(syncFn).toContain('swap-amount-out');
  });
});

// ── N7: trigger points ────────────────────────────────────────────────────────
describe('swpSyncToActiveChain — registered on all trigger points', () => {
  it('N7.1: called in chainChanged handler', () => {
    const chainChangedBlock = blockAt(html, 'raw.on(\'chainChanged\'', 1100);
    expect(chainChangedBlock).toContain('swpSyncToActiveChain');
  });

  it('N7.2: called in WALLET_CONNECTED listener', () => {
    // The UB WALLET_CONNECTED listener at line ~45391 now includes swpSyncToActiveChain
    const wcBlock = blockAt(html, 'addEventListener(\'WALLET_CONNECTED\', function() {\n  _ubBumpGeneration', 600);
    expect(wcBlock).toContain('swpSyncToActiveChain');
  });

  it('N7.3: called in WALLET_SWITCHED listener', () => {
    const wsBlock = blockAt(html, 'addEventListener(\'WALLET_SWITCHED\', function() {\n  _ubBumpGeneration', 600);
    expect(wsBlock).toContain('swpSyncToActiveChain');
  });

  it('N7.4: each call is wrapped in try/catch — no uncaught errors', () => {
    // Count occurrences: each must be inside a try block
    const tryWrap = /try\s*\{[^}]*swpSyncToActiveChain[^}]*\}/g;
    const matches = html.match(tryWrap);
    expect(matches).not.toBeNull();
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });
});

// ── N8: no duplicate listener registration ────────────────────────────────────
describe('swpSyncToActiveChain — no duplicate registrations', () => {
  it('N8.1: _swpSyncChainLast guard variable declared exactly once', () => {
    const decls = (html.match(/var _swpSyncChainLast\s*=/g) || []).length;
    expect(decls).toBe(1);
  });

  it('N8.2: swpSyncToActiveChain function declared exactly once', () => {
    const decls = (html.match(/function swpSyncToActiveChain\s*\(/g) || []).length;
    expect(decls).toBe(1);
  });
});

// ── N9: stale async guard — _swapQuoteSeq ─────────────────────────────────────
describe('swpSyncToActiveChain — stale async response prevention', () => {
  it('N9.1: increments _swapQuoteSeq on sync to invalidate in-flight LI.FI callbacks', () => {
    const syncFn = fnBlock(html, 'swpSyncToActiveChain', 3000);
    expect(syncFn).toContain('_swapQuoteSeq++');
  });

  it('N9.2: updateSwapRate uses _swapQuoteSeq as race guard', () => {
    const rateFn = fnBlock(html, 'updateSwapRate', 5000);
    expect(rateFn).toContain('_swapQuoteSeq');
  });
});

// ── N10: existing applySwapTokens untouched ────────────────────────────────────
describe('regression — applySwapTokens still renders badges', () => {
  const applyFn = fnBlock(html, 'applySwapTokens', 1000);

  it('N10.1: applySwapTokens still exists', () => {
    expect(applyFn).not.toBe('');
  });

  it('N10.2: still renders swp-net-in badge', () => {
    expect(applyFn).toContain('swp-net-in');
  });

  it('N10.3: still renders swp-net-out badge', () => {
    expect(applyFn).toContain('swp-net-out');
  });
});

// ── N11: SWP object still has all required fields ─────────────────────────────
describe('regression — SWP object structure unchanged', () => {
  it('N11.1: SWP.fromChainId initialized to 5042', () => {
    const swpBlock = blockAt(html, 'const SWP = {', 1200);
    expect(swpBlock).toContain('fromChainId: 5042');
  });

  it('N11.2: SWP.toChainId initialized to 5042', () => {
    const swpBlock = blockAt(html, 'const SWP = {', 1200);
    expect(swpBlock).toContain('toChainId: 5042');
  });
});
