/**
 * Swap — Standard legacy-DEX layout restoration (presentation isolation).
 * ═══════════════════════════════════════════════════════════════════════
 * Structural guards: Standard mode uses the simple-DEX layout (terminal chrome
 * hidden), Advanced mode keeps the trading terminal, and Swap History stays a
 * SINGLE shared source rendered by both modes (no duplicated fetch/state).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

describe('Swap — Standard legacy-DEX layout (presentation isolation)', () => {
  it('Standard mode hides trading-terminal chrome (scoped to .swp-standard)', () => {
    expect(html).toContain('#page-swap.swp-standard .st-header{display:none}');
    expect(html).toContain('#page-swap.swp-standard .st-chart-section{display:none}');
    expect(html).toContain('#page-swap.swp-standard .st-lower-panel{display:none}');
    expect(html).toContain('#page-swap.swp-standard .st-status-bar{display:none}');
    expect(html).toContain('#page-swap.swp-standard .st-swap-tabs{display:none}');
  });

  it('Standard mode has a page header (like other tabs), hidden in Advanced', () => {
    expect(html).toContain('id="swp-std-header"');
    expect(html).toContain('#page-swap.swp-standard .swp-std-header{display:flex}');
    expect(html).toContain('.swp-std-header{display:none}');
  });

  it('site footer is shown only in Standard swap mode', () => {
    expect(html).toContain('body.swap-standard-mode .site-footer{display:block !important}');
    expect(html).toContain('swap-standard-mode');
  });

  it('Standard swap panel is styled as a clean centered card', () => {
    expect(html).toContain('#page-swap.swp-standard .st-swap-panel');
    expect(html).toContain('max-width:480px');
  });

  it('Standard shows the side column (ROUTES + Swap Summary + Recent Swaps)', () => {
    expect(html).toContain('class="swp-side-col"');
    expect(html).toContain('#page-swap.swp-standard .swp-side-col{display:flex}');
    expect(html).toContain('id="swa-hist-list"');
    expect(html).toContain('id="swa-summary"');
  });

  it('Advanced layout is NOT hidden (terminal chrome preserved)', () => {
    // No rule hides terminal chrome outside the .swp-standard scope.
    expect(html).not.toContain('#page-swap.swp-advanced .st-chart-section{display:none}');
    // Chart section still exists and is only hidden in Standard.
    expect(html).toContain('class="st-chart-section"');
  });

  it('Swap History remains a single shared source (no standard/advanced split)', () => {
    expect(html).not.toContain('standardHistory');
    expect(html).not.toContain('advancedHistory');
    expect(html).toContain("getElementById('swa-hist-list')");
    expect(html).toContain('id="swap-history"'); // authoritative hidden container
  });

  it('provider comparison + selection still present', () => {
    expect(html).toContain('id="swap-route-list"');
    expect(html).toContain('swpSelectRoute');
    expect(html).toContain('resolveSelection');
    expect(html).toContain('findExecutableQuote');
  });
});
