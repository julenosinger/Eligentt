/**
 * Bridge Multi-Token Audit 1.3 — targeted regression tests for confirmed defects.
 *
 * Tests cover:
 *  D1 – executeBridgeViaLiFi: no silent USDC fallback for missing token address
 *  D2 – history label uses selected token symbol (not hardcoded "USDC")
 *  D4 – executeBridgeOrTurbo fallback uses isEligible, not legacy .route()
 *  D5 – CCTP toast uses selected token symbol
 *  D6 – _bridgeReadBal shows "—" for tokens with no address (no USDC substitution)
 *  D7 – _bridgeGetTokenMeta returns null for token with zero address
 *  D8 – _bridgeToRaw / _bridgeFromRaw default to 6 decimals when meta is missing
 *  D9 – _fetchBridgeRoutes blocks when token not on chain (no silent fallback)
 *  D10 – validate route still runs after fix (srcToken/dstToken correctly passed)
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// ── helpers ──────────────────────────────────────────────────────────────────
/** Extract text between two anchor strings (non-inclusive). */
function between(src, start, end) {
  const si = src.indexOf(start);
  if (si === -1) return '';
  const sub = src.slice(si + start.length);
  const ei = sub.indexOf(end);
  return ei === -1 ? sub : sub.slice(0, ei);
}

/** Extract a named function body (first { ... } balanced block). */
function fnBody(src, name) {
  const sig = 'function ' + name;
  const start = src.indexOf(sig);
  if (start === -1) return '';
  let depth = 0, i = start;
  while (i < src.length) {
    if (src[i] === '{') { depth++; }
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    i++;
  }
  return '';
}

// ── D1: executeBridgeViaLiFi — no silent USDC fallback ──────────────────────
describe('D1 – executeBridgeViaLiFi: no USDC fallback for missing token address', () => {
  // Find executeBridgeViaLiFi body
  const fn = (() => {
    const marker = 'async function executeBridgeViaLiFi()';
    const start = html.indexOf(marker);
    if (start === -1) return '';
    // Take enough context for the srcToken/dstToken block
    return html.slice(start, start + 3000);
  })();

  it('srcToken uses only the selected token, no || fallback to USDC address', () => {
    // The old bad pattern was: getTokenAddressForChain(chainId, sym) || getTokenAddressForChain(chainId, 'USDC')
    expect(fn).not.toMatch(/getTokenAddressForChain\([^)]+\)\s*\|\|\s*getTokenAddressForChain\([^)]+,\s*'USDC'\)/);
  });

  it('srcToken assignment does not reference USDC as a fallback', () => {
    const srcLine = fn.split('\n').find(l => l.includes('const srcToken') || l.includes('let srcToken') || l.includes('var srcToken')) || '';
    expect(srcLine).not.toContain("'USDC'");
  });

  it('dstToken assignment does not reference USDC as a fallback', () => {
    const dstLine = fn.split('\n').find(l => l.includes('const dstToken') || l.includes('let dstToken') || l.includes('var dstToken')) || '';
    expect(dstLine).not.toContain("'USDC'");
  });

  it('has individual guards for srcToken and dstToken missing', () => {
    expect(fn).toContain('if (!srcToken)');
    expect(fn).toContain('if (!dstToken)');
  });

  it('guard message includes the selected token symbol (not hardcoded)', () => {
    // Should reference _lifiFromSym / _lifiToSym, not a hardcoded 'USDC'
    const guardBlock = between(fn, 'if (!srcToken)', 'if (!dstToken)');
    expect(guardBlock).toContain('_lifiFromSym');
  });
});

// ── D2: History labels use selected token symbol ──────────────────────────────
describe('D2 – history addToHistory labels use selected token symbol', () => {
  const cctp = (() => {
    const m = 'async function executeBridgeViaCCTP()';
    const s = html.indexOf(m);
    return s === -1 ? '' : html.slice(s, s + 8000);
  })();
  const lifi = (() => {
    const m = 'async function executeBridgeViaLiFi()';
    const s = html.indexOf(m);
    return s === -1 ? '' : html.slice(s, s + 12000);
  })();

  it('CCTP success history label uses `token` variable', () => {
    // The teal addToHistory block is unique within executeBridgeViaCCTP success path.
    // Search html directly — the CCTP fn body window is too small for this block.
    const addBlock = between(html, "sub: `CCTP v2 · ${new Date().toLocaleTimeString", "toast(`✓ Bridged");
    // Walk back to grab the label line (it precedes the sub line)
    const label = between(html, "statusEl.textContent = 'Completed'; statusEl.style.color = 'var(--green)';", "sub: `CCTP v2 ·");
    expect(label).toContain('${token}');
    expect(label).not.toMatch(/`\$\{amt\}\s*USDC:/);
  });

  it('CCTP fail history label uses `token` variable', () => {
    // The fail addToHistory is unique — search around the fail sub line.
    const label = between(html, "statusEl.textContent = 'Failed'; statusEl.style.color = 'var(--red)'", "sub: `CCTP v2 · failed`");
    expect(label).toContain('${token}');
    expect(label).not.toMatch(/`\$\{amt\}\s*USDC:/);
  });

  it('LiFi completed history label uses `_lifiFromSym`', () => {
    // Find the completed block using its unique sub line (includes toLocaleTimeString)
    const addBlock = between(html, "pollResult.completed", "toast(`✓ Bridged");
    expect(addBlock).toContain('${_lifiFromSym}');
    expect(addBlock).not.toMatch(/`\$\{amt\}\s*USDC:/);
  });

  it('LiFi FAILED state history label uses `_lifiFromSym`', () => {
    // Search the full html for the FAILED block (offset exceeds lifi window)
    const widerBlock = between(html, "LI.FI explicitly reported FAILED/ERROR", "toast('Bridge failed");
    expect(widerBlock).toContain('${_lifiFromSym}');
  });

  it('LiFi pending/settling history label uses `_lifiFromSym`', () => {
    const widerBlock = between(html, "Source confirmed but cross-chain completion not yet observed.", "toast('Source transaction");
    expect(widerBlock).toContain('${_lifiFromSym}');
  });
});

// ── D4: executeBridgeOrTurbo fallback uses isEligible, not .route() ───────────
describe('D4 – executeBridgeOrTurbo fallback: isEligible instead of .route()', () => {
  const fn = (() => {
    const m = 'function executeBridgeOrTurbo()';
    const s = html.indexOf(m);
    return s === -1 ? '' : html.slice(s, s + 4200);
  })();

  it('fallback path calls BridgeKitRouter.isEligible', () => {
    const fallback = between(fn, 'Fallback: no routes loaded', 'executeBridgeViaLiFi()');
    expect(fallback).toContain('BridgeKitRouter.isEligible(');
  });

  it('fallback path does NOT use BridgeKitRouter.route(...).provider', () => {
    const fallback = between(fn, 'Fallback: no routes loaded', 'executeBridgeViaLiFi()');
    // The comment mentions ".route()" as context — check the actual code does not
    // call it as a routing expression (e.g. .route(...).provider === 'cctp')
    expect(fallback).not.toMatch(/BridgeKitRouter\.route\(/);
  });

  it('isEligible guard checks fromChain, toChain, token', () => {
    const fallback = between(fn, 'Fallback: no routes loaded', 'executeBridgeViaLiFi()');
    expect(fallback).toMatch(/isEligible\(fromChain\.chainId,\s*toChain\.chainId,\s*token\)/);
  });
});

// ── D5: CCTP step labels use selected token ───────────────────────────────────
describe('D5 – executeBridgeViaCCTP: step labels use selected token', () => {
  const fn = (() => {
    const m = 'async function executeBridgeViaCCTP()';
    const s = html.indexOf(m);
    return s === -1 ? '' : html.slice(s, s + 5000);
  })();

  it('approve step label uses `token` variable, not hardcoded USDC', () => {
    expect(fn).toContain('Approve ${token}');
    expect(fn).not.toContain('Approve USDC');
  });

  it('burn step label uses `token` variable', () => {
    expect(fn).toContain('Burn ${token}');
    expect(fn).not.toContain('Burn USDC');
  });

  it('mint step label uses `token` variable', () => {
    expect(fn).toContain('Mint ${token}');
    expect(fn).not.toContain('Mint USDC');
  });
});

// ── D6 / D7: _bridgeGetTokenMeta returns null for zero/missing address ─────────
describe('D6/D7 – _bridgeGetTokenMeta: null for tokens with no valid address', () => {
  it('filters out zero address (0x000...000)', () => {
    expect(html).toContain("t.address === '0x0000000000000000000000000000000000000000'");
  });

  it('_bridgeGetTokenMeta checks both address presence and non-zero value', () => {
    const fn = fnBody(html, '_bridgeGetTokenMeta');
    expect(fn).toContain('!t.address');
    expect(fn).toContain('0x0000000000000000000000000000000000000000');
    expect(fn).toContain('return null');
  });

  it('_bridgeReadBal shows "—" when token has no address (no USDC fallback)', () => {
    const fn = fnBody(html, '_bridgeReadBal');
    // Guard fires before RPC call
    expect(fn).toContain("set(elId, '—')");
    // The old USDC fallback pattern must not be present
    expect(fn).not.toContain("|| getTokenAddressForChain");
    expect(fn).not.toContain("'USDC'");
  });
});

// ── D8: _bridgeToRaw / _bridgeFromRaw ─────────────────────────────────────────
describe('D8 – _bridgeToRaw / _bridgeFromRaw: safe decimal defaults', () => {
  it('_bridgeToRaw falls back to 6 decimals when meta is missing', () => {
    const fn = fnBody(html, '_bridgeToRaw');
    expect(fn).toContain('meta ? meta.decimals : 6');
  });

  it('_bridgeFromRaw falls back to 6 decimals when meta is missing', () => {
    const fn = fnBody(html, '_bridgeFromRaw');
    expect(fn).toContain('meta ? meta.decimals : 6');
  });

  it('_bridgeToRaw uses Math.round to avoid float precision errors', () => {
    const fn = fnBody(html, '_bridgeToRaw');
    expect(fn).toContain('Math.round(');
  });
});

// ── D9: _fetchBridgeRoutes blocks when token not on chain ─────────────────────
describe('D9 – _fetchBridgeRoutes: blocks execution for tokens not on chain', () => {
  const fn = (() => {
    const m = 'async function _fetchBridgeRoutes(';
    const s = html.indexOf(m);
    return s === -1 ? '' : html.slice(s, s + 4000);
  })();

  it('returns [] immediately when fromMeta is null (source token not on chain)', () => {
    expect(fn).toContain('if (!fromMeta) return []');
  });

  it('returns [] immediately when toMeta is null (dest token not on chain)', () => {
    expect(fn).toContain('if (!toMeta)   return []');
  });

  it('does NOT fall back to USDC address when fromMeta is null', () => {
    // The old bad pattern was: fromSym = 'USDC'; fromMeta = ...USDC...
    const guardBlock = between(fn, 'if (!fromMeta)', 'if (!toMeta)');
    expect(guardBlock).not.toContain("fromSym = 'USDC'");
    expect(guardBlock).not.toContain("bridgeFromToken = 'USDC'");
  });

  it('passes token address objects (not just symbols) to LiFiAdapter.getRoutes', () => {
    expect(fn).toContain('address: fromMeta.address');
    expect(fn).toContain('address: toMeta.address');
  });
});

// ── D10: validateRoute still receives correct srcToken/dstToken after fix ─────
describe('D10 – LiFi validate route: correct token addresses used', () => {
  const lifi = (() => {
    const m = 'async function executeBridgeViaLiFi()';
    const s = html.indexOf(m);
    return s === -1 ? '' : html.slice(s, s + 13000);
  })();

  it('validateRoute is still called', () => {
    expect(lifi).toContain('LiFiAdapter.validateRoute(');
  });

  it('validateRoute receives srcToken (selected token address, not USDC)', () => {
    // validateRoute args span multiple lines; use the full multi-line block
    const block = between(lifi, 'LiFiAdapter.validateRoute(_routeForValidation', 'if (!vres.ok)');
    expect(block).toContain('fromToken: srcToken');
    expect(block).toContain('toToken: dstToken');
  });

  it('validateRoute receives fromChain and toChain IDs', () => {
    // validateRoute call is multi-line; search for each key in the wider LiFi body
    const validateBlock = between(lifi, 'LiFiAdapter.validateRoute(_routeForValidation', 'if (!vres.ok)');
    expect(validateBlock).toContain('fromChainId: fromChain.chainId');
    expect(validateBlock).toContain('toChainId: toChain.chainId');
  });

  it('validateRoute receives the correct recipient address', () => {
    const validateBlock = between(lifi, 'LiFiAdapter.validateRoute(_routeForValidation', 'if (!vres.ok)');
    expect(validateBlock).toContain('recipient: walletAddress');
  });

  it('approval uses srcToken (selected token), not a hardcoded USDC address', () => {
    // Comment is "3. ERC-20 approval on the LI.FI spender"; stop before renderBridgeStep(1, 'success'
    const approveBlock = between(lifi, 'ERC-20 approval on the LI.FI spender', "renderBridgeStep(1, 'success'");
    expect(approveBlock).toContain('new ethers.Contract(srcToken');
  });
});

// ── EURC CCTP chain pair validation (existing + extended) ────────────────────
describe('EURC CCTP eligibility: isEligible gates per-chain EURC support', () => {
  it('EURC_CCTP_CHAINS is defined in bridgeKitRouter.js', () => {
    const router = fs.readFileSync(
      path.join(__dirname, '..', 'shared', 'bridgeKitRouter.js'), 'utf8'
    );
    expect(router).toContain('EURC_CCTP_CHAINS');
    expect(router).toContain('5042');  // Arc
    expect(router).toContain('8453');  // Base
  });

  it('isEligible rejects EURC for chains not in EURC_CCTP_CHAINS', () => {
    const router = fs.readFileSync(
      path.join(__dirname, '..', 'shared', 'bridgeKitRouter.js'), 'utf8'
    );
    // isEligible calls isEurcCctpChain() which checks EURC_CCTP_CHAINS
    const eligFn = fnBody(router, 'isEligible');
    expect(eligFn).toContain('isEurcCctpChain');
    expect(eligFn).toContain("'EURC'");
  });

  it('executeBridgeViaCCTP isEligible guard present (not just isCCTPToken check)', () => {
    const fn = (() => {
      const m = 'async function executeBridgeViaCCTP()';
      const s = html.indexOf(m);
      return s === -1 ? '' : html.slice(s, s + 1500);
    })();
    expect(fn).toContain('BridgeKitRouter.isEligible(');
    expect(fn).not.toContain('BridgeKitRouter.isCCTPToken(');
  });
});
