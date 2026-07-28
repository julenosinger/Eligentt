/**
 * Autonoma Treasury Manager V2 — Phase 2
 * ───────────────────────────────────────
 * ADDITIVE module. Intelligence layer for Treasury operations.
 * Detects idle funds, insufficient balances, upcoming requirements,
 * vault issues, gas reserve problems, and expired permissions.
 * Read-only analysis + suggestions. NEVER executes automatically.
 *
 * Reuses: TreasuryVault, VaultAccounting, UnifiedBalance, ScheduleEngine,
 *         FinancialContext, AgentAuthorization
 *
 * Attached to window.AutonomaTreasuryManager
 */
(function () {
  'use strict';

  var lastScan = 0;
  var findings = [];
  var config = {
    minGasReserve: 0.01,     // minimum native gas (ETH)
    idleThreshold: 100,       // USDC idle > 100 = flag
    lowBalanceThreshold: 500, // USDC below this = warning
    scanIntervalMs: 60000,    // 1 minute
    enabled: true
  };

  /* ── Scanner ───────────────────────────────────────────────────────── */
  function scan() {
    if (!config.enabled) return [];
    var now = Date.now();
    if (now - lastScan < 5000) return findings; // debounce 5s
    lastScan = now;
    findings = [];

    checkIdleFunds();
    checkInsufficientBalance();
    checkUpcomingPayrolls();
    checkVaultHealth();
    checkGasReserves();
    checkTreasuryAllocation();
    checkExpiredPermissions();
    checkUpcomingSchedules();

    return findings;
  }

  /* ── Detection Functions ───────────────────────────────────────────── */
  function checkIdleFunds() {
    try {
      var assets = [];
      if (typeof UB !== 'undefined' && UB.state && UB.state.assets) assets = UB.state.assets;
      assets.forEach(function (a) {
        if (a.token === 'USDC' && a.usd > config.idleThreshold && a.chainId !== 'Arc_Testnet') {
          findings.push({
            type: 'idle_funds', severity: 'info',
            title: 'Idle funds detected',
            detail: a.usd.toFixed(2) + ' USDC on ' + (a.chainName || a.chainId),
            suggestion: 'Consider bridging to Arc for Treasury utilization',
            action: 'bridge_idle',
            params: { chain: a.chainId, amount: a.balance, token: a.token }
          });
        }
      });
    } catch (_) {}
  }

  function checkInsufficientBalance() {
    try {
      if (typeof UB === 'undefined' || !UB.state) return;
      var total = UB.state.totalUSD || 0;
      var active = window.AutonomaFinancialPlanner
        ? window.AutonomaFinancialPlanner.getActive()
        : [];
      active.forEach(function (p) {
        if (p.params && p.params.amount && total < p.params.amount) {
          findings.push({
            type: 'insufficient_balance', severity: 'warning',
            title: 'Insufficient balance for: ' + p.explanation,
            detail: 'Required: ' + p.params.amount + ' ' + (p.params.token || 'USDC') + ' | Available: ' + total.toFixed(2) + ' USD',
            suggestion: 'Top up balance or adjust plan amount',
            action: 'top_up',
            params: { needed: p.params.amount - total, plan: p.id }
          });
        }
      });
    } catch (_) {}
  }

  function checkUpcomingPayrolls() {
    try {
      if (typeof ScheduleEngine === 'undefined') return;
      var all = ScheduleEngine.getAll ? ScheduleEngine.getAll() : [];
      var now = Date.now();
      all.forEach(function (s) {
        if (!s.nextExecution) return;
        var ms = new Date(s.nextExecution).getTime();
        var hours = (ms - now) / 3600000;
        if (hours > 0 && hours < 48) {
          var estimated = estimatePayrollAmount(s);
          var available = (typeof UB !== 'undefined' && UB.state) ? UB.state.totalUSD : 0;
          findings.push({
            type: 'upcoming_payroll', severity: 'warning',
            title: 'Payroll scheduled in ' + Math.round(hours) + ' hours',
            detail: (s.name || 'Unnamed') + ' | Required: ~' + estimated.toFixed(2) + ' USDC | Available: ' + available.toFixed(2) + ' USDC',
            suggestion: estimated > available ? 'Bridge funds from other chains' : 'Ensure balance stays above ' + estimated.toFixed(2) + ' USDC',
            action: estimated > available ? 'bridge_for_payroll' : 'monitor',
            params: { schedule: s.id, needed: estimated, available: available }
          });
        }
      });
    } catch (_) {}
  }

  function estimatePayrollAmount(schedule) {
    try {
      if (schedule.amount) return parseFloat(schedule.amount);
      if (schedule.totalAmount) return parseFloat(schedule.totalAmount);
      return 0;
    } catch (_) { return 0; }
  }

  function checkVaultHealth() {
    try {
      if (typeof VaultAccounting === 'undefined') return;
      var available = VaultAccounting.getTotalAvailable ? VaultAccounting.getTotalAvailable('usdc') : 0;
      if (available < config.lowBalanceThreshold) {
        findings.push({
          type: 'vault_low', severity: 'warning',
          title: 'Treasury Vault balance low',
          detail: available.toFixed(2) + ' USDC available',
          suggestion: 'Deposit funds to maintain liquidity',
          action: 'deposit_vault',
          params: { current: available, min: config.lowBalanceThreshold }
        });
      }
    } catch (_) {}
  }

  function checkGasReserves() {
    try {
      if (typeof UB === 'undefined' || !UB.state || !UB.state.assets) return;
      var arcAsset = null;
      UB.state.assets.forEach(function (a) {
        if (a.token === 'ETH' && (a.chainId === 'Arc_Testnet' || a.chainId === 5042002)) arcAsset = a;
      });
      if (arcAsset && arcAsset.balance < config.minGasReserve) {
        findings.push({
          type: 'gas_low', severity: 'warning',
          title: 'Gas reserve low on Arc',
          detail: arcAsset.balance.toFixed(4) + ' ETH (min: ' + config.minGasReserve + ')',
          suggestion: 'Bridge ETH or use faucet',
          action: 'top_up_gas',
          params: { current: arcAsset.balance, min: config.minGasReserve }
        });
      }
    } catch (_) {}
  }

  function checkTreasuryAllocation() {
    try {
      if (typeof FinancialContext === 'undefined') return;
      var snapshot = FinancialContext.getSnapshot ? FinancialContext.getSnapshot() : {};
      if (snapshot && snapshot.allocations && !snapshot.allocations.length) {
        findings.push({
          type: 'no_allocation', severity: 'info',
          title: 'No Treasury allocation configured',
          detail: 'Allocate a percentage of income to Treasury for automated savings',
          suggestion: 'Use Financial Planner to set up an allocation',
          action: 'setup_allocation',
          params: {}
        });
      }
    } catch (_) {}
  }

  function checkExpiredPermissions() {
    try {
      if (typeof AgentAuthorization === 'undefined') return;
      var auths = AgentAuthorization.getAll ? AgentAuthorization.getAll() : [];
      var now = Date.now();
      auths.forEach(function (a) {
        if (a.expiresAt && a.expiresAt < now + 86400000) {
          var hours = Math.round((a.expiresAt - now) / 3600000);
          findings.push({
            type: 'permission_expiring', severity: 'warning',
            title: 'Permission expires in ' + hours + ' hours',
            detail: (a.purpose || 'Authorization') + ' (' + (a.id || '').slice(0, 8) + ')',
            suggestion: 'Renew or extend the authorization',
            action: 'extend_permission',
            params: { authId: a.id, expiresAt: a.expiresAt }
          });
        }
      });
    } catch (_) {}
  }

  function checkUpcomingSchedules() {
    try {
      if (typeof ScheduleEngine === 'undefined') return;
      var all = ScheduleEngine.getAll ? ScheduleEngine.getAll() : [];
      var now = Date.now();
      var count = 0;
      all.forEach(function (s) {
        if (s.nextExecution) {
          var ms = new Date(s.nextExecution).getTime();
          if (ms > now && ms < now + 86400000) count++;
        }
      });
      if (count > 0) {
        findings.push({
          type: 'upcoming_schedules', severity: 'info',
          title: count + ' schedule(s) due in the next 24h',
          detail: 'Total upcoming: ' + count,
          suggestion: 'Ensure sufficient balance for all scheduled payments',
          action: 'review_schedules',
          params: { count: count }
        });
      }
    } catch (_) {}
  }

  /* ── Action Card Generator ─────────────────────────────────────────── */
  function getTreasuryAlertCard(R) {
    scan();
    if (!findings.length) return '';
    if (!R || typeof R.card !== 'function') return '';

    var warnings = findings.filter(function (f) { return f.severity === 'warning'; });
    var infos = findings.filter(function (f) { return f.severity === 'info'; });

    var o = '';
    o += R.section('Treasury Intelligence', 'ti ti-building-bank');

    if (warnings.length) {
      o += R.section(warnings.length + ' Alert' + (warnings.length > 1 ? 's' : ''), '', 'red');
      warnings.forEach(function (f) {
        o += R.row(f.title, f.detail);
        o += '<div style="font-size:8px;color:var(--teal);padding:2px 0 8px 0">→ ' + f.suggestion + '</div>';
      });
    }

    if (infos.length) {
      o += R.section(infos.length + ' Insight' + (infos.length > 1 ? 's' : ''), '', 'teal');
      infos.forEach(function (f) {
        o += R.row(f.title, f.detail);
        o += '<div style="font-size:8px;color:var(--muted2);padding:2px 0 8px 0">→ ' + f.suggestion + '</div>';
      });
    }

    if (!warnings.length && !infos.length) {
      o += R.row('All Clear', 'No treasury issues detected');
    }

    o += R.actions([
      { label: 'View Details', cls: 'teal', onclick: 'AutonomaTreasuryManager.showDetails()' },
      { label: 'Dismiss', cls: '', onclick: 'AutonomaTreasuryManager.dismiss()' }
    ]);
    return R.card(o, 'Treasury Manager', findings.length ? 'yellow' : 'green');
  }

  function showDetails() {
    scan();
    try {
      if (typeof showToast === 'function') {
        findings.forEach(function (f) {
          showToast((f.severity === 'warning' ? '⚠ ' : 'ℹ ') + f.title + ': ' + f.suggestion, f.severity === 'warning' ? 'warning' : 'info');
        });
      }
    } catch (_) {}
  }

  function dismiss() {
    findings = [];
    lastScan = 0;
  }

  function getSummary() {
    scan();
    return {
      alerts: findings.filter(function (f) { return f.severity === 'warning'; }).length,
      insights: findings.filter(function (f) { return f.severity === 'info'; }).length,
      total: findings.length,
      findings: findings.slice()
    };
  }

  window.AutonomaTreasuryManager = {
    scan: scan,
    getFindings: function () { return findings.slice(); },
    getTreasuryAlertCard: getTreasuryAlertCard,
    showDetails: showDetails,
    dismiss: dismiss,
    getSummary: getSummary,
    config: config
  };

  console.log('[AutonomaTreasuryManager] Initialized — Treasury Intelligence Layer active.');
})();
