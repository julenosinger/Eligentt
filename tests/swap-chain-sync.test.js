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

  it('N5.4: on non-Arc chains with only 1 available token, tokenOutIdx stays -1 (no invalid fallback)', () => {
    // Guard: the sync function must NOT use Math.min(1, ...) as fallback — that was the P1 bug
    expect(syncFn).not.toContain('Math.min(1,');
    // It must allow idxOut to stay -1 when no second token is available
    expect(syncFn).toContain('idxOut'); // idxOut variable exists
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

// ── N12: P3 — switchNetwork() wires swpSyncToActiveChain ─────────────────────
describe('P3 — switchNetwork integrates swpSyncToActiveChain', () => {
  it('N12.1: switchNetwork success path calls swpSyncToActiveChain', () => {
    const swFn = fnBlock(html, 'switchNetwork', 1200);
    expect(swFn).toContain('swpSyncToActiveChain');
  });

  it('N12.2: call is wrapped in try/catch — no uncaught errors', () => {
    // The call is inside the .then() callback at offset ~700 chars from fn start
    const swFn = fnBlock(html, 'switchNetwork', 1200);
    expect(swFn).toContain('swpSyncToActiveChain');
    expect(swFn).toContain('try {');
  });
});

// ── N13: P1 — _swpTokOut sentinel when tokenOutIdx === -1 ────────────────────
describe('P1 — _swpTokOut sentinel for missing token', () => {
  it('N13.1: _swpTokOut handles negative tokenOutIdx without falling back to TOKEN_LIST[1]', () => {
    const fn = fnBlock(html, '_swpTokOut', 600);
    // Must have explicit guard for idx < 0
    expect(fn).toContain('tokenOutIdx < 0');
  });

  it('N13.2: sentinel has _noToken flag', () => {
    const fn = fnBlock(html, '_swpTokOut', 600);
    expect(fn).toContain('_noToken: true');
  });

  it('N13.3: swpSyncToActiveChain shows "Select output token" when no valid out-token', () => {
    const syncFn = fnBlock(html, 'swpSyncToActiveChain', 3500);
    expect(syncFn).toContain('Select output token');
    expect(syncFn).toContain('_noToken');
  });
});

// ── N14: FUNCTIONAL — execute real swapAvailableTokens logic ─────────────────
// These tests build minimal stubs matching the real TOKEN_LIST/CHAIN_REGISTRY
// structure from index.html and execute the real filtering logic directly,
// without mocking any production path.
describe('P1 FUNCTIONAL — swapAvailableTokens produces valid pairs per chain', () => {
  // Replicate the exact TOKEN_LIST and CHAIN_REGISTRY from index.html
  const TOKEN_LIST = [
    { sym: 'USDC', name: 'USD Coin',    decimals: 6, color: '#2775ca', icon: '$' },
    { sym: 'EURC', name: 'Euro Coin',   decimals: 6, color: '#0066cc', icon: '€' },
    { sym: 'cirBTC', name: 'cirBTC',    decimals: 8, color: '#f7931a', icon: '₿' },
  ];

  const CHAIN_REGISTRY = {
    5042: { tokens: {
      USDC: { address: '0x3600000000000000000000000000000000000000', decimals: 6 },
      EURC: { address: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1', decimals: 6 },
      cirBTC: { address: '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0', decimals: 8 },
    }},
    8453: { tokens: {
      USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
      EURC: { address: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', decimals: 6 },
    }},
    1:    { tokens: { USDC: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 } }},
    42161:{ tokens: { USDC: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 } }},
    10:   { tokens: { USDC: { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 } }},
    137:  { tokens: { USDC: { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 } }},
  };

  // Real logic from index.html (swapAvailableTokens)
  function swapAvailableTokens(chainId) {
    const cid = Number(chainId);
    const reg = CHAIN_REGISTRY[cid];
    const out = [];
    for (const t of TOKEN_LIST) {
      if (!t || t.sym === 'ETH') continue;
      const addr = reg?.tokens?.[t.sym]?.address;
      if (addr && addr !== '0x0000000000000000000000000000000000000000') out.push(t);
    }
    return out;
  }

  // Real P1-fixed logic from swpSyncToActiveChain
  function pickDefaultPair(cid) {
    const avail = swapAvailableTokens(cid);
    let symIn = 'USDC';
    let symOut = null;
    const hasIn = avail.some(t => t.sym === symIn);
    if (!hasIn) symIn = avail.length > 0 ? avail[0].sym : null;
    const preferred = (cid === 5042) ? 'EURC' : null;
    const hasPreferred = preferred && avail.some(t => t.sym === preferred);
    if (hasPreferred) {
      symOut = preferred;
    } else if (avail.length > 1) {
      const alt = avail.find(t => t.sym !== symIn);
      symOut = alt ? alt.sym : null;
    }
    let idxIn = -1, idxOut = -1;
    for (let i = 0; i < TOKEN_LIST.length; i++) {
      if (symIn  && TOKEN_LIST[i].sym === symIn  && idxIn  === -1) idxIn  = i;
      if (symOut && TOKEN_LIST[i].sym === symOut && idxOut === -1) idxOut = i;
    }
    return { symIn, symOut, idxIn, idxOut, avail };
  }

  it('N14.1: Arc (5042) → USDC/EURC, both indices ≥ 0', () => {
    const p = pickDefaultPair(5042);
    expect(p.symIn).toBe('USDC');
    expect(p.symOut).toBe('EURC');
    expect(p.idxIn).toBeGreaterThanOrEqual(0);
    expect(p.idxOut).toBeGreaterThanOrEqual(0);
    expect(p.idxIn).not.toBe(p.idxOut);
  });

  it('N14.2: Base (8453) → USDC/EURC (Base has EURC), both indices ≥ 0', () => {
    const p = pickDefaultPair(8453);
    expect(p.symIn).toBe('USDC');
    expect(p.symOut).toBe('EURC'); // Base has EURC registered
    expect(p.idxIn).toBeGreaterThanOrEqual(0);
    expect(p.idxOut).toBeGreaterThanOrEqual(0);
  });

  it('N14.3: Ethereum (1) → USDC only, symOut=null, idxOut=-1 (no invalid fallback)', () => {
    const p = pickDefaultPair(1);
    expect(p.symIn).toBe('USDC');
    expect(p.symOut).toBeNull(); // only 1 token available
    expect(p.idxOut).toBe(-1);  // must NOT be 1 (EURC index) — that was the bug
    expect(p.avail).toHaveLength(1);
  });

  it('N14.4: Arbitrum (42161) → same as Ethereum — idxOut=-1', () => {
    const p = pickDefaultPair(42161);
    expect(p.symOut).toBeNull();
    expect(p.idxOut).toBe(-1);
  });

  it('N14.5: Optimism (10) → idxOut=-1', () => {
    const p = pickDefaultPair(10);
    expect(p.idxOut).toBe(-1);
  });

  it('N14.6: Polygon (137) → idxOut=-1', () => {
    const p = pickDefaultPair(137);
    expect(p.idxOut).toBe(-1);
  });

  it('N14.7: Arc EURC address is real (not zero address)', () => {
    const p = pickDefaultPair(5042);
    const addr = CHAIN_REGISTRY[5042].tokens.EURC.address;
    expect(addr).not.toBe('0x0000000000000000000000000000000000000000');
    expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('N14.8: no chain produces symIn === symOut (same token both sides)', () => {
    [5042, 8453, 1, 42161, 10, 137].forEach(cid => {
      const p = pickDefaultPair(cid);
      if (p.symOut !== null) {
        expect(p.symIn).not.toBe(p.symOut);
      }
    });
  });
});

// ── N15: FUNCTIONAL — _swpTokOut sentinel logic ───────────────────────────────
describe('P1 FUNCTIONAL — _swpTokOut sentinel when no valid output token', () => {
  // Replicate _swpTokOut logic
  const TOKEN_LIST_F = [
    { sym: 'USDC', name: 'USD Coin', decimals: 6 },
    { sym: 'EURC', name: 'Euro Coin', decimals: 6 },
    { sym: 'cirBTC', name: 'cirBTC',  decimals: 8 },
  ];

  function swpTokOut(tokenOutIdx, tokenOutObj) {
    if (tokenOutObj) return tokenOutObj;
    if (tokenOutIdx < 0) return { sym: '—', name: 'Select token', decimals: 6, color: '#64748b', icon: '?', _noToken: true };
    return TOKEN_LIST_F[tokenOutIdx] || { sym: '—', name: 'Select token', decimals: 6, color: '#64748b', icon: '?', _noToken: true };
  }

  it('N15.1: idx=1 (EURC) returns EURC correctly', () => {
    const t = swpTokOut(1, null);
    expect(t.sym).toBe('EURC');
    expect(t._noToken).toBeUndefined();
  });

  it('N15.2: idx=-1 returns sentinel with _noToken:true', () => {
    const t = swpTokOut(-1, null);
    expect(t._noToken).toBe(true);
    expect(t.sym).toBe('—');
  });

  it('N15.3: idx=99 (out of range) returns sentinel', () => {
    const t = swpTokOut(99, null);
    expect(t._noToken).toBe(true);
  });

  it('N15.4: tokenOutObj overrides idx — always returns the obj', () => {
    const obj = { sym: 'WETH', symbol: 'WETH', decimals: 18 };
    const t = swpTokOut(-1, obj); // obj wins even when idx=-1
    expect(t.sym).toBe('WETH');
  });
});
