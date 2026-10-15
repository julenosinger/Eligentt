/**
 * swap-router-blink.test.js
 * ═══════════════════════════════════════════════════════════════════════
 * Guards the "router blinking" fix: routers must NOT disappear or be replaced
 * by "Finding routes..." when a new (background) quote starts. The UI must:
 *
 *   · never wipe swap-route-list on a background refresh
 *   · use a non-destructive "Updating routes..." indicator instead
 *   · keep cards visible and skip identical rebuilds
 *   · invalidate a stale quote on a real token/network/amount change (safety)
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const uiModesSrc = fs.readFileSync(path.join(root, 'shared', 'swapUiModes.js'), 'utf8');

function fn(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  if (s < 0) return '';
  const e = src.indexOf(endMarker, s);
  return src.slice(s, e < 0 ? src.length : e);
}

describe('blink prevention — SwapUiModes.showRouteUpdating', () => {
  it('defines a non-destructive showRouteUpdating()', () => {
    expect(uiModesSrc).toContain('function showRouteUpdating()');
  });

  it('showRouteUpdating() never touches the route list (no wipe)', () => {
    const body = fn(uiModesSrc, 'function showRouteUpdating()', 'function clearRouteSelector()');
    expect(body).not.toContain('swap-route-list');
    expect(body).not.toContain('innerHTML');
    expect(body).toContain('Updating routes...');
  });

  it('exports showRouteUpdating', () => {
    expect(uiModesSrc).toContain('showRouteUpdating: showRouteUpdating');
  });

  it('renderRouteSelector skips identical rebuilds (no DOM churn)', () => {
    const body = fn(uiModesSrc, 'function renderRouteSelector(', 'function showRouteLoading()');
    expect(body).toContain('_lastRouteListHtml');
    expect(body).toContain('html !== _lastRouteListHtml');
  });

  it('clearRouteSelector resets the rebuild cache', () => {
    const body = fn(uiModesSrc, 'function clearRouteSelector()', '// Apply the default mode');
    expect(body).toContain("_lastRouteListHtml = ''");
  });
});

describe('blink prevention — updateSwapRate keeps cards during refresh', () => {
  it('tracks the displayed params key', () => {
    expect(html).toContain('_displayedParamsKey: null');
    expect(html).toContain('const displayKey = (SWP.fromChainId || activeChainId)');
  });

  it('detects param change + existing cards (hasCards)', () => {
    const body = fn(html, 'const displayKey = (SWP.fromChainId || activeChainId)', 'swapRateTimer = setTimeout');
    expect(body).toContain('const paramsChanged = SWP._displayedParamsKey !== displayKey');
    expect(body).toContain('const hasCards =');
  });

  it('invalidates the stale quote on a real param change (safety)', () => {
    const body = fn(html, 'if (paramsChanged) {', 'if (!hasCards) {');
    expect(body).toContain('SWP.lastQuote = null');
    expect(body).toContain('SWP._towerQuoteData = null');
  });

  it('only shows the loading state when there are no cards', () => {
    const body = fn(html, 'if (!hasCards) {', 'swapRateTimer = setTimeout');
    expect(body).toContain('showRouteLoading');
  });

  it('uses the non-destructive indicator when cards already exist', () => {
    const body = fn(html, 'if (!hasCards) {', 'swapRateTimer = setTimeout');
    expect(body).toContain('showRouteUpdating');
  });
});
