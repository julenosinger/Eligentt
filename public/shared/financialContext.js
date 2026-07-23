/**
 * Financial Context Bridge — Shared communication layer between Autonoma & AI Smart Wallet
 *
 * Read-only data access layer. Both Autonoma and AI Smart Wallet consume the same contexts
 * without duplicating business logic, without new databases, without modifying existing flows.
 *
 * Attached to window.FinancialContext
 */
(function(){
  'use strict';

  /* ── Providers ──────────────────────────────────────────────────── */
  function _aiw() {
    try { if (typeof window.AIWallet !== 'undefined') return window.AIWallet; } catch(_e){}
    return null;
  }

  function _scheduleEngine() {
    try { if (typeof window.ScheduleEngine !== 'undefined') return window.ScheduleEngine; } catch(_e){}
    return null;
  }

  function _agentAuth() {
    try { if (typeof window.AgentAuthorization !== 'undefined') return window.AgentAuthorization; } catch(_e){}
    return null;
  }

  function _agentWallet() {
    try { if (typeof window.AgentWalletManager !== 'undefined') return window.AgentWalletManager; } catch(_e){}
    return null;
  }

  /* ── Wallet Context ─────────────────────────────────────────────── */
  function getWalletContext() {
    var ctx = {
      personalAddress: null,
      agentAddress: null,
      activeChainId: null,
      walletMode: 'personal',
      emergencyStop: false
    };
    try { ctx.personalAddress = typeof window.walletAddress !== 'undefined' ? window.walletAddress : null; } catch(_e){}
    try { ctx.activeChainId = typeof window.activeChainId !== 'undefined' ? window.activeChainId : null; } catch(_e){}
    var aiw = _aiw();
    if (aiw) {
      try { ctx.walletMode = aiw.getMode ? aiw.getMode() : 'personal'; } catch(_e){}
      try { ctx.emergencyStop = aiw.isEmergencyStopped ? aiw.isEmergencyStopped() : false; } catch(_e){}
    }
    try {
      var awm = _agentWallet();
      if (awm && awm.getAgentAddress) ctx.agentAddress = awm.getAgentAddress() || null;
    } catch(_e){}
    return ctx;
  }

  /* ── Financial Context ──────────────────────────────────────────── */
  function getFinancialContext() {
    var ctx = {
      portfolio: { totalUsd: 0, wallets: [] },
      vault: {},
      gas: null,
      limits: {},
      healthScore: 0,
      availableAt: null
    };
    var aiw = _aiw();
    if (!aiw) return ctx;

    // Portfolio — read from AI Smart Wallet cache
    try {
      if (aiw.getIntents) ctx.intents = aiw.getIntents().length;
    } catch(_e){}

    // Vault allocations
    try {
      if (typeof aiw._vaultView === 'function') {
        ctx.vault = { USDC: aiw._vaultView('USDC'), EURC: aiw._vaultView('EURC') };
      }
    } catch(_e){}

    return ctx;
  }

  /* ── Balance Context (snapshot) ─────────────────────────────────── */
  function getBalanceContext() {
    var ctx = {
      personalBalances: {},
      agentBalances: {},
      totalUsd: 0,
      updatedAt: 0
    };

    try {
      if (typeof window.__FinancialBridge !== 'undefined' && window.__FinancialBridge._portfolioSnapshot) {
        var snap = window.__FinancialBridge._portfolioSnapshot;
        ctx.personalBalances = snap.personal || {};
        ctx.agentBalances = snap.agent || {};
        ctx.totalUsd = snap.totalUsd || 0;
        ctx.updatedAt = snap.at || 0;
      }
    } catch(_e){}

    return ctx;
  }

  /* ── Portfolio Context ──────────────────────────────────────────── */
  function getPortfolioContext() {
    var ctx = { totalUsd: 0, wallets: [], cacheAge: null };
    try {
      var aiw = _aiw();
      if (aiw && aiw._portfolioData) {
        var pd = aiw._portfolioData();
        ctx.totalUsd = pd.totalUsd || 0;
        ctx.wallets = pd.wallets || [];
        ctx.cacheAge = pd.cacheAge || null;
      }
    } catch(_e){}
    return ctx;
  }

  /* ── Schedule Context ───────────────────────────────────────────── */
  function getScheduleContext() {
    var ctx = { total: 0, active: 0, upcoming: [], due: [], aiCreated: 0 };
    try {
      var se = _scheduleEngine();
      if (se) {
        var all = se.getAll ? se.getAll() : [];
        var now = Date.now();
        ctx.total = all.length;
        ctx.upcoming = all.filter(function(s) {
          return s.status === 'Active' && s.nextRun && new Date(s.nextRun).getTime() > now;
        }).slice(0, 20);
        ctx.due = all.filter(function(s) {
          return s.status === 'Active' && s.nextRun && new Date(s.nextRun).getTime() <= now;
        });
        ctx.active = all.filter(function(s) { return s.status === 'Active'; }).length;
        ctx.aiCreated = all.filter(function(s) { return s.createdBy === 'aiwallet'; }).length;
      }
    } catch(_e){}
    return ctx;
  }

  /* ── Permission / Security Context ──────────────────────────────── */
  function getSecurityContext() {
    var ctx = {
      activeGrants: 0,
      totalSpendingCap: 0,
      totalDailyLimit: 0,
      allowedOps: [],
      agentPaused: false,
      emergencyStop: false
    };
    try {
      var auth = _agentAuth();
      if (auth && auth.getAuthSummary) {
        var s = auth.getAuthSummary();
        ctx.activeGrants = s.count || 0;
        ctx.totalSpendingCap = s.totalSpendingLimit || 0;
        ctx.totalDailyLimit = s.totalDailyLimit || 0;
        ctx.allowedOps = s.allowedOps ? Array.from(s.allowedOps) : [];
      }
    } catch(_e){}
    try {
      var awm = _agentWallet();
      if (awm && awm.isPaused) ctx.agentPaused = !!awm.isPaused();
    } catch(_e){}
    try {
      var aiw = _aiw();
      if (aiw && aiw.isEmergencyStopped) ctx.emergencyStop = !!aiw.isEmergencyStopped();
    } catch(_e){}
    return ctx;
  }

  /* ── Transaction History Context ─────────────────────────────────── */
  function getTransactionContext() {
    var ctx = { recent: [], total: 0 };
    try {
      var aiw = _aiw();
      if (aiw) {
        var hist = aiw.getHistory ? aiw.getHistory() : [];
        ctx.total = hist.length;
        ctx.recent = hist.slice(0, 10);
      }
    } catch(_e){}
    return ctx;
  }

  /* ── Workflow Context ───────────────────────────────────────────── */
  function getWorkflowContext() {
    var ctx = { total: 0, active: 0, list: [] };
    try {
      if (typeof window.__FinancialBridge !== 'undefined' && window.__FinancialBridge._workflows) {
        var wfs = window.__FinancialBridge._workflows;
        ctx.total = wfs.length || 0;
        ctx.active = wfs.filter(function(w) { return w.status === 'active'; }).length || 0;
        ctx.list = wfs.slice(0, 10);
      }
    } catch(_e){}
    return ctx;
  }

  /* ── Recommendations Context ────────────────────────────────────── */
  function getRecommendationContext() {
    var ctx = { recs: [] };
    try {
      if (typeof window.__FinancialBridge !== 'undefined' && window.__FinancialBridge._recommendations) {
        ctx.recs = window.__FinancialBridge._recommendations.slice(0, 6);
      }
    } catch(_e){}
    return ctx;
  }

  /* ── Full Snapshot (all contexts at once) ───────────────────────── */
  function getSnapshot() {
    return {
      wallet: getWalletContext(),
      balance: getBalanceContext(),
      portfolio: getPortfolioContext(),
      schedules: getScheduleContext(),
      security: getSecurityContext(),
      transactions: getTransactionContext(),
      workflows: getWorkflowContext(),
      recommendations: getRecommendationContext(),
      financial: getFinancialContext(),
      at: Date.now()
    };
  }

  /* ── Autonoma Intent Receiver ───────────────────────────────────── */
  function receiveAutonomaIntent(intent) {
    var aiw = _aiw();
    if (!aiw) return { received: false, reason: 'AI Smart Wallet unavailable' };
    try {
      var id = aiw.submitIntent ? aiw.submitIntent(intent) : null;
      if (id) {
        return { received: true, intentId: id, status: 'validating' };
      }
      return { received: false, reason: 'Intent rejected by validation' };
    } catch(e) {
      return { received: false, reason: e.message || 'Error submitting intent' };
    }
  }

  /* ── Status updates back to Autonoma ────────────────────────────── */
  var _statusCallbacks = [];

  function onStatusUpdate(callback) {
    if (typeof callback === 'function') _statusCallbacks.push(callback);
    if (_statusCallbacks.length > 10) _statusCallbacks.shift();
  }

  function emitStatus(update) {
    _statusCallbacks.forEach(function(cb) {
      try { cb(update); } catch(_e){}
    });
  }

  /* Listen to schedule execution results */
  try {
    document.addEventListener('SCHEDULE_UPDATED', function(e) {
      if (e.detail && e.detail.item && e.detail.changes && e.detail.changes.execCount !== undefined) {
        emitStatus({
          type: 'execution_result',
          schedId: e.detail.item.id,
          name: e.detail.item.name,
          amount: e.detail.item.amount,
          token: e.detail.item.token,
          status: 'executed',
          timestamp: Date.now()
        });
      }
    });
  } catch(_e){}

  try {
    document.addEventListener('SCHEDULE_CREATED', function(e) {
      if (e.detail && e.detail.createdBy === 'aiwallet') {
        emitStatus({
          type: 'schedule_created',
          schedId: e.detail.id,
          name: e.detail.name || e.detail.type,
          status: 'created',
          timestamp: Date.now()
        });
      }
    });
  } catch(_e){}

  /* ── Internal bridge for performance (portfolio snapshot caching) ── */
  window.__FinancialBridge = window.__FinancialBridge || {
    _portfolioSnapshot: null,
    _workflows: [],
    _recommendations: []
  };

  function updatePortfolioSnapshot(snapshot) {
    window.__FinancialBridge._portfolioSnapshot = snapshot;
  }

  function updateWorkflowsList(list) {
    window.__FinancialBridge._workflows = list || [];
  }

  function updateRecommendations(list) {
    window.__FinancialBridge._recommendations = list || [];
  }

  /* ── Public API ─────────────────────────────────────────────────── */
  window.FinancialContext = {
    // Context readers (read-only)
    getWalletContext: getWalletContext,
    getFinancialContext: getFinancialContext,
    getBalanceContext: getBalanceContext,
    getPortfolioContext: getPortfolioContext,
    getScheduleContext: getScheduleContext,
    getSecurityContext: getSecurityContext,
    getTransactionContext: getTransactionContext,
    getWorkflowContext: getWorkflowContext,
    getRecommendationContext: getRecommendationContext,
    getSnapshot: getSnapshot,

    // Intent bridge
    receiveAutonomaIntent: receiveAutonomaIntent,

    // Status bridge
    onStatusUpdate: onStatusUpdate,
    emitStatus: emitStatus,

    // Performance snapshot
    updatePortfolioSnapshot: updatePortfolioSnapshot,
    updateWorkflowsList: updateWorkflowsList,
    updateRecommendations: updateRecommendations
  };
})();
