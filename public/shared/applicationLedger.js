/**
 * Elligentt Application Ledger & Metrics — Phase 1 (Core Infrastructure)
 * ══════════════════════════════════════════════════════════════════════
 * ACCOUNTING-ONLY data layer for the shared Liquidity Core. It attributes each
 * intent/operation to an Application + Client and computes the per-application
 * metrics that the dashboard "view by application" and the enriched history use.
 *
 * It NEVER moves funds, touches Smart Contracts, the Vault, Treasury, CCTP,
 * Settlement or Reimbursement. It reads the existing intent objects (the single
 * source of truth) and derives segregated accounting on top — no duplication of
 * liquidity or Treasury logic.
 *
 * Usage (browser):
 *   <script src="shared/applicationLedger.js"></script>
 *   const breakdown = ApplicationLedger.getApplicationBreakdown(intents);
 *   const m = ApplicationLedger.computeMetrics(intents, 'ELLIGENT');
 */
const ApplicationLedger = (() => {
  'use strict';

  const STORE_KEY = 'elligente_application_ledger';
  const MAX_ENTRIES = 5000;

  const DEFAULT_APP = 'ELLIGENT';
  const DEFAULT_CLIENT = 'default';

  const STAGES = Object.freeze({
    INTENT: 'INTENT',
    VAULT_DEBIT: 'VAULT_DEBIT',
    TREASURY_PAYMENT: 'TREASURY_PAYMENT',
    BRIDGE: 'BRIDGE',
    SETTLEMENT: 'SETTLEMENT',
    VAULT_CREDIT: 'VAULT_CREDIT',
  });

  function _defaults() {
    if (typeof ApplicationContext !== 'undefined' && ApplicationContext.defaults) {
      const d = ApplicationContext.defaults();
      return { application: d.application, client: d.client };
    }
    return { application: DEFAULT_APP, client: DEFAULT_CLIENT };
  }

  // Extract the { application, client } attribution from an intent (or any object)
  // with defaults applied. Fully backward compatible with legacy untagged intents.
  function contextOf(obj) {
    const d = _defaults();
    if (!obj || typeof obj !== 'object') return { application: d.application, client: d.client };
    const application = String(obj.application || obj.applicationId || d.application).toUpperCase();
    const client = String(obj.client || obj.clientId || d.client);
    return { application, client };
  }

  function _num(v) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : 0;
  }

  function _amountOf(i) {
    return _num(i.grossAmount != null ? i.grossAmount : i.amount);
  }

  function _isSettled(i) {
    return i.status === 'Settled' || !!i._treasuryReimbursed || (i.memoOnChain && i._treasuryReimbursed);
  }

  function _isFulfilled(i) {
    return ['Fulfilled', 'Settling', 'Settled'].includes(i.status) || !!i.arcTxHash || !!i.arcFulfillmentTimestamp;
  }

  function _isFailed(i) {
    return i.status === 'Failed' || !!i._verificationFailed;
  }

  // ── localStorage side-channel (optional, best-effort) ──────────────────────
  function _load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : { entries: [] };
    } catch (_) { return { entries: [] }; }
  }

  function _save(state) {
    try {
      if (state.entries.length > MAX_ENTRIES) {
        state.entries = state.entries.slice(-MAX_ENTRIES);
      }
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (_) {}
  }

  function record(entry) {
    const e = entry || {};
    const ctx = contextOf(e);
    const normalized = {
      application: ctx.application,
      client: ctx.client,
      version: String(e.version || '1'),
      intentId: e.intentId || null,
      stage: e.stage || STAGES.INTENT,
      amount: e.amount != null ? _num(e.amount) : null,
      asset: e.asset ? String(e.asset).toLowerCase() : null,
      status: e.status || 'Pending',
      txHash: e.txHash || null,
      bridge: e.bridge || null,
      timestamp: e.timestamp || Date.now(),
    };
    const state = _load();
    state.entries.push(normalized);
    _save(state);
    return normalized;
  }

  function getAll() { return _load().entries; }

  function getByApplication(application) {
    const app = String(application || DEFAULT_APP).toUpperCase();
    return _load().entries.filter(e => e.application === app);
  }

  function clear() { _save({ entries: [] }); }

  // ── Metrics ────────────────────────────────────────────────────────────────
  function _avg(list) {
    if (!list.length) return 0;
    return list.reduce((a, b) => a + b, 0) / list.length;
  }

  /**
   * Compute the full dashboard metric set for one application (or, when no
   * application is given, for ALL intents combined).
   */
  function computeMetrics(intents, application) {
    const list = Array.isArray(intents) ? intents : [];
    const app = application ? String(application).toUpperCase() : null;
    const scoped = app ? list.filter(i => contextOf(i).application === app) : list;

    let totalVolume = 0;
    let pendingSettlementAmount = 0;
    let pendingSettlementCount = 0;
    let treasuryOutstanding = 0;
    let vaultUsage = 0;
    let settledCount = 0;
    let failedCount = 0;
    const clients = new Set();
    const settlementDurations = [];
    const bridgeDurations = [];
    const reimbursementDurations = [];

    for (const i of scoped) {
      const amt = _amountOf(i);
      totalVolume += amt;
      clients.add(contextOf(i).client);

      const settled = _isSettled(i);
      const fulfilled = _isFulfilled(i);

      if (settled) settledCount++;
      if (_isFailed(i)) failedCount++;

      if (!settled && !_isFailed(i)) {
        pendingSettlementAmount += amt;
        pendingSettlementCount++;
      }

      // Vault debited (paid out) but not yet reimbursed → outstanding / in-use.
      if (fulfilled && !settled) {
        treasuryOutstanding += amt;
        vaultUsage += amt;
      }

      const created = _num(i.createdAt);
      const fulfilledAt = _num(i.arcFulfillmentTimestamp);
      const settledAt = _num(i.settledAt || i.updatedAt);

      if (settled && created && settledAt && settledAt >= created) {
        settlementDurations.push(settledAt - created);
      }
      if (fulfilledAt && created && fulfilledAt >= created) {
        bridgeDurations.push(fulfilledAt - created);
      }
      if (settled && fulfilledAt && settledAt && settledAt >= fulfilledAt) {
        reimbursementDurations.push(settledAt - fulfilledAt);
      }
    }

    const intentCount = scoped.length;
    const successRate = intentCount > 0 ? (settledCount / intentCount) * 100 : 0;

    return {
      application: app || 'ALL',
      intentCount,
      clientCount: clients.size,
      totalVolume,
      pendingSettlement: pendingSettlementAmount,
      pendingSettlementCount,
      treasuryOutstanding,
      vaultUsage,
      averageSettlement: _avg(settlementDurations),   // ms
      averageBridgeTime: _avg(bridgeDurations),        // ms
      reimbursementTime: _avg(reimbursementDurations), // ms
      successRate,                                      // %
      settledCount,
      failedCount,
    };
  }

  // List of applications present in the intent set (always includes ELLIGENT).
  function listApplications(intents) {
    const set = new Set([DEFAULT_APP]);
    for (const i of (Array.isArray(intents) ? intents : [])) {
      set.add(contextOf(i).application);
    }
    return Array.from(set);
  }

  // Per-application metric map for the dashboard "Applications" view.
  function getApplicationBreakdown(intents) {
    const apps = listApplications(intents);
    const out = {};
    for (const app of apps) {
      out[app] = computeMetrics(intents, app);
    }
    return out;
  }

  return {
    STAGES,
    contextOf,
    record,
    getAll,
    getByApplication,
    clear,
    computeMetrics,
    listApplications,
    getApplicationBreakdown,
  };
})();

if (typeof window !== 'undefined') {
  window.ApplicationLedger = ApplicationLedger;
}
