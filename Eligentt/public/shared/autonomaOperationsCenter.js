/**
 * Autonoma Operations Center V2 — Phase 10
 * ───────────────────────────────────────
 * ADDITIVE module. Read-only aggregation dashboard.
 * Aggregates data from: AI Smart Wallet, Unified Balance,
 * Schedule Engine, Treasury, Vault, Reports, History,
 * Approval Center, Workflows — WITHOUT modifying any of them.
 *
 * Attached to window.AutonomaOperationsCenter
 */
(function () {
  'use strict';

  /* ── Aggregation ───────────────────────────────────────────────────── */
  function getSnapshot() {
    var snap = {
      timestamp: Date.now(),
      portfolio: { totalUSD: 0, assets: 0, chains: 0 },
      operations: { payments: 0, bridges: 0, swaps: 0, schedules: 0, payrolls: 0 },
      treasury: { status: 'Healthy', vaultUSD: 0, vaultAvailable: 0 },
      gas: { status: 'Healthy', arcEth: 0 },
      approvals: { active: 0, expiring: 0 },
      revenue: 0,
      expenses: 0,
      automationScore: 0
    };

    // Unified Balance
    try {
      if (typeof UB !== 'undefined' && UB.state) {
        snap.portfolio.totalUSD = UB.state.totalUSD || 0;
        snap.portfolio.assets = (UB.state.assets || []).length;
        var chains = {};
        (UB.state.assets || []).forEach(function (a) { chains[a.chainId || a.chainName] = true; });
        snap.portfolio.chains = Object.keys(chains).length;
      }
    } catch (_) {}

    // Schedule Engine
    try {
      if (typeof ScheduleEngine !== 'undefined') {
        var all = ScheduleEngine.getAll ? ScheduleEngine.getAll() : [];
        snap.operations.schedules = all.length;
        all.forEach(function (s) {
          var type = (s.type || '').toLowerCase();
          if (type.indexOf('payment') !== -1) snap.operations.payments++;
          if (type.indexOf('payroll') !== -1) snap.operations.payrolls++;
        });
      }
    } catch (_) {}

    // Tx History (bridges & swaps)
    try {
      if (typeof txHistory !== 'undefined' && Array.isArray(txHistory)) {
        txHistory.forEach(function (tx) {
          if ((tx.label || '').toLowerCase().indexOf('bridge') !== -1) snap.operations.bridges++;
          if ((tx.label || '').toLowerCase().indexOf('swap') !== -1) snap.operations.swaps++;
        });
      }
    } catch (_) {}

    // Treasury Vault
    try {
      if (typeof VaultAccounting !== 'undefined') {
        snap.treasury.vaultAvailable = VaultAccounting.getTotalAvailable ? VaultAccounting.getTotalAvailable('usdc') : 0;
        snap.treasury.vaultUSD = snap.treasury.vaultAvailable;
        if (snap.treasury.vaultAvailable < 1) snap.treasury.status = 'Low';
      }
    } catch (_) {}

    // Gas
    try {
      if (typeof UB !== 'undefined' && UB.state && UB.state.assets) {
        var arcEth = UB.state.assets.find(function (a) { return a.token === 'ETH' && (a.chainId === 'Arc_Testnet' || a.chainId === 5042002); });
        snap.gas.arcEth = arcEth ? arcEth.balance : 0;
        if (snap.gas.arcEth < 0.01) snap.gas.status = 'Low';
      }
    } catch (_) {}

    // Approval Center
    try {
      if (typeof AgentAuthorization !== 'undefined') {
        var auths = AgentAuthorization.getAll ? AgentAuthorization.getAll() : [];
        snap.approvals.active = auths.filter(function (a) { return a.status === 'active'; }).length;
        var now = Date.now();
        snap.approvals.expiring = auths.filter(function (a) { return a.expiresAt && a.expiresAt < now + 86400000; }).length;
      }
    } catch (_) {}

    // Revenue / Expenses from Reports
    try {
      if (typeof xcStats !== 'undefined') snap.revenue = (xcStats.volume || 0);
      if (typeof FinancialMemory !== 'undefined' && FinancialMemory.getSnapshot) {
        var snap2 = FinancialMemory.getSnapshot();
        if (snap2 && snap2.revenue) snap.revenue = Math.max(snap.revenue, snap2.revenue || 0);
      }
    } catch (_) {}

    // Automation score
    var totalOps = snap.operations.payments + snap.operations.swaps + snap.operations.bridges;
    var scheduledOps = snap.operations.schedules;
    snap.automationScore = totalOps > 0 ? Math.round((scheduledOps / (totalOps + scheduledOps)) * 100) : 0;

    return snap;
  }

  /* ── Status Color ──────────────────────────────────────────────────── */
  function statusColor(status) {
    if (status === 'Healthy' || status === 'OK') return 'var(--green)';
    if (status === 'Low') return 'var(--yellow)';
    return 'var(--red)';
  }

  /* ── Dashboard Card Generator ───────────────────────────────────────── */
  function getDashboardCard(R) {
    if (!R || typeof R.card !== 'function') return '';
    var snap = getSnapshot();

    var o = '';
    o += R.section("Today's Operations", 'ti ti-dashboard');

    o += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">';
    o += metricBox('Payments', snap.operations.payments, 'var(--teal)');
    o += metricBox('Bridges', snap.operations.bridges, 'var(--blue)');
    o += metricBox('Swaps', snap.operations.swaps, 'var(--purple)');
    o += metricBox('Schedules', snap.operations.schedules, 'var(--yellow)');
    o += metricBox('Payrolls', snap.operations.payrolls, '#f59e0b');
    o += metricBox('Approvals', snap.approvals.active, 'var(--teal)');
    o += '</div>';

    o += R.section('Health');
    o += statusRow('Vault', snap.treasury.status, snap.treasury.vaultAvailable.toFixed(2) + ' USDC');
    o += statusRow('Gas', snap.gas.status, snap.gas.arcEth.toFixed(4) + ' ETH');
    o += statusRow('Portfolio', snap.portfolio.totalUSD > 0 ? 'Active' : 'Empty', '$' + snap.portfolio.totalUSD.toFixed(2));

    o += R.section('Financials');
    o += R.row('Revenue', '$' + snap.revenue.toFixed(2));
    o += R.row('Expenses', '$' + snap.expenses.toFixed(2));
    o += R.row('Automation Score', snap.automationScore + '%');

    if (snap.approvals.expiring > 0) {
      o += R.section('Alerts', '', 'yellow');
      o += R.row('Expiring', snap.approvals.expiring + ' permission(s) expire within 24h');
    }

    o += R.actions([
      { label: 'Refresh', cls: 'teal', onclick: 'AutonomaOperationsCenter.refresh()' },
      { label: 'View Reports', cls: '', onclick: "showPage('reports')" }
    ]);

    return R.card(o, 'Operations Center', 'teal');
  }

  function metricBox(label, value, color) {
    return '<div style="background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:6px;padding:6px 8px;text-align:center">' +
      '<div style="font-size:14px;font-weight:700;color:' + color + '">' + (value || 0) + '</div>' +
      '<div style="font-size:7px;color:var(--muted2);margin-top:2px">' + label + '</div></div>';
  }

  function statusRow(label, status, detail) {
    var color = statusColor(status);
    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;font-size:9px">' +
      '<span style="color:var(--muted2)">' + label + '</span>' +
      '<span style="color:' + color + ';font-weight:600">' + status + '</span>' +
      '<span style="color:var(--muted2);font-size:8px">' + detail + '</span></div>';
  }

  function refresh() {
    try {
      if (typeof AutonomaTreasuryManager !== 'undefined') AutonomaTreasuryManager.scan();
      if (typeof toast === 'function') toast('Operations Center refreshed', 'info');
    } catch (_) {}
  }

  window.AutonomaOperationsCenter = {
    getSnapshot: getSnapshot,
    getDashboardCard: getDashboardCard,
    refresh: refresh
  };

  console.log('[AutonomaOperationsCenter] Initialized — Read-only aggregation active.');
})();
