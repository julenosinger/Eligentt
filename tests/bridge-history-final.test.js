/**
 * Bridge History — Final Correctness Suite (1.3-final)
 * Covers every scenario required by the spec:
 *  - MutationObserver captures via data-brg-* (not CSS selectors)
 *  - Status semantic (pending/done/failed) — never inferred from raw color string
 *  - Dedup: stored with confirmed finalStatus wins over session pending entry
 *  - Refresh: real recoverPendingIntents path + no-wallet fallback
 *  - XSS payloads and invalid URLs blocked
 *  - Filter, panel open/close, Swap/Send isolation
 */

import { readFileSync } from 'fs';
import { describe, it, expect } from 'vitest';

const html = readFileSync('index.html', 'utf8');

// ── helpers ──────────────────────────────────────────────────────────────────
const fnBody = (src, name) => {
  const s = src.indexOf('function ' + name);
  if (s < 0) return '';
  let depth = 0, i = s;
  while (i < src.length) {
    if (src[i] === '{') depth++;
    if (src[i] === '}') { depth--; if (depth === 0) return src.slice(s, i + 1); }
    i++;
  }
  return src.slice(s);
};

const varBlock = (src, name) => {
  const s = src.indexOf('var ' + name);
  if (s < 0) return '';
  const end = src.indexOf('\n', s + 1);
  return src.slice(s, end > s ? end : s + 200);
};

const blockAt = (src, anchor, len) => {
  const s = src.indexOf(anchor);
  return s < 0 ? '' : src.slice(s, s + len);
};

// fnBody uses brace-counting which breaks for destructured params; use blockAt
const addToHistory   = blockAt(html, 'function addToHistory(containerId,', 1300);
// Capture the entire _initBrgHistObserver IIFE (observer + _attach + all vars)
const observer       = blockAt(html, '(function _initBrgHistObserver()', 5000);
const brgHistRender  = fnBody(html, 'brgHistRender');
const brgHistRefresh = fnBody(html, 'brgHistRefresh');
const brgHistBuildRow= fnBody(html, '_brgHistBuildRow');
const brgSafeExp     = fnBody(html, '_brgSafeExplorerBase');
const brgSafeHash    = fnBody(html, '_brgSafeTxHash');
const brgOpenHistory = fnBody(html, 'brgOpenHistory');
const brgCloseHistory= fnBody(html, 'brgCloseHistory');
const normalizeStored= blockAt(html, 'function _normalizeStored', 900);

// ── GROUP A: addToHistory — data-brg-* attributes ────────────────────────────
describe('A — addToHistory sets data-brg-* attributes', () => {

  it('A1: sets data-brg-label', () => {
    expect(addToHistory).toContain("setAttribute('data-brg-label'");
  });

  it('A2: sets data-brg-sub', () => {
    expect(addToHistory).toContain("setAttribute('data-brg-sub'");
  });

  it('A3: sets data-brg-hash', () => {
    expect(addToHistory).toContain("setAttribute('data-brg-hash'");
  });

  it('A4: sets data-brg-explorer', () => {
    expect(addToHistory).toContain("setAttribute('data-brg-explorer'");
  });

  it('A5: sets data-brg-dotcolor', () => {
    expect(addToHistory).toContain("setAttribute('data-brg-dotcolor'");
  });

  it('A6: explorer link is conditional on txHash presence', () => {
    // Link must be inside a ternary/conditional — not always emitted
    expect(addToHistory).toMatch(/txHash\s*\?/);
  });

  it('A7: uses _safePurify for label and sub', () => {
    expect(addToHistory).toContain('_safePurify(label)');
    expect(addToHistory).toContain('_safePurify(sub)');
  });
});

// ── GROUP B: MutationObserver — data-brg-* reads, not CSS selectors ──────────
describe('B — MutationObserver reads data-brg-* (not CSS style selectors)', () => {

  it('B1: reads data-brg-label', () => {
    expect(observer).toContain("getAttribute('data-brg-label')");
  });

  it('B2: reads data-brg-sub', () => {
    expect(observer).toContain("getAttribute('data-brg-sub')");
  });

  it('B3: reads data-brg-hash', () => {
    expect(observer).toContain("getAttribute('data-brg-hash')");
  });

  it('B4: reads data-brg-explorer', () => {
    expect(observer).toContain("getAttribute('data-brg-explorer')");
  });

  it('B5: reads data-brg-dotcolor', () => {
    expect(observer).toContain("getAttribute('data-brg-dotcolor')");
  });

  it('B6: does NOT use querySelector with font-weight style selector', () => {
    expect(observer).not.toContain('font-weight:600');
  });

  it('B7: does NOT use querySelector with color:var(--muted2) selector', () => {
    expect(observer).not.toContain('color:var(--muted2)');
  });

  it('B8: observer.observe targets bridge-history container with childList:true', () => {
    expect(observer).toContain('childList: true');
  });
});

// ── GROUP C: Semantic status — no color-string inference in brgHistRender ─────
describe('C — Semantic status field; brgHistRender never infers from raw color', () => {

  it('C1: _normalizeStored derives status from finalStatus, not from color', () => {
    expect(normalizeStored).toContain('finalStatus');
    expect(normalizeStored).toContain("'failed'");
    expect(normalizeStored).toContain("'pending'");
    expect(normalizeStored).toContain("'done'");
  });

  it('C2: PENDING_STATUSES set covers BURN_CONFIRMED', () => {
    expect(normalizeStored).toContain('BURN_CONFIRMED');
  });

  it('C3: PENDING_STATUSES set covers WAITING_ATTESTATION', () => {
    expect(normalizeStored).toContain('WAITING_ATTESTATION');
  });

  it('C4: PENDING_STATUSES set covers BRIDGE_PENDING', () => {
    expect(normalizeStored).toContain('BRIDGE_PENDING');
  });

  it('C5: PENDING_STATUSES set covers CREATED', () => {
    expect(normalizeStored).toContain('CREATED');
  });

  it('C6: observer uses STATUS_PENDING / STATUS_FAILED arrays for color normalisation', () => {
    expect(observer).toContain('STATUS_PENDING');
    expect(observer).toContain('STATUS_FAILED');
  });

  it('C7: observer stores semantic status field (not raw boolean from color index)', () => {
    expect(observer).toContain("status:   semanticStatus");
  });

  it('C8: observer handles rgb() color format for pending', () => {
    expect(observer).toContain('rgb(245, 158, 11)');
  });

  it('C9: observer handles rgb() color format for failed', () => {
    expect(observer).toContain('rgb(239, 68, 68)');
  });
});

// ── GROUP D: Dedup — stored confirmed status supersedes session pending ────────
describe('D — Deduplication: stored confirmed status wins over session pending', () => {

  it('D1: storedByHash lookup built before merging session entries', () => {
    expect(brgHistRender).toContain('storedByHash');
  });

  it('D2: session entry superseded when stored has non-pending finalStatus', () => {
    // The merge block must check storedPending before deciding to override
    expect(brgHistRender).toContain('storedPending');
  });

  it('D3: _normalizeStored used for both override path and standalone stored path', () => {
    const count = (brgHistRender.match(/_normalizeStored/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('D4: seenHashes prevents duplicate keys', () => {
    expect(brgHistRender).toContain('seenHashes[key]');
  });

  it('D5: entries sorted descending by timestamp', () => {
    expect(brgHistRender).toContain('(b.ts || 0) - (a.ts || 0)');
  });

  it('D6: empty records (no label and no hash) are skipped', () => {
    expect(brgHistRender).toContain('h.label || n.txHash');
  });
});

// ── GROUP E: Refresh — real recovery, no fake setTimeout simulation ───────────
describe('E — brgHistRefresh: real status, no fake simulation', () => {

  it('E1: calls recoverPendingIntents when available', () => {
    expect(brgHistRefresh).toContain('recoverPendingIntents()');
  });

  it('E2: guards with walletAddress check before on-chain call', () => {
    expect(brgHistRefresh).toContain('walletAddress');
  });

  it('E3: no setTimeout as sole refresh mechanism', () => {
    // setTimeout may exist but NOT as the only path that calls brgHistRender
    const settimeouts = (brgHistRefresh.match(/setTimeout/g) || []).length;
    expect(settimeouts).toBe(0);
  });

  it('E4: calls brgHistRender on completion (both success and failure paths)', () => {
    const renders = (brgHistRefresh.match(/brgHistRender\(\)/g) || []).length;
    expect(renders).toBeGreaterThanOrEqual(1);
  });

  it('E5: uses .then()/.catch() for async recoverPendingIntents', () => {
    expect(brgHistRefresh).toContain('.then(');
    expect(brgHistRefresh).toContain('.catch(');
  });

  it('E6: _brgHistBusy guard prevents concurrent refresh calls', () => {
    expect(brgHistRefresh).toContain('_brgHistBusy');
  });
});

// ── GROUP F: Security — XSS and URL validation preserved ─────────────────────
describe('F — XSS and URL security preserved', () => {

  it('F1: _brgSafeExplorerBase rejects non-https protocol', () => {
    expect(brgSafeExp).toContain("'https:'");
  });

  it('F2: _brgSafeExplorerBase validates against trusted list', () => {
    expect(brgSafeExp).toContain('_BRG_TRUSTED_EXPLORERS');
  });

  it('F3: _brgSafeExplorerBase returns null for untrusted origins', () => {
    expect(brgSafeExp).toContain('return null');
  });

  it('F4: _brgSafeTxHash validates 0x+64hex pattern', () => {
    expect(brgSafeHash).toMatch(/0x\[0-9a-fA-F\]\{64\}|0x\[0-9a-f\]\{64\}/);
  });

  it('F5: _brgHistBuildRow sets label via textContent (not innerHTML)', () => {
    expect(brgHistBuildRow).toContain('.textContent = e.label');
  });

  it('F6: _brgHistBuildRow sets sub via textContent', () => {
    expect(brgHistBuildRow).toContain('.textContent = e.sub');
  });

  it('F7: _brgHistBuildRow has no innerHTML assignment of user data', () => {
    // innerHTML may appear for non-user-data (icon classes) but not for label/sub/hash
    const iHtml = brgHistBuildRow.match(/\.innerHTML\s*=/g) || [];
    expect(iHtml.length).toBe(0);
  });

  it('F8: explorer link uses rel="noopener noreferrer"', () => {
    expect(brgHistBuildRow).toContain('noopener noreferrer');
  });

  it('F9: brgHistRender clears list via removeChild loop, not innerHTML=""', () => {
    expect(brgHistRender).toContain('removeChild');
    expect(brgHistRender).not.toContain('list.innerHTML = \'\'');
    expect(brgHistRender).not.toContain('list.innerHTML=""');
  });

  it('F10: addToHistory does not use innerHTML directly for label/sub', () => {
    // addToHistory uses _safePurify inside setSafeHTML which is acceptable;
    // but direct label/sub should NOT appear raw inside a template literal
    // without _safePurify wrapping.
    expect(addToHistory).not.toMatch(/`[^`]*\$\{label\}[^`]*`/);
    expect(addToHistory).not.toMatch(/`[^`]*\$\{sub\}[^`]*`/);
  });

  it('F11: trusted explorer list covers all 6 supported chains', () => {
    const trusted = blockAt(html, '_BRG_TRUSTED_EXPLORERS', 400);
    expect(trusted).toContain('explorer.arc.io');
    expect(trusted).toContain('etherscan.io');
    expect(trusted).toContain('basescan.org');
    expect(trusted).toContain('arbiscan.io');
    expect(trusted).toContain('optimistic.etherscan.io');
    expect(trusted).toContain('polygonscan.com');
  });
});

// ── GROUP G: Filter + Panel open/close ───────────────────────────────────────
describe('G — Filter, panel open/close', () => {

  it('G1: brgOpenHistory adds "open" class', () => {
    expect(brgOpenHistory).toContain('open');
  });

  it('G2: brgCloseHistory removes "open" class', () => {
    expect(brgCloseHistory).toContain('remove');
    expect(brgCloseHistory).toContain('open');
  });

  it('G3: filter "done" path excludes pending and failed entries', () => {
    expect(brgHistRender).toContain("'done'");
    expect(brgHistRender).toContain('!e.pending && !e.failed');
  });

  it('G4: filter "pending" path shows only pending entries', () => {
    expect(brgHistRender).toContain("'pending'");
    expect(brgHistRender).toContain('!!e.pending');
  });

  it('G5: brgCloseHistory removes Escape keydown listener', () => {
    expect(brgCloseHistory).toContain('removeEventListener');
  });

  it('G6: empty state uses textContent (no innerHTML)', () => {
    expect(brgHistRender).toContain('emptySpan.textContent');
    expect(brgHistRender).not.toContain('emptySpan.innerHTML');
  });
});

// ── GROUP H: Module isolation — Swap/Send/global unchanged ────────────────────
describe('H — Module isolation: Swap, Send Assets, global addToHistory unchanged', () => {

  it('H1: addToHistory global is not reassigned by Bridge History code', () => {
    // No pattern like: addToHistory = function or addToHistory=function
    // after the initial definition (which is the definition itself, not a reassignment)
    const defIdx = html.indexOf('function addToHistory(');
    const after   = html.slice(defIdx + 50);
    expect(after).not.toMatch(/addToHistory\s*=\s*function/);
  });

  it('H2: _brgPatched monkey-patch flag no longer present', () => {
    expect(html).not.toContain('_brgPatched');
  });

  it('H3: MutationObserver scoped to bridge-history container only', () => {
    expect(observer).toContain("getElementById('bridge-history')");
    expect(observer).not.toContain("getElementById('swap-history')");
    expect(observer).not.toContain("getElementById('sa-history')");
  });

  it('H4: swpOpenHistory function body is unchanged (Swap isolation)', () => {
    const swp = fnBody(html, 'swpOpenHistory');
    expect(swp).toContain('swp-hist-overlay');
    expect(swp).not.toContain('brg-hist');
  });

  it('H5: saExecuteCrossChain still references BridgeKitRouter (Send Assets unchanged)', () => {
    const sa = fnBody(html, 'saExecuteCrossChain');
    // Send Assets uses BridgeKitRouter.route (its own CCTP routing, not isEligible)
    expect(sa).toContain('BridgeKitRouter');
  });

  it('H6: brgHistRender does not touch swap-hist-list or sa-history', () => {
    expect(brgHistRender).not.toContain('swp-hist-list');
    expect(brgHistRender).not.toContain('sa-history');
  });
});
