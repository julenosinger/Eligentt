/**
 * AgentCapabilityRouter — Dynamic Action Surface generator
 * =========================================================
 * Converts a confirmed intent + params into a CONTEXTUAL action surface:
 *   Proposal Card  →  User Approval  →  Route to existing engine  →  Result
 *
 * PRINCIPLES:
 *  • Zero new execution logic — all writes route to the EXISTING _executeIntent
 *  • All financial actions REQUIRE user approval (confirm/cancel)
 *  • Read queries (balance, history, etc.) produce inline data cards
 *  • Dynamic surfaces are TEMPORARY — they disappear after action
 *  • Security: never auto-executes, never exposes keys
 *
 * Attached to: window.AgentCapabilityRouter
 */
(function () {
  'use strict';

  /* ── safe module accessor ─────────────────────────────────── */
  function mod(name) {
    try { return (typeof window !== 'undefined' && window[name] != null) ? window[name] : null; } catch (e) { return null; }
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtUSDC(n) {
    if (n == null || isNaN(n)) return '—';
    var v = parseFloat(n);
    return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  }
  function shortAddr(a) {
    if (!a || a.length < 10) return a || '—';
    return a.slice(0, 8) + '…' + a.slice(-6);
  }

  /* ── pending proposal store ───────────────────────────────── */
  var _proposals = {}; // proposalId → { intent, params, runtime }
  var _propSeq = 0;

  function storeProp(intent, params, runtime) {
    var id = 'prop_' + Date.now().toString(36) + '_' + (++_propSeq);
    _proposals[id] = { intent: intent, params: params, runtime: runtime, createdAt: Date.now() };
    // auto-expire after 10 minutes
    setTimeout(function () { delete _proposals[id]; }, 600000);
    return id;
  }

  /* ── risk badge ───────────────────────────────────────────── */
  function riskBadge(amount) {
    var n = parseFloat(amount) || 0;
    if (n > 10000) return '<span class="das-risk high">HIGH RISK</span>';
    if (n > 1000)  return '<span class="das-risk medium">MEDIUM RISK</span>';
    return '<span class="das-risk low">LOW RISK</span>';
  }

  /* ══════════════════════════════════════════════════════════
     SURFACE BUILDERS — one per capability
     Each returns HTML for the proposal card (before execution).
     After user approves → routeExecution() calls the existing engine.
     ══════════════════════════════════════════════════════════ */

  /* ── SEND PROPOSAL ──────────────────────────────────────── */
  function buildSendProposal(params, propId) {
    var amount  = params.amount || '?';
    var token   = params.token  || 'USDC';
    var addr    = params.address || '';
    var name    = params.recipientName || '';
    var network = params.chain || 'Arc Mainnet';
    var display = name ? esc(name) + ' <span style="color:var(--muted2);font-size:9px">' + shortAddr(addr) + '</span>' : '<code style="font-size:9px">' + shortAddr(addr) + '</code>';

    return '<div class="das-wrap">' +
      '<div class="das-header"><span class="das-icon send"><i class="ti ti-send"></i></span>' +
      '<div class="das-title-area"><span class="das-op-label">SEND PROPOSAL</span>' +
      '<span class="das-headline">I found a route for your payment.</span></div>' +
      riskBadge(amount) + '</div>' +
      '<div class="das-body">' +
      '<div class="das-flow">' +
        '<div class="das-flow-item"><span class="das-flow-label">Amount</span>' +
        '<span class="das-flow-value blue">' + esc(String(amount)) + ' <strong>' + esc(token) + '</strong></span></div>' +
        '<div class="das-flow-arrow"><i class="ti ti-arrow-right"></i></div>' +
        '<div class="das-flow-item"><span class="das-flow-label">Recipient</span>' +
        '<span class="das-flow-value">' + display + '</span></div>' +
      '</div>' +
      '<div class="das-detail-row"><i class="ti ti-world"></i><span>' + esc(network) + '</span></div>' +
      '</div>' +
      '<div class="das-actions">' +
        '<button class="das-btn review" onclick="AgentCapabilityRouter.approve(\'' + propId + '\')"><i class="ti ti-check"></i>Approve & Send</button>' +
        '<button class="das-btn cancel" onclick="AgentCapabilityRouter.cancel(\'' + propId + '\')"><i class="ti ti-x"></i>Cancel</button>' +
      '</div></div>';
  }

  /* ── SWAP PROPOSAL ──────────────────────────────────────── */
  function buildSwapProposal(params, propId) {
    var amount   = params.amount  || '?';
    var fromTok  = params.token   || 'USDC';
    var toTok    = params.toToken || params.toAsset || (fromTok === 'USDC' ? 'EURC' : 'USDC');
    var network  = params.chain   || 'Arc Mainnet';
    var route    = params.route   || 'LI.FI';
    var estimate = params.estimate || null;

    // Try to get live quote from SwapAggregator
    var estDisplay = estimate ? fmtUSDC(estimate) : '≈ computing…';
    try {
      var SA = mod('SwapAggregator');
      if (SA && typeof SA.getBestEstimate === 'function') {
        var est = SA.getBestEstimate(fromTok, toTok, parseFloat(amount));
        if (est && est.output) { estDisplay = fmtUSDC(est.output); route = est.route || route; }
      }
    } catch (e) {}

    return '<div class="das-wrap">' +
      '<div class="das-header"><span class="das-icon swap"><i class="ti ti-arrows-exchange"></i></span>' +
      '<div class="das-title-area"><span class="das-op-label">SWAP PROPOSAL</span>' +
      '<span class="das-headline">I found a route for your swap.</span></div>' +
      riskBadge(amount) + '</div>' +
      '<div class="das-body">' +
      '<div class="das-flow">' +
        '<div class="das-flow-item">' +
          '<span class="das-flow-label">From</span>' +
          '<span class="das-flow-value">' + esc(String(amount)) + ' <strong>' + esc(fromTok) + '</strong></span>' +
        '</div>' +
        '<div class="das-flow-arrow"><i class="ti ti-arrow-right"></i></div>' +
        '<div class="das-flow-item">' +
          '<span class="das-flow-label">To</span>' +
          '<span class="das-flow-value teal">≈ ' + estDisplay + ' <strong>' + esc(toTok) + '</strong></span>' +
        '</div>' +
      '</div>' +
      '<div class="das-detail-row"><i class="ti ti-route"></i><span>Route: ' + esc(route) + '</span></div>' +
      '<div class="das-detail-row"><i class="ti ti-world"></i><span>' + esc(network) + '</span></div>' +
      '</div>' +
      '<div class="das-actions">' +
        '<button class="das-btn review" onclick="AgentCapabilityRouter.approve(\'' + propId + '\')"><i class="ti ti-check"></i>Approve & Swap</button>' +
        '<button class="das-btn cancel" onclick="AgentCapabilityRouter.cancel(\'' + propId + '\')"><i class="ti ti-x"></i>Cancel</button>' +
      '</div></div>';
  }

  /* ── BRIDGE PROPOSAL ────────────────────────────────────── */
  function buildBridgeProposal(params, propId) {
    var amount    = params.amount    || '?';
    var token     = params.token     || 'USDC';
    var fromChain = params.fromChain || 'Arc Mainnet';
    var toChain   = params.toChain   || 'Ethereum';

    return '<div class="das-wrap">' +
      '<div class="das-header"><span class="das-icon bridge"><i class="ti ti-topology-star-3"></i></span>' +
      '<div class="das-title-area"><span class="das-op-label">BRIDGE PROPOSAL</span>' +
      '<span class="das-headline">Cross-chain transfer via CCTP v2.</span></div>' +
      riskBadge(amount) + '</div>' +
      '<div class="das-body">' +
      '<div class="das-flow">' +
        '<div class="das-flow-item">' +
          '<span class="das-flow-label">From</span>' +
          '<span class="das-flow-value">' + esc(String(amount)) + ' ' + esc(token) + ' on <strong>' + esc(fromChain) + '</strong></span>' +
        '</div>' +
        '<div class="das-flow-arrow"><i class="ti ti-arrow-right"></i></div>' +
        '<div class="das-flow-item">' +
          '<span class="das-flow-label">To</span>' +
          '<span class="das-flow-value purple"><strong>' + esc(toChain) + '</strong></span>' +
        '</div>' +
      '</div>' +
      '<div class="das-detail-row"><i class="ti ti-route"></i><span>Circle CCTP v2 · Circle attestation</span></div>' +
      '</div>' +
      '<div class="das-actions">' +
        '<button class="das-btn review bridge-btn" onclick="AgentCapabilityRouter.approve(\'' + propId + '\')"><i class="ti ti-check"></i>Approve & Bridge</button>' +
        '<button class="das-btn cancel" onclick="AgentCapabilityRouter.cancel(\'' + propId + '\')"><i class="ti ti-x"></i>Cancel</button>' +
      '</div></div>';
  }

  /* ── SCHEDULE PROPOSAL ──────────────────────────────────── */
  function buildScheduleProposal(params, propId) {
    var amount    = params.amount     || '?';
    var token     = params.token      || 'USDC';
    var freq      = params.recurrence || 'once';
    var addr      = params.address    || '';
    var name      = params.recipientName || '';
    var network   = params.chain || 'Arc Mainnet';
    var freqLabel = { once:'Once',daily:'Daily',weekly:'Weekly',biweekly:'Bi-weekly',monthly:'Monthly' }[freq] || esc(freq);
    var recipient = name ? esc(name) : (addr ? shortAddr(addr) : 'Recipient TBD');

    return '<div class="das-wrap">' +
      '<div class="das-header"><span class="das-icon schedule"><i class="ti ti-calendar-event"></i></span>' +
      '<div class="das-title-area"><span class="das-op-label">SCHEDULE PROPOSAL</span>' +
      '<span class="das-headline">Recurring payment proposal.</span></div>' +
      riskBadge(amount) + '</div>' +
      '<div class="das-body">' +
      '<div class="das-flow">' +
        '<div class="das-flow-item"><span class="das-flow-label">Amount</span><span class="das-flow-value blue">' + esc(String(amount)) + ' <strong>' + esc(token) + '</strong></span></div>' +
        '<div class="das-flow-arrow"><i class="ti ti-arrow-right"></i></div>' +
        '<div class="das-flow-item"><span class="das-flow-label">Recipient</span><span class="das-flow-value">' + esc(recipient) + '</span></div>' +
      '</div>' +
      '<div class="das-detail-row"><i class="ti ti-repeat"></i><span>Frequency: <strong>' + freqLabel + '</strong></span></div>' +
      '<div class="das-detail-row"><i class="ti ti-world"></i><span>' + esc(network) + '</span></div>' +
      '</div>' +
      '<div class="das-actions">' +
        '<button class="das-btn review schedule-btn" onclick="AgentCapabilityRouter.approve(\'' + propId + '\')"><i class="ti ti-check"></i>Approve & Schedule</button>' +
        '<button class="das-btn cancel" onclick="AgentCapabilityRouter.cancel(\'' + propId + '\')"><i class="ti ti-x"></i>Cancel</button>' +
      '</div></div>';
  }

  /* ── BATCH/MULTISEND PROPOSAL ───────────────────────────── */
  function buildBatchProposal(params, propId) {
    var total     = params.amount || '?';
    var token     = params.token  || 'USDC';
    var count     = params.recipientCount || (params.addresses ? params.addresses.length : '?');

    return '<div class="das-wrap">' +
      '<div class="das-header"><span class="das-icon batch"><i class="ti ti-stack"></i></span>' +
      '<div class="das-title-area"><span class="das-op-label">BATCH PAYMENT PROPOSAL</span>' +
      '<span class="das-headline">Multi-recipient payment via MultiSendExecutorV4.</span></div>' +
      riskBadge(total) + '</div>' +
      '<div class="das-body">' +
      '<div class="das-flow">' +
        '<div class="das-flow-item"><span class="das-flow-label">Recipients</span><span class="das-flow-value blue"><strong>' + esc(String(count)) + '</strong></span></div>' +
        '<div class="das-flow-arrow"><i class="ti ti-arrow-right"></i></div>' +
        '<div class="das-flow-item"><span class="das-flow-label">Total</span><span class="das-flow-value green"><strong>' + esc(String(total)) + ' ' + esc(token) + '</strong></span></div>' +
      '</div>' +
      '<div class="das-detail-row"><i class="ti ti-contract"></i><span>MultiSendExecutorV4 · Arc Mainnet</span></div>' +
      '</div>' +
      '<div class="das-actions">' +
        '<button class="das-btn review" onclick="AgentCapabilityRouter.approve(\'' + propId + '\')"><i class="ti ti-check"></i>Approve & Execute Batch</button>' +
        '<button class="das-btn cancel" onclick="AgentCapabilityRouter.cancel(\'' + propId + '\')"><i class="ti ti-x"></i>Cancel</button>' +
      '</div></div>';
  }

  /* ── CROSS-CHAIN PROPOSAL ───────────────────────────────── */
  function buildCrossChainProposal(params, propId) {
    var amount  = params.amount  || '?';
    var token   = params.token   || 'USDC';
    var toChain = params.toChain || 'Ethereum';
    var addr    = params.address || '';

    return '<div class="das-wrap">' +
      '<div class="das-header"><span class="das-icon xchain"><i class="ti ti-world"></i></span>' +
      '<div class="das-title-area"><span class="das-op-label">CROSS-CHAIN PROPOSAL</span>' +
      '<span class="das-headline">Cross-chain payment via CCTP v2.</span></div>' +
      riskBadge(amount) + '</div>' +
      '<div class="das-body">' +
      '<div class="das-flow">' +
        '<div class="das-flow-item"><span class="das-flow-label">Amount</span><span class="das-flow-value blue">' + esc(String(amount)) + ' <strong>' + esc(token) + '</strong></span></div>' +
        '<div class="das-flow-arrow"><i class="ti ti-arrow-right"></i></div>' +
        '<div class="das-flow-item"><span class="das-flow-label">To</span><span class="das-flow-value teal"><strong>' + esc(toChain) + '</strong>' + (addr ? ' · ' + shortAddr(addr) : '') + '</span></div>' +
      '</div>' +
      '</div>' +
      '<div class="das-actions">' +
        '<button class="das-btn review" onclick="AgentCapabilityRouter.approve(\'' + propId + '\')"><i class="ti ti-check"></i>Approve & Send Cross-Chain</button>' +
        '<button class="das-btn cancel" onclick="AgentCapabilityRouter.cancel(\'' + propId + '\')"><i class="ti ti-x"></i>Cancel</button>' +
      '</div></div>';
  }

  /* ── RESULT CARD ────────────────────────────────────────── */
  function buildResultCard(intent, params, txHash, status) {
    var statusColor = status === 'confirmed' ? 'var(--green)' : status === 'failed' ? 'var(--red)' : 'var(--yellow)';
    var statusIcon  = status === 'confirmed' ? 'circle-check' : status === 'failed' ? 'circle-x' : 'clock';
    var statusLabel = status === 'confirmed' ? 'Completed' : status === 'failed' ? 'Failed' : 'Pending';

    var opLabel = {
      SEND_PAYMENT: 'Send', SWAP_EXECUTE: 'Swap', BRIDGE: 'Bridge',
      CREATE_SCHEDULE: 'Schedule', MULTISEND: 'Batch', CROSS_CHAIN: 'Cross-Chain'
    }[intent] || intent;

    var amount  = params.amount || '';
    var token   = params.token  || 'USDC';
    var toToken = params.toToken || null;
    var addr    = params.address || '';

    var summary = '';
    if (toToken) {
      summary = esc(String(amount)) + ' ' + esc(token) + ' → ' + esc(toToken);
    } else if (addr) {
      summary = esc(String(amount)) + ' ' + esc(token) + ' to <code style="font-size:9px">' + shortAddr(addr) + '</code>';
    } else {
      summary = esc(String(amount)) + ' ' + esc(token);
    }

    return '<div class="das-result">' +
      '<div class="das-result-status" style="color:' + statusColor + '">' +
        '<i class="ti ti-' + statusIcon + '"></i> ' + statusLabel +
      '</div>' +
      '<div class="das-result-op">' + esc(opLabel) + '</div>' +
      '<div class="das-result-summary">' + summary + '</div>' +
      (txHash ? '<div class="das-result-tx"><span class="das-tx-label">Transaction</span><code>' + shortAddr(txHash) + '</code>' +
        '<button class="das-tx-copy" onclick="navigator.clipboard&&navigator.clipboard.writeText(\'' + esc(txHash) + '\')" title="Copy hash"><i class="ti ti-copy"></i></button>' +
        '<a class="das-tx-link" href="https://explorer.arc.io/tx/' + esc(txHash) + '" target="_blank" rel="noopener">View <i class="ti ti-external-link"></i></a>' +
      '</div>' : '') +
    '</div>';
  }

  /* ══════════════════════════════════════════════════════════
     MAIN ENTRY — createSurface
     Called from the agent pipeline when a write intent is ready.
     Returns HTML for the proposal card.
     ══════════════════════════════════════════════════════════ */
  function createSurface(intent, params, runtime) {
    runtime = runtime || {};
    var propId = storeProp(intent, params, runtime);
    var canonical = (intent || '').toUpperCase();

    if (canonical === 'SEND_PAYMENT')     return buildSendProposal(params, propId);
    if (canonical === 'SWAP_EXECUTE')     return buildSwapProposal(params, propId);
    if (canonical === 'BRIDGE')           return buildBridgeProposal(params, propId);
    if (canonical === 'CREATE_SCHEDULE')  return buildScheduleProposal(params, propId);
    if (canonical === 'MULTISEND' || canonical === 'MASS_PAYMENT')
                                          return buildBatchProposal(params, propId);
    if (canonical === 'CROSS_CHAIN' || canonical === 'CROSSCHAIN_PAYROLL')
                                          return buildCrossChainProposal(params, propId);
    // Fallback: generic proposal card
    return buildGenericProposal(intent, params, propId);
  }

  function buildGenericProposal(intent, params, propId) {
    var label = esc((intent || '').replace(/_/g, ' ').toLowerCase());
    var amount = params.amount != null ? esc(String(params.amount)) + ' ' + esc(params.token || 'USDC') : '';
    return '<div class="das-wrap">' +
      '<div class="das-header"><span class="das-icon"><i class="ti ti-sparkles"></i></span>' +
      '<div class="das-title-area"><span class="das-op-label">' + label.toUpperCase() + '</span>' +
      '<span class="das-headline">Ready to execute.</span></div>' + riskBadge(params.amount) + '</div>' +
      '<div class="das-body">' + (amount ? '<div class="das-detail-row"><i class="ti ti-coin"></i><span>' + amount + '</span></div>' : '') + '</div>' +
      '<div class="das-actions">' +
        '<button class="das-btn review" onclick="AgentCapabilityRouter.approve(\'' + propId + '\')"><i class="ti ti-check"></i>Approve</button>' +
        '<button class="das-btn cancel" onclick="AgentCapabilityRouter.cancel(\'' + propId + '\')"><i class="ti ti-x"></i>Cancel</button>' +
      '</div></div>';
  }

  /* ══════════════════════════════════════════════════════════
     APPROVE — route to existing execution engine
     ══════════════════════════════════════════════════════════ */
  async function approve(propId) {
    var entry = _proposals[propId];
    if (!entry) {
      // Proposal expired or not found
      _agentReply('<div class="aut-intro" style="color:var(--muted2)"><i class="ti ti-clock" style="margin-right:4px"></i>This proposal has expired. Please try again.</div>');
      return;
    }
    delete _proposals[propId];

    var intent  = entry.intent;
    var params  = entry.params;
    var runtime = entry.runtime || {};

    // Replace the proposal card in the last AI message with a "processing" indicator
    _replaceSurface(propId, '<div class="das-executing"><span class="das-exec-spinner"></span>Executing ' + esc((intent||'').replace(/_/g,' ').toLowerCase()) + '…</div>');

    // Route to the existing executeIntent function
    try {
      var execFn = runtime.executeIntent || (typeof window !== 'undefined' ? window.__autExecuteIntent : null);
      if (typeof execFn !== 'function') {
        // Fallback: open the relevant page and let user complete manually
        _openCapabilityPage(intent, params);
        _agentReply('<div class="das-result"><div class="das-result-status" style="color:var(--yellow)"><i class="ti ti-external-link"></i> Opened</div><div class="das-result-op">' + esc((intent||'').replace(/_/g,' ').toLowerCase()) + '</div><div class="das-result-summary">The relevant page was opened. Complete the operation there.</div></div>');
        return;
      }

      var result = await execFn(intent, params, runtime.msg || '');

      // Post result card
      var C = mod('AutonomaAgentBrain');
      var verification = C ? C.verify({ ok: true, html: result }, { canonical: (intent||'').toLowerCase(), entities: params, isWrite: true }, runtime) : { status: 'pending', transactionHash: null };

      // Replace executing indicator with result
      var txHash = verification ? verification.transactionHash : null;
      var status = verification ? verification.status : 'pending';

      _replaceSurface(propId, buildResultCard(intent, params, txHash, status) + (result || ''));

    } catch (e) {
      _replaceSurface(propId, '<div class="das-result"><div class="das-result-status" style="color:var(--red)"><i class="ti ti-circle-x"></i> Error</div>' +
        '<div class="das-result-summary">' + esc(e && e.message ? e.message.slice(0, 120) : String(e).slice(0, 120)) + '</div></div>');
    }
  }

  function cancel(propId) {
    delete _proposals[propId];
    _replaceSurface(propId, '<div class="das-cancelled"><i class="ti ti-x"></i> Operation cancelled.</div>');
  }

  /* ── Page opener for fallback ─────────────────────────────── */
  function _openCapabilityPage(intent, params) {
    try {
      var pageMap = {
        SEND_PAYMENT: 'send', SWAP_EXECUTE: 'swap', BRIDGE: 'bridge',
        CREATE_SCHEDULE: 'schedule', MULTISEND: 'batch', CROSS_CHAIN: 'xchain',
        CREATE_PAYMENT_LINK: 'links', CREATE_INVOICE: 'invoices'
      };
      var page = pageMap[(intent||'').toUpperCase()];
      if (page && typeof window.showPage === 'function') window.showPage(page);
    } catch (e) {}
  }

  /* ── DOM helpers ──────────────────────────────────────────── */
  function _replaceSurface(propId, html) {
    // Replace the surface element inside the last AI message that contains this propId
    try {
      var msgs = document.querySelectorAll('#aut-messages .aut-msg.ai .aut-msg-body');
      for (var i = msgs.length - 1; i >= 0; i--) {
        var body = msgs[i];
        var wrap = body.querySelector('.das-wrap[data-prop="' + propId + '"], .das-executing[data-prop="' + propId + '"]');
        if (!wrap) {
          // Try finding via button onclick containing propId
          var btns = body.querySelectorAll('[onclick*="' + propId + '"]');
          if (btns.length) { wrap = btns[0].closest('.das-wrap') || btns[0].closest('.das-executing'); }
        }
        if (wrap) {
          var tmp = document.createElement('div');
          tmp.innerHTML = html;
          wrap.parentNode.replaceChild(tmp.firstElementChild || tmp, wrap);
          var c = document.getElementById('aut-messages');
          if (c) c.scrollTop = c.scrollHeight;
          return;
        }
      }
      // Fallback: append as new AI message
      _agentReply(html);
    } catch (e) {}
  }

  function _agentReply(html) {
    try {
      if (typeof window.autUI === 'function') { window.autUI('ai', html); return; }
      var c = document.getElementById('aut-messages');
      if (!c) return;
      var d = document.createElement('div');
      d.className = 'aut-msg ai';
      d.innerHTML = '<div class="aut-msg-avatar"><i class="ti ti-brain"></i></div><div class="aut-msg-body">' + html + '</div>';
      c.appendChild(d);
      c.scrollTop = c.scrollHeight;
    } catch (e) {}
  }

  /* ══════════════════════════════════════════════════════════
     BALANCE READ SURFACE — conversational inline card
     ──────────────────────────────────────────────────────────
     Priority order:
       1. CircleAgent (real Circle Developer Wallet via /api/agent)
       2. Connected personal wallet (secondary, shown separately)
       3. FinancialContext / AutonomaCore world-state snapshot
       4. Connected personal wallet (walletAddress)
     ══════════════════════════════════════════════════════════ */
  async function buildBalanceSurface() {
    var sections = [];

    /* ── 1. Circle Agent Wallet (canonical) ────────────────────── */
    try {
      var CA = mod('CircleAgent');
      if (CA && typeof CA.getBalance === 'function') {
        var circleStatus = null;
        if (typeof CA.getStatus === 'function') {
          try { circleStatus = await CA.getStatus(); } catch (_e) {}
        }
        var circleAddr = circleStatus
          ? (circleStatus.walletAddress || (circleStatus.wallet && circleStatus.wallet.address) || null)
          : (typeof CA.getCachedAddress === 'function' ? CA.getCachedAddress() : null);

        var balData = await CA.getBalance();
        var fmtd = (typeof CA.formatBalance === 'function') ? CA.formatBalance(balData) : {};

        // Also try from status.balances (same endpoint, already loaded)
        if (!Object.keys(fmtd).length && circleStatus && circleStatus.balances) {
          fmtd = CA.formatBalance({ tokenBalances: circleStatus.balances });
        }

        if (Object.keys(fmtd).length || circleAddr) {
          var circleRows = '';
          var circleTotal = 0;
          Object.keys(fmtd).forEach(function (sym) {
            var val = parseFloat(fmtd[sym] || 0);
            circleTotal += val;
            circleRows += '<div class="das-bal-row">' +
              '<span class="das-bal-tok" style="color:var(--blue)">' + esc(sym) + '</span>' +
              '<span class="das-bal-val">$' + fmtUSDC(val) + '</span>' +
            '</div>';
          });
          if (!circleRows) {
            circleRows = '<div style="color:var(--muted2);font-size:10px;padding:4px 0">No token balances yet — Circle Wallet is ready.</div>';
          }
          sections.push(
            '<div class="das-balance" style="border-color:rgba(39,117,202,.35);background:rgba(39,117,202,.05)">' +
              '<div class="das-balance-header" style="color:#2775ca">' +
                '<i class="ti ti-building-bank"></i> Circle Agent Wallet' +
                '<span style="margin-left:auto;font-size:8px;background:rgba(34,197,94,.12);color:var(--green);border-radius:3px;padding:1px 5px;font-weight:600">CANONICAL</span>' +
              '</div>' +
              (circleAddr ? '<div class="das-balance-addr"><code style="font-size:9px">' + esc(circleAddr) + '</code>' +
                '<button onclick="navigator.clipboard&&navigator.clipboard.writeText(\'' + esc(circleAddr) + '\')" style="background:none;border:none;cursor:pointer;color:var(--muted2);font-size:9px;padding:0 3px" title="Copy"><i class="ti ti-copy"></i></button></div>' : '') +
              '<div style="font-size:8.5px;color:var(--muted2);margin-bottom:6px">Arc Mainnet · Circle Developer Wallet</div>' +
              circleRows +
              (circleTotal > 0 ? '<div class="das-balance-total"><span>Total</span><span style="color:var(--green)">$' + fmtUSDC(circleTotal) + '</span></div>' : '') +
            '</div>'
          );
        }
      }
    } catch (e) {}

    /* ── 2. Connected personal wallet ───────────────────────────────
       (Agent EOA / AgentWalletManager removed — Circle Wallet is the
        sole canonical agent identity. The EOA is an internal signer
        and must never appear in the Agent UI.) */
    try {
      var connAddr = (typeof window !== 'undefined') ? window.walletAddress : null;
      if (connAddr && connAddr !== (sections.length ? null : connAddr)) {
        // Only show if it differs from the Circle Wallet address
        var circleCanon = null;
        try {
          var _ca2 = mod('CircleAgent');
          if (_ca2) circleCanon = _ca2.getCachedAddress ? _ca2.getCachedAddress() : null;
        } catch (_) {}
        if (!circleCanon || circleCanon.toLowerCase() !== connAddr.toLowerCase()) {
          sections.push(
            '<div class="das-balance" style="border-color:rgba(6,247,233,.2)">' +
              '<div class="das-balance-header"><i class="ti ti-wallet"></i> Connected Wallet</div>' +
              '<div class="das-balance-addr"><code style="font-size:9px">' + esc(connAddr) + '</code></div>' +
              '<div style="font-size:8.5px;color:var(--muted2);margin-top:4px">Personal wallet · Arc Mainnet</div>' +
              '<div style="font-size:9px;color:var(--muted2);margin-top:6px">For live token balances open the <button onclick="showPage&&showPage(\'unified-balance\')" style="background:none;border:none;color:var(--teal);cursor:pointer;font-size:9px;padding:0">Unified Balance</button> page.</div>' +
            '</div>'
          );
        }
      }
    } catch (e) {}

    /* ── Fallback when nothing loaded ─────────────────────────────── */
    if (!sections.length) {
      sections.push(
        '<div class="das-balance">' +
          '<div class="das-balance-header"><i class="ti ti-wallet"></i> Wallet Balance</div>' +
          '<div style="color:var(--muted2);font-size:10px;padding:4px 0">Connect your wallet or configure the Circle Agent in settings to see balances.</div>' +
        '</div>'
      );
    }

    return '<div style="display:flex;flex-direction:column;gap:10px">' + sections.join('') + '</div>';
  }

  /* ══════════════════════════════════════════════════════════
     PUBLIC API
     ══════════════════════════════════════════════════════════ */
  window.AgentCapabilityRouter = {
    createSurface:    createSurface,
    approve:          approve,
    cancel:           cancel,
    buildResultCard:  buildResultCard,
    buildBalanceSurface: buildBalanceSurface,
    // expose for external override (used in index.html injection)
    _proposals:       _proposals
  };
})();
