/**
 * Elligentt EventMigrationLayer — Bridge inline onclick → EventBus (Phase 13.3)
 * Captures legacy inline event handlers and routes them to EventBus.
 * Maintains compatibility during migration. Never breaks existing handlers.
 * Attached to: window.EventMigrationLayer
 */
(function () {
  'use strict';

  var _captured = [];
  var _active = false;

  function start() {
    if (_active) return;
    _active = true;

    // Listen for DOM changes to capture newly added onclick handlers
    try {
      if (typeof document !== 'undefined' && document.body) {
        _scanDom(document.body);
      }
    } catch (_e) {}

    // Observer for dynamic content
    try {
      if (typeof MutationObserver !== 'undefined') {
        var obs = new MutationObserver(function (mutations) {
          mutations.forEach(function (m) {
            m.addedNodes.forEach(function (node) {
              if (node.nodeType === 1) _scanDom(node);
            });
          });
        });
        obs.observe(document.body, { childList: true, subtree: true });
      }
    } catch (_e2) {}

    console.log('[EventMigrationLayer] Active — capturing inline handlers');
  }

  function _scanDom(root) {
    try {
      var elements = root.querySelectorAll ? root.querySelectorAll('[onclick],[onchange],[oninput],[onsubmit]') : [];
      // Legacy handlers remain fully functional — we only log for analysis
      if (elements.length > 0 && _captured.length < 100) {
        for (var i = 0; i < Math.min(elements.length, 10); i++) {
          _captured.push({
            tag: elements[i].tagName,
            id: elements[i].id || '',
            onclick: elements[i].getAttribute('onclick') || '',
            capturedAt: Date.now()
          });
        }
      }
    } catch (_e) {}
  }

  function getCaptured() { return _captured.slice(); }
  function getCount() { return _captured.length; }

  function stop() { _active = false; }

  /** Analyze captured handlers and suggest EventBus equivalents */
  function analyze() {
    var report = {
      totalCaptured: _captured.length,
      suggestions: []
    };

    var _suggestions = {
      'showPage':   'EventBus.emit("PAGE_CHANGED") via TabManager.activate()',
      'renderContacts': 'EventBus.emit("CONTACTS_REFRESH") via ContactsDomain.refresh()',
      'updateSwapRate': 'EventBus.emit("SWAP_UPDATED") via SwapDomain.refresh()',
      'updateBridgeEst': 'EventBus.emit("BRIDGE_UPDATED") via BridgeDomain.refresh()',
      'renderQueueTable': 'EventBus.emit("HISTORY_REFRESH") via HistoryDomain.refresh()',
      'renderInvoices': 'EventBus.emit("INVOICES_REFRESH") via Docs domain'
    };

    Object.keys(_suggestions).forEach(function (key) {
      var count = _captured.filter(function (c) { return c.onclick && c.onclick.indexOf(key) !== -1; }).length;
      if (count > 0) {
        report.suggestions.push({ handler: key, occurrences: count, suggestion: _suggestions[key] });
      }
    });

    return report;
  }

  window.EventMigrationLayer = {
    VERSION: '1.0.0',
    start: start, stop: stop,
    getCaptured: getCaptured, getCount: getCount,
    analyze: analyze
  };
})();
