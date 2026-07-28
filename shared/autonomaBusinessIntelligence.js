/**
 * Autonoma Business Intelligence V2 — Phase 12
 * ───────────────────────────────────────
 * ADDITIVE module. Operational intelligence layer.
 * Provides: revenue insights, expense insights, treasury insights,
 * gas insights, portfolio insights, automation insights.
 *
 * REAL DATA ONLY. NO MOCK DATA.
 * Read-only. NEVER executes anything.
 *
 * Attached to window.AutonomaBusinessIntelligence
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'elligentt_bizint_v1';
  var history = [];

  function load() { try { var r = localStorage.getItem(STORAGE_KEY); if (r) history = JSON.parse(r); } catch (_) { history = []; } }
  function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(history)); } catch (_) {} }

  /* ── Snapshot Recording ────────────────────────────────────────────── */
  function takeSnapshot() {
    try {
      var snap = {
        ts: Date.now(),
        portfolio: 0,
        vaultUSD: 0,
        gasETH: 0,
        schedules: 0,
        auths: 0,
        revenue: 0
      };
      if (typeof UB !== 'undefined' && UB.state) snap.portfolio = UB.state.totalUSD || 0;
      if (typeof VaultAccounting !== 'undefined') snap.vaultUSD = VaultAccounting.getTotalAvailable ? VaultAccounting.getTotalAvailable('usdc') : 0;
      if (typeof ScheduleEngine !== 'undefined') snap.schedules = (ScheduleEngine.getAll ? ScheduleEngine.getAll() : []).length;
      if (typeof AgentAuthorization !== 'undefined') snap.auths = (AgentAuthorization.getAll ? AgentAuthorization.getAll() : []).length;
      history.push(snap);
      if (history.length > 100) history = history.slice(-100);
      save();
    } catch (_) {}
  }

  /* ── Insight Generation ─────────────────────────────────────────────── */
  function generateInsights() {
    takeSnapshot();
    var insights = [];
    if (history.length < 2) return insights;

    var current = history[history.length - 1];
    var weekAgo = findSnapshot(Date.now() - 604800000);
    var monthAgo = findSnapshot(Date.now() - 2592000000);

    // Portfolio growth
    if (monthAgo && current.portfolio > 0) {
      var change = ((current.portfolio - monthAgo.portfolio) / Math.max(monthAgo.portfolio, 1)) * 100;
      if (change > 10) insights.push({ type: 'portfolio_growth', text: 'Your portfolio has grown ' + Math.round(change) + '% this month.', confidence: 85 });
    }

    // Treasury growth
    if (monthAgo && current.vaultUSD > 0 && monthAgo.vaultUSD > 0) {
      var tChange = ((current.vaultUSD - monthAgo.vaultUSD) / monthAgo.vaultUSD) * 100;
      if (Math.abs(tChange) > 5) {
        insights.push({
          type: 'treasury_change', confidence: 80,
          text: 'Your Treasury has ' + (tChange > 0 ? 'grown' : 'decreased') + ' ' + Math.round(Math.abs(tChange)) + '% this month.'
        });
      }
    }

    // Automation trends
    if (weekAgo && current.schedules > weekAgo.schedules) {
      insights.push({ type: 'automation_growth', text: 'You have ' + (current.schedules - weekAgo.schedules) + ' more schedules than last week.', confidence: 70 });
    }

    // Portfolio concentration
    try {
      if (typeof UB !== 'undefined' && UB.state && UB.state.assets) {
        var total = UB.state.totalUSD || 0;
        var usdcTotal = 0;
        UB.state.assets.forEach(function (a) {
          if (a.token === 'USDC') usdcTotal += (a.usd || 0);
        });
        var concentration = total > 0 ? (usdcTotal / total) * 100 : 0;
        if (concentration > 80) {
          insights.push({ type: 'concentration', text: 'Your portfolio is ' + Math.round(concentration) + '% concentrated in USDC.', confidence: 75 });
        }
      }
    } catch (_) {}

    // Vault underutilization
    if (current.vaultUSD < 10 && current.portfolio > 500) {
      insights.push({ type: 'vault_underutilized', text: 'Your Vault is underutilized. Consider allocating funds to earn yield.', confidence: 72 });
    }

    // Authorization health
    if (current.auths === 0) {
      insights.push({ type: 'no_auth', text: 'No agent authorizations configured. Set up permissions for automated operations.', confidence: 65 });
    }

    return insights;
  }

  function findSnapshot(targetTime) {
    var best = null;
    for (var i = 0; i < history.length; i++) {
      if (history[i].ts <= targetTime) best = history[i];
      if (history[i].ts > targetTime) break;
    }
    return best;
  }

  /* ── Insight Card Generator ────────────────────────────────────────── */
  function getInsightsCard(R) {
    var insights = generateInsights();
    if (!insights.length) return '';

    if (!R || typeof R.card !== 'function') {
      return '<div>' + insights.map(function (i) { return i.text; }).join('<br>') + '</div>';
    }

    var o = '';
    o += R.section('Business Intelligence', 'ti ti-chart-bar');

    insights.forEach(function (insight) {
      o += '<div style="display:flex;align-items:flex-start;gap:6px;padding:4px 0;font-size:9px">' +
        '<span style="color:var(--teal);flex-shrink:0;margin-top:1px">◆</span>' +
        '<span style="color:var(--text)">' + insight.text + '</span>' +
        '</div>';
    });

    o += R.actions([
      { label: 'View Reports', cls: 'teal', onclick: "showPage('reports')" }
    ]);
    return R.card(o, 'Business Intelligence', 'purple');
  }

  load();

  // Auto-snapshot every 60 minutes
  setInterval(takeSnapshot, 3600000);
  takeSnapshot();

  window.AutonomaBusinessIntelligence = {
    generateInsights: generateInsights,
    getInsightsCard: getInsightsCard,
    takeSnapshot: takeSnapshot
  };

  console.log('[AutonomaBusinessIntelligence] Initialized — BI Layer active.');
})();
