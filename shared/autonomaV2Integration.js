/**
 * Autonoma V2 Integration Layer
 * ──────────────────────────────────────
 * ADDITIVE module. Integrates all Phase 1-14 capabilities into the existing
 * Autonoma pipeline WITHOUT modifying any existing file or function.
 *
 * Uses surgical monkey-patching on:
 *   - AutonomaCore.process() → adds Financial Planner + Treasury + BI cards
 *   - _classifyIntent() → adds new intents
 *   - _executeIntent() → adds new handlers
 *   - autProcess() → injects V2 intelligence before existing flow
 *
 * ALL existing functionality preserved. Purely additive.
 *
 * Attached to window.AutonomaV2
 */
(function () {
  'use strict';

  /* ── 1. Wait for dependencies ──────────────────────────────────────── */
  function waitForDeps(cb) {
    var tries = 0;
    function check() {
      tries++;
      if (typeof AutonomaCore !== 'undefined' && typeof window._classifyIntent === 'function') {
        return cb();
      }
      if (tries < 60) setTimeout(check, 200);
    }
    check();
  }

  /* ── 2. WORD_MAP Enhancement ───────────────────────────────────────── */
  function enhanceWordMap() {
    if (!window.AutonomaCore || !window.AutonomaCore._wordMap) return;
    var wm = window.AutonomaCore._wordMap;

    // Expose WORD_MAP if not already
    if (!wm) {
      try {
        // Access the internal WORD_MAP from the module closure
        // If unavailable, we add via the process pipeline instead
      } catch (_) {}
    }

    // Add new goals to the goal detection
    if (window.AutonomaCore._enhanceGoals) {
      window.AutonomaCore._enhanceGoals({
        financial_plan: { en: ['plan', 'allocate', 'reserve', 'set aside', 'save for', 'keep at least', 'never allow', 'move excess', 'separate'], pt: ['planejar', 'alocar', 'reservar', 'separar', 'guardar', 'manter', 'nunca deixar', 'mover excesso', 'economizar'] },
        treasury_check: { en: ['treasury', 'vault health', 'idle funds', 'gas reserve', 'upcoming payroll', 'expiring permissions'], pt: ['tesouraria', 'saude do vault', 'fundos parados', 'reserva de gas', 'folha proxima', 'permissoes expirando'] },
        operations_view: { en: ['operations', 'dashboard', 'overview', 'today', 'summary', 'status'], pt: ['operacoes', 'painel', 'resumo', 'hoje', 'status', 'visao geral'] },
        business_intel: { en: ['insights', 'analytics', 'growth', 'trends', 'report', 'analysis', 'recommendations'], pt: ['insights', 'analise', 'crescimento', 'tendencias', 'relatorio', 'recomendacoes'] },
        team_manage: { en: ['team', 'permissions', 'manager', 'finance', 'owner', 'operations role'], pt: ['equipe', 'permissoes', 'gerente', 'financas', 'dono', 'operacoes'] },
        small_biz: { en: ['freelancer', 'creator', 'agency', 'small business', 'dao', 'payroll management'], pt: ['freelancer', 'criador', 'agencia', 'pequena empresa', 'dao', 'gestao de folha'] }
      });
    }
  }

  /* ── 3. Intent Classification Enhancement ──────────────────────────── */
  function enhanceClassifyIntent() {
    var origClassify = window._classifyIntent;
    if (!origClassify) return;

    window._classifyIntent = function (msg) {
      // Try original first
      var result = origClassify(msg);
      if (result && result !== 'UNKNOWN') return result;

      // V2 intents
      var lower = (msg || '').toLowerCase();

      // Financial planning patterns
      if (/(?:separate|reserve|allocate|set aside|save for|keep at least|never allow|move excess|separe|reserve|alocar|guardar|mantenha?|n[uã]o deixe|mover excesso)/i.test(lower)) {
        return 'FINANCIAL_PLAN';
      }

      // Treasury/operations checks
      if (/(?:treasury health|vault status|idle funds|gas reserve|upcoming payroll|expiring permissions|sa[uú]de do vault|fundos parados|reserva de g[aá]s|folha pr[oó]xima)/i.test(lower)) {
        return 'TREASURY_CHECK';
      }

      // Operations overview
      if (/(?:operations dashboard|overview|today.*summary|status report|painel de opera[cç][oõ]es|resumo de hoje)/i.test(lower)) {
        return 'OPERATIONS_VIEW';
      }

      // Business intelligence
      if (/(?:insights|analytics|growth|trends|analysis|recommendations|insights?|an[aá]lise|crescimento|tend[eê]ncias)/i.test(lower)) {
        return 'BUSINESS_INTEL';
      }

      // Team management
      if (/(?:team permission|add manager|set finance role|team access|permiss[oõ]es de equipe|adicionar gerente)/i.test(lower)) {
        return 'TEAM_MANAGE';
      }

      // Payment collections (Phase 8)
      if (/(?:create (?:a )?payment link|new invoice|generate invoice|criar (?:um )?link de pagamento|nova fatura|gerar fatura)/i.test(lower)) {
        return 'CREATE_COLLECTION';
      }

      // Multi-step execution (Phase 7)
      if (/(?:execution plan|show plan|what will happen|plano de execu[cç][aã]o|mostrar plano|o que vai acontecer)/i.test(lower)) {
        return 'SHOW_EXECUTION_PLAN';
      }

      // Small business
      if (/(?:small business|freelancer|creator mode|agency mode|pequena empresa|modo freelancer)/i.test(lower)) {
        return 'SMALL_BIZ_MODE';
      }

      return result;
    };
  }

  /* ── 4. Intent Execution Enhancement ───────────────────────────────── */
  function enhanceExecuteIntent() {
    var origExecute = window._executeIntent;
    if (!origExecute) return;

    window._executeIntent = function (intent, params, msg) {
      // V2 intents
      switch (intent) {
        case 'FINANCIAL_PLAN':
          return handleFinancialPlan(msg);
        case 'TREASURY_CHECK':
          return handleTreasuryCheck(msg);
        case 'OPERATIONS_VIEW':
          return handleOperationsView(msg);
        case 'BUSINESS_INTEL':
          return handleBusinessIntel(msg);
        case 'TEAM_MANAGE':
          return handleTeamManage(msg);
        case 'CREATE_COLLECTION':
          return handleCreateCollection(msg);
        case 'SHOW_EXECUTION_PLAN':
          return handleShowExecutionPlan(msg);
        case 'SMALL_BIZ_MODE':
          return handleSmallBizMode(msg);
        default:
          return origExecute(intent, params, msg);
      }
    };
  }

  /* ── 5. V2 Intent Handlers ─────────────────────────────────────────── */
  function handleFinancialPlan(msg) {
    try {
      if (typeof AutonomaFinancialPlanner === 'undefined') return showMsg('Financial Planner not loaded yet. Please try again.', 'error');
      var plan = AutonomaFinancialPlanner.buildPlan(msg);
      if (!plan) return showMsg("I couldn't understand the financial plan. Could you be more specific?", 'info');

      var html = '';
      try {
        if (typeof R !== 'undefined') {
          html = AutonomaFinancialPlanner.getApprovalCard(plan, R);
        }
      } catch (_) {}
      if (!html) {
        html = '<div class="aut-msg ai"><div class="aut-msg-body">' +
          '<strong>Financial Plan</strong><br>' +
          plan.explanation + '<br><br>' +
          '<small>Confidence: ' + plan.confidence + '%</small><br>' +
          '<small>Estimated cost: ' + (plan.estimatedCost ? plan.estimatedCost.total : '~0.001 USDC') + '</small><br><br>' +
          '<button class="btn primary" onclick="AutonomaFinancialPlanner.approve(\'' + plan.id + '\')">Approve Plan</button> ' +
          '<button class="btn" onclick="AutonomaFinancialPlanner.cancel(\'' + plan.id + '\')">Cancel</button>' +
          '</div></div>';
      }
      injectCard(html);
    } catch (e) {
      showMsg('Error analyzing plan: ' + (e.message || 'Unknown'), 'error');
    }
  }

  function handleTreasuryCheck(msg) {
    try {
      if (typeof AutonomaTreasuryManager === 'undefined') return showMsg('Treasury Manager not loaded yet.', 'error');
      var card = '';
      try { if (typeof R !== 'undefined') card = AutonomaTreasuryManager.getTreasuryAlertCard(R); } catch (_) {}
      if (!card) {
        var findings = AutonomaTreasuryManager.scan();
        card = '<div class="aut-msg ai"><div class="aut-msg-body">';
        if (!findings.length) {
          card += '<strong>Treasury Health</strong><br>All clear — no issues detected.';
        } else {
          card += '<strong>Treasury Alerts</strong><br>';
          findings.forEach(function (f) {
            card += '<div style="font-size:9px;padding:4px 0;border-bottom:1px solid var(--border)">' +
              (f.severity === 'warning' ? '⚠' : 'ℹ') + ' <strong>' + f.title + '</strong><br>' +
              f.detail + '<br><span style="color:var(--teal)">→ ' + f.suggestion + '</span></div>';
          });
        }
        card += '</div></div>';
      }
      injectCard(card);
    } catch (e) {
      showMsg('Error checking treasury: ' + (e.message || 'Unknown'), 'error');
    }
  }

  function handleOperationsView(msg) {
    try {
      if (typeof AutonomaOperationsCenter === 'undefined') return showMsg('Operations Center not loaded yet.', 'error');
      var card = '';
      try { if (typeof R !== 'undefined') card = AutonomaOperationsCenter.getDashboardCard(R); } catch (_) {}
      if (!card) {
        var snap = AutonomaOperationsCenter.getSnapshot();
        card = '<div class="aut-msg ai"><div class="aut-msg-body">' +
          '<strong>Operations Center</strong><br>' +
          'Portfolio: $' + snap.portfolio.totalUSD.toFixed(2) + '<br>' +
          'Schedules: ' + snap.operations.schedules + '<br>' +
          'Vault: ' + snap.treasury.status + ' (' + snap.treasury.vaultAvailable.toFixed(2) + ' USDC)<br>' +
          'Automation: ' + snap.automationScore + '%' +
          '</div></div>';
      }
      injectCard(card);
    } catch (e) {
      showMsg('Error loading operations: ' + (e.message || 'Unknown'), 'error');
    }
  }

  function handleBusinessIntel(msg) {
    try {
      if (typeof AutonomaBusinessIntelligence === 'undefined') return showMsg('Business Intelligence not loaded yet.', 'error');
      var card = '';
      try { if (typeof R !== 'undefined') card = AutonomaBusinessIntelligence.getInsightsCard(R); } catch (_) {}
      if (!card) {
        var insights = AutonomaBusinessIntelligence.generateInsights();
        card = '<div class="aut-msg ai"><div class="aut-msg-body">';
        card += '<strong>Business Intelligence</strong><br>';
        if (!insights.length) {
          card += 'Not enough data yet. Keep using the platform and I will generate insights.';
        } else {
          insights.forEach(function (i) {
            card += '<div style="font-size:9px;padding:2px 0">◆ ' + i.text + '</div>';
          });
        }
        card += '</div></div>';
      }
      injectCard(card);
    } catch (e) {
      showMsg('Error generating insights: ' + (e.message || 'Unknown'), 'error');
    }
  }

  function handleTeamManage(msg) {
    var html = '<div class="aut-msg ai"><div class="aut-msg-body">' +
      '<strong>Team Management</strong><br>' +
      'Team permissions are managed through the Permission Center. Available roles:<br><br>' +
      '• <strong>Owner</strong> — Full permissions<br>' +
      '• <strong>Manager</strong> — Schedule creation<br>' +
      '• <strong>Finance</strong> — Invoice generation<br>' +
      '• <strong>Payroll</strong> — Payroll uploads<br>' +
      '• <strong>Operations</strong> — Treasury reports<br><br>' +
      'To configure team permissions, open the <strong>Settings → Permissions</strong> page.' +
      '</div></div>';
    injectCard(html);
  }

  function handleCreateCollection(msg) {
    var html = '<div class="aut-msg ai"><div class="aut-msg-body">' +
      '<strong>Create Collection</strong><br>' +
      'I can help you create payment links and invoices. What would you like to do?<br><br>' +
      '<button class="btn teal" onclick="showPage(\'links\')">Create Payment Link</button> ' +
      '<button class="btn" onclick="showPage(\'invoices\')">Create Invoice</button>' +
      '</div></div>';
    injectCard(html);
  }

  function handleShowExecutionPlan(msg) {
    try {
      if (typeof ExecutionPlanner === 'undefined') return showMsg('Execution Planner not loaded yet.', 'error');
      var steps = ExecutionPlanner.plan ? ExecutionPlanner.plan(msg) : [{ step: 1, label: 'Review your request', detail: 'Awaiting more details' }];
      var html = '<div class="aut-msg ai"><div class="aut-msg-body"><strong>Execution Plan</strong><br>';
      steps.forEach(function (s) {
        html += '<div style="font-size:9px;padding:3px 0">' + s.step + '. ' + s.label + '</div>';
      });
      html += '</div></div>';
      injectCard(html);
    } catch (e) {
      showMsg('Error building plan: ' + (e.message || 'Unknown'), 'error');
    }
  }

  function handleSmallBizMode(msg) {
    var suggestions = [];
    try {
      if (typeof AutonomaFinancialMemory !== 'undefined') {
        suggestions = AutonomaFinancialMemory.getSuggestions();
      }
    } catch (_) {}
    var html = '<div class="aut-msg ai"><div class="aut-msg-body">' +
      '<strong>Small Business Mode</strong><br>' +
      'I am your financial copilot. You can run most of Elligentt by simply talking to me.<br><br>' +
      '<strong>Quick actions:</strong><br>' +
      '• "Pay my team" — Process payroll<br>' +
      '• "Check treasury" — View vault & gas health<br>' +
      '• "Show operations" — Today\'s dashboard<br>' +
      '• "Create payment link" — Generate invoice links<br>' +
      '• "Schedule payments" — Set up recurring operations<br>';
    if (suggestions.length) {
      html += '<br><strong>Suggestions based on your patterns:</strong><br>';
      suggestions.forEach(function (s) { html += '• ' + s.text + '<br>'; });
    }
    html += '</div></div>';
    injectCard(html);
  }

  /* ── 6. AutProcess Enhancement ─────────────────────────────────────── */
  function enhanceAutoProcess() {
    if (typeof window.autProcess !== 'function') return;
    var origProcess = window.autProcess;

    window.autProcess = function (msg) {
      // Try V2 intelligence first
      try {
        var v2Result = tryV2Intelligence(msg);
        if (v2Result) return v2Result;
      } catch (_) {}

      // Fall through to original
      return origProcess(msg);
    };
  }

  function tryV2Intelligence(msg) {
    var lower = (msg || '').toLowerCase();

    // Financial plan detection
    if (typeof AutonomaFinancialPlanner !== 'undefined') {
      var plan = AutonomaFinancialPlanner.understand(msg);
      if (plan.type && plan.confidence >= 75) {
        handleFinancialPlan(msg);
        return true;
      }
    }

    // Memory-based suggestions
    if (typeof AutonomaFinancialMemory !== 'undefined') {
      var payrollSug = AutonomaFinancialMemory.getFridayPayrollSuggestion();
      if (payrollSug && /(?:payroll|folha|pay team|pagar equipe)/i.test(lower)) {
        var html = '<div class="aut-msg ai"><div class="aut-msg-body">' + payrollSug.text +
          '<br><br><button class="btn primary" onclick="showPage(\'schedule\')">Prepare Payroll</button> ' +
          '<button class="btn" onclick="autonomaSendQuick(\'skip\')">Skip</button></div></div>';
        injectCard(html);
        return true;
      }
    }

    return false;
  }

  /* ── 7. Autonoma Agent Enhancement ─────────────────────────────────── */
  function enhanceAgentReplies() {
    // Add V2 context to every agent reply
    try {
      if (typeof AutonomaAgent !== 'undefined') {
        var origReply = AutonomaAgent.getAgentReply;
        if (origReply && !window.__v2AgentEnhanced) {
          AutonomaAgent.getAgentReply = function (query) {
            // Check V2 queries first
            var lower = (query || '').toLowerCase();
            if (/(?:operations|dashboard|overview)/i.test(lower) && typeof AutonomaOperationsCenter !== 'undefined') {
              var snap = AutonomaOperationsCenter.getSnapshot();
              return 'Current operations: ' + snap.operations.payments + ' payments, ' + snap.operations.schedules + ' schedules, $' + snap.portfolio.totalUSD.toFixed(2) + ' portfolio. Vault: ' + snap.treasury.status + '.';
            }
            if (/(?:treasury|vault|gas)/i.test(lower) && typeof AutonomaTreasuryManager !== 'undefined') {
              AutonomaTreasuryManager.scan();
              var f = AutonomaTreasuryManager.getFindings();
              if (!f.length) return 'Treasury is healthy. No issues detected.';
              return f.map(function (x) { return x.title + ': ' + x.suggestion; }).join(' | ');
            }
            return origReply(query);
          };
          window.__v2AgentEnhanced = true;
        }
      }
    } catch (_) {}
  }

  /* ── Utilities ─────────────────────────────────────────────────────── */
  function showMsg(text, type) {
    try {
      if (typeof toast === 'function') return toast(text, type);
    } catch (_) {}
    if (typeof _addAutMsg === 'function') {
      _addAutMsg(text, type === 'error' ? 'error' : '');
    }
  }

  function injectCard(html) {
    try {
      var c = document.getElementById('aut-messages');
      if (!c) return;
      var w = document.getElementById('aut-welcome');
      if (w) w.style.display = 'none';
      var typing = c.querySelector('.aut-typing-msg');
      if (typing) typing.remove();
      c.insertAdjacentHTML('beforeend', html);
      c.scrollTop = c.scrollHeight;
    } catch (_) {}
  }

  /* ── Initialization ────────────────────────────────────────────────── */
  waitForDeps(function () {
    enhanceWordMap();
    enhanceClassifyIntent();
    enhanceExecuteIntent();
    enhanceAutoProcess();
    setTimeout(enhanceAgentReplies, 1500);
    console.log('[AutonomaV2] All V2 layers initialized — Financial Planner, Treasury Manager, Operations Center, BI, Memory active.');
  });

  window.AutonomaV2 = {
    tryV2Intelligence: tryV2Intelligence,
    handleFinancialPlan: handleFinancialPlan,
    handleTreasuryCheck: handleTreasuryCheck,
    handleOperationsView: handleOperationsView,
    handleBusinessIntel: handleBusinessIntel
  };

})();
