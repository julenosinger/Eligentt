/**
 * SwapUiModes — Standard/Advanced presentation controller + ROUTES comparison selector.
 * ═══════════════════════════════════════════════════════════════════════
 * Presentation-only layer for the Swap page. It never quotes or executes
 * anything — it switches how the SAME Swap Engine is presented, and renders the
 * side-by-side route comparison from quotes already produced by SwapAggregator.
 *
 *   Standard  → clean DEX: no chart/market bar, ROUTES selector on the right
 *   Advanced  → full terminal: chart + market data + technical details (unchanged)
 *
 * Selection is a canonical source string (e.g. 'local' | 'tower') resolved here
 * and consumed by the caller (index.html) to drive the executed route. Providers
 * are rendered from metadata, so a future provider only needs a normalized quote
 * (no rendering rewrite).
 *
 * Attached to window.SwapUiModes
 */
(function () {
  'use strict';

  if (typeof window !== 'undefined' && window.SwapUiModes) return;

  var MODES = ['standard', 'advanced'];
  var _mode = 'standard';

  // Provider metadata — the UI renders these dynamically. A future provider only
  // needs a normalized quote + an entry here (the engine already normalizes).
  var PROVIDER_META = {
    local: { id: 'local', name: 'Elligentt', type: 'AMM', sourceLabel: 'Local AMM' },
    tower: { id: 'tower', name: 'Tower', type: 'AGG', sourceLabel: 'Aggregator' },
  };

  function getMode() { return _mode; }

  function setMode(mode) {
    if (MODES.indexOf(mode) === -1) mode = 'standard';
    _mode = mode;
    applyMode();
    return _mode;
  }

  function providerMeta(source) {
    if (PROVIDER_META[source]) return PROVIDER_META[source];
    return { id: source, name: source || 'Provider', type: '', sourceLabel: source || '' };
  }

  function tryBig(v) {
    if (typeof v === 'bigint') return v;
    if (v == null) return null;
    try { var b = BigInt(String(v)); return b; } catch (_) { return null; }
  }

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

  function isExecutableQuote(q) {
    if (!q || q.ok !== true || q.executable !== true) return false;
    var eo = tryBig(q.expectedOutRaw);
    var mo = tryBig(q.minOutRaw);
    return eo !== null && eo > 0n && mo !== null && mo > 0n;
  }

  /**
   * Resolve the selected route after a new aggregator decision.
   * A manual selection persists across refreshes with the SAME params key; it
   * resets to the best executable when the params changed or the selection is no
   * longer valid (provider became invalid / disappeared / failed validation).
   * @param {object} decision SwapAggregator decision
   * @param {string|null} prevSource previous selected source
   * @param {string|null} prevKey previous params key
   * @param {string} currentKey current params key
   * @returns {string|null} selected source (or null = none executable)
   */
  function resolveSelection(decision, prevSource, prevKey, currentKey) {
    var quotes = (decision && decision.quotes) || [];
    var exec = {};
    for (var i = 0; i < quotes.length; i++) {
      if (isExecutableQuote(quotes[i])) exec[quotes[i].source] = true;
    }
    if (prevSource && prevKey === currentKey && exec[prevSource]) return prevSource;
    var bestExec = (decision && decision.bestExecutable) || null;
    if (bestExec && exec[bestExec.source]) return bestExec.source;
    return null;
  }

  /** Find the executable quote object for a source. */
  function findExecutableQuote(quotes, source) {
    for (var i = 0; i < (quotes || []).length; i++) {
      var q = quotes[i];
      if (q && q.source === source && isExecutableQuote(q)) return q;
    }
    return null;
  }

  /** Apply the mode classes (removes the routes class when leaving Standard). */
  function applyMode() {
    try {
      var page = document.getElementById('page-swap');
      if (page) {
        page.classList.remove('swp-standard', 'swp-advanced');
        page.classList.add('swp-' + _mode);
        if (_mode !== 'standard') page.classList.remove('swp-routes');
      }
      // Body-level class so the site footer (a sibling of the app shell) can be
      // shown only in Standard swap mode.
      if (document.body) {
        document.body.classList.remove('swap-standard-mode', 'swap-advanced-mode');
        document.body.classList.add(_mode === 'standard' ? 'swap-standard-mode' : 'swap-advanced-mode');
      }
      var stdBtn = document.getElementById('swp-mode-standard');
      var advBtn = document.getElementById('swp-mode-advanced');
      if (stdBtn) stdBtn.classList.toggle('active', _mode === 'standard');
      if (advBtn) advBtn.classList.toggle('active', _mode === 'advanced');
    } catch (_) {}
  }

  /**
   * Build the ROUTES comparison list from a SwapAggregator decision.
   * Executable quotes are selectable; non-executable quotes are "Reference only".
   * @param {object} decision { quotes:[], bestExecutable }
   * @param {string|null} selectedSource
   * @param {object} opts { tokenIn, tokenInDecimals, tokenOut, tokenOutDecimals, amountInRaw }
   * @returns {string} HTML (rows only)
   */
  function buildRouteListHtml(decision, selectedSource, opts) {
    opts = opts || {};
    var quotes = (decision && decision.quotes) || [];

    var valid = [];
    for (var i = 0; i < quotes.length; i++) {
      var q = quotes[i];
      if (!q || q.ok !== true) continue;
      var eo = tryBig(q.expectedOutRaw);
      if (eo === null || eo <= 0n) continue;
      valid.push(q);
    }

    if (!valid.length) {
      return '<div class="route-empty">No routes available</div>';
    }

    valid.sort(function (a, b) {
      var ea = tryBig(a.expectedOutRaw), eb = tryBig(b.expectedOutRaw);
      if (ea !== eb) return ea > eb ? -1 : 1;
      var ma = tryBig(a.minOutRaw), mb = tryBig(b.minOutRaw);
      if (ma !== mb) return ma > mb ? -1 : 1;
      return ((a.feeBps || 0) - (b.feeBps || 0));
    });

    var execs = [], refs = [];
    for (var j = 0; j < valid.length; j++) {
      (valid[j].executable === true ? execs : refs).push(valid[j]);
    }

    var out = '';
    var seen = {};

    function row(q, executable, selected) {
      var meta = providerMeta(q.source);
      var o = formatOut(q.expectedOutRaw, opts.tokenOutDecimals);
      var fee = q.feeBps != null ? ((Number(q.feeBps) / 100).toFixed(2) + '%') : '';
      var impact = q.priceImpactBps != null ? ((Number(q.priceImpactBps) / 100).toFixed(2) + '% impact') : '';

      var state;
      if (!executable) {
        state = '<span class="route-state ref">Reference only</span>';
      } else if (selected) {
        state = '<span class="route-state sel">✓ Selected</span>';
      } else {
        state = '<span class="route-state">Select</span>';
      }

      var cls = 'route-row' + (selected ? ' selected' : '') + (executable ? '' : ' reference');
      var click = executable ? (' onclick="swpSelectRoute(\'' + q.source + '\')"') : '';

      var line2 = '';
      if (fee) line2 += '<span>Fee ' + fee + '</span>';
      if (impact) line2 += '<span>' + impact + '</span>';
      line2 += '<span>' + meta.sourceLabel + '</span>';

      return '<div class="' + cls + '"' + click + ' data-source="' + q.source + '">' +
        '<div class="route-radio">' + (selected ? '<span></span>' : '') + '</div>' +
        '<div class="route-main">' +
          '<div class="route-line1"><span class="route-name">' + meta.name + '</span>' +
            '<span class="route-tag">' + meta.type + '</span>' +
            '<span class="route-out">' + o + ' ' + (opts.tokenOut || '') + '</span></div>' +
          '<div class="route-line2">' + line2 + '</div>' +
        '</div>' +
        state +
      '</div>';
    }

    for (var k = 0; k < execs.length; k++) {
      var e = execs[k];
      seen[e.source] = true;
      out += row(e, true, selectedSource === e.source);
    }
    for (var r = 0; r < refs.length; r++) {
      var rq = refs[r];
      seen[rq.source] = true;
      out += row(rq, false, false);
    }

    // Unavailable sources shown discreetly (never a global error).
    for (var m = 0; m < quotes.length; m++) {
      var q2 = quotes[m];
      if (!q2 || q2.ok === true) continue;
      if (seen[q2.source]) continue;
      seen[q2.source] = true;
      var meta2 = providerMeta(q2.source);
      out +=
        '<div class="route-row unavailable" data-source="' + q2.source + '">' +
          '<div class="route-radio"></div>' +
          '<div class="route-main"><div class="route-line1"><span class="route-name">' + meta2.name + '</span>' +
            '<span class="route-out unavailable">unavailable</span></div></div>' +
          '<span class="route-state ref">Unavailable</span>' +
        '</div>';
    }

    return out;
  }

  /** Render the ROUTES selector into the DOM (Standard mode only). */
  function renderRouteSelector(decision, selectedSource, opts) {
    try {
      var list = document.getElementById('swap-route-list');
      if (list) list.innerHTML = buildRouteListHtml(decision, selectedSource, opts);
      var page = document.getElementById('page-swap');
      var status = document.getElementById('swap-route-status');
      if (status) status.textContent = 'Compare execution routes';
      var hasValid = !!((decision && decision.quotes || []).some(function (q) {
        return q && q.ok === true;
      }));
      if (page && _mode === 'standard' && hasValid) {
        page.classList.add('swp-routes');
      } else if (page) {
        page.classList.remove('swp-routes');
      }
    } catch (_) {}
  }

  /** Show the loading state inside the route card (Standard mode). */
  function showRouteLoading() {
    try {
      var page = document.getElementById('page-swap');
      var list = document.getElementById('swap-route-list');
      var status = document.getElementById('swap-route-status');
      if (_mode === 'standard' && page) page.classList.add('swp-routes');
      if (status) status.textContent = 'Finding routes...';
      if (list) list.innerHTML =
        '<div class="route-empty"><i class="ti ti-loader-2 spin"></i> Finding routes...</div>';
    } catch (_) {}
  }

  /** Hide + empty the route card (no amount / no route / error / leaving Standard). */
  function clearRouteSelector() {
    try {
      var page = document.getElementById('page-swap');
      var list = document.getElementById('swap-route-list');
      if (page) page.classList.remove('swp-routes');
      if (list) list.innerHTML = '';
    } catch (_) {}
  }

  // Apply the default mode (standard) once the DOM is ready.
  if (typeof document !== 'undefined') {
    var _boot = function () { try { applyMode(); } catch (_) {} };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _boot);
    else _boot();
  }

  window.SwapUiModes = {
    MODES: MODES.slice(),
    PROVIDER_META: PROVIDER_META,
    getMode: getMode,
    setMode: setMode,
    applyMode: applyMode,
    providerMeta: providerMeta,
    isExecutableQuote: isExecutableQuote,
    resolveSelection: resolveSelection,
    findExecutableQuote: findExecutableQuote,
    buildRouteListHtml: buildRouteListHtml,
    renderRouteSelector: renderRouteSelector,
    showRouteLoading: showRouteLoading,
    clearRouteSelector: clearRouteSelector,
    version: '2.0.0',
  };
})();
