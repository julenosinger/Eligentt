/**
 * Elligentt Permission Cards — In-Chat Permit UI Generator
 * Generates interactive HTML cards for permission requests, active permits, and audit logs.
 * Uses the existing R builder pattern for consistency.
 * Attached to window.PermissionCards
 */
(function(){
  'use strict';

  var PE = window.PermitEngine;

  /* ── Icon map per permission type ── */
  var TYPE_ICONS = {
    spend: 'cash', spend_permit: 'cash',
    erc20: 'file-certificate', erc20_permit: 'file-certificate', permit2: 'file-certificate',
    session: 'clock', session_permit: 'clock',
    execution: 'code', contract_execution: 'code', contract: 'code',
    treasury: 'building-bank', treasury_permission: 'building-bank',
    bridge: 'topology-star-3', bridge_permission: 'topology-star-3',
    signature: 'pencil', wallet_signature: 'pencil', sign: 'pencil',
    swap: 'arrows-exchange',
    payment: 'send',
    multisend: 'users-group'
  };

  function typeIcon(type){
    return TYPE_ICONS[type] || 'shield-lock';
  }

  function typeLabel(type){
    var map = {
      spend: 'Spend Permit', spend_permit: 'Spend Permit',
      erc20: 'ERC20 Permit', erc20_permit: 'ERC20 Permit', permit2: 'Permit2',
      session: 'Session Permit', session_permit: 'Session Permit',
      execution: 'Contract Execution', contract_execution: 'Contract Execution', contract: 'Contract Execution',
      treasury: 'Treasury Permission', treasury_permission: 'Treasury Permission',
      bridge: 'Bridge Permission', bridge_permission: 'Bridge Permission',
      signature: 'Wallet Signature', wallet_signature: 'Wallet Signature', sign: 'Wallet Signature',
      swap: 'Swap Permission', payment: 'Payment Permission', multisend: 'MultiSend Permission'
    };
    return map[type] || (type.charAt(0).toUpperCase() + type.slice(1) + ' Permission');
  }

  /* ── Status badge helpers ── */
  function statusBadge(status){
    var map = {
      active: { text: 'Active', cls: 'live' },
      pending: { text: 'Pending', cls: 'pending' },
      revoked: { text: 'Revoked', cls: 'pending' },
      expired: { text: 'Expired', cls: 'pending' },
      depleted: { text: 'Depleted', cls: 'pending' },
      used: { text: 'Used', cls: 'live' }
    };
    var b = map[status] || { text: status, cls: 'pending' };
    return '<span class="aut-rc-badge ' + b.cls + '">' + b.text + '</span>';
  }

  /* ── Row (mirrors R.row) ── */
  function row(label, value, color){
    return '<div class="aut-rc-row"><span class="aut-rl">' + label + '</span><span class="aut-rv' + (color ? ' style="color:var(--' + color + ')"' : '') + '">' + value + '</span></div>';
  }

  function sep(){ return '<div class="aut-rc-sep"></div>'; }

  function section(title){ return '<div class="aut-rc-section">' + title + '</div>'; }

  function card(head, body, actions){
    return '<div class="aut-rc perm-card">' + head + '<div class="aut-rc-body">' + body + '</div>' + (actions || '') + '</div>';
  }

  function head(icon, title, badgeStatus){
    return '<div class="aut-rc-head"><i class="ti ti-' + icon + '"></i><span class="aut-rc-title">' + title + '</span>' + (badgeStatus ? statusBadge(badgeStatus) : '') + '</div>';
  }

  function actions(...btns){
    return '<div class="aut-act-bar">' + btns.map(function(b){
      var dataAttr = b.dataAttrs || '';
      return '<button class="aut-act ' + (b.cls || '') + '" ' + dataAttr + ' onclick="' + b.action + '"><i class="ti ti-' + (b.icon || 'check') + '"></i>' + b.label + '</button>';
    }).join('') + '</div>';
  }

  function chainPill(name, color){
    return '<span class="aut-chain-pill"><span class="dot" style="background:' + (color || '#4f8ef7') + '"></span>' + name + '</span>';
  }

  function intro(text){
    return '<div class="aut-intro">' + text + '</div>';
  }

  /* ── Safe HTML + JS escapers ── */
  function escHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function escJs(s){
    return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'\\"').replace(/\n/g,'\\n').replace(/\r/g,'');
  }

  /* ════════════════════════════════════════════
     PERMISSION REQUEST CARD
     Generated when AI needs authorization
  ════════════════════════════════════════════ */
  function buildRequestCard(opts, permitId){
    var now = Date.now();
    var id = permitId || null;
    var safeType = escHtml(opts.type || 'spend');
    var safeAsset = escHtml(opts.asset || 'USDC');
    var safeDest = escHtml(opts.destination || '*');
    var safeNet = escHtml(opts.network || 'Arc Testnet');
    var safeContract = escHtml(opts.contract || '');
    var safePurpose = escHtml(opts.purpose || '');
    var safeGas = escHtml(opts.estimatedGas || 'N/A');
    var allowedOpsJson = escHtml(JSON.stringify(opts.allowedOps || []));
    var retryPhrase = escHtml(opts._retryPhrase || '');
    var dataAttrs = ' data-ptype="' + safeType + '" data-pamt="' + (opts.maxAmount || 0) + '" data-passet="' + safeAsset + '" data-pdest="' + safeDest + '" data-pnet="' + safeNet + '" data-pcontract="' + safeContract + '" data-pdur="' + (opts.durationMs || 1800000) + '" data-ppurpose="' + safePurpose + '" data-pgas="' + safeGas + '" data-pretry="' + retryPhrase + '"';
    var onApprove = "window._approvePermitEl(this)";
    var onReject = "window._rejectPermit()";

    return intro('<strong style="color:#a78bfa">Autonoma needs your permission</strong> to proceed with this operation.') +
      card(
        head(typeIcon(opts.type), typeLabel(opts.type), 'pending'),
        row('Permission Type', typeLabel(opts.type), 'purple') +
        row('Asset', opts.asset || 'USDC', '') +
        row('Maximum Amount', '<strong style="font-size:13px">' + (opts.maxAmount || 0) + ' ' + (opts.asset || 'USDC') + '</strong>', 'green') +
        (opts.destination && opts.destination !== '*' ? row('Destination Contract', '<code style="font-size:8.5px;color:#06F7E9">' + (opts.destination.length > 12 ? opts.destination.substring(0,10) + '...' : opts.destination) + '</code>', '') : '') +
        row('Network', chainPill(opts.network || 'Arc Testnet', '#4f8ef7'), '') +
        row('Expiration', PE.fmtTimeLeft(now + (opts.durationMs || 1800000)), 'yellow') +
        row('Purpose', (opts.purpose || 'General operation').substring(0, 40), '') +
        row('Estimated Gas', opts.estimatedGas || 'N/A', ''),
        actions(
          { icon: 'check', label: 'Approve', cls: 'confirm', action: onApprove, dataAttrs: dataAttrs },
          { icon: 'x', label: 'Reject', cls: 'danger', action: onReject }
        )
      );
  }

  /* ════════════════════════════════════════════
     ESCALATION CARD
     When current limit is insufficient
  ════════════════════════════════════════════ */
  function buildEscalationCard(currentLimit, required, additional, opts, permit){
    var safeAsset = escHtml(opts.asset || 'USDC');
    var safeType = escHtml(opts.type || 'spend');
    var pid = permit ? escHtml(permit.id) : '';
    var onApproveEsc = "window._approveEscalation('" + pid + "'," + required + ",'" + safeAsset + "','" + safeType + "'," + (opts.durationMs || 1800000) + ")";
    var onRejectEsc = "window._rejectPermit()";

    return intro('<strong style="color:#f59e0b">Limit escalation needed</strong> — the current permit does not cover the full amount.') +
      '<div class="esc-card" style="background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.2);border-radius:10px;padding:12px 14px;margin-top:8px">' +
      '<div style="display:flex;justify-content:space-between;margin-bottom:6px">' +
        '<span style="color:var(--muted2);font-size:10px">Current Limit</span>' +
        '<span style="font-weight:700;color:var(--yellow);font-size:10px">' + currentLimit + ' ' + (opts.asset||'USDC') + '</span>' +
      '</div>' +
      '<div style="display:flex;justify-content:space-between;margin-bottom:6px">' +
        '<span style="color:var(--muted2);font-size:10px">Required</span>' +
        '<span style="font-weight:700;color:#ef4444;font-size:10px">' + required + ' ' + (opts.asset||'USDC') + '</span>' +
      '</div>' +
      '<div style="display:flex;justify-content:space-between;padding-top:6px;border-top:1px solid rgba(245,158,11,.15)">' +
        '<span style="color:var(--muted2);font-size:10px">Need Additional</span>' +
        '<span style="font-weight:700;color:#f59e0b;font-size:12px">' + additional + ' ' + (opts.asset||'USDC') + '</span>' +
      '</div>' +
      '<div style="margin-top:10px;display:flex;gap:6px">' +
        '<button class="aut-act confirm" onclick="' + onApproveEsc + '"><i class="ti ti-check"></i>Approve Additional</button>' +
        '<button class="aut-act danger" onclick="' + onRejectEsc + '"><i class="ti ti-x"></i>Reject</button>' +
      '</div></div>';
  }

  /* ════════════════════════════════════════════
     ACTIVE PERMISSIONS DISPLAY
     Shows all active permits in chat
  ════════════════════════════════════════════ */
  function buildActivePermitsList(){
    var active = PE.getActive();
    if(active.length === 0){
      return intro('No active permissions at the moment.') +
        card(head('shield-off', 'Active Permissions', 'pending'),
          '<div style="font-size:10px;color:var(--muted2);text-align:center;padding:12px">You have no active permissions. When the AI needs authorization, a permission card will appear here.</div>');
    }

    var items = active.map(function(p){
      var remaining = Math.max(0, p.maxAmount - (p.usedAmount || 0));
      var remainingStr = remaining.toFixed(2) + ' ' + p.asset;
      var remainingColor = remaining > 0 ? 'green' : 'yellow';

      return '<div class="perm-active-item" style="background:rgba(0,0,0,.15);border-radius:8px;padding:10px;margin-bottom:6px">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
          '<div style="width:28px;height:28px;border-radius:50%;background:rgba(167,139,250,.15);border:1px solid rgba(167,139,250,.25);display:flex;align-items:center;justify-content:center"><i class="ti ti-' + typeIcon(p.type) + '" style="color:#a78bfa;font-size:12px"></i></div>' +
          '<div style="flex:1"><div style="font-size:10px;font-weight:700;color:var(--text)">' + typeLabel(p.type) + '</div><div style="font-size:8px;color:var(--muted)">' + p.purpose + '</div></div>' +
          statusBadge(p.status) +
        '</div>' +
        row('Asset', p.asset, '') +
        row('Remaining Allowance', '<strong style="color:var(--' + remainingColor + ')">' + remainingStr + '</strong>', remainingColor) +
        row('Expiration', PE.fmtTimeLeft(p.expiresAt), '') +
        row('Allowed Operations', p.allowedOps.length > 0 ? p.allowedOps.join(', ') : 'All', 'teal') +
        row('Last Used', p.lastUsed ? PE.fmtDate(p.lastUsed) : 'Never', '') +
        '<div style="margin-top:8px;display:flex;gap:4px">' +
          '<button class="aut-act danger" onclick="PermitEngine.revoke(\'' + p.id + '\');autonomaSendQuick(\'show permissions\')" style="font-size:8px;padding:3px 8px"><i class="ti ti-x"></i>Revoke</button>' +
        '</div>' +
      '</div>';
    }).join('');

    return intro('Here are your <strong style="color:#a78bfa">Active Permissions</strong>:') +
      '<div style="margin-top:6px">' + items + '</div>' +
      '<div class="aut-act-bar" style="margin-top:6px">' +
        '<button class="aut-act danger" onclick="PermitEngine.revokeAll();autonomaSendQuick(\'show permissions\')"><i class="ti ti-shield-x"></i>Revoke All</button>' +
        '<button class="aut-act" onclick="autonomaSendQuick(\'audit log\')"><i class="ti ti-history"></i>Audit Log</button>' +
      '</div>';
  }

  /* ════════════════════════════════════════════
     AUDIT LOG DISPLAY
  ════════════════════════════════════════════ */
  function buildAuditLog(limit){
    var entries = PE.getAuditLog(limit || 20);
    if(entries.length === 0){
      return intro('No audit log entries yet.') +
        card(head('history', 'Permit Audit Log'),
          '<div style="font-size:10px;color:var(--muted2);text-align:center;padding:12px">The audit log will appear here once permits are used.</div>');
    }

    var items = entries.map(function(e){
      return '<div class="aut-rc-row" style="font-size:9px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.03)">' +
        '<span class="aut-rl" style="flex:1">' + PE.fmtDate(e.timestamp) + '</span>' +
        '<span style="font-weight:600;color:var(--text);min-width:100px;text-align:right">' + e.operation.substring(0, 18) + '</span>' +
        '<span style="font-weight:700;color:var(--green);min-width:70px;text-align:right">' + (e.amount || '') + '</span>' +
        '<span style="font-size:8px;color:var(--muted2);min-width:50px;text-align:right">' + (e.result === 'success' ? '<span style="color:#22c55e">OK</span>' : '<span style="color:#ef4444">FAIL</span>') + '</span>' +
      '</div>';
    }).join('');

    return intro('<strong style="color:#a78bfa">Permit Audit Log</strong> — immutable record of all permit operations.') +
      card(head('history', 'Audit Log', { text: entries.length + ' entries', cls: 'live' }),
        '<div style="font-size:8px;color:var(--muted2);margin-bottom:4px;display:flex;justify-content:space-between"><span>Timestamp</span><span style="min-width:100px;text-align:right">Operation</span><span style="min-width:70px;text-align:right">Amount</span><span style="min-width:50px;text-align:right">Result</span></div>' +
        items,
        actions(
          { icon: 'refresh', label: 'Refresh', cls: '', action: "autonomaSendQuick('audit log')" },
          { icon: 'shield', label: 'Active Permits', cls: 'primary', action: "autonomaSendQuick('show permissions')" }
        ));
  }

  /* ════════════════════════════════════════════
     PERMISSION GRANTED CONFIRMATION
  ════════════════════════════════════════════ */
  function buildGrantedCard(permit){
    var remaining = Math.max(0, permit.maxAmount - (permit.usedAmount || 0));
    return intro('<strong style="color:#22c55e">Permission granted!</strong> The AI can now execute operations within the allowed scope.') +
      card(
        head(typeIcon(permit.type), typeLabel(permit.type), 'live'),
        row('Asset', permit.asset, '') +
        row('Limit', '<strong>' + permit.maxAmount + ' ' + permit.asset + '</strong>', 'green') +
        row('Remaining', remaining.toFixed(2) + ' ' + permit.asset, 'green') +
        row('Expires', PE.fmtTimeLeft(permit.expiresAt), 'yellow') +
        row('Allowed', permit.allowedOps.length > 0 ? permit.allowedOps.join(', ') : 'All operations', 'teal') +
        row('Network', chainPill(permit.network, '#4f8ef7'), ''),
        actions(
          { icon: 'shield-check', label: 'Show All Permits', cls: 'primary', action: "autonomaSendQuick('show permissions')" },
          { icon: 'x', label: 'Revoke', cls: 'danger', action: "PermitEngine.revoke('" + permit.id + "');autonomaSendQuick('show permissions')" }
        )
      );
  }

  /* ════════════════════════════════════════════
     REVOKE CONFIRMATION
  ════════════════════════════════════════════ */
  function buildRevokedCard(count, target){
    return intro('<strong style="color:var(--muted2)">Permissions revoked:</strong> ' + (target || 'All requested')) +
      card(head('shield-x', 'Permissions Revoked'),
        row('Count', count + ' permit(s) revoked', ''),
        row('Status', 'No longer active', 'yellow'),
        actions(
          { icon: 'plus', label: 'New Permit', cls: 'primary', action: "showPage('autonoma')" },
          { icon: 'shield', label: 'Status', cls: '', action: "autonomaSendQuick('show permissions')" }
        ));
  }

  /* ════════════════════════════════════════════
     SESSION WALLET INFO
  ════════════════════════════════════════════ */
  function buildSessionWalletInfo(){
    var addr = PE.getSessionWalletAddress();
    return intro('The <strong style="color:#a78bfa">Agent Session Wallet</strong> is an internal wallet that executes operations on your behalf. Your main wallet only signs permits.') +
      card(head('wallet', 'Session Wallet'),
        row('Address', addr ? '<code style="font-size:8.5px;color:#06F7E9">' + addr.substring(0,10) + '...' + addr.substring(addr.length-6) + '</code>' : 'Not initialized', 'teal') +
        row('Role', 'Transaction executor', '') +
        row('Security', 'Only operations within permit scope are allowed', 'green'),
        actions(
          { icon: 'shield', label: 'View Permits', cls: 'primary', action: "autonomaSendQuick('show permissions')" }
        ));
  }

  /* ── Public approve callback (called from card buttons) ── */
  function safeEscape(s){ return s.replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }

  /* ════════════════════════════════════════════
     EXECUTION PLAN CARD (Phase 1)
  ════════════════════════════════════════════ */
  function buildExecutionPlan(plan){
    if(!plan) return intro('No execution plan available.');
    var stepsHtml = plan.steps.map(function(s,i){
      var label = (window.ExecutionPlanner && window.ExecutionPlanner.STEP_LABELS[s]) || s;
      var icon = (window.ExecutionPlanner && window.ExecutionPlanner.STEP_ICONS[s]) || 'circle';
      var num = '<span style="width:18px;height:18px;border-radius:50%;background:rgba(6,247,233,.12);display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#06F7E9;margin-right:8px;flex-shrink:0">'+(i+1)+'</span>';
      return '<div style="display:flex;align-items:center;padding:3px 0;font-size:10px;color:var(--text)">'+num+'<i class="ti ti-'+icon+'" style="color:'+(i<plan.currentStep?'#22c55e':i===plan.currentStep?'#06F7E9':'var(--muted2)')+';margin-right:6px;font-size:11px"></i>'+label+(i<plan.currentStep?' <span style="color:#22c55e;font-size:9px">&#10003;</span>':'')+'</div>';
    }).join('');

    var riskColor = window.RiskEngine ? window.RiskEngine.riskLevelCSS(plan.riskLevel) : '#f59e0b';

    return intro('<strong style="color:#a78bfa">Execution Plan</strong> — review before approving:') +
      '<div class="aut-rc exec-plan-card" style="border-color:rgba(167,139,250,.25)!important;background:linear-gradient(135deg,rgba(167,139,250,.04),rgba(6,247,233,.02))!important;border-radius:10px;overflow:hidden;margin-top:8px">' +
      '<div class="aut-rc-head" style="background:rgba(167,139,250,.08)!important;border-bottom-color:rgba(167,139,250,.15)!important"><i class="ti ti-clipboard-list" style="color:#a78bfa"></i><span class="aut-rc-title">Execution Plan</span><span class="aut-rc-badge live">New</span></div>' +
      '<div class="aut-rc-body">' +
        row('Goal', '<strong>'+plan.goal+'</strong>', 'purple') + sep() +
        '<div class="aut-rc-section">Execution Steps</div>' +
        '<div style="margin:4px 0">'+stepsHtml+'</div>' + sep() +
        row('Estimated Time', '<strong style="color:#06F7E9">'+plan.estimatedTime+' seconds</strong>', '') +
        row('Estimated Gas', plan.estimatedGas, '') +
        row('Estimated Cost', plan.estimatedCost, 'yellow') +
        row('Risk Level', '<strong style="color:'+riskColor+'">'+plan.riskLevel+'</strong> ('+plan.successProbability+' success)', plan.riskLevel === 'LOW' ? 'green' : plan.riskLevel === 'MEDIUM' ? 'yellow' : 'red') +
      '</div>' +
      '<div class="aut-act-bar">' +
        '<button class="aut-act confirm" onclick="window._approvePlan(\''+plan.id+'\')"><i class="ti ti-check"></i>Approve Plan</button>' +
        '<button class="aut-act danger" onclick="var c=this.closest(\'.aut-msg-body\');if(c)c.innerHTML+=\'<div class=\\\'aut-intro\\\' style=\\\'color:var(--muted2)\\\'><i class=\\\'ti ti-x\\\'></i>Plan cancelled.</div>\';"><i class="ti ti-x"></i>Cancel</button>' +
      '</div></div>';
  }

  /* ════════════════════════════════════════════
     RISK ANALYSIS CARD (Phase 2)
  ════════════════════════════════════════════ */
  function buildRiskAnalysis(risk, operation){
    if(!risk) return '';
    var levelColor = risk.level === 'LOW' ? '#22c55e' : risk.level === 'MEDIUM' ? '#f59e0b' : risk.level === 'HIGH' ? '#f97316' : '#ef4444';
    var levelBg = risk.level === 'LOW' ? 'rgba(34,197,94,.12)' : risk.level === 'MEDIUM' ? 'rgba(245,158,11,.12)' : risk.level === 'HIGH' ? 'rgba(249,115,22,.12)' : 'rgba(239,68,68,.12)';

    var findingsHtml = risk.findings.map(function(f){
      var fc = f.level==='LOW'?'#22c55e':f.level==='MEDIUM'?'#f59e0b':f.level==='HIGH'?'#f97316':'#ef4444';
      return '<div style="display:flex;justify-content:space-between;padding:2px 0;font-size:9px;border-bottom:1px solid rgba(255,255,255,.03)"><span style="color:var(--muted2)">'+f.factor+'</span><span style="font-weight:600;color:'+fc+'">'+f.level+'</span><span style="color:var(--muted);text-align:right;max-width:180px;font-size:8.5px">'+f.detail+'</span></div>';
    }).join('');

    return intro('Risk assessment for this operation:') +
      '<div class="aut-rc" style="border-color:'+levelColor+'44!important;background:linear-gradient(135deg,'+levelBg+',rgba(0,0,0,.02))!important;border-radius:10px;overflow:hidden;margin-top:8px">' +
      '<div class="aut-rc-head" style="background:'+levelBg+'!important;border-bottom-color:'+levelColor+'22!important"><i class="ti ti-shield-check"></i><span class="aut-rc-title">Risk Analysis</span><span class="aut-rc-badge" style="background:'+levelBg+';border:1px solid '+levelColor+'44;color:'+levelColor+'">'+risk.level+'</span></div>' +
      '<div class="aut-rc-body">' +
        row('Operation', '<strong>'+operation+'</strong>', 'purple') +
        row('Risk', '<strong style="color:'+levelColor+';font-size:14px">'+risk.level+'</strong>', '') +
        '<div class="aut-rc-sep"></div>' +
        '<div class="aut-rc-section">Detailed Findings</div>' +
        findingsHtml +
        '<div class="aut-rc-sep"></div>' +
        row('Recommendation', '<strong style="color:'+levelColor+'">'+risk.recommendation+'</strong>', risk.level==='LOW'?'green':'yellow') +
        (risk.requiresExplicitConfirm ? '<div style="margin-top:6px;padding:6px 8px;border-radius:5px;background:rgba(239,68,68,.08);font-size:9px;color:#ef4444"><i class="ti ti-alert-triangle"></i> This risk level requires explicit confirmation even if a valid permit exists.</div>' : '') +
      '</div></div>';
  }

  /* ════════════════════════════════════════════
     EXECUTION PREVIEW CARD (Phase 3)
  ════════════════════════════════════════════ */
  function buildExecutionPreview(plan){
    var stepsHtml = plan.steps.map(function(s){
      var label = (window.ExecutionPlanner && window.ExecutionPlanner.STEP_LABELS[s]) || s;
      return '<div style="display:flex;align-items:center;padding:2px 0;font-size:10px;color:var(--green)"><i class="ti ti-check" style="color:#22c55e;margin-right:6px;font-size:10px"></i>'+label+'</div>';
    }).join('');

    return intro('I will perform:') +
      '<div class="aut-rc" style="border-color:rgba(34,197,94,.25)!important;background:linear-gradient(135deg,rgba(34,197,94,.03),rgba(6,247,233,.01))!important;border-radius:10px;overflow:hidden;margin-top:8px">' +
      '<div class="aut-rc-head" style="background:rgba(34,197,94,.06)!important;border-bottom-color:rgba(34,197,94,.12)!important"><i class="ti ti-list-check"></i><span class="aut-rc-title">Execution Preview</span><span class="aut-rc-badge live">Ready</span></div>' +
      '<div class="aut-rc-body">' +
        '<div style="margin-bottom:6px">'+stepsHtml+'</div>' + sep() +
        row('Estimated completion', '<strong style="color:#06F7E9">~'+plan.estimatedTime+' seconds</strong>', '') +
        row('Expected final balances', 'Verified after execution', 'green') +
        (plan.riskLevel==='HIGH'||plan.riskLevel==='CRITICAL' ? '<div style="margin-top:6px;padding:5px 8px;border-radius:5px;background:rgba(239,68,68,.06);font-size:9px;color:#ef4444"><i class="ti ti-alert-triangle"></i> '+plan.riskLevel+' risk — requires explicit confirmation.</div>' : '') +
      '</div>' +
      '<div class="aut-act-bar">' +
        '<button class="aut-act confirm" onclick="window._executePlan(\''+plan.id+'\')"><i class="ti ti-player-play"></i>Execute Now</button>' +
        '<button class="aut-act danger" onclick="var c=this.closest(\'.aut-msg-body\');if(c)c.innerHTML+=\'<div class=\\\'aut-intro\\\' style=\\\'color:var(--muted2)\\\'><i class=\\\'ti ti-x\\\'></i>Execution cancelled.</div>\';"><i class="ti ti-x"></i>Cancel</button>' +
      '</div></div>';
  }

  /* ════════════════════════════════════════════
     EXECUTION QUEUE CARD (Phase 7)
  ════════════════════════════════════════════ */
  function buildExecutionQueue(){
    if(typeof ExecutionQueue==='undefined') return intro('Queue system initializing...');
    var tasks = ExecutionQueue.getQueue('active');
    if(tasks.length === 0){
      return intro('No active tasks in the execution queue.') +
        card(head('list-check', 'Execution Queue', 'pending'),
          '<div style="font-size:10px;color:var(--muted2);text-align:center;padding:12px">All tasks completed. New tasks will appear here during execution.</div>');
    }
    var items = tasks.map(function(t){
      var sc = ExecutionQueue.statusColor(t.status);
      return '<div class="perm-active-item" style="border-color:'+sc+'22">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
          '<div style="width:22px;height:22px;border-radius:50%;background:'+sc+'22;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:'+sc+'">'+t.id.substr(-3)+'</div>' +
          '<div style="flex:1"><div style="font-size:10px;font-weight:700;color:var(--text)">'+t.operation+'</div><div style="font-size:8px;color:var(--muted)">'+t.chain+'</div></div>' +
          '<span style="font-size:8px;padding:2px 8px;border-radius:10px;background:'+sc+'18;color:'+sc+';font-weight:600;border:1px solid '+sc+'33">'+ExecutionQueue.fmtStatus(t.status)+'</span>' +
        '</div>' +
        row('Amount', t.amount+' '+t.asset, '') +
        row('Started', t.started ? (new Date(t.started)).toLocaleTimeString() : '—', '') +
        row('Elapsed', ExecutionQueue.fmtElapsed(t.elapsed), '') +
        (t.progress > 0 ? row('Progress', '<span style="color:#06F7E9">'+t.progress+'%</span> '+t.progressLabel, 'teal') : '') +
        (t.error ? row('Error', '<span style="color:#ef4444">'+t.error+'</span>', 'red') : '') +
        '<div style="margin-top:6px;display:flex;gap:4px">' +
          (t.status==='failed' ? '<button class="aut-act" onclick="ExecutionQueue.retry(\''+t.id+'\');autonomaSendQuick(\'execution queue\')" style="font-size:8px;padding:3px 8px"><i class="ti ti-refresh"></i>Retry</button>' : '') +
          (t.status!=='running'&&t.status!=='completed' ? '<button class="aut-act danger" onclick="ExecutionQueue.cancel(\''+t.id+'\');autonomaSendQuick(\'execution queue\')" style="font-size:8px;padding:3px 8px"><i class="ti ti-x"></i>Cancel</button>' : '') +
        '</div>' +
      '</div>';
    }).join('');

    return intro('Active <strong style="color:#a78bfa">Execution Queue</strong>:') +
      '<div style="margin-top:6px">'+items+'</div>' +
      '<div class="aut-act-bar" style="margin-top:6px"><button class="aut-act" onclick="autonomaSendQuick(\'execution history\')"><i class="ti ti-history"></i>View History</button></div>';
  }

  /* ════════════════════════════════════════════
     EXECUTION HISTORY CARD (Phase 9)
  ════════════════════════════════════════════ */
  function buildExecutionHistory(filter){
    if(typeof ExecutionHistory==='undefined') return intro('History system initializing...');
    var entries = ExecutionHistory.getHistory(filter, 30);
    var stats = ExecutionHistory.getStats();
    if(entries.length === 0){
      return intro('No execution history yet.') +
        card(head('history', 'Execution History'),
          '<div style="font-size:10px;color:var(--muted2);text-align:center;padding:12px">Completed operations will appear here with execution details and links.</div>');
    }
    var items = entries.map(function(e){
      var rc = e.result==='success'?'#22c55e':'#ef4444';
      return '<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.03);font-size:9px">' +
        '<span style="color:var(--muted2);min-width:80px">'+ExecutionHistory.fmtDate(e.timestamp)+'</span>' +
        '<span style="font-weight:600;color:var(--text);min-width:80px">'+e.operation+'</span>' +
        '<span style="font-weight:700;color:var(--green);min-width:70px;text-align:right">'+(e.amount||0)+' '+e.asset+'</span>' +
        '<span style="color:'+rc+';min-width:50px;text-align:right;font-weight:600">'+e.result+'</span>' +
        '</div>';
    }).join('');

    return intro('You asked about <strong style="color:#a78bfa">execution history</strong>.') +
      card(head('history', 'Execution History', {text: stats.total+' total', cls: 'live'}),
        '<div style="display:flex;gap:12px;margin-bottom:8px">' +
          '<div style="text-align:center"><div style="font-size:16px;font-weight:700;color:#06F7E9">'+stats.today+'</div><div style="font-size:8px;color:var(--muted2)">Today</div></div>' +
          '<div style="text-align:center"><div style="font-size:16px;font-weight:700;color:#a78bfa">'+stats.week+'</div><div style="font-size:8px;color:var(--muted2)">Week</div></div>' +
          '<div style="text-align:center"><div style="font-size:16px;font-weight:700;color:#4f8ef7">'+stats.month+'</div><div style="font-size:8px;color:var(--muted2)">Month</div></div>' +
          '<div style="text-align:center"><div style="font-size:16px;font-weight:700;color:#ef4444">'+stats.failedCount+'</div><div style="font-size:8px;color:var(--muted2)">Failed</div></div>' +
        '</div>' +
        '<div style="font-size:8px;color:var(--muted2);margin-bottom:4px;display:flex;gap:8px"><span style="min-width:80px">Time</span><span style="min-width:80px">Operation</span><span style="min-width:70px;text-align:right">Amount</span><span style="min-width:50px;text-align:right">Result</span></div>' +
        items,
        actions(
          {icon:'refresh',label:'Refresh',cls:'',action:"autonomaSendQuick('execution history')"},
          {icon:'list-check',label:'Execution Queue',cls:'primary',action:"autonomaSendQuick('execution queue')"}
        ));
  }

  /* ════════════════════════════════════════════
     AI RECOMMENDATIONS CARD (Phase 8)
  ════════════════════════════════════════════ */
  function buildRecommendations(recs){
    if(!recs || recs.length === 0) return '';
    var items = recs.map(function(r){
      return '<div class="perm-active-item" style="border-color:rgba(167,139,250,.15)">' +
        '<div style="display:flex;align-items:flex-start;gap:6px">' +
          '<i class="ti ti-bulb" style="color:#f59e0b;font-size:14px;margin-top:2px;flex-shrink:0"></i>' +
          '<div style="flex:1">' +
            '<div style="font-size:10px;color:var(--text);margin-bottom:3px">'+r.text+'</div>' +
            '<div style="font-size:10px;font-weight:600;color:#a78bfa;margin-bottom:6px">'+r.suggestion+'</div>' +
            '<button class="aut-act" onclick="autonomaSendQuick(\''+r.action.replace(/'/g,"\\'")+'\')" style="font-size:8px;padding:3px 8px"><i class="ti ti-check"></i>Let\'s do it</button>' +
          '</div></div></div>';
    }).join('');

    return intro('<strong style="color:#f59e0b">AI Recommendations</strong> — based on your usage patterns:') +
      '<div style="margin-top:6px">'+items+'</div>' +
      '<div style="margin-top:4px;font-size:8px;color:var(--muted2)">I never execute recommendations automatically. Always ask first.</div>';
  }

  /* ════════════════════════════════════════════
     CONDITIONAL PERMIT DISPLAY (Phase 4)
  ════════════════════════════════════════════ */
  function buildConditionalPermitDisplay(permit){
    if(!permit || !permit.conditions) return '';
    var c = permit.conditions;
    return '<div style="margin-top:4px;font-size:9px">' +
      '<div class="aut-rc-section" style="color:#a78bfa">Conditions</div>' +
      (c.windowStart !== undefined ? '<div style="display:flex;justify-content:space-between;font-size:9px"><span style="color:var(--muted2)">Execution Window</span><span style="color:var(--text)">'+c.windowStart+':00–'+c.windowEnd+':00 UTC</span></div>' : '') +
      (c.maxGasUsd !== undefined ? '<div style="display:flex;justify-content:space-between;font-size:9px"><span style="color:var(--muted2)">Max Gas</span><span style="color:var(--text)">$'+c.maxGasUsd+'</span></div>' : '') +
      (c.maxSlippage !== undefined ? '<div style="display:flex;justify-content:space-between;font-size:9px"><span style="color:var(--muted2)">Max Slippage</span><span style="color:var(--text)">'+c.maxSlippage+'%</span></div>' : '') +
      (c.maxBridgeFee !== undefined ? '<div style="display:flex;justify-content:space-between;font-size:9px"><span style="color:var(--muted2)">Max Bridge Fee</span><span style="color:var(--text)">'+c.maxBridgeFee+' '+permit.asset+'</span></div>' : '') +
    '</div>';
  }

  /* ════════════════════════════════════════════
     SCHEDULED PERMITS DISPLAY (Phase 5)
  ════════════════════════════════════════════ */
  function buildScheduledPermitsList(){
    if(typeof PermitEngine==='undefined') return intro('Permission system initializing...');
    var scheds = PermitEngine.getScheduled();
    if(scheds.length === 0){
      return intro('No scheduled permits.') +
        card(head('calendar-event', 'Scheduled Permits'),
          '<div style="font-size:10px;color:var(--muted2);text-align:center;padding:12px">Set up recurring permits for automated operations like weekly payments or monthly bridge.</div>',
          actions({icon:'plus',label:'Create Schedule',cls:'primary',action:"autonomaSendQuick('schedule a daily payment of 100 USDC')"}));
    }
    var items = scheds.map(function(s){
      var due = s.nextExecution <= Date.now();
      return '<div class="perm-active-item" style="border-color:'+(due?'rgba(34,197,94,.3)':'rgba(167,139,250,.15)')+'">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
          '<div style="width:28px;height:28px;border-radius:50%;background:'+(due?'rgba(34,197,94,.15)':'rgba(167,139,250,.15)')+';display:flex;align-items:center;justify-content:center"><i class="ti ti-calendar-event" style="color:'+(due?'#22c55e':'#a78bfa')+';font-size:12px"></i></div>' +
          '<div style="flex:1"><div style="font-size:10px;font-weight:700;color:var(--text)">'+s.name+'</div><div style="font-size:8px;color:var(--muted)">'+PermitEngine.fmtRecurrence(s)+'</div></div>' +
          (due ? '<span style="font-size:8px;padding:2px 8px;border-radius:10px;background:rgba(34,197,94,.12);color:#22c55e;font-weight:600;border:1px solid rgba(34,197,94,.2)">Due</span>' : '') +
        '</div>' +
        row('Operation', s.basePermit.purpose||s.basePermit.type, '') +
        row('Amount', s.basePermit.maxAmount+' '+s.basePermit.asset, 'green') +
        row('Next Execution', due ? '<strong style="color:#22c55e">Now</strong>' : PermitEngine.fmtDate(s.nextExecution), due?'green':'') +
        row('Executed', s.executionCount+' time(s)', '') +
        '<div style="margin-top:6px;display:flex;gap:4px">' +
          (due ? '<button class="aut-act confirm" onclick="PermitEngine.executeScheduled(\''+s.id+'\');autonomaSendQuick(\'scheduled permits\')" style="font-size:8px;padding:3px 8px"><i class="ti ti-player-play"></i>Execute</button>' : '') +
          '<button class="aut-act danger" onclick="PermitEngine.cancelScheduled(\''+s.id+'\');autonomaSendQuick(\'scheduled permits\')" style="font-size:8px;padding:3px 8px"><i class="ti ti-x"></i>Cancel</button>' +
        '</div>' +
      '</div>';
    }).join('');

    return intro('Your <strong style="color:#a78bfa">Scheduled Permits</strong>:') +
      '<div style="margin-top:6px">'+items+'</div>' +
      '<div class="aut-act-bar" style="margin-top:6px"><button class="aut-act" onclick="autonomaSendQuick(\'schedule a weekly payment\')"><i class="ti ti-plus"></i>New Schedule</button></div>';
  }

  /* ════════════════════════════════════════════
     SAFETY CHECK CARD (Phase 11)
  ════════════════════════════════════════════ */
  function buildSafetyCheck(checks){
    var itemsHtml = checks.map(function(c){
      var ic = c.passed ? 'check' : 'x';
      var color = c.passed ? '#22c55e' : '#ef4444';
      var bg = c.passed ? 'rgba(34,197,94,.06)' : 'rgba(239,68,68,.06)';
      return '<div style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:9px;background:'+bg+';border-radius:4px;padding:4px 8px;margin-bottom:2px">' +
        '<i class="ti ti-'+ic+'" style="color:'+color+';font-size:10px;flex-shrink:0"></i><span>'+c.label+'</span>' +
        '</div>';
    }).join('');

    var allPassed = checks.every(function(c){return c.passed;});

    return intro('<strong style="color:'+(allPassed?'#22c55e':'#ef4444')+'">Safety Checks</strong> — pre-execution validation:') +
      '<div style="margin-top:6px">'+itemsHtml+'</div>' +
      (allPassed ? '<div style="margin-top:4px;font-size:9px;color:#22c55e"><i class="ti ti-check"></i> All checks passed — safe to execute.</div>' : '<div style="margin-top:4px;font-size:9px;color:#ef4444"><i class="ti ti-alert-triangle"></i> Some checks failed — execution blocked.</div>');
  }

  /* ── Plan approve/execute callbacks ── */
  window._activePlans = {};
  window._approvePlan = function(planId){
    var plan = window._activePlans[planId];
    if(!plan) return;
    plan.approved = true;
    var c = document.getElementById('aut-messages');
    if(c){
      var lastAi = c.querySelector('.aut-msg.ai:last-child .aut-msg-body');
      if(lastAi){
        lastAi.innerHTML += buildExecutionPreview(plan);
        c.scrollTop = c.scrollHeight;
      }
    }
  };
  window._executePlan = function(planId){
    var plan = window._activePlans[planId];
    if(!plan) return;
    var c = document.getElementById('aut-messages');
    if(c){
      if(typeof ExecutionQueue !== 'undefined'){
        var task = ExecutionQueue.enqueue({type:'workflow',operation:plan.goal,amount:plan.riskDetails.length>0?0:0,asset:'USDC',chain:'Arc Testnet'});
        ExecutionQueue.updateStatus(task.id, 'running', {progress:10,progressLabel:'Starting workflow...'});
      }
      var lastAi = c.querySelector('.aut-msg.ai:last-child .aut-msg-body');
      var steps = plan.steps.map(function(s,i){
        var label = (window.ExecutionPlanner && window.ExecutionPlanner.STEP_LABELS[s]) || s;
        return '<div style="display:flex;align-items:center;padding:2px 0;font-size:10px"><i class="ti ti-check" style="color:#22c55e;margin-right:6px;font-size:10px"></i>'+label+' <span style="color:#22c55e;font-size:8px;margin-left:4px">done</span></div>';
      }).join('');
      if(lastAi){
        lastAi.innerHTML += '<div class="aut-intro" style="color:#22c55e"><i class="ti ti-check"></i> Workflow <strong>"'+plan.goal+'"</strong> executed successfully!</div>' +
          '<div class="aut-result"><div class="aut-result-title"><i class="ti ti-check-circle"></i> Execution Complete</div><div class="aut-result-body">'+steps+'</div></div>';
        c.scrollTop = c.scrollHeight;
      }
      if(typeof ExecutionQueue !== 'undefined'){
        var tasks = ExecutionQueue.getQueue('running');
        for(var i=0;i<tasks.length;i++){ ExecutionQueue.updateStatus(tasks[i].id,'completed',{result:'success'}); }
      }
      if(typeof ExecutionHistory !== 'undefined'){
        ExecutionHistory.recordExecution({operation:plan.goal,amount:plan.riskDetails.length>0?0:0,asset:'USDC',chain:'Arc Testnet',result:'success',displayText:plan.goal});
      }
    }
  };

  window.PermissionCards = {
    buildRequestCard: buildRequestCard,
    buildEscalationCard: buildEscalationCard,
    buildActivePermitsList: buildActivePermitsList,
    buildAuditLog: buildAuditLog,
    buildGrantedCard: buildGrantedCard,
    buildRevokedCard: buildRevokedCard,
    buildSessionWalletInfo: buildSessionWalletInfo,
    // New card types (Phases 1-11)
    buildExecutionPlan: buildExecutionPlan,
    buildRiskAnalysis: buildRiskAnalysis,
    buildExecutionPreview: buildExecutionPreview,
    buildExecutionQueue: buildExecutionQueue,
    buildExecutionHistory: buildExecutionHistory,
    buildRecommendations: buildRecommendations,
    buildConditionalPermitDisplay: buildConditionalPermitDisplay,
    buildScheduledPermitsList: buildScheduledPermitsList,
    buildSafetyCheck: buildSafetyCheck,
    typeLabel: typeLabel,
    typeIcon: typeIcon,
    /* Safe approve wrapper with error handling */
    _safeApprove: function(type, maxAmount, asset, destination, network, allowedOps, contract, durationMs, purpose, estimatedGas){
      try {
        var permit = PE.grant({
          type: type,
          maxAmount: maxAmount,
          asset: asset,
          destination: destination,
          network: network,
          allowedOps: allowedOps || [],
          contract: contract || '',
          durationMs: durationMs || 1800000,
          purpose: purpose
        });
        var c = document.getElementById('aut-messages');
        if(c){
          var lastAi = c.querySelector('.aut-msg.ai:last-child .aut-msg-body');
          if(lastAi){
            lastAi.innerHTML += buildGrantedCard(permit);
            c.scrollTop = c.scrollHeight;
          }
        }
        return permit;
      } catch(e){
        var c = document.getElementById('aut-messages');
        if(c){
          var lastAi = c.querySelector('.aut-msg.ai:last-child .aut-msg-body');
          if(lastAi){
            lastAi.innerHTML += '<div class="aut-intro" style="color:#ef4444">Approve error: ' + (e.message || '') + '</div>';
            c.scrollTop = c.scrollHeight;
          }
        }
      }
    },
    /* Called from approve button in card */
    approve: function(type, maxAmount, asset, destination, network, allowedOps, contract, durationMs, purposeEncoded, estimatedGas){
      var purpose = decodeURIComponent(purposeEncoded || '');
      var permit = PE.grant({
        type: type,
        maxAmount: maxAmount,
        asset: asset,
        destination: destination,
        network: network,
        allowedOps: allowedOps || [],
        contract: contract || '',
        durationMs: durationMs || 1800000,
        purpose: purpose
      });
      /* Replace the card in the chat with the granted confirmation */
      var c = document.getElementById('aut-messages');
      if(c){
        var lastAi = c.querySelector('.aut-msg.ai:last-child .aut-msg-body');
        if(lastAi){
          lastAi.innerHTML += buildGrantedCard(permit);
          c.scrollTop = c.scrollHeight;
        }
      }
      return permit;
    },
    _safeEscalate: function(permitId, newLimit, asset, allowedOps, durationMs){
      try {
        if(permitId){
          PE.increaseLimit(permitId, newLimit);
        } else {
          PE.grant({
            type: 'spend', maxAmount: newLimit, asset: asset || 'USDC',
            allowedOps: allowedOps || [], durationMs: durationMs || 1800000,
            purpose: 'Escalated limit'
          });
        }
        var c = document.getElementById('aut-messages');
        if(c){
          var lastAi = c.querySelector('.aut-msg.ai:last-child .aut-msg-body');
          if(lastAi){
            lastAi.innerHTML += '<div class="aut-intro" style="color:#22c55e"><i class="ti ti-check"></i> Limit increased to <strong>' + newLimit + ' ' + (asset||'USDC') + '</strong>. You can now proceed.</div>';
            c.scrollTop = c.scrollHeight;
          }
        }
      } catch(e){
        var c2 = document.getElementById('aut-messages');
        if(c2){
          var lastAi2 = c2.querySelector('.aut-msg.ai:last-child .aut-msg-body');
          if(lastAi2) lastAi2.innerHTML += '<div class="aut-intro" style="color:#ef4444">Escalate error: ' + (e.message || '') + '</div>';
        }
      }
    },
  };
})();
