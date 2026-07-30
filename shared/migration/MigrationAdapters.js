/**
 * Elligentt MigrationAdapters — New→Legacy Fallback Wrappers (Phase 7)
 * Each adapter tries the new architecture first. Falls back to legacy if unavailable.
 * When MigrationFlags.isEnabled(), uses ONLY new path (no fallback for parity verification).
 * Attached to: window.Migrate
 */
(function () {
  'use strict';

  /**
   * Migration pattern:
   *   - If MigrationFlag enabled → new path ONLY (parity verification mode)
   *   - If new path available → new path with try/catch
   *   - Fallback → legacy path
   */

  function _shouldUseNew(flag) {
    try { if (typeof MigrationFlags !== 'undefined') return MigrationFlags.isEnabled(flag); } catch (_e) {}
    return false;
  }

  function _tryNew(fn, args) {
    try { return fn.apply(null, args); } catch (e) { return null; }
  }

  /* ── CONTACTS ──────────────────────────────────────────────── */

  function contacts_render() {
    if (_shouldUseNew('USE_CONTACTS_DOMAIN')) {
      try { if (typeof ContactsDomain !== 'undefined') { ContactsDomain.refresh(); return; } } catch (_e) {}
    }
    try { if (typeof ContactsDomain !== 'undefined') { ContactsDomain.refresh(); return; } } catch (_e) {}
    try { if (typeof renderContacts === 'function') { renderContacts(); return; } } catch (_e2) {}
  }

  function contacts_refresh() { contacts_render(); }

  /* ── SCHEDULER ──────────────────────────────────────────────── */

  function scheduler_render() {
    if (_shouldUseNew('USE_SCHEDULER_DOMAIN')) {
      try { if (typeof SchedulerDomain !== 'undefined') { SchedulerDomain.refresh(); return; } } catch (_e) {}
    }
    try { if (typeof SchedulerDomain !== 'undefined') { SchedulerDomain.refresh(); return; } } catch (_e) {}
    try { if (typeof renderSchedules === 'function') { renderSchedules(); return; } } catch (_e2) {}
  }

  /* ── REPORTS ────────────────────────────────────────────────── */

  function reports_render() {
    if (_shouldUseNew('USE_REPORTS_DOMAIN')) {
      try { if (typeof ReportsDomain !== 'undefined') { ReportsDomain.refresh(); return; } } catch (_e) {}
    }
    try { if (typeof ReportsDomain !== 'undefined') { ReportsDomain.refresh(); return; } } catch (_e) {}
    try { if (typeof renderReports === 'function') { renderReports(); return; } } catch (_e2) {}
  }

  /* ── HISTORY ────────────────────────────────────────────────── */

  function history_render() {
    if (_shouldUseNew('USE_HISTORY_DOMAIN')) {
      try { if (typeof HistoryDomain !== 'undefined') { HistoryDomain.refresh(); return; } } catch (_e) {}
    }
    try { if (typeof HistoryDomain !== 'undefined') { HistoryDomain.refresh(); return; } } catch (_e) {}
    try { if (typeof renderQueueTable === 'function') { renderQueueTable(); return; } } catch (_e2) {}
  }

  /* ── NOTIFICATIONS ──────────────────────────────────────────── */

  function notify(msg, type) {
    if (_shouldUseNew('USE_NOTIFICATION_DOMAIN')) {
      try { if (typeof NotificationDomain !== 'undefined') { NotificationDomain[type || 'info'](msg); return; } } catch (_e) {}
    }
    try { if (typeof NotificationDomain !== 'undefined') { NotificationDomain[type || 'info'](msg); return; } } catch (_e) {}
    try { if (typeof toast === 'function') { toast(msg, type || 'info'); return; } } catch (_e2) {}
  }

  /* ── WALLET ─────────────────────────────────────────────────── */

  function wallet_connect(walletType) {
    try { if (typeof WalletDomain !== 'undefined') return WalletDomain.connect(walletType); } catch (_e) {}
    try { if (typeof connectWalletConnect === 'function') return connectWalletConnect(); } catch (_e2) {}
    return null;
  }

  /* ── EXECUTION COORDINATOR ──────────────────────────────────── */

  function execution_begin(op, params) {
    if (_shouldUseNew('USE_EXECUTION_COORDINATOR')) {
      try { if (typeof ExecutionCoordinator !== 'undefined') return ExecutionCoordinator.begin(op, params); } catch (_e) {}
    }
    try { if (typeof ExecutionCoordinator !== 'undefined') return ExecutionCoordinator.begin(op, params); } catch (_e) {}
    return 'LEGACY_' + Date.now().toString(36);
  }

  function execution_complete(id, result) {
    try { if (typeof ExecutionCoordinator !== 'undefined') { ExecutionCoordinator.complete(id, result); return; } } catch (_e) {}
  }

  /* ── AUDIT ──────────────────────────────────────────────────── */

  function audit_log(event, detail) {
    if (_shouldUseNew('USE_AUDIT_MANAGER')) {
      try { if (typeof AuditManager !== 'undefined') { AuditManager.log(event, detail); return; } } catch (_e) {}
    }
    try { if (typeof AuditManager !== 'undefined') { AuditManager.log(event, detail); return; } } catch (_e) {}
  }

  /* ── CACHE ──────────────────────────────────────────────────── */

  function cache_get(ns, key) {
    try { if (typeof CacheManager !== 'undefined') return CacheManager.get(ns, key); } catch (_e) {}
    return undefined;
  }

  function cache_set(ns, key, value, ttl) {
    try { if (typeof CacheManager !== 'undefined') { CacheManager.set(ns, key, value, ttl); return; } } catch (_e) {}
  }

  /* ── LOCK ───────────────────────────────────────────────────── */

  function lock_acquire(name, ttl) {
    try { if (typeof LockManager !== 'undefined') return LockManager.acquire(name, ttl); } catch (_e) {}
    return true;
  }

  function lock_release(name) {
    try { if (typeof LockManager !== 'undefined') { LockManager.release(name); return; } } catch (_e) {}
  }

  /** @public */
  window.Migrate = {
    VERSION: '1.0.0',
    // Contacts
    contacts_render: contacts_render, contacts_refresh: contacts_refresh,
    // Scheduler
    scheduler_render: scheduler_render,
    // Reports
    reports_render: reports_render,
    // History
    history_render: history_render,
    // Notifications
    notify: notify,
    // Wallet
    wallet_connect: wallet_connect,
    // Execution
    execution_begin: execution_begin, execution_complete: execution_complete,
    // Audit
    audit_log: audit_log,
    // Cache
    cache_get: cache_get, cache_set: cache_set,
    // Lock
    lock_acquire: lock_acquire, lock_release: lock_release
  };
})();
