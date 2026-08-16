/**
 * SWAP TERMINAL UI — layout + Trade History refresh (Phase 6.6.1).
 * ═══════════════════════════════════════════════════════════════════════════
 * Static guards for the Swap terminal: the right Swap card must not be clipped
 * by the lower Trade History section, the whole #page-swap must scroll, the
 * refresh control must hit the authoritative API with refresh=true (no duplicate
 * requests, no DOM/session writes, no Date.now, no queryFilter Swap/Swapped).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function between(start, end) {
  const i = html.indexOf(start);
  if (i < 0) return '';
  const j = html.indexOf(end, i);
  return html.slice(i, j < 0 ? html.length : j);
}

describe('Swap terminal layout (no overlap / no clipping)', () => {
  it('#page-swap is the vertical scroll container', () => {
    const rule = between('#page-swap{', '}');
    expect(rule).toContain('overflow-y:auto');
  });

  it('desktop main area flows at natural height (not viewport-filling)', () => {
    const block = between('@media(min-width:961px){', '@media(max-width:480px){');
    expect(block).toContain('.st-main-area{flex:0 0 auto;height:auto;min-height:0;overflow:visible}');
  });

  it('right Swap card is not clipped (overflow visible) and bottom stays reachable', () => {
    const block = between('@media(min-width:961px){', '@media(max-width:480px){');
    expect(block).toContain('.st-right-panels{overflow:visible;height:auto}');
    expect(block).toContain('.st-swap-panel{flex:0 0 auto;height:auto}');
    expect(block).toContain('.st-swap-body{flex:0 0 auto;overflow:visible}');
  });

  it('Trade History sits below (no internal competing scrollbar on desktop)', () => {
    const block = between('@media(min-width:961px){', '@media(max-width:480px){');
    expect(block).toContain('.st-lower-panel{height:auto;min-height:30vh}');
    expect(block).toContain('.st-lower-body{overflow:visible}');
  });
});

describe('Trade History refresh control', () => {
  it('renders a Refresh button in the lower tabs header', () => {
    expect(html).toContain('id="st-trade-refresh"');
    expect(html).toContain('onclick="stRefreshTradeHistory()"');
    expect(html).toContain('st-refresh-btn');
  });

  it('refresh calls the authoritative API with refresh=true', () => {
    const fn = between('async function stRefreshTradeHistory()', '// ── Status Bar Update');
    expect(fn).toContain('refreshAuthoritativeSwapHistory(true)');
  });

  it('prevents duplicate simultaneous refresh requests', () => {
    const fn = between('async function stRefreshTradeHistory()', '// ── Status Bar Update');
    expect(fn).toContain('_stTradeRefreshBusy');
    expect(fn).toContain('if (_stTradeRefreshBusy) return');
    expect(fn).toContain('btn.disabled = true');
    expect(fn).toContain('btn.disabled = false');
  });

  it('re-renders both Swap Trade History and Liquidity Recent Activity (shared source)', () => {
    const fn = between('async function stRefreshTradeHistory()', '// ── Status Bar Update');
    expect(fn).toContain('stUpdateHistory()');
    expect(fn).toContain('swpSyncRecentSwaps()');
    expect(fn).toContain('poolUpdateUI()');
  });
});

describe('History data stays authoritative', () => {
  it('Trade History uses block timestamp + raw amounts + txHash (no Date.now)', () => {
    const fn = between('function stRenderTradeHistory(body)', 'function stRenderFunds');
    expect(fn).toContain('ev.amountInRaw');
    expect(fn).toContain('ev.amountOutRaw');
    expect(fn).toContain('ev.txHash');
    expect(fn).toContain('formatActivityTime(ev.timestamp)');
    expect(fn).not.toContain('Date.now');
    expect(fn).not.toContain('new Date');
  });

  it('empty state handles INDEX_WARMING / INDEX_UNAVAILABLE / ERROR (never fake 0)', () => {
    const fn = between('function stRenderTradeHistory(body)', 'function stRenderFunds');
    expect(fn).toContain('Analytics warming up');
    expect(fn).toContain('History unavailable');
  });

  it('no frontend Swap/Swapped queryFilter was reintroduced', () => {
    expect(html).not.toContain('filters.Swap(');
    expect(html).not.toContain('filters.Swapped(');
    expect(html).not.toContain('POOL_SWAPPED_EVENT_ABI');
  });
});
