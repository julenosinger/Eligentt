/**
 * SwapUiModes — Standard / Advanced presentation controller + provider comparison.
 * ═══════════════════════════════════════════════════════════════════════
 * Presentation-only layer for the Swap page. It never quotes or executes
 * anything — it only switches how the SAME Swap Engine is presented and renders
 * the provider comparison from quotes already produced by SwapAggregator.
 *
 *   Standard  → clean DEX: no chart, no market bar, provider comparison visible
 *   Advanced  → full terminal: chart + market data + technical details
 *
 * Execution stays in the existing flow (executeSwap). No duplicated logic.
 *
 * Attached to window.SwapUiModes
 */
(function () {
  'use strict';

  if (typeof window !== 'undefined' && window.SwapUiModes) return;

  var MODES = ['standard', 'advanced'];
  var _mode = 'standard';

  function getMode() { return _mode; }

  function setMode(mode) {
    if (MODES.indexOf(mode) === -1) mode = 'standard';
    _mode = mode;
    applyMode();
    return _mode;
  }

  /** Toggle the page-level class + segmented buttons + comparison visibility. */
  function applyMode() {
    try {
      var page = document.getElementById('page-swap');
      if (page) {
        page.classList.remove('swp-standard', 'swp-advanced');
        page.classList.add('swp-' + _mode);
      }
      var stdBtn = document.getElementById('swp-mode-standard');
      var advBtn = document.getElementById('swp-mode-advanced');
      if (stdBtn) stdBtn.classList.toggle('active', _mode === 'standard');
      if (advBtn) advBtn.classList.toggle('active', _mode === 'advanced');
      var cmp = document.getElementById('swp-comparison-card');
      if (cmp) {
        var hasRows = !!(cmp.querySelector && cmp.querySelector('.swp-comp-row, .swp-comparison-empty'));
        cmp.style.display = (_mode === 'standard' && hasRows) ? '' : 'none';
      }
    } catch (_) {}
  }

  /** Human display name for a quote source (never trusts a UI-only hardcode). */
  function providerName(q) {
    if (!q) return 'Provider';
    if (q.source === 'tower') return 'Tower';
    if (q.source === 'local') return 'Elligentt';
    return q.provider || q.source || 'Provider';
  }

  function sourceLabel(q) {
    if (!q) return '';
    if (q.source === 'tower') return 'Tower';
    if (q.source === 'local') return 'Local Pool';
    return q.source || '';
  }

  /** Format a raw BigInt output into human units (presentation only). */
  function formatOut(raw, decimals) {
    try {
      if (typeof SwapMath !== 'undefined' && SwapMath.formatUnits) {
        var d = Math.floor(Number(decimals) || 0);
        var s = SwapMath.formatUnits(String(raw), d);
        if (s != null) return s;
      }
    } catch (_) {}
    return String(raw);
  }

  /**
   * Build the provider comparison rows from a SwapAggregator decision.
   * Deterministic ordering: valid quotes sorted by expectedOutRaw desc, then
   * minOutRaw desc, then feeBps asc — identical rule to SwapAggregator.pickBest.
   * @param {object} decision { ok, best, quotes:[] }
   * @param {object} opts { tokenOut, tokenOutDecimals }
   * @returns {string} HTML (rows only, no wrapper)
   */
  function buildComparisonHtml(decision, opts) {
    opts = opts || {};
    var quotes = (decision && decision.quotes) || [];
    var best = (decision && decision.best) || null;

    var valid = [];
    for (var i = 0; i < quotes.length; i++) {
      var q = quotes[i];
      if (!q || q.ok !== true) continue;
      var eo = tryBig(q.expectedOutRaw);
      if (eo === null || eo <= 0n) continue;
      valid.push(q);
    }

    if (!valid.length) {
      return '<div class="swp-comparison-empty">No quotes available</div>';
    }

    valid.sort(function (a, b) {
      var ea = tryBig(a.expectedOutRaw), eb = tryBig(b.expectedOutRaw);
      if (ea !== eb) return ea > eb ? -1 : 1;
      var ma = tryBig(a.minOutRaw), mb = tryBig(b.minOutRaw);
      if (ma !== mb) return ma > mb ? -1 : 1;
      return ((a.feeBps || 0) - (b.feeBps || 0));
    });

    var out = '';
    var seen = {};
    for (var j = 0; j < valid.length; j++) {
      var v = valid[j];
      seen[v.source] = true;
      var isBest = !!best && best.source === v.source;
      var fee = v.feeBps != null ? ((Number(v.feeBps) / 100).toFixed(2) + '%') : '—';
      out +=
        '<div class="swp-comp-row' + (isBest ? ' best' : '') + '">' +
          (isBest ? '<span class="swp-comp-badge">BEST PRICE</span>' : '') +
          '<div class="swp-comp-top"><span class="swp-comp-name">' + providerName(v) + '</span>' +
          '<span class="swp-comp-out">' + formatOut(v.expectedOutRaw, opts.tokenOutDecimals) + ' ' + (opts.tokenOut || '') + '</span></div>' +
          '<div class="swp-comp-sub"><span>Fee: ' + fee + '</span><span>' + sourceLabel(v) + '</span></div>' +
        '</div>';
    }

    // Unavailable sources shown discreetly (never a global error).
    for (var k = 0; k < quotes.length; k++) {
      var q2 = quotes[k];
      if (!q2 || q2.ok === true) continue;
      if (seen[q2.source]) continue;
      seen[q2.source] = true;
      out +=
        '<div class="swp-comp-row unavailable">' +
          '<div class="swp-comp-top"><span class="swp-comp-name">' + providerName(q2) + '</span>' +
          '<span class="swp-comp-out unavailable">unavailable</span></div>' +
        '</div>';
    }

    return out;
  }

  /** Render the comparison card into the DOM (Standard mode only). */
  function renderComparison(decision, opts) {
    try {
      var list = document.getElementById('swp-comparison-list');
      if (list) list.innerHTML = buildComparisonHtml(decision, opts);
      var card = document.getElementById('swp-comparison-card');
      if (card) {
        var hasRows = !!(card.querySelector && card.querySelector('.swp-comp-row, .swp-comparison-empty'));
        card.style.display = (_mode === 'standard' && hasRows) ? '' : 'none';
      }
    } catch (_) {}
  }

  /** Hide + empty the comparison card (no quote / route unavailable). */
  function clearComparison() {
    try {
      var list = document.getElementById('swp-comparison-list');
      if (list) list.innerHTML = '';
      var card = document.getElementById('swp-comparison-card');
      if (card) card.style.display = 'none';
    } catch (_) {}
  }

  function tryBig(v) {
    if (typeof v === 'bigint') return v;
    if (v == null) return null;
    try { var b = BigInt(String(v)); return b; } catch (_) { return null; }
  }

  // Apply the default mode (standard) once the DOM is ready.
  if (typeof document !== 'undefined') {
    var _boot = function () { try { applyMode(); } catch (_) {} };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _boot);
    else _boot();
  }

  window.SwapUiModes = {
    MODES: MODES.slice(),
    getMode: getMode,
    setMode: setMode,
    applyMode: applyMode,
    buildComparisonHtml: buildComparisonHtml,
    renderComparison: renderComparison,
    clearComparison: clearComparison,
    version: '1.0.0',
  };
})();
