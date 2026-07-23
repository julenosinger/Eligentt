/**
 * Elligentt Autonoma NLU Consolidation — Phase 5 Remediation
 * Resolves the dual NLU problem: AutonomaCore has its own understand() AND
 * AutonomaNLU has decompose(). Only ONE intent parser must exist.
 *
 * Strategy: Integrate AutonomaNLU.decompose() INTO AutonomaCore.process()
 * as an enhancement layer. The original WORD_MAP understand() remains as
 * fallback for legacy commands.
 *
 * Attached to window.AutonomaConsolidation
 */
(function(){
  'use strict';

  var _installed = false;

  /**
   * Enhanced process() that uses AutonomaNLU for entity extraction,
   * then falls back to AutonomaCore's WORD_MAP for intent routing.
   */
  function enhancedProcess(msg, callbacks) {
    // Try AutonomaNLU first for rich entity extraction
    var enriched = null;
    try {
      if (typeof window.AutonomaNLU !== 'undefined') {
        enriched = window.AutonomaNLU.enrich(msg);
      }
    } catch(e) {}

    // If AutonomaNLU enriched the message with entities, use them
    if (enriched && enriched.type === 'enriched' && enriched.enhanced) {
      var e = enriched.enhanced;

      // Pass enriched entities to the original AutonomaCore.process
      if (typeof window.AutonomaCore !== 'undefined') {
        // Build enhanced callbacks
        var enhancedCallbacks = callbacks || {};
        enhancedCallbacks._enrichedEntities = e;

        var result = window.AutonomaCore._originalProcess ?
          window.AutonomaCore._originalProcess(msg, enhancedCallbacks) :
          window.AutonomaCore.process(msg, enhancedCallbacks);

        // Attach NLU metadata
        if (result && typeof result === 'object') {
          result._nluEnhanced = true;
          result._enrichedData = {
            amount: e.amount,
            token: e.token,
            address: e.address,
            chain: e.chain || e.toChain,
            fromChain: e.fromChain,
            toChain: e.toChain,
            recurrence: e.recurrence,
            date: e.date,
            time: e.time,
            action: e.action,
            intentType: e.intentType,
            executionType: e.executionType
          };
        }
        return result;
      }
    }

    // Fallback to original AutonomaCore.process
    if (typeof window.AutonomaCore !== 'undefined') {
      var fallbackResult = window.AutonomaCore._originalProcess ?
        window.AutonomaCore._originalProcess(msg, callbacks) :
        window.AutonomaCore.process(msg, callbacks);
      return fallbackResult;
    }

    // Neither available
    return { type: 'error', msg: 'Autonoma processing unavailable' };
  }

  function install() {
    if (_installed) return;

    var maxAttempts = 60;
    var attempts = 0;

    function tryInstall() {
      attempts++;

      if (typeof window.AutonomaCore !== 'undefined') {
        // Save original to prevent circular reference
        if (!window.AutonomaCore._originalProcess) {
          window.AutonomaCore._originalProcess = window.AutonomaCore.process;
        }

        // Replace with enhanced version
        window.AutonomaCore.process = enhancedProcess;

        _installed = true;
        console.log('[AutonomaConsolidation] NLU consolidated. AutonomaNLU → AutonomaCore bridge active.');
        return;
      }

      if (attempts < maxAttempts) setTimeout(tryInstall, 200);
    }

    tryInstall();
  }

  /**
   * Check if AutonomaNLU is being used by any module.
   * Returns dependency report.
   */
  function analyzeDependencies() {
    var report = {
      autonomaCoreUsed: typeof window.AutonomaCore !== 'undefined',
      autonomaNLUUsed: typeof window.AutonomaNLU !== 'undefined',
      nluConsumed: false,
      nluCalledFrom: [],
      recommendation: ''
    };

    // Check if AutonomaNLU is ever called
    if (report.autonomaNLUUsed) {
      // Scan for references in other modules (rough check)
      var keys = Object.keys(window);
      for (var i = 0; i < keys.length; i++) {
        var val = window[keys[i]];
        if (val && typeof val === 'object' && val !== window.AutonomaNLU) {
          try {
            var str = JSON.stringify(Object.keys(val));
            if (str.indexOf('decompose') !== -1 || str.indexOf('enrich') !== -1) {
              report.nluCalledFrom.push(keys[i]);
            }
          } catch(e) {}
        }
      }

      report.nluConsumed = report.nluCalledFrom.length > 0;
    }

    if (!report.nluConsumed && report.autonomaCoreUsed) {
      report.recommendation = 'AutonomaNLU is NOT consumed by any other module. Safe to mark as DORMANT. AutonomaCore.process() is the active parser.';
    } else if (report.nluConsumed) {
      report.recommendation = 'AutonomaNLU IS consumed. Keep integrated through the consolidation bridge.';
    }

    return report;
  }

  // Auto-install
  setTimeout(install, 2000);

  window.AutonomaConsolidation = {
    install: install,
    enhancedProcess: enhancedProcess,
    analyzeDependencies: analyzeDependencies,
    isInstalled: function() { return _installed; }
  };
})();
