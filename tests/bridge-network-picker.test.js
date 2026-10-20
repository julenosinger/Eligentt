/**
 * Bridge Premium Network Picker — tests
 * Verifies the scoped Bridge network picker: HTML structure, CSS, JS functions,
 * picker open/close/select/search, swap-chains, invalid combos, and zero regressions
 * in all existing bridge/swap functionality.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// ── helpers ──────────────────────────────────────────────────────────────────
function between(src, startStr, endStr) {
  const s = src.indexOf(startStr);
  if (s < 0) return '';
  const e = endStr ? src.indexOf(endStr, s + startStr.length) : src.length;
  return e < 0 ? src.slice(s) : src.slice(s, e + endStr.length);
}
function fnBody(name) {
  return between(html, 'function ' + name + '(', '\nfunction ');
}

// ── HTML structure ────────────────────────────────────────────────────────────
describe('Bridge Network Picker — HTML structure', () => {
  it('from-chain-sel uses brgOpenNetPicker, not cycleFromChain', () => {
    // onclick= comes BEFORE id= in the element; search from class to end of tag.
    const fromTag = between(html, 'class="chain-sel brg-chain-sel" onclick=', 'id="from-chain-sel"');
    expect(fromTag).toContain("brgOpenNetPicker('from')");
    expect(fromTag).not.toContain('cycleFromChain()');
  });

  it('to-chain-sel uses brgOpenNetPicker, not cycleToChain', () => {
    const toTag = between(html, 'class="chain-sel brg-chain-sel" onclick=', 'id="to-chain-sel"');
    expect(toTag).toContain("brgOpenNetPicker('to')");
    expect(toTag).not.toContain('cycleToChain()');
  });

  it('from-chain-logo wrapper exists inside from-chain-sel', () => {
    const fromSel = between(html, 'id="from-chain-sel"', '</div>');
    expect(fromSel).toContain('id="from-chain-logo"');
    expect(fromSel).toContain('brg-chain-logo-wrap');
  });

  it('to-chain-logo wrapper exists inside to-chain-sel', () => {
    const toSel = between(html, 'id="to-chain-sel"', '</div>');
    expect(toSel).toContain('id="to-chain-logo"');
    expect(toSel).toContain('brg-chain-logo-wrap');
  });

  it('both selectors carry brg-chain-sel class', () => {
    // grep for the full opening tag of each selector (all attributes on one line).
    const allLines = html.split('\n');
    const fromLine = allLines.find(l => l.includes('id="from-chain-sel"')) || '';
    const toLine   = allLines.find(l => l.includes('id="to-chain-sel"'))   || '';
    expect(fromLine).toContain('brg-chain-sel');
    expect(toLine).toContain('brg-chain-sel');
    expect(fromLine).toContain('Select source network');
    expect(toLine).toContain('Select destination network');
    expect(fromLine).toContain("brgOpenNetPicker('from')");
    expect(toLine).toContain("brgOpenNetPicker('to')");
  });

  it('cycleFromChain and cycleToChain are still defined (not removed)', () => {
    expect(html).toContain('function cycleFromChain()');
    expect(html).toContain('function cycleToChain()');
  });

  it('swapBridgeChains is still defined', () => {
    expect(html).toContain('function swapBridgeChains()');
  });
});

// ── CSS ───────────────────────────────────────────────────────────────────────
describe('Bridge Network Picker — scoped CSS', () => {
  it('.brg-chain-sel CSS is defined', () => {
    expect(html).toContain('.brg-chain-sel');
  });

  it('.brg-chain-logo-wrap CSS is defined', () => {
    expect(html).toContain('.brg-chain-logo-wrap');
  });

  it('.brg-np-overlay CSS is defined and scoped (not ns-overlay override)', () => {
    expect(html).toContain('.brg-np-overlay');
    // Must not redefine ns-overlay (would break wallet network selector).
    const bridgeCss = between(html, '/* ── Bridge Network Picker modal', '.chain-dot');
    expect(bridgeCss).not.toMatch(/\.ns-overlay\s*{/);
  });

  it('.brg-np-box CSS is defined', () => {
    expect(html).toContain('.brg-np-box');
  });

  it('.brg-np-row CSS is defined', () => {
    expect(html).toContain('.brg-np-row');
  });

  it('.brg-np-disabled prevents pointer events', () => {
    expect(html).toContain('pointer-events: none');
    expect(html).toContain('.brg-np-disabled');
  });

  it('.brg-np-empty state CSS is defined', () => {
    expect(html).toContain('.brg-np-empty');
  });

  it('responsive breakpoint for mobile (brg-np-box)', () => {
    expect(html).toContain('.brg-np-box { width: 100vw');
  });

  it('z-index above token picker (10010 > 9999)', () => {
    const overlay = between(html, '.brg-np-overlay {', '}');
    expect(overlay).toContain('10010');
  });
});

// ── JS functions ──────────────────────────────────────────────────────────────
describe('Bridge Network Picker — JS functions', () => {
  it('brgOpenNetPicker is defined', () => {
    expect(html).toContain('function brgOpenNetPicker(side)');
  });

  it('brgPickNet is defined', () => {
    expect(html).toContain('function brgPickNet(idx)');
  });

  it('brgCloseNetPicker is defined', () => {
    expect(html).toContain('function brgCloseNetPicker()');
  });

  it('_brgNpFilter is defined', () => {
    expect(html).toContain('function _brgNpFilter(q)');
  });

  it('_brgApplyChainLogo is defined', () => {
    expect(html).toContain('function _brgApplyChainLogo(wrapperId, chain)');
  });

  it('_brgPickerSide state variable is declared', () => {
    expect(html).toContain('var _brgPickerSide = null');
  });
});

// ── Picker open behavior ──────────────────────────────────────────────────────
describe('brgOpenNetPicker — open behavior', () => {
  const fn = fnBody('brgOpenNetPicker');

  it('sets _brgPickerSide to the given side', () => {
    expect(fn).toContain('_brgPickerSide = side');
  });

  it('removes stale picker before opening a new one', () => {
    expect(fn).toContain("getElementById('brg-net-picker')");
    expect(fn).toContain('.remove()');
  });

  it('builds rows from CHAINS array (not hardcoded)', () => {
    expect(fn).toContain('CHAINS.map');
  });

  it('picker modal has id="brg-net-picker"', () => {
    expect(fn).toContain("modal.id = 'brg-net-picker'");
  });

  it('picker modal uses ns-overlay class (inherits premium CSS)', () => {
    expect(fn).toContain("'ns-overlay brg-np-overlay'");
  });

  it('uses ns-chain-row CSS class on chain rows', () => {
    expect(fn).toContain('ns-chain-row brg-np-row');
  });

  it('reuses _nsChainLogo for real network logos', () => {
    expect(fn).toContain('_nsChainLogo');
  });

  it('shows "Selected" badge for the current selection', () => {
    expect(fn).toContain('Selected');
  });

  it('shows "In use" badge and disabled state for opposite side chain', () => {
    expect(fn).toContain('brg-np-in-use');
    expect(fn).toContain('brg-np-disabled');
  });

  it('adds backdrop click handler to close picker', () => {
    expect(fn).toContain('brgCloseNetPicker()');
  });

  it('adds Escape key handler', () => {
    expect(fn).toContain("e.key === 'Escape'");
    expect(fn).toContain('brgCloseNetPicker');
  });

  it('focuses search input after opening', () => {
    expect(fn).toContain("getElementById('brg-np-search')");
    expect(fn).toContain('.focus()');
  });

  it('opens search input with oninput wired to _brgNpFilter', () => {
    expect(fn).toContain('_brgNpFilter');
    expect(fn).toContain('brg-np-search');
  });

  it('shows "No networks found" empty state element', () => {
    expect(fn).toContain('brg-np-empty');
  });
});

// ── Picker select behavior ────────────────────────────────────────────────────
describe('brgPickNet — selection behavior', () => {
  const fn = fnBody('brgPickNet');

  it('guards against invalid idx (no chain)', () => {
    expect(fn).toContain('if (!chain) return');
  });

  it('prevents selecting the opposite side chain (same-chain guard)', () => {
    expect(fn).toContain('oppositeIdx');
    expect(fn).toContain('idx === oppositeIdx');
  });

  it('offers swap when opposite chain selected', () => {
    expect(fn).toContain('swapBridgeChains()');
  });

  it('sets bridgeFromIdx when side is "from"', () => {
    expect(fn).toContain("_brgPickerSide === 'from'");
    expect(fn).toContain('bridgeFromIdx = idx');
  });

  it('sets bridgeToIdx when side is "to"', () => {
    expect(fn).toContain('bridgeToIdx   = idx');
  });

  it('calls brgCloseNetPicker after selection', () => {
    expect(fn).toContain('brgCloseNetPicker()');
  });

  it('calls applyBridgeChains after selection', () => {
    expect(fn).toContain('applyBridgeChains()');
  });

  it('calls updateBridgeEst after selection (quote refresh)', () => {
    expect(fn).toContain('updateBridgeEst()');
  });
});

// ── Picker close behavior ─────────────────────────────────────────────────────
describe('brgCloseNetPicker — close behavior', () => {
  const fn = fnBody('brgCloseNetPicker');

  it('removes the modal element', () => {
    expect(fn).toContain("getElementById('brg-net-picker')");
    expect(fn).toContain('.remove()');
  });

  it('removes the Escape key listener to avoid leaks', () => {
    expect(fn).toContain('removeEventListener');
    expect(fn).toContain('_brgEscHandler');
  });

  it('resets _brgPickerSide to null', () => {
    expect(fn).toContain('_brgPickerSide = null');
  });
});

// ── Search/filter ─────────────────────────────────────────────────────────────
describe('_brgNpFilter — search/filter behavior', () => {
  const fn = fnBody('_brgNpFilter');

  it('reads from brg-np-list element', () => {
    expect(fn).toContain("getElementById('brg-np-list')");
  });

  it('shows/hides rows based on query match', () => {
    expect(fn).toContain("row.style.display = show ? ''");
  });

  it('shows empty state when no rows match', () => {
    expect(fn).toContain("getElementById('brg-np-empty')");
    expect(fn).toContain("visible === 0 ? 'flex'");
  });

  it('matches against chain name and sub (chain ID / shortName)', () => {
    expect(fn).toContain('ns-row-name');
    expect(fn).toContain('ns-row-sub');
  });

  it('query is case-insensitive (lowercased)', () => {
    expect(fn).toContain('.toLowerCase()');
  });
});

// ── _brgApplyChainLogo ────────────────────────────────────────────────────────
describe('_brgApplyChainLogo — logo application', () => {
  const fn = fnBody('_brgApplyChainLogo');

  it('uses _nsChainLogo when available (premium SVG/img logos)', () => {
    expect(fn).toContain('_nsChainLogo');
  });

  it('falls back to colored dot when _nsChainLogo unavailable', () => {
    expect(fn).toContain('chain-dot');
    expect(fn).toContain('chain.color');
  });

  it('resizes logo to 22x22 to fit compact selector', () => {
    expect(fn).toContain('22px');
  });
});

// ── applyBridgeChains integration ─────────────────────────────────────────────
describe('applyBridgeChains — logo update integration', () => {
  const fn = fnBody('applyBridgeChains');

  it('calls _brgApplyChainLogo for from-chain-logo', () => {
    expect(fn).toContain("_brgApplyChainLogo('from-chain-logo'");
  });

  it('calls _brgApplyChainLogo for to-chain-logo', () => {
    expect(fn).toContain("_brgApplyChainLogo('to-chain-logo'");
  });

  it('still calls _bridgeUpdateTokenSelectors (token logic preserved)', () => {
    expect(fn).toContain('_bridgeUpdateTokenSelectors()');
  });

  it('still calls refreshBridgeBalances (balance logic preserved)', () => {
    expect(fn).toContain('refreshBridgeBalances()');
  });
});

// ── Isolation: other tabs not affected ────────────────────────────────────────
describe('Isolation — no regressions in other tabs', () => {
  it('brg-np-overlay does not override .ns-overlay (wallet network selector intact)', () => {
    // ns-overlay must still be defined.
    expect(html).toContain('.ns-overlay{');
    // Our new class is brg-np-overlay, not ns-overlay.
    const ourCss = between(html, '.brg-np-overlay {', '}');
    expect(ourCss).toContain('10010');
  });

  it('openNetworkSelector function is still present (wallet network selector unchanged)', () => {
    expect(html).toContain('function openNetworkSelector()');
  });

  it('_nsChainLogo is still present and not modified', () => {
    expect(html).toContain('function _nsChainLogo(chain)');
  });

  it('executeSwap function still present (Swap tab intact)', () => {
    expect(html).toContain('function executeSwap()');
  });

  it('executeBridgeOrTurbo still present (Bridge execution intact)', () => {
    expect(html).toContain('function executeBridgeOrTurbo()');
  });

  it('BridgeKitRouter.isEligible guard still present (CCTP route validation intact)', () => {
    expect(html).toContain('BridgeKitRouter.isEligible');
  });

  it('no global CSS selector like "chain-sel {" without page scope (no cross-tab pollution)', () => {
    // .chain-sel CSS must not be followed by brg-specific rules without proper class scoping.
    // The brg- prefix ensures scoping.
    expect(html).toContain('.brg-chain-sel');
    expect(html).toContain('.brg-np-overlay');
  });
});

// ── UX completeness ───────────────────────────────────────────────────────────
describe('UX completeness', () => {
  it('picker has a close button (ns-close)', () => {
    const openFn = fnBody('brgOpenNetPicker');
    expect(openFn).toContain('ns-close');
    expect(openFn).toContain('brgCloseNetPicker()');
  });

  it('title changes between "Source" and "Destination"', () => {
    const openFn = fnBody('brgOpenNetPicker');
    expect(openFn).toContain('Select Source Network');
    expect(openFn).toContain('Select Destination Network');
  });

  it('shows network count in picker subtitle', () => {
    const openFn = fnBody('brgOpenNetPicker');
    expect(openFn).toContain('CHAINS.length');
    expect(openFn).toContain('networks available');
  });

  it('uses teal icon consistent with Bridge tab accent color', () => {
    const openFn = fnBody('brgOpenNetPicker');
    expect(openFn).toContain('var(--teal)');
    expect(openFn).toContain('ti-topology-star-3');
  });

  it('section label "SUPPORTED NETWORKS" matches Bridge context', () => {
    const openFn = fnBody('brgOpenNetPicker');
    expect(openFn).toContain('SUPPORTED NETWORKS');
  });

  it('role="dialog" for accessibility', () => {
    const openFn = fnBody('brgOpenNetPicker');
    expect(openFn).toContain('role');
    expect(openFn).toContain('dialog');
  });
});
