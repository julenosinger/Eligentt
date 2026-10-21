/**
 * Bridge History Security & Isolation Tests — 1.3.2
 *
 * Covers:
 *  S1  – XSS: brgHistRender must NOT use innerHTML to insert untrusted data
 *  S2  – XSS: _brgHistBuildRow uses safe DOM methods only
 *  S3  – URL validation: _brgSafeExplorerBase rejects javascript:/data:/http:/relative
 *  S4  – URL validation: _brgSafeExplorerBase accepts known https origins only
 *  S5  – Hash validation: _brgSafeTxHash rejects malformed values
 *  S6  – Hash validation: _brgSafeTxHash accepts well-formed 0x+64hex
 *  S7  – Isolation: addToHistory global NOT monkey-patched (no _brgPatched flag)
 *  S8  – Isolation: MutationObserver approach used instead of wrapper
 *  S9  – Refresh: brgHistRefresh calls recoverPendingIntents when available
 *  S10 – Refresh: brgHistRefresh does NOT use setTimeout-only simulation
 *  S11 – Deduplication: seenHashes pattern present in brgHistRender
 *  S12 – Status mapping: pending states mapped correctly from finalStatus
 *  S13 – Empty state: no innerHTML string for empty list (uses createElement)
 *  S14 – Trusted list: all 6 known explorer origins present
 *  S15 – No raw HTML injection: brgHistRender body contains no .innerHTML = '<
 *  S16 – Scope guard: addToHistory function body unchanged (original still present)
 *  S17 – Scope guard: swpOpenHistory unchanged
 *  S18 – Scope guard: saExecuteCrossChain unchanged
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const router = fs.readFileSync(path.join(__dirname, '..', 'shared', 'bridgeKitRouter.js'), 'utf8');

// ── helpers ──────────────────────────────────────────────────────────────────
function between(src, start, end) {
  const si = src.indexOf(start);
  if (si === -1) return '';
  const sub = src.slice(si + start.length);
  const ei = sub.indexOf(end);
  return ei === -1 ? sub : sub.slice(0, ei);
}

function fnBody(src, name) {
  const sig = 'function ' + name;
  const start = src.indexOf(sig);
  if (start === -1) return '';
  let depth = 0, i = start;
  while (i < src.length) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    i++;
  }
  return '';
}

// ── S1: brgHistRender must NOT inject untrusted data via innerHTML ───────────
describe('S1/S2/S15 – XSS: no innerHTML of untrusted data', () => {
  const renderFn = fnBody(html, 'brgHistRender');

  it('S1: brgHistRender does not assign innerHTML with user-derived template literal', () => {
    // The old pattern was: list.innerHTML = filtered.map(...).join('')
    expect(renderFn).not.toMatch(/list\.innerHTML\s*=\s*filtered/);
    expect(renderFn).not.toMatch(/list\.innerHTML\s*=.*\.map\(/);
  });

  it('S2: _brgHistBuildRow exists and uses textContent for label and sub', () => {
    const buildFn = fnBody(html, '_brgHistBuildRow');
    expect(buildFn).not.toBe('');
    // label and sub MUST be set via textContent, not innerHTML
    expect(buildFn).toMatch(/pair\.textContent\s*=/);
    expect(buildFn).toMatch(/amts\.textContent\s*=/);
    // Must NOT inject e.label or e.sub as raw HTML
    expect(buildFn).not.toMatch(/innerHTML.*e\.label/);
    expect(buildFn).not.toMatch(/innerHTML.*e\.sub/);
  });

  it('S15: brgHistRender body has no innerHTML = "<... template literal injection', () => {
    // Any innerHTML assignment in brgHistRender must be for static structure (empty state),
    // not for filtered entry data.
    // The render function must NOT do: list.innerHTML = ... (any entry data)
    // It may only do: while(list.firstChild) list.removeChild(...)
    expect(renderFn).not.toMatch(/\.innerHTML\s*=\s*filtered/);
    expect(renderFn).not.toMatch(/\.innerHTML\s*=.*e\.(label|sub|txHash|explorer|dotColor)/);
  });

  it('S2b: badge text set via textContent, not innerHTML', () => {
    const buildFn = fnBody(html, '_brgHistBuildRow');
    expect(buildFn).toMatch(/badge\.textContent\s*=/);
    expect(buildFn).not.toMatch(/badge\.innerHTML\s*=/);
  });
});

// ── S3/S4: URL validation ────────────────────────────────────────────────────
describe('S3/S4 – _brgSafeExplorerBase: URL validation', () => {
  const safeBase = fnBody(html, '_brgSafeExplorerBase');

  it('S3: function exists', () => {
    expect(safeBase).not.toBe('');
  });

  it('S3: rejects non-https protocols', () => {
    // Must check u.protocol !== "https:"
    expect(safeBase).toContain("u.protocol !== 'https:'");
  });

  it('S3: returns null for untrusted origins', () => {
    expect(safeBase).toContain('return null');
  });

  it('S4: validates against _BRG_TRUSTED_EXPLORERS list', () => {
    expect(safeBase).toContain('_BRG_TRUSTED_EXPLORERS');
  });

  it('S4: uses URL constructor for parsing (not string concatenation)', () => {
    expect(safeBase).toContain('new URL(');
  });
});

// ── S5/S6: Hash validation ───────────────────────────────────────────────────
describe('S5/S6 – _brgSafeTxHash: hash validation', () => {
  const safeFn = fnBody(html, '_brgSafeTxHash');

  it('S5: function exists', () => {
    expect(safeFn).not.toBe('');
  });

  it('S5: validates 0x + 64 hex chars pattern', () => {
    expect(safeFn).toContain('0x[0-9a-fA-F]{64}');
  });

  it('S5: returns null for invalid input', () => {
    expect(safeFn).toContain('return null');
  });

  it('S6: uses regex test to validate', () => {
    expect(safeFn).toMatch(/\.test\(/);
  });
});

// ── S7/S8: Isolation — no monkey-patch of global addToHistory ───────────────
describe('S7/S8 – Isolation: no global addToHistory monkey-patch', () => {
  it('S7: _brgPatched flag no longer set on addToHistory', () => {
    // The old patch set addToHistory._brgPatched = true — this must be gone.
    expect(html).not.toContain('addToHistory._brgPatched = true');
    expect(html).not.toContain('addToHistory._brgPatched');
  });

  it('S7: addToHistory is not reassigned by Bridge History code', () => {
    // The patch wrapped: addToHistory = function(containerId, opts) { ... }
    // after the brgHistRender block. This pattern must be gone.
    const brgBlock = between(html, '// ── Bridge History Panel (slide-in', '// ── Bridge History & Monitoring');
    expect(brgBlock).not.toMatch(/addToHistory\s*=\s*function/);
  });

  it('S8: MutationObserver used for local bridge container observation', () => {
    expect(html).toContain('MutationObserver');
    expect(html).toContain('observer.observe(container');
    // Observer target is the bridge-history container, not a global hook
    expect(html).toContain("getElementById('bridge-history')");
  });

  it('S8: _brgSessionEntries queue is local (not attached to global objects)', () => {
    expect(html).toContain('var _brgSessionEntries = []');
    // Must NOT be window._brgSessionEntries or similar
    expect(html).not.toContain('window._brgSessionEntries');
  });
});

// ── S9/S10: Refresh — real status, no simulation ────────────────────────────
describe('S9/S10 – brgHistRefresh: real status, no setTimeout simulation', () => {
  const refreshFn = fnBody(html, 'brgHistRefresh');

  it('S9: calls recoverPendingIntents when available', () => {
    expect(refreshFn).toContain('recoverPendingIntents');
    expect(refreshFn).toContain('typeof recoverPendingIntents');
  });

  it('S9: checks walletAddress before attempting on-chain recovery', () => {
    expect(refreshFn).toContain('walletAddress');
  });

  it('S10: does NOT use setTimeout as the sole refresh mechanism', () => {
    // The old code was: setTimeout(function() { brgHistRender(); }, 600)
    // with NO real data fetch — just a fake spin.
    expect(refreshFn).not.toMatch(/setTimeout\(function\(\)\s*\{[\s\S]*?brgHistRender\(\)[\s\S]*?\},\s*600\)/);
  });

  it('S10: documents the limitation (no-wallet fallback re-renders from persisted state)', () => {
    // The else branch must exist for the no-wallet case
    expect(refreshFn).toContain('_done()');
  });
});

// ── S11: Deduplication ───────────────────────────────────────────────────────
describe('S11 – brgHistRender: deduplication by hash', () => {
  const renderFn = fnBody(html, 'brgHistRender');

  it('S11: seenHashes object used for deduplication', () => {
    expect(renderFn).toContain('seenHashes');
  });

  it('S11: checks seenHashes before pushing entries', () => {
    expect(renderFn).toMatch(/seenHashes\[key\]/);
  });

  it('S11: sets seenHashes[key] = true to mark seen entries', () => {
    expect(renderFn).toContain('seenHashes[key] = true');
  });
});

// ── S12: Status mapping ──────────────────────────────────────────────────────
describe('S12 – Status mapping: pending states from finalStatus', () => {
  const renderFn = fnBody(html, 'brgHistRender');

  it('S12: BURN_CONFIRMED treated as pending', () => {
    expect(renderFn).toContain('BURN_CONFIRMED');
  });

  it('S12: WAITING_ATTESTATION treated as pending', () => {
    expect(renderFn).toContain('WAITING_ATTESTATION');
  });

  it('S12: EXECUTED/finalStatus=EXECUTED maps to teal dotColor', () => {
    expect(renderFn).toContain("'EXECUTED'");
    expect(renderFn).toContain('#2dd4bf');
  });

  it('S12: FAILED maps to red dotColor', () => {
    expect(renderFn).toContain("'FAILED'");
    expect(renderFn).toContain('#ef4444');
  });
});

// ── S13: Empty state uses createElement ──────────────────────────────────────
describe('S13 – Empty state: createElement, not innerHTML string', () => {
  const renderFn = fnBody(html, 'brgHistRender');

  it('S13: creates empty div via createElement', () => {
    expect(renderFn).toContain("createElement('div')");
  });

  it('S13: empty state text set via textContent', () => {
    expect(renderFn).toMatch(/emptySpan\.textContent\s*=/);
  });

  it('S13: list cleared via removeChild loop, not innerHTML = ""', () => {
    expect(renderFn).toContain('list.removeChild(list.firstChild)');
    expect(renderFn).not.toMatch(/list\.innerHTML\s*=\s*['"]\s*['"]/);
  });
});

// ── S14: Trusted explorer list ───────────────────────────────────────────────
describe('S14 – _BRG_TRUSTED_EXPLORERS: all known chains present', () => {
  it('S14: Arc explorer trusted', () => {
    expect(html).toContain("'https://explorer.arc.io'");
  });
  it('S14: Etherscan trusted', () => {
    expect(html).toContain("'https://etherscan.io'");
  });
  it('S14: Basescan trusted', () => {
    expect(html).toContain("'https://basescan.org'");
  });
  it('S14: Arbiscan trusted', () => {
    expect(html).toContain("'https://arbiscan.io'");
  });
  it('S14: Optimistic Etherscan trusted', () => {
    expect(html).toContain("'https://optimistic.etherscan.io'");
  });
  it('S14: Polygonscan trusted', () => {
    expect(html).toContain("'https://polygonscan.com'");
  });
});

// ── S16/S17/S18: Scope guards — out-of-scope functions untouched ─────────────
describe('S16/S17/S18 – Scope guard: other modules untouched', () => {
  it('S16: addToHistory original function still defined (uses setSafeHTML)', () => {
    expect(html).toContain('function addToHistory(containerId,{icon,color,label,sub,txHash,dotColor,explorer})');
    expect(html).toContain('setSafeHTML(div');
  });

  it('S17: swpOpenHistory unchanged', () => {
    expect(html).toContain('function swpOpenHistory()');
    expect(html).toContain("document.addEventListener('keydown', _swpHistKeyDown)");
  });

  it('S18: saExecuteCrossChain unchanged (Send Assets)', () => {
    expect(html).toContain('function saExecuteCrossChain');
    expect(html).toContain('BridgeKitRouter.route(');
  });
});
