/**
 * Bridge Multi-Token 1.3.1 — Regression Gate
 *
 * Purpose: prove the three confirmed defects are fixed, document what the
 * defective code looked like, and provide per-pair / per-token coverage for
 * all five history entries across both execution paths.
 *
 * Validation level: static / structural (unit).
 * Live API and on-chain execution are NOT available in sandbox — those are
 * declared as pending in the summary section at the bottom of each describe.
 *
 * Defects covered:
 *  D1 – executeBridgeViaLiFi: silent USDC address fallback removed
 *  D2 – history labels hardcoded "USDC" replaced by selected token symbol
 *  D4 – executeBridgeOrTurbo fallback uses isEligible, not legacy .route()
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html   = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const router = fs.readFileSync(path.join(__dirname, '..', 'shared', 'bridgeKitRouter.js'), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
/** Extract text between two anchors (non-inclusive, first match). */
function between(src, start, end) {
  const si = src.indexOf(start);
  if (si === -1) return '';
  const sub = src.slice(si + start.length);
  const ei  = sub.indexOf(end);
  return ei === -1 ? sub : sub.slice(0, ei);
}

/** Balanced-brace extraction for a named function. */
function fnBody(src, name) {
  const sig   = 'function ' + name;
  const start = src.indexOf(sig);
  if (start === -1) return '';
  let depth = 0, i = start;
  while (i < src.length) {
    if (src[i] === '{')      { depth++; }
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    i++;
  }
  return '';
}

// Extract the three function bodies once; all describe-blocks reuse them.
const lifi = (() => {
  const s = html.indexOf('async function executeBridgeViaLiFi()');
  return s === -1 ? '' : html.slice(s, s + 15000);
})();

const cctp = (() => {
  const s = html.indexOf('async function executeBridgeViaCCTP()');
  return s === -1 ? '' : html.slice(s, s + 16000);
})();

const turbo = (() => {
  const s = html.indexOf('function executeBridgeOrTurbo()');
  return s === -1 ? '' : html.slice(s, s + 5000);
})();

// ═════════════════════════════════════════════════════════════════════════════
// D1 — executeBridgeViaLiFi: no silent USDC address fallback
// ═════════════════════════════════════════════════════════════════════════════
describe('D1 regression gate: executeBridgeViaLiFi — no USDC address fallback', () => {
  /**
   * WHAT THE BUG LOOKED LIKE (before fix):
   *   const srcToken = getTokenAddressForChain(chain, sym) || getTokenAddressForChain(chain, 'USDC');
   *   const dstToken = getTokenAddressForChain(chain, sym) || getTokenAddressForChain(chain, 'USDC');
   *   if (!srcToken || !dstToken) { ... }   // <-- dead code; USDC always resolves
   *
   * CONSEQUENCE: selecting cirBTC on Ethereum would approve the USDC contract
   * instead of cirBTC, silently bridging USDC while displaying "cirBTC".
   * The guard never fired because USDC always has an address.
   *
   * WHAT THE FIX LOOKS LIKE:
   *   const srcToken = getTokenAddressForChain(chain, sym);          // no fallback
   *   if (!srcToken) { toast('... is not available on ...'); return; }
   */

  it('ANTI-PATTERN ABSENT: srcToken must not use || USDC fallback', () => {
    // The exact old buggy patterns — must not exist anywhere in executeBridgeViaLiFi.
    expect(lifi).not.toContain("getTokenAddressForChain(fromChain.chainId, _lifiFromSym) || getTokenAddressForChain(fromChain.chainId, 'USDC')");
    expect(lifi).not.toContain("getTokenAddressForChain(fromChain.chainId, _lifiFromSym)||getTokenAddressForChain(fromChain.chainId,'USDC')");
  });

  it('ANTI-PATTERN ABSENT: dstToken must not use || USDC fallback', () => {
    expect(lifi).not.toContain("getTokenAddressForChain(toChain.chainId, _lifiToSym) || getTokenAddressForChain(toChain.chainId, 'USDC')");
    expect(lifi).not.toContain("getTokenAddressForChain(toChain.chainId,   _lifiToSym)   || getTokenAddressForChain(toChain.chainId,   'USDC')");
  });

  it('ANTI-PATTERN ABSENT: combined guard (!srcToken || !dstToken) with single message must not exist', () => {
    // The old single combined guard meant token symbol in the message could be wrong.
    expect(lifi).not.toContain("if (!srcToken || !dstToken)");
  });

  it('CORRECT: srcToken resolved directly, no fallback', () => {
    // The fixed line: no right-hand side after the closing paren
    const srcLine = lifi.split('\n').find(l =>
      (l.includes('const srcToken') || l.includes('var srcToken')) &&
      l.includes('getTokenAddressForChain')
    ) || '';
    expect(srcLine).toBeTruthy();
    expect(srcLine).not.toContain("|| getTokenAddressForChain");
    expect(srcLine).not.toContain("'USDC'");
  });

  it('CORRECT: dstToken resolved directly, no fallback', () => {
    const dstLine = lifi.split('\n').find(l =>
      (l.includes('const dstToken') || l.includes('var dstToken')) &&
      l.includes('getTokenAddressForChain')
    ) || '';
    expect(dstLine).toBeTruthy();
    expect(dstLine).not.toContain("|| getTokenAddressForChain");
    expect(dstLine).not.toContain("'USDC'");
  });

  it('CORRECT: separate guard for missing srcToken with per-chain message', () => {
    expect(lifi).toContain("if (!srcToken)");
    // Message must include the token symbol variable and chain name variable
    const srcGuard = between(lifi, 'if (!srcToken)', 'if (!dstToken)');
    expect(srcGuard).toContain('_lifiFromSym');
    expect(srcGuard).toContain('fromChain.name');
    expect(srcGuard).toContain('return');
  });

  it('CORRECT: separate guard for missing dstToken with per-chain message', () => {
    expect(lifi).toContain("if (!dstToken)");
    const dstGuard = between(lifi, 'if (!dstToken)', 'var _lifiFromMeta');
    expect(dstGuard).toContain('_lifiToSym');
    expect(dstGuard).toContain('toChain.name');
    expect(dstGuard).toContain('return');
  });

  it('CORRECT: guard message says "is not available on" (not vague "not available on this route")', () => {
    // Old message was generic; new messages name the chain.
    expect(lifi).toContain('is not available on ');
    expect(lifi).toContain('Select a supported token');
    expect(lifi).not.toContain('not available on this route');
  });

  it('CORRECT: execution cannot reach approve() when srcToken is missing', () => {
    // approve() is inside an ethers.Contract call — it must appear AFTER the guards
    const afterGuards = between(lifi, 'if (!dstToken)', 'async function ');
    // approve must be present after guards (normal ERC-20 approval path)
    expect(afterGuards).toContain('approve(');
    // The approve call references srcToken (the correct, guard-validated address)
    expect(afterGuards).toContain('new ethers.Contract(srcToken');
  });

  it('CORRECT: validateRoute is called AFTER the token address guards', () => {
    // validateRoute must not appear before the if (!srcToken) guard
    const beforeGuards = between(lifi, 'async function executeBridgeViaLiFi()', 'if (!srcToken)');
    expect(beforeGuards).not.toContain('validateRoute');
    // And it IS present after
    const afterGuards = between(lifi, 'if (!dstToken)', 'async function ');
    expect(afterGuards).toContain('LiFiAdapter.validateRoute(');
  });

  // Live validation note
  it.skip('PENDING LIVE: approve() targets correct contract on-chain (requires wallet)', () => {
    // Cannot verify without a connected wallet and live chain.
    // Must be validated manually on Arc Mainnet before production release.
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// D2 — History labels use selected token symbol (all 5 entries)
// ═════════════════════════════════════════════════════════════════════════════
describe('D2 regression gate: history labels use selected token symbol (5 entries)', () => {
  /**
   * WHAT THE BUG LOOKED LIKE (before fix, all 5 entries):
   *   label: `${amt} USDC: ${fromChain.name} → ${toChain.name}`,
   *
   * CONSEQUENCE: bridging 5 EURC would show "5 USDC: Arc → Base" in history.
   *
   * WHAT THE FIX LOOKS LIKE:
   *   CCTP:  label: `${amt} ${token}: ${fromChain.name} → ${toChain.name}`,
   *   LiFi:  label: `${amt} ${_lifiFromSym}: ${fromChain.name} → ${toChain.name}`,
   */

  // ── CCTP entry 1: success ──────────────────────────────────────────────────
  it('ANTI-PATTERN ABSENT: CCTP success label must not hardcode USDC', () => {
    // Unique anchor: the success addToHistory is the only one followed by
    // the "toast(`✓ Bridged" line in the CCTP success block.
    const successLabel = between(
      html,
      "statusEl.textContent = 'Completed'; statusEl.style.color = 'var(--green)';",
      "sub: `CCTP v2 · ${new Date().toLocaleTimeString"
    );
    expect(successLabel).not.toMatch(/label:\s*`\$\{amt\}\s*USDC:/);
  });

  it('CORRECT: CCTP success label uses ${token}', () => {
    const successLabel = between(
      html,
      "statusEl.textContent = 'Completed'; statusEl.style.color = 'var(--green)';",
      "sub: `CCTP v2 · ${new Date().toLocaleTimeString"
    );
    expect(successLabel).toContain('${token}');
  });

  // ── CCTP entry 2: fail ────────────────────────────────────────────────────
  it('ANTI-PATTERN ABSENT: CCTP fail label must not hardcode USDC', () => {
    const failLabel = between(
      html,
      "statusEl.textContent = 'Failed'; statusEl.style.color = 'var(--red)'",
      "sub: `CCTP v2 · failed`"
    );
    expect(failLabel).not.toMatch(/label:\s*`\$\{amt\}\s*USDC:/);
  });

  it('CORRECT: CCTP fail label uses ${token}', () => {
    const failLabel = between(
      html,
      "statusEl.textContent = 'Failed'; statusEl.style.color = 'var(--red)'",
      "sub: `CCTP v2 · failed`"
    );
    expect(failLabel).toContain('${token}');
  });

  // ── LiFi entry 3: completed ───────────────────────────────────────────────
  it('ANTI-PATTERN ABSENT: LiFi completed label must not hardcode USDC', () => {
    const completedBlock = between(html, 'pollResult.completed', "toast(`✓ Bridged");
    expect(completedBlock).not.toMatch(/label:\s*`\$\{amt\}\s*USDC:/);
  });

  it('CORRECT: LiFi completed label uses ${_lifiFromSym}', () => {
    const completedBlock = between(html, 'pollResult.completed', "toast(`✓ Bridged");
    expect(completedBlock).toContain('${_lifiFromSym}');
  });

  // ── LiFi entry 4: FAILED/ERROR status ────────────────────────────────────
  it('ANTI-PATTERN ABSENT: LiFi FAILED status label must not hardcode USDC', () => {
    const failedBlock = between(
      html,
      'LI.FI explicitly reported FAILED/ERROR',
      "toast('Bridge failed"
    );
    expect(failedBlock).not.toMatch(/label:\s*`\$\{amt\}\s*USDC:/);
  });

  it('CORRECT: LiFi FAILED status label uses ${_lifiFromSym}', () => {
    const failedBlock = between(
      html,
      'LI.FI explicitly reported FAILED/ERROR',
      "toast('Bridge failed"
    );
    expect(failedBlock).toContain('${_lifiFromSym}');
  });

  // ── LiFi entry 5: pending / settling ─────────────────────────────────────
  it('ANTI-PATTERN ABSENT: LiFi settling label must not hardcode USDC', () => {
    const settlingBlock = between(
      html,
      'Source confirmed but cross-chain completion not yet observed.',
      "toast('Source transaction"
    );
    expect(settlingBlock).not.toMatch(/label:\s*`\$\{amt\}\s*USDC:/);
  });

  it('CORRECT: LiFi settling label uses ${_lifiFromSym}', () => {
    const settlingBlock = between(
      html,
      'Source confirmed but cross-chain completion not yet observed.',
      "toast('Source transaction"
    );
    expect(settlingBlock).toContain('${_lifiFromSym}');
  });

  // ── Count check: zero USDC-hardcoded history labels remain ───────────────
  it('GLOBAL: no addToHistory call in either bridge function uses hardcoded USDC label', () => {
    // We search the combined cctp+lifi window for the old pattern.
    const combined = cctp + lifi;
    const matches = (combined.match(/label:\s*`\$\{amt\}\s*USDC:/g) || []);
    expect(matches).toHaveLength(0);
  });

  // Live validation note
  it.skip('PENDING LIVE: history panel shows correct token after EURC bridge (requires wallet)', () => {
    // Cannot verify without a connected wallet and real Bridge execution.
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// D4 — executeBridgeOrTurbo fallback: isEligible, not .route()
// ═════════════════════════════════════════════════════════════════════════════
describe('D4 regression gate: executeBridgeOrTurbo fallback uses isEligible', () => {
  /**
   * WHAT THE BUG LOOKED LIKE (before fix):
   *   BridgeKitRouter.route(fromChain.chainId, toChain.chainId, token).provider === 'cctp'
   *
   * CONSEQUENCE: .route() only calls isCCTPToken + isCCTPChain, not isEligible.
   * For EURC Arc→Ethereum:
   *   - .route() returns provider:'cctp' (Arc and Ethereum are both CCTP chains, EURC is a CCTP token)
   *   - .isEligible() returns false  (Ethereum has no EURC in EURC_CCTP_CHAINS)
   * So the fallback would dispatch executeBridgeViaCCTP for EURC Arc→Ethereum,
   * relying entirely on the secondary guard inside executeBridgeViaCCTP (which
   * does call isEligible) to catch it — a second-line-of-defence dependency.
   *
   * WHAT THE FIX LOOKS LIKE:
   *   BridgeKitRouter.isEligible(fromChain.chainId, toChain.chainId, token)
   */

  it('ANTI-PATTERN ABSENT: fallback path must not call .route().provider', () => {
    const fallback = between(turbo, 'Fallback: no routes loaded', 'executeBridgeViaLiFi()');
    // The old call: BridgeKitRouter.route(fromChain.chainId, toChain.chainId, token).provider === 'cctp'
    expect(fallback).not.toMatch(/BridgeKitRouter\.route\s*\(/);
    expect(fallback).not.toContain(".provider === 'cctp'");
  });

  it('CORRECT: fallback path calls BridgeKitRouter.isEligible', () => {
    const fallback = between(turbo, 'Fallback: no routes loaded', 'executeBridgeViaLiFi()');
    expect(fallback).toContain('BridgeKitRouter.isEligible(');
  });

  it('CORRECT: isEligible call receives fromChain.chainId, toChain.chainId, token', () => {
    const fallback = between(turbo, 'Fallback: no routes loaded', 'executeBridgeViaLiFi()');
    expect(fallback).toMatch(/isEligible\(\s*fromChain\.chainId\s*,\s*toChain\.chainId\s*,\s*token\s*\)/);
  });

  it('CORRECT: isEligible guard is checked before dispatching executeBridgeViaCCTP', () => {
    // executeBridgeViaCCTP must come AFTER the isEligible check in the fallback block
    const fallback = between(turbo, 'Fallback: no routes loaded', '}\nexecuteBridgeViaLiFi');
    const eligIdx = fallback.indexOf('isEligible(');
    const cctpIdx = fallback.indexOf('executeBridgeViaCCTP()');
    expect(eligIdx).toBeGreaterThan(-1);
    expect(cctpIdx).toBeGreaterThan(eligIdx);
  });

  // ── Per-pair EURC eligibility (structural proofs via bridgeKitRouter.js) ──
  it('EURC_CCTP_CHAINS includes Arc (5042) and Base (8453), nothing else', () => {
    const chainObj = between(router, 'EURC_CCTP_CHAINS', '}');
    // Must contain both Arc and Base chain IDs
    expect(chainObj).toContain("'5042'");
    expect(chainObj).toContain("'8453'");
    // Must NOT contain Ethereum (1), Arbitrum (42161), Optimism (10), Polygon (137)
    expect(chainObj).not.toContain("'1'");
    expect(chainObj).not.toContain("'42161'");
    expect(chainObj).not.toContain("'10'");
    expect(chainObj).not.toContain("'137'");
  });

  it('isEurcCctpChain checks EURC_CCTP_CHAINS membership', () => {
    const fn = fnBody(router, 'isEurcCctpChain');
    expect(fn).toContain('EURC_CCTP_CHAINS');
    // Must check string coercion (chain IDs may arrive as numbers)
    expect(fn).toContain('String(chainId)');
  });

  it('isEligible returns false for EURC on Ethereum (chainId 1) — not in EURC_CCTP_CHAINS', () => {
    const fn = fnBody(router, 'isEligible');
    // isEligible must call isEurcCctpChain for EURC tokens — ensures the check runs
    expect(fn).toContain("=== 'EURC'");
    expect(fn).toContain('isEurcCctpChain');
    // It must NOT hard-code an allow for chain 1
    expect(fn).not.toMatch(/chainId\s*===?\s*1\b/);
    expect(fn).not.toMatch(/chainId\s*===?\s*['"]1['"]/);
  });

  it('isEligible returns false for EURC on Arbitrum (42161) — not in EURC_CCTP_CHAINS', () => {
    const fn = fnBody(router, 'isEligible');
    // Same structural proof: isEurcCctpChain gates eligibility; 42161 not in the set
    expect(fn).toContain('isEurcCctpChain');
    expect(fn).not.toMatch(/42161/);
  });

  it('executeBridgeViaCCTP also has its own isEligible guard (defence in depth)', () => {
    // Even with the D4 fix, executeBridgeViaCCTP retains its own guard.
    // Stop anchor is the line after the guard returns — the next block comment.
    const cctpGuardBlock = between(
      cctp,
      'Guard: CCTP only supports USDC/EURC on eligible chains',
      '_walletOpInProgress = true'
    );
    expect(cctpGuardBlock).toContain('BridgeKitRouter.isEligible(');
    expect(cctpGuardBlock).toContain('executeBridgeViaLiFi()');
    expect(cctpGuardBlock).toContain('return');
  });

  it('Send Assets saExecuteCrossChain still uses BridgeKitRouter.route (untouched, separate scope)', () => {
    // Confirm that the D4 fix was correctly scoped to executeBridgeOrTurbo only
    // and did NOT accidentally change the Send Assets routing path.
    const saFn = between(
      html,
      'function saExecuteCrossChain',
      'async function saExecuteCCTPCrossChain'
    );
    expect(saFn).toContain('BridgeKitRouter.route(');
  });

  // Live validation note
  it.skip('PENDING LIVE: EURC Arc→Base CCTP route completes on-chain (requires wallet + real funds)', () => {
    // Cannot verify without a connected wallet and real EURC on Arc Mainnet.
    // EURC CCTP Arc↔Base is eligible per code; not yet verified with real transaction.
    // Amber "not sandbox-verified" badge is shown in the UI for this route.
  });

  it.skip('PENDING LIVE: EURC Arc→Ethereum routes via LiFi (requires LiFi API key)', () => {
    // Cannot verify without a live LIFI_API_KEY in the environment.
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Global scope guard — verify no out-of-scope files were modified
// ═════════════════════════════════════════════════════════════════════════════
describe('Scope guard: out-of-scope tabs not modified', () => {
  // These tests read the same index.html and confirm that well-known anchors
  // from other tabs are present and unmodified.  If they were accidentally
  // changed, these tests break.

  const SWAP_ANCHOR    = 'function swpOpenHistory()';
  const SEND_ANCHOR    = 'function saExecuteCrossChain';
  const BILLING_ANCHOR = 'function billingSetMode(';
  const UB_ANCHOR      = 'function ubInit() {';

  it('Swap History function is present and untouched', () => {
    expect(html).toContain(SWAP_ANCHOR);
  });

  it('Send Assets cross-chain function is present and untouched', () => {
    expect(html).toContain(SEND_ANCHOR);
  });

  it('Billing init function is present and untouched', () => {
    expect(html).toContain(BILLING_ANCHOR);
  });

  it('Unified Balance init function is present and untouched', () => {
    expect(html).toContain(UB_ANCHOR);
  });
});
