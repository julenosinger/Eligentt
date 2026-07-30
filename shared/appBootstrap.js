/**
 * Elligentt AppBootstrap — Application Orchestrator (Phase 1 Architecture)
 *
 * Centralized startup orchestrator. Initializes every module in strict order.
 * Prevents duplicated initialization. Detects initialization failures.
 * Logs startup timing for performance analysis.
 *
 * Contains ZERO business logic. Only orchestration.
 *
 * Attached to: window.AppBootstrap
 *
 * @module appBootstrap
 * @version 1.0.0
 */
(function () {
  'use strict';

  var VERSION = '1.0.0';

  /** @type {boolean} */
  var _started = false;

  /** @type {boolean} */
  var _initialized = false;

  /** @type {{ phase: string, startTime: number, endTime: number|null, success: boolean|null, error: string|null }[]} */
  var _phases = [];

  /** @type {Record<string, number>} Phase durations in ms */
  var _durations = {};

  /**
   * Register a startup phase.
   * @param {string} phaseName
   * @returns {{ start: number }} Timing marker
   */
  function _beginPhase(phaseName) {
    var entry = { phase: phaseName, startTime: performance.now(), endTime: null, success: null, error: null };
    _phases.push(entry);
    return { start: entry.startTime };
  }

  /**
   * Complete a startup phase.
   * @param {string} phaseName
   * @param {boolean} success
   * @param {string} [error]
   */
  function _endPhase(phaseName, success, error) {
    for (var i = _phases.length - 1; i >= 0; i--) {
      if (_phases[i].phase === phaseName) {
        _phases[i].endTime = performance.now();
        _phases[i].success = success;
        _phases[i].error = error || null;
        _durations[phaseName] = _phases[i].endTime - _phases[i].startTime;
        break;
      }
    }
  }

  /* ════════════════════════════════════════════
     STARTUP SEQUENCE
  ════════════════════════════════════════════ */

  /**
   * Initialize the application in a strict, deterministic order.
   *
   * Startup order:
   *   1. Configuration
   *   2. EventBus
   *   3. Stores
   *   4. RPC Service
   *   5. Wallet Service
   *   6. Modal Manager
   *   7. Toast Manager
   *   8. Tab Manager
   *   9. Notification Service
   *   10. Module Loader
   *   11. AI Wallet
   *   12. Autonoma
   *   13. Contacts
   *   14. Scheduler
   *   15. Treasury
   *   16. UI
   *   17. Application Ready
   *
   * Each phase failure is logged but does NOT stop subsequent phases.
   *
   * @param {Object} [opts]
   * @param {Function} [opts.onReady] - Called after all phases complete
   * @returns {Promise<void>}
   */
  async function start(opts) {
    if (_started) {
      console.warn('[AppBootstrap] Already started — skipping duplicate initialization');
      return;
    }
    _started = true;

    var o = opts || {};
    var onReady = o.onReady || null;

    var t0 = performance.now();
    console.log('[AppBootstrap] Starting application bootstrap v' + VERSION + '...');

    /* ── Phase 1: Configuration ────────────────────────────────── */
    _beginPhase('config');
    try {
      // Configuration modules are loaded synchronously via script tags before this runs.
      // Verify they are available.
      if (typeof SystemConfig !== 'undefined' || typeof CHAIN_REGISTRY !== 'undefined') {
        _endPhase('config', true);
        console.log('[AppBootstrap] config ✓ (' + _durations['config'].toFixed(1) + 'ms)');
      } else {
        _endPhase('config', false, 'No configuration globals found');
        console.warn('[AppBootstrap] config ✗ — no configuration globals found');
      }
    } catch (e) {
      _endPhase('config', false, e.message);
      console.warn('[AppBootstrap] config ✗:', e.message);
    }

    /* ── Phase 2: EventBus ──────────────────────────────────────── */
    _beginPhase('eventBus');
    try {
      if (typeof EventBus === 'undefined') {
        _endPhase('eventBus', false, 'EventBus not loaded');
        console.warn('[AppBootstrap] eventBus ✗ — module not loaded');
      } else {
        // Register initial system event
        var bootSub = EventBus.on('APP_BOOT_COMPLETE', function () {
          // Reserved for future consumers
        });
        _endPhase('eventBus', true);
        console.log('[AppBootstrap] eventBus ✓ (' + _durations['eventBus'].toFixed(1) + 'ms)');
      }
    } catch (e) {
      _endPhase('eventBus', false, e.message);
      console.warn('[AppBootstrap] eventBus ✗:', e.message);
    }

    /* ── Phase 3: Stores ───────────────────────────────────────── */
    _beginPhase('stores');
    try {
      var storeOk = true;
      if (typeof UIStore !== 'undefined') { /* initialized */ } else { storeOk = false; }
      if (typeof WalletStore !== 'undefined') { /* initialized */ } else { storeOk = false; }
      if (typeof SettingsStore !== 'undefined') { /* initialized */ } else { storeOk = false; }
      _endPhase('stores', storeOk);
      console.log('[AppBootstrap] stores ' + (storeOk ? '✓' : '✗') + ' (' + _durations['stores'].toFixed(1) + 'ms)');
    } catch (e) {
      _endPhase('stores', false, e.message);
      console.warn('[AppBootstrap] stores ✗:', e.message);
    }

    /* ── Phase 4: RPC Service ──────────────────────────────────── */
    _beginPhase('rpcService');
    try {
      if (typeof RPCService !== 'undefined') {
        // Pre-register known fallbacks from CHAIN_REGISTRY
        try {
          if (typeof CHAIN_REGISTRY !== 'undefined') {
            var chainKeys = Object.keys(CHAIN_REGISTRY);
            var fallbacks = [];
            for (var c = 0; c < chainKeys.length; c++) {
              var chain = CHAIN_REGISTRY[chainKeys[c]];
              if (chain && chain.rpc) {
                fallbacks.push({ uri: chain.rpc });
              }
            }
            if (fallbacks.length) RPCService.setFallbacks(fallbacks);
          }
        } catch (_e1) { /* non-critical */ }
        _endPhase('rpcService', true);
      } else {
        _endPhase('rpcService', false, 'RPCService not loaded');
      }
      console.log('[AppBootstrap] rpcService ' + (typeof RPCService !== 'undefined' ? '✓' : '✗') + ' (' + _durations['rpcService'].toFixed(1) + 'ms)');
    } catch (e) {
      _endPhase('rpcService', false, e.message);
      console.warn('[AppBootstrap] rpcService ✗:', e.message);
    }

    /* ── Phase 5: Wallet Service ───────────────────────────────── */
    _beginPhase('walletService');
    try {
      if (typeof WalletService !== 'undefined') {
        _endPhase('walletService', true);
      } else {
        _endPhase('walletService', false, 'WalletService not loaded');
      }
      console.log('[AppBootstrap] walletService ' + (typeof WalletService !== 'undefined' ? '✓' : '✗') + ' (' + _durations['walletService'].toFixed(1) + 'ms)');
    } catch (e) {
      _endPhase('walletService', false, e.message);
    }

    /* ── Phase 6: Component Managers ───────────────────────────── */
    _beginPhase('components');
    try {
      var compOk = true;
      if (typeof ModalManager === 'undefined') compOk = false;
      if (typeof ToastManager === 'undefined') compOk = false;
      if (typeof TabManager === 'undefined') compOk = false;
      _endPhase('components', compOk);
      console.log('[AppBootstrap] components ' + (compOk ? '✓' : '✗') + ' (' + _durations['components'].toFixed(1) + 'ms)');
    } catch (e) {
      _endPhase('components', false, e.message);
    }

    /* ── Phase 7: Notification Service ─────────────────────────── */
    _beginPhase('notificationService');
    try {
      if (typeof NotificationService !== 'undefined') {
        _endPhase('notificationService', true);
      } else {
        _endPhase('notificationService', false, 'NotificationService not loaded');
      }
      console.log('[AppBootstrap] notificationService ' + (typeof NotificationService !== 'undefined' ? '✓' : '✗') + ' (' + _durations['notificationService'].toFixed(1) + 'ms)');
    } catch (e) {
      _endPhase('notificationService', false, e.message);
    }

    /* ── Phase 8: Module Loader ────────────────────────────────── */
    _beginPhase('moduleLoader');
    try {
      if (typeof ModuleLoader !== 'undefined' && ModuleLoader.init) {
        ModuleLoader.init();
        _endPhase('moduleLoader', true);
      } else {
        _endPhase('moduleLoader', false, 'ModuleLoader not loaded');
      }
      console.log('[AppBootstrap] moduleLoader ' + (typeof ModuleLoader !== 'undefined' ? '✓' : '✗') + ' (' + _durations['moduleLoader'].toFixed(1) + 'ms)');
    } catch (e) {
      _endPhase('moduleLoader', false, e.message);
    }

    /* ── Phase 9: AI Wallet ────────────────────────────────────── */
    _beginPhase('aiWallet');
    try {
      if (typeof AIWallet !== 'undefined') {
        _endPhase('aiWallet', true);
      } else {
        _endPhase('aiWallet', false, 'AIWallet not loaded');
      }
      console.log('[AppBootstrap] aiWallet ' + (typeof AIWallet !== 'undefined' ? '✓' : '✗') + ' (' + _durations['aiWallet'].toFixed(1) + 'ms)');
    } catch (e) {
      _endPhase('aiWallet', false, e.message);
    }

    /* ── Phase 10: Autonoma ────────────────────────────────────── */
    _beginPhase('autonoma');
    try {
      var autonomaOk = true;
      if (typeof AutonomaCore === 'undefined') autonomaOk = false;
      if (typeof AutonomaNLU === 'undefined') autonomaOk = false;
      if (typeof AutonomaAgent === 'undefined') autonomaOk = false;
      _endPhase('autonoma', autonomaOk);
      console.log('[AppBootstrap] autonoma ' + (autonomaOk ? '✓' : '✗') + ' (' + _durations['autonoma'].toFixed(1) + 'ms)');
    } catch (e) {
      _endPhase('autonoma', false, e.message);
    }

    /* ── Phase 11: Contacts ────────────────────────────────────── */
    _beginPhase('contacts');
    try {
      var contactsOk = typeof contactsHubV2 !== 'undefined' || typeof renderContacts === 'function';
      _endPhase('contacts', contactsOk);
      console.log('[AppBootstrap] contacts ' + (contactsOk ? '✓' : '✗') + ' (' + _durations['contacts'].toFixed(1) + 'ms)');
    } catch (e) {
      _endPhase('contacts', false, e.message);
    }

    /* ── Phase 12: Scheduler ───────────────────────────────────── */
    _beginPhase('scheduler');
    try {
      var schedOk = typeof ScheduleEngine !== 'undefined';
      _endPhase('scheduler', schedOk);
      console.log('[AppBootstrap] scheduler ' + (schedOk ? '✓' : '✗') + ' (' + _durations['scheduler'].toFixed(1) + 'ms)');
    } catch (e) {
      _endPhase('scheduler', false, e.message);
    }

    /* ── Phase 13: Treasury ────────────────────────────────────── */
    _beginPhase('treasury');
    try {
      var treasOk = typeof TreasurySync !== 'undefined' || typeof vaultRefreshUI === 'function';
      _endPhase('treasury', treasOk);
      console.log('[AppBootstrap] treasury ' + (treasOk ? '✓' : '✗') + ' (' + _durations['treasury'].toFixed(1) + 'ms)');
    } catch (e) {
      _endPhase('treasury', false, e.message);
    }

    /* ── Phase 14: UI ──────────────────────────────────────────── */
    _beginPhase('ui');
    try {
      // Register core tabs with TabManager for future extension
      if (typeof TabManager !== 'undefined' && TabManager.register) {
        var coreTabs = [
          'send', 'xchain', 'batch', 'queue', 'links', 'invoices', 'unified-balance',
          'schedule', 'swap', 'bridge', 'pool', 'autonoma', 'aiwallet',
          'treasury', 'xcdashboard', 'recipients', 'templates', 'reports', 'settings'
        ];
        for (var t = 0; t < coreTabs.length; t++) {
          TabManager.register(coreTabs[t], {});
        }
      }
      _endPhase('ui', true);
      console.log('[AppBootstrap] ui ✓ (' + _durations['ui'].toFixed(1) + 'ms)');
    } catch (e) {
      _endPhase('ui', false, e.message);
    }

    /* ── Phase 15: Ready ───────────────────────────────────────── */
    _beginPhase('ready');
    _endPhase('ready', true);

    var totalTime = performance.now() - t0;
    _durations['total'] = totalTime;

    console.log('[AppBootstrap] ✓ Application ready in ' + totalTime.toFixed(1) + 'ms');
    console.log('[AppBootstrap] Phase durations:', JSON.stringify(_durations));

    // Emit app ready event
    try {
      if (typeof EventBus !== 'undefined' && EventBus.emit) {
        EventBus.emit('APP_BOOT_COMPLETE', {
          totalTime: totalTime,
          phases: _durations,
          success: getFailedPhases().length === 0
        });
      }
    } catch (_e) {}

    // Notify document for any listeners outside EventBus
    try {
      if (typeof document !== 'undefined') {
        document.dispatchEvent(new CustomEvent('APP_BOOT_COMPLETE', { detail: { totalTime: totalTime } }));
      }
    } catch (_e2) {}

    _initialized = true;

    // Callback
    if (typeof onReady === 'function') {
      try { onReady(getReport()); } catch (_e3) {}
    }
  }

  /* ════════════════════════════════════════════
     DIAGNOSTICS
  ════════════════════════════════════════════ */

  /**
   * Get list of failed phases.
   * @returns {{ phase: string, error: string }[]}
   */
  function getFailedPhases() {
    return _phases
      .filter(function (p) { return p.success === false; })
      .map(function (p) { return { phase: p.phase, error: p.error || 'unknown' }; });
  }

  /**
   * Get full startup report.
   * @returns {{ version: string, started: boolean, initialized: boolean, totalTime: number, phases: Record<string,number>, failed: { phase: string, error: string }[] }}
   */
  function getReport() {
    return {
      version: VERSION,
      started: _started,
      initialized: _initialized,
      totalTime: _durations['total'] || 0,
      phases: _durations,
      failed: getFailedPhases()
    };
  }

  /**
   * Check if bootstrap has completed.
   * @returns {boolean}
   */
  function isReady() { return _initialized; }

  /**
   * Check if start has been called.
   * @returns {boolean}
   */
  function isStarted() { return _started; }

  /**
   * Wait until the bootstrap is complete. Resolves immediately if already done.
   * @param {number} [timeout=30000] - Max wait time in ms
   * @returns {Promise<Object>}
   */
  function waitForReady(timeout) {
    return new Promise(function (resolve, reject) {
      if (_initialized) { resolve(getReport()); return; }
      var maxWait = timeout || 30000;
      var start = Date.now();
      var interval = setInterval(function () {
        if (_initialized) {
          clearInterval(interval);
          resolve(getReport());
        } else if (Date.now() - start > maxWait) {
          clearInterval(interval);
          reject(new Error('Bootstrap timeout after ' + maxWait + 'ms'));
        }
      }, 100);
    });
  }

  /** @public */
  window.AppBootstrap = {
    VERSION: VERSION,
    start: start,
    getReport: getReport,
    getFailedPhases: getFailedPhases,
    isReady: isReady,
    isStarted: isStarted,
    waitForReady: waitForReady
  };
})();
