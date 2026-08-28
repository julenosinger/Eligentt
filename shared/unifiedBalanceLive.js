/**
 * UnifiedBalanceLive — the Screen Live controller (Live Mode + Action Modes).
 * ═══════════════════════════════════════════════════════════════════════
 * OBSERVES operations — never executes them. It renders the real-time
 * operation stream and the contextual action-mode panels inside the Screen Live,
 * and turns the financial metrics into compact digital indicators.
 *
 *   Live Mode    → operation stream (bounded, latest first)
 *   Action Modes → send / swap / move / batch / bridge contextual status
 *
 * Subscribes ONCE to UBOperationBus (no duplicate listeners). No polling.
 *
 * Attached to window.UBLive
 */
(function () {
  'use strict';

  if (typeof window !== 'undefined' && window.UBLive) return;

  var MODES = ['live', 'send', 'swap', 'move', 'batch', 'bridge'];
  var MAX_STREAM = 20;

  var _mode = 'live';
  var _ops = [];          // bounded, most recent first
  var _sub = null;        // single bus subscription
  var _inited = false;

  function _bus() {
    try { return (typeof UBOperationBus !== 'undefined') ? UBOperationBus : null; } catch (_) { return null; }
  }

  function _el(id) {
    try { return document.getElementById(id); } catch (_) { return null; }
  }

  function _fmtTime(ts) {
    try { return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
    catch (_) { return '—'; }
  }

  function _short(a) {
    if (!a) return '—';
    if (a.length <= 12) return a;
    return a.slice(0, 6) + '...' + a.slice(-4);
  }

  function _fmtUSD(n) {
    return '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function _fmtAmt(op) {
    if (op.amount == null) return '';
    var a = Number(op.amount);
    if (!isFinite(a)) return '';
    var s = a.toLocaleString('en-US', { maximumFractionDigits: 4 });
    return s + (op.asset ? ' ' + op.asset : '');
  }

  function _statusColor(status) {
    switch (status) {
      case 'confirmed':
      case 'complete': return 'var(--green)';
      case 'failed': return 'var(--red)';
      case 'pending': return 'var(--yellow)';
      case 'started':
      case 'start':
      case 'update': return 'var(--teal)';
      default: return 'var(--muted2)';
    }
  }

  /* ── operation stream (internal, bounded) ── */
  function _onOperation(op) {
    // Dedup: update existing entry by id, never duplicate.
    for (var i = _ops.length - 1; i >= 0; i--) {
      if (_ops[i].id === op.id) { _ops.splice(i, 1); break; }
    }
    _ops.unshift(op);
    if (_ops.length > MAX_STREAM) _ops.length = MAX_STREAM;
    _renderStream();
  }

  /* ── Live Mode stream ── */
  function _renderStream() {
    var el = _el('ub-live-feed');
    if (!el) return;
    if (_mode !== 'live') return;

    if (!_ops.length) {
      el.innerHTML =
        '<div style="color:var(--muted);font-size:8.5px;font-weight:600;padding:6px 2px">No operations yet</div>' +
        '<div style="color:var(--muted2);font-size:8px;padding:0 2px 6px">Run a Send, Swap, Move, Batch or Bridge operation to see live activity here.</div>';
      return;
    }

    var html = '';
    for (var i = 0; i < _ops.length; i++) {
      var op = _ops[i];
      var type = String(op.type || op.source || 'op').toUpperCase();
      var dest = op.destination ? ' → ' + _short(op.destination) : '';
      var hash = op.txHash
        ? '<a href="https://testnet.arcscan.app/tx/' + op.txHash + '" target="_blank" style="color:var(--blue);font-size:7px;text-decoration:none" title="' + op.txHash + '">' + _short(op.txHash) + '</a>'
        : '';
      var prog = (op.progress != null)
        ? '<span style="display:inline-block;width:34px;height:3px;background:rgba(255,255,255,.08);border-radius:2px;overflow:hidden;vertical-align:middle"><span style="display:block;width:' + Math.max(0, Math.min(100, Number(op.progress))) + '%;height:100%;background:var(--teal)"></span></span>'
        : '';
      html += '<div class="ub-dash-feed-line">' +
        '<span class="t">' + _fmtTime(op.timestamp) + '</span>' +
        '<span class="n">' + type + '</span>' +
        '<span>' + _fmtAmt(op) + dest + '</span>' +
        prog +
        '<span style="margin-left:auto;color:' + _statusColor(op.status) + ';font-size:7px">' + op.status + '</span>' +
        hash +
        '</div>';
    }
    el.innerHTML = html;
  }

  /* ── compact financial indicators ── */
  function _metrics() {
    var m = { balance: 0, todayOut: 0, reserved: 0, projected7d: 0, projected30d: 0, received: 0, sent: 0, netFlow: 0, txCount: 0 };
    try {
      var UBM = (typeof UBMerchant !== 'undefined') ? UBMerchant : null;
      var cf = UBM && UBM.calcCashFlow ? UBM.calcCashFlow() : null;
      var mo = UBM && UBM.calcMonthlyOverview ? UBM.calcMonthlyOverview() : null;
      var ats = UBM && UBM.calcAvailableToSpend ? UBM.calcAvailableToSpend() : null;
      if (cf) {
        m.balance = cf.balance || 0;
        m.todayOut = cf.todayOut || 0;
        m.projected7d = cf.projected7d || 0;
        m.projected30d = cf.projected30d || 0;
        m.receivables = cf.receivables || 0;
      }
      if (ats) { m.reserved = ats.reserved || 0; }
      if (mo) {
        m.received = mo.received || 0;
        m.sent = mo.sent || 0;
        m.netFlow = mo.netFlow || 0;
        m.txCount = mo.totalTx || 0;
      }
    } catch (_) {}
    return m;
  }

  function _renderIndicators() {
    var el = _el('ub-financial-center');
    if (!el) return;
    var m = _metrics();
    function row(label, value, color, big) {
      return '<div class="ub-fin-row"><span class="ub-fin-label">' + label + '</span><span class="ub-fin-value' + (big ? ' big' : '') + '" style="color:' + (color || 'var(--text)') + '">' + value + '</span></div>';
    }

    el.innerHTML =
      '<div class="ub-fin">' +
        '<div class="ub-fin-head"><i class="ti ti-chart-line" style="font-size:9px;color:var(--teal)"></i><span class="ub-fin-head-label">Financial Telemetry</span></div>' +
        '<div class="ub-fin-cols">' +
          '<div class="ub-fin-col">' +
            row('Balance', _fmtUSD(m.balance), 'var(--teal)', true) +
            row('Out Today', _fmtUSD(m.todayOut), 'var(--red)') +
            row('Reserved', _fmtUSD(m.reserved), 'var(--yellow)') +
            row('7D Projected', _fmtUSD(m.projected7d), m.projected7d >= 0 ? 'var(--green)' : 'var(--red)') +
            row('30D Projected', _fmtUSD(m.projected30d), m.projected30d >= 0 ? 'var(--green)' : 'var(--red)') +
          '</div>' +
          '<div class="ub-fin-col">' +
            row('Received 30D', _fmtUSD(m.received), 'var(--green)') +
            row('Sent 30D', _fmtUSD(m.sent), 'var(--red)') +
            row('Net Flow', _fmtUSD(m.netFlow), m.netFlow >= 0 ? 'var(--green)' : 'var(--red)') +
            row('Tx Count', String(m.txCount), 'var(--blue)') +
          '</div>' +
        '</div>' +
      '</div>';
    el.style.display = 'flex';

    // Reveal the collapsible Financial Telemetry card + keep its summary fresh.
    var card = _el('ub-fin-card');
    if (card) card.style.display = '';
    var summary = _el('ub-fin-summary');
    if (summary) summary.textContent = _fmtUSD(m.balance);
  }

  /* ── Action Mode panel ── */
  function _modeMeta(mode) {
    var map = {
      send:   { icon: 'send', title: 'SEND MODE', action: 'Send Asset', page: 'send' },
      swap:   { icon: 'arrows-exchange', title: 'SWAP MODE', action: 'Swap Tokens', page: 'swap' },
      move:   { icon: 'topology-star-3', title: 'MOVE MODE', action: 'Move / Bridge', page: 'bridge' },
      batch:  { icon: 'stack', title: 'BATCH MODE', action: 'Batch Payment', page: 'batch' },
      bridge: { icon: 'world-share', title: 'BRIDGE MODE', action: 'Cross-chain Bridge', page: 'bridge' },
    };
    return map[mode] || map.send;
  }

  function _renderMode() {
    var el = _el('ub-live-mode');
    if (!el) return;
    var feedBody = _el('ub-live-feed');

    if (_mode === 'live') {
      el.style.display = 'none';
      if (feedBody) feedBody.style.display = '';
      _renderStream();
      return;
    }

    if (feedBody) feedBody.style.display = 'none';

    var meta = _modeMeta(_mode);
    // Latest matching operation for contextual status (if any).
    var latest = null;
    for (var i = 0; i < _ops.length; i++) {
      if ((_ops[i].type || '').toLowerCase().indexOf(_mode) !== -1 || (_ops[i].source || '').toLowerCase().indexOf(_mode) !== -1) {
        latest = _ops[i]; break;
      }
    }

    var statusHtml;
    if (latest) {
      statusHtml = '<span class="ub-live-mode-status" style="color:' + _statusColor(latest.status) + '">' + latest.status + '</span>';
    } else {
      statusHtml = '<span class="ub-live-mode-status" style="color:var(--muted2)">Ready</span>';
    }

    el.style.display = 'block';
    el.innerHTML =
      '<div class="ub-live-mode-bar">' +
        '<i class="ti ti-' + meta.icon + '" style="font-size:13px;color:var(--teal)"></i>' +
        '<span class="ub-live-mode-title">' + meta.title + '</span>' +
        statusHtml +
        '<span style="margin-left:auto;display:flex;gap:6px">' +
          '<button class="btn" onclick="if(window.exitUnifiedBalanceMode){exitUnifiedBalanceMode();}else{UBLive.exitToLive();}" style="font-size:8px;padding:3px 8px"><i class="ti ti-arrow-left"></i> Back to Live</button>' +
        '</span>' +
      '</div>' +
      '<div class="ub-live-mode-hint" style="padding:5px 2px 0">Configure the ' + _mode + ' operation in the panel — execution reuses the existing flow.</div>';
  }

  function _renderAll() {
    _renderIndicators();
    _renderStream();
    _renderMode();
  }

  /* ── public API ── */
  function setMode(mode) {
    if (MODES.indexOf(mode) === -1) mode = 'live';
    _mode = mode;
    _renderAll();
    return _mode;
  }

  function enterAction(mode) {
    return setMode(mode);
  }

  function exitToLive() {
    return setMode('live');
  }

  function getMode() { return _mode; }

  function refresh() { _renderAll(); }

  function init() {
    if (_inited) return;
    _inited = true;
    var bus = _bus();
    if (bus) {
      // Register exactly ONCE.
      _sub = bus.on(function (op) { _onOperation(op); });
    }
    // Seed the stream from any already-tracked history.
    if (bus && typeof bus.history === 'function') {
      var hist = bus.history(MAX_STREAM);
      for (var i = hist.length - 1; i >= 0; i--) _onOperation(hist[i]);
    }
    _renderAll();
  }

  window.UBLive = {
    MODES: MODES.slice(),
    init: init,
    setMode: setMode,
    enterAction: enterAction,
    exitToLive: exitToLive,
    getMode: getMode,
    refresh: refresh,
    version: '1.0.0',
  };
})();
