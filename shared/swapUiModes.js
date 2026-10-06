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
    lifi:  { id: 'lifi',  name: 'LI.FI',    type: 'AGG', sourceLabel: 'LI.FI Aggregator' },
  };

  function getMode() { return _mode; }

  function setMode(mode) {
    if (MODES.indexOf(mode) === -1) mode = 'standard';
    _mode = mode;
    applyMode();
    return _mode;
  }

  function providerMeta(source, quote) {
    if (PROVIDER_META[source]) return PROVIDER_META[source];
    // lifi-<routeId>: a real route from getRoutes — use the actual tool label
    // (e.g. 'Stargate', 'Across', 'CCTP') carried in quote.label when available.
    if (source && source.indexOf('lifi-') === 0) {
      var toolLabel = (quote && quote.label) ? quote.label : null;
      var displayName = toolLabel || 'LI.FI';
      return { id: source, name: displayName, type: 'BRIDGE', sourceLabel: 'via LI.FI' };
    }
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
    // Build ordered list of selectable sources (best output first — already sorted
    // by SwapAggregator's pickBest, but we re-sort here to be safe).
    var selectableOrdered = [];
    for (var i = 0; i < quotes.length; i++) {
      // lifi-N quotes are selectable but may not have calldata yet (_needsStepTx).
      // Treat them as selectable for route-comparison display purposes.
      if (isExecutableQuote(quotes[i]) || (quotes[i] && quotes[i].ok === true && quotes[i]._needsStepTx)) {
        exec[quotes[i].source] = true;
        selectableOrdered.push(quotes[i]);
      }
    }
    // Sort selectable by expectedOutRaw desc so first item = best output.
    selectableOrdered.sort(function(a, b) {
      var ea = (typeof a.expectedOutRaw === 'bigint') ? a.expectedOutRaw : BigInt(String(a.expectedOutRaw || 0));
      var eb = (typeof b.expectedOutRaw === 'bigint') ? b.expectedOutRaw : BigInt(String(b.expectedOutRaw || 0));
      return ea > eb ? -1 : ea < eb ? 1 : 0;
    });

    // Persist a valid manual selection across refreshes with the same params.
    if (prevSource && prevKey === currentKey && exec[prevSource]) return prevSource;
    // Use bestExecutable when available (has ready calldata).
    var bestExec = (decision && decision.bestExecutable) || null;
    if (bestExec && exec[bestExec.source]) return bestExec.source;
    // Fall back to the best selectable lifi-N route (calldata fetched on user confirm).
    if (selectableOrdered.length > 0) return selectableOrdered[0].source;
    return null;
  }

  /** Find the executable quote object for a source. */
  function findExecutableQuote(quotes, source) {
    for (var i = 0; i < (quotes || []).length; i++) {
      var q = quotes[i];
      if (!q || q.source !== source) continue;
      // lifi-N quotes are selectable even before calldata is fetched (flagged _needsStepTx).
      if (isExecutableQuote(q) || (q.ok === true && q._needsStepTx)) return q;
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

  // Chain short names for cross-chain path display.
  var CHAIN_SHORT = { 5042:'Arc', 1:'ETH', 8453:'Base', 42161:'ARB', 10:'OP', 137:'POL' };

  function chainShort(id) {
    return id != null ? (CHAIN_SHORT[Number(id)] || ('#' + id)) : '';
  }

  function fmtTime(sec) {
    if (sec == null || isNaN(Number(sec))) return null;
    var s = Number(sec);
    if (s < 60) return '~' + Math.round(s) + 's';
    return '~' + Math.round(s / 60) + 'm';
  }

  function fmtFee(feeBps, amountInRaw, decimals) {
    // Returns a human-readable fee string from feeBps + input amount.
    if (feeBps == null) return null;
    try {
      var pct = (Number(feeBps) / 100).toFixed(2) + '%';
      return pct;
    } catch (_) { return null; }
  }

  function escH(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  /**
   * Build the ROUTES comparison list from a SwapAggregator decision.
   * Executable quotes are selectable; non-executable are shown as reference.
   * @param {object} decision { quotes:[], bestExecutable }
   * @param {string|null} selectedSource
   * @param {object} opts { tokenIn, tokenInDecimals, tokenOut, tokenOutDecimals, amountInRaw, fromChainId, toChainId }
   * @returns {string} HTML (rows only)
   */
  function buildRouteListHtml(decision, selectedSource, opts) {
    opts = opts || {};
    var quotes = (decision && decision.quotes) || [];

    // Collect valid (ok + positive output) quotes — selectable includes _needsStepTx.
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

    // Sort: best output first (mirrors Bridge ordering).
    valid.sort(function (a, b) {
      var ea = tryBig(a.expectedOutRaw), eb = tryBig(b.expectedOutRaw);
      if (ea !== eb) return ea > eb ? -1 : 1;
      var ma = tryBig(a.minOutRaw), mb = tryBig(b.minOutRaw);
      if (ma !== mb) return ma > mb ? -1 : 1;
      return ((a.feeBps || 0) - (b.feeBps || 0));
    });

    // Badge assignments (same logic as _brsRenderRoutes in Bridge).
    var bestRateIdx = 0;

    var fastestIdx = -1;
    var fastestTime = Infinity;
    for (var fi = 0; fi < valid.length; fi++) {
      var et = valid[fi].estimatedTime != null ? Number(valid[fi].estimatedTime)
             : valid[fi].execSec != null ? Number(valid[fi].execSec) : null;
      if (et !== null && et < fastestTime) { fastestTime = et; fastestIdx = fi; }
    }
    if (fastestIdx === 0) fastestIdx = -1;

    var tokenOutSym = typeof opts.tokenOut === 'object' ? (opts.tokenOut.symbol || 'USDC') : (opts.tokenOut || 'USDC');
    var tokenOutDec = opts.tokenOutDecimals != null ? opts.tokenOutDecimals
      : (typeof opts.tokenOut === 'object' && opts.tokenOut ? opts.tokenOut.decimals : null);

    var out = '';
    var seen = {};

    for (var j = 0; j < valid.length; j++) {
      var q = valid[j];
      seen[q.source] = true;
      var isBest    = j === bestRateIdx;
      var isFastest = j === fastestIdx;
      var isSel     = selectedSource === q.source;
      var isSelectable = q.executable === true || q._needsStepTx === true;

      var meta = providerMeta(q.source, q);
      var provLetter = (meta.name || '?').charAt(0).toUpperCase();

      var outStr = formatOut(q.expectedOutRaw, tokenOutDec);

      // Metrics — same 5 columns as Bridge: Bridge fee, Protocol fees, Est. gas, Est. time, Steps.
      var feePctStr = q.feeBps != null ? (Number(q.feeBps) / 100).toFixed(2) + '%' : '—';
      var feesUsd   = q.feeCostUSD != null ? '$' + Number(q.feeCostUSD).toFixed(3) : '—';
      var gasUsd    = q.gasCostUSD  != null ? '$' + Number(q.gasCostUSD).toFixed(3)  : '—';
      var execSec   = q.estimatedTime != null ? q.estimatedTime : (q.execSec != null ? q.execSec : null);
      var timeStr   = execSec != null ? (Number(execSec) < 60 ? Math.round(Number(execSec)) + 's'
                        : Math.round(Number(execSec) / 60) + ' min') : '—';
      var stepsNum  = (q.stepsData && q.stepsData.length) || (typeof q.steps === 'number' ? q.steps : null) || 1;

      // Badges — absolute-positioned like Bridge (brs-best-badge).
      var badges = '';
      if (isBest)    badges += '<div class="brs-best-badge">Best Rate</div>';
      if (isFastest) badges += '<div class="brs-best-badge" style="right:auto;left:12px;background:var(--purple)">Fastest</div>';

      // Select button — same style as Bridge.
      var selectHtml;
      if (!isSelectable) {
        selectHtml = '<span class="brs-unavail-tag">Reference</span>';
      } else if (isSel) {
        selectHtml = '<button class="brs-select-btn brs-select-btn--selected" onclick="event.stopPropagation();swpSelectRoute(\'' + escH(q.source) + '\')"><i class="ti ti-check"></i> Selected</button>';
      } else {
        selectHtml = '<button class="brs-select-btn" onclick="event.stopPropagation();swpSelectRoute(\'' + escH(q.source) + '\')">Select</button>';
      }

      var cls = 'brs-route' +
        (isBest ? ' brs-best' : '') +
        (isSel  ? ' brs-selected' : '') +
        (!isSelectable ? ' brs-unavail' : '');

      out += '<div class="' + cls + '" data-source="' + escH(q.source) + '">' +
        badges +
        '<div class="brs-route-top">' +
          '<div class="brs-provider-icon">' + provLetter + '</div>' +
          '<div style="flex:1;min-width:0;overflow:hidden">' +
            '<div class="brs-provider-name">' + escH(meta.name) + '</div>' +
            '<div class="brs-protocol-tag">' + escH(meta.sourceLabel) + '</div>' +
          '</div>' +
          '<div class="brs-out-amount" style="margin-left:8px">' +
            '<div class="brs-out-val">' + escH(outStr) + '</div>' +
            '<div class="brs-out-label">' + escH(tokenOutSym) + ' received</div>' +
          '</div>' +
          '<div class="brs-route-steps" style="margin-left:8px;flex-shrink:0;padding-top:0;border-top:none">' + selectHtml + '</div>' +
        '</div>' +
        '<div class="brs-meta">' +
          '<div class="brs-meta-item"><div class="brs-meta-val">' + feePctStr + '</div><div class="brs-meta-lbl">Bridge fee</div></div>' +
          '<div class="brs-meta-item"><div class="brs-meta-val">' + feesUsd   + '</div><div class="brs-meta-lbl">Protocol fees</div></div>' +
          '<div class="brs-meta-item"><div class="brs-meta-val">' + gasUsd    + '</div><div class="brs-meta-lbl">Est. gas</div></div>' +
          '<div class="brs-meta-item"><div class="brs-meta-val">' + timeStr   + '</div><div class="brs-meta-lbl">Est. time</div></div>' +
          '<div class="brs-meta-item"><div class="brs-meta-val">' + stepsNum  + '</div><div class="brs-meta-lbl">Steps</div></div>' +
        '</div>' +
      '</div>';
    }

    // Unavailable providers (ok=false) — discreet, same as Bridge.
    for (var m = 0; m < quotes.length; m++) {
      var q2 = quotes[m];
      if (!q2 || q2.ok === true) continue;
      if (seen[q2.source]) continue;
      seen[q2.source] = true;
      var meta2 = providerMeta(q2.source, q2);
      out +=
        '<div class="brs-route brs-unavail" data-source="' + escH(q2.source) + '">' +
          '<div class="brs-route-top">' +
            '<div class="brs-provider-icon">' + escH((meta2.name || '?').charAt(0).toUpperCase()) + '</div>' +
            '<div style="flex:1;min-width:0"><div class="brs-provider-name">' + escH(meta2.name) + '</div></div>' +
            '<span class="brs-unavail-tag">Unavailable</span>' +
          '</div>' +
        '</div>';
    }

    return out;
  }

  /** Render the ROUTES selector into the DOM (Standard mode only). */
  function renderRouteSelector(decision, selectedSource, opts) {
    try {
      opts = opts || {};
      var list = document.getElementById('swap-route-list');
      if (list) list.innerHTML = buildRouteListHtml(decision, selectedSource, opts);
      var page = document.getElementById('page-swap');
      var status = document.getElementById('swap-route-status');
      // Count valid quotes for the status label.
      var validCount = ((decision && decision.quotes) || []).filter(function (q) {
        return q && q.ok === true;
      }).length;
      // Cross-chain label.
      var fromId = opts.fromChainId != null ? opts.fromChainId : (opts.chainId || null);
      var toId   = opts.toChainId   != null ? opts.toChainId   : (opts.chainId || null);
      var isCross = fromId != null && toId != null && Number(fromId) !== Number(toId);
      if (status) {
        var label = validCount ? (validCount + ' route' + (validCount !== 1 ? 's' : '')) : 'No routes';
        if (isCross && fromId && toId) {
          var cs = CHAIN_SHORT[Number(fromId)] || ('#' + fromId);
          var cd = CHAIN_SHORT[Number(toId)]   || ('#' + toId);
          label += ' · ' + cs + ' → ' + cd;
        }
        status.textContent = label;
      }
      var hasValid = validCount > 0;
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
