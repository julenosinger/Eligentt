/**
 * UB Merchant Financial Hub — additive merchant features for Unified Balance
 * Reads real data from existing Elligentt modules. Never duplicates logic.
 * Attached to window.UBMerchant
 */
(function(){
  'use strict';

  var _rendered = false;
  var _data = {};

  /* ════════════════════════════════════════
     DATA COLLECTORS — read from existing sources
  ════════════════════════════════════════ */
  function collectSchedules() {
    var all = [];
    try {
      if (typeof ScheduleEngine !== 'undefined') all = ScheduleEngine.getAll();
    } catch(e) {}
    var active = all.filter(function(s){ return s.status === 'Active'; });
    var upcoming = active.filter(function(s){ return s.nextRun && new Date(s.nextRun) > Date.now(); });
    var due = active.filter(function(s){ return s.nextRun && new Date(s.nextRun) <= Date.now(); });
    return { all: all, active: active, upcoming: upcoming, due: due };
  }

  function collectInvoices() {
    var list = [];
    try {
      if (typeof invoiceList !== 'undefined') list = invoiceList;
      else {
        var raw = localStorage.getItem('invoices');
        if (raw) list = JSON.parse(raw);
      }
    } catch(e) {}
    var pending = list.filter(function(i){ return i.status === 'Sent' || i.status === 'Pending' || i.status === 'Processing'; });
    var paid = list.filter(function(i){ return i.status === 'Paid' || i.status === 'Confirmed'; });
    var totalPending = pending.reduce(function(s,i){ return s + (parseFloat(i.amount)||0); }, 0);
    return { list: list, pending: pending, paid: paid, totalPending: totalPending };
  }

  function collectPaymentLinks() {
    var links = [];
    try {
      if (typeof Store !== 'undefined') links = Store.load('payment_links', []);
    } catch(e) {}
    var active = links.filter(function(l){ return l.status === 'active' || l.status === 'pending'; });
    var totalActive = active.reduce(function(s,l){ return s + (parseFloat(l.amount)||0); }, 0);
    return { links: links, active: active, totalActive: totalActive };
  }

  function collectTransactionHistory() {
    var txs = [];
    try { if (typeof txHistory !== 'undefined' && Array.isArray(txHistory)) txs = txHistory; } catch(e) {}
    try {
      var bh = JSON.parse(localStorage.getItem('batch_history') || '[]');
      txs = txs.concat(bh);
    } catch(e) {}
    var now = Date.now();
    var today = txs.filter(function(t){ var d = new Date(t.date||t.timestamp||0); return now - d.getTime() < 86400000; });
    var week = txs.filter(function(t){ var d = new Date(t.date||t.timestamp||0); return now - d.getTime() < 604800000; });
    var month = txs.filter(function(t){ var d = new Date(t.date||t.timestamp||0); return now - d.getTime() < 2592000000; });
    var totalSent = month.reduce(function(s,t){ return s + (parseFloat(t.amount||t.totalAmount||0)); }, 0);
    return { txs: txs, today: today, week: week, month: month, totalSent: totalSent, count: month.length };
  }

  function collectVault() {
    var vault = {};
    try {
      if (typeof AIWallet !== 'undefined' && AIWallet._vaultView) {
        var v = AIWallet._vaultView('USDC');
        vault = { locked: v.locked || 0, automation: v.automation || 0, treasury: v.treasury || 0, operational: v.operational || 0 };
      }
    } catch(e) {}
    try {
      var cfg = JSON.parse(localStorage.getItem('elligentt_aiw_vault_v1') || '{}');
      if (cfg.USDC) {
        vault.locked = vault.locked || cfg.USDC.locked || 0;
        vault.automation = vault.automation || cfg.USDC.automation || 0;
        vault.treasury = vault.treasury || cfg.USDC.treasury || 0;
      }
    } catch(e) {}
    return vault;
  }

  function collectGasReserve() {
    try {
      var cfg = JSON.parse(localStorage.getItem('elligentt_aiw_gas_v1') || '{}');
      return cfg.minReserve || 1;
    } catch(e) { return 1; }
  }

  function collectQueue() {
    var q = [];
    try {
      if (typeof ExecutionQueue !== 'undefined' && ExecutionQueue.getItems) q = ExecutionQueue.getItems();
    } catch(e) {}
    return q;
  }

  function collectAgentBalance() {
    try {
      if (UB && UB.state && UB.state.assets) {
        var agent = UB.state.assets.filter(function(a){ return a.chainId === 'Arc Testnet' || a.chainName === 'Arc Testnet'; });
        return agent.reduce(function(s,a){ return s + a.usd; }, 0);
      }
    } catch(e) {}
    return 0;
  }

  function collectContacts() {
    var contacts = {};
    var txs = collectTransactionHistory().txs;
    txs.forEach(function(t){
      var addr = t.to || t.recipient || t.destination || '';
      if (!addr || !/^0x[a-fA-F0-9]{40}$/.test(addr)) return;
      var key = addr.toLowerCase();
      if (!contacts[key]) contacts[key] = { addr: addr, count: 0, total: 0, last: 0 };
      contacts[key].count++;
      contacts[key].total += parseFloat(t.amount||t.totalAmount||0);
      var d = new Date(t.date||t.timestamp||0);
      if (d.getTime() > contacts[key].last) contacts[key].last = d.getTime();
    });
    return Object.values(contacts).sort(function(a,b){ return b.count - a.count; });
  }

  /* ════════════════════════════════════════
     MERCHANT METRICS CALCULATORS
  ════════════════════════════════════════ */
  function calcAvailableToSpend() {
    var scheds = collectSchedules();
    var vault = collectVault();
    var invoices = collectInvoices();
    var links = collectPaymentLinks();
    var txs = collectTransactionHistory();
    var gasReserve = collectGasReserve();

    var totalBalance = (UB && UB.state) ? UB.state.totalUSD : 0;
    var reserved = (vault.locked || 0) + (vault.treasury || 0);
    var outgoingDue = scheds.due.reduce(function(s,sch){ return s + (parseFloat(sch.amount||sch.total||0)); }, 0);
    var outgoingUpcoming = scheds.upcoming.reduce(function(s,sch){ return s + (parseFloat(sch.amount||sch.total||0)); }, 0);
    var receivables = invoices.totalPending + links.totalActive;
    var available = totalBalance - reserved - outgoingUpcoming + receivables;

    return {
      totalBalance: totalBalance,
      reserved: reserved,
      scheduledOutgoing: outgoingDue,
      upcomingOutgoing: outgoingUpcoming,
      receivables: receivables,
      gasReserve: gasReserve,
      available: Math.max(0, available)
    };
  }

  function calcCashFlow() {
    var scheds = collectSchedules();
    var invoices = collectInvoices();
    var now = Date.now();
    var day = 86400000;

    var todayOut = scheds.due.reduce(function(s,sch){ return s + (parseFloat(sch.amount||sch.total||0)); }, 0);
    var tomorrowOut = scheds.upcoming.filter(function(s){ var d = new Date(s.nextRun); return d.getTime() - now < day*2 && d.getTime() - now > day; }).reduce(function(s,sch){ return s + (parseFloat(sch.amount||sch.total||0)); }, 0);
    var weekOut = scheds.upcoming.filter(function(s){ var d = new Date(s.nextRun); return d.getTime() - now < day*7; }).reduce(function(s,sch){ return s + (parseFloat(sch.amount||sch.total||0)); }, 0);
    var monthOut = scheds.upcoming.filter(function(s){ var d = new Date(s.nextRun); return d.getTime() - now < day*30; }).reduce(function(s,sch){ return s + (parseFloat(sch.amount||sch.total||0)); }, 0);
    var receivables = invoices.totalPending + collectPaymentLinks().totalActive;
    var balance = (UB && UB.state) ? UB.state.totalUSD : 0;

    return {
      balance: balance,
      todayOut: todayOut,
      tomorrowOut: tomorrowOut,
      weekOut: weekOut,
      monthOut: monthOut,
      receivables: receivables,
      projected7d: balance - weekOut + receivables,
      projected30d: balance - monthOut + receivables
    };
  }

  function calcMonthlyOverview() {
    var txs = collectTransactionHistory();
    var invoices = collectInvoices();
    var received = invoices.paid.reduce(function(s,i){ return s + (parseFloat(i.amount)||0); }, 0);
    var sent = txs.totalSent;
    return {
      received: received,
      sent: sent,
      netFlow: received - sent,
      totalTx: txs.count,
      avgDaily: txs.count > 0 ? (sent / 30) : 0
    };
  }

  function collectReceivables() {
    var invoices = collectInvoices();
    var links = collectPaymentLinks();
    var items = [];
    invoices.pending.forEach(function(i){
      items.push({ type: 'invoice', id: i.id||'', customer: i.clientName||i.to||'—', amount: parseFloat(i.amount)||0, status: i.status||'Pending', due: i.dueDate||i.createdAt||'', token: i.token||'USDC' });
    });
    links.active.forEach(function(l){
      items.push({ type: 'link', id: l.id||'', customer: l.label||l.name||'—', amount: parseFloat(l.amount)||0, status: l.status||'active', due: l.expiresAt||'', token: l.token||'USDC' });
    });
    return items.slice(0, 15);
  }

  function collectUpcomingPayments() {
    var scheds = collectSchedules();
    var items = [];
    scheds.active.slice(0, 20).forEach(function(s){
      items.push({
        id: s.id, name: s.name, type: s.type, token: s.token||'USDC',
        amount: parseFloat(s.amount||s.total||0),
        recipient: s.address || (s.recipients&&s.recipients[0]?s.recipients[0].addr:''),
        recipients: s.recipients,
        date: s.nextRun, freq: s.freq,
        executor: s.createdBy === 'aiwallet' ? 'Agent Wallet' : (s.createdBy === 'autonoma' ? 'Autonoma' : 'Schedule'),
        status: s.status
      });
    });
    return items;
  }

  /* ════════════════════════════════════════
     RENDER HELPERS
  ════════════════════════════════════════ */
  function card(headHtml, bodyHtml) {
    return '<div class="card" style="animation:fadeIn .3s ease">' + headHtml + '<div class="cb" style="display:flex;flex-direction:column;gap:6px">' + bodyHtml + '</div></div>';
  }

  function ch(icon, title, badge) {
    var b = badge ? '<span style="font-size:8px;margin-left:auto;padding:2px 6px;border-radius:3px;' + (badge.style||'') + '">' + badge.text + '</span>' : '';
    return '<div class="ch"><i class="ti ti-' + icon + '" style="font-size:13px;color:var(--teal)"></i><span class="ct">' + title + '</span>' + b + '</div>';
  }

  function kv(label, value, color) {
    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.03);font-size:9px"><span style="color:var(--muted2)">' + label + '</span><span style="color:' + (color||'var(--text)') + ';font-weight:600;font-family:JetBrains Mono,monospace">' + value + '</span></div>';
  }

  function metricBox(label, value, color, sub) {
    return '<div style="background:rgba(0,0,0,.18);border:1px solid var(--border);border-radius:6px;padding:8px 10px;text-align:center;min-width:80px"><div style="font-size:7px;color:var(--muted2);text-transform:uppercase;letter-spacing:.3px;margin-bottom:3px">' + label + '</div><div style="font-size:14px;font-weight:800;color:' + (color||'var(--text)') + '">' + value + '</div>' + (sub ? '<div style="font-size:7px;color:var(--muted2);margin-top:1px">' + sub + '</div>' : '') + '</div>';
  }

  function pill(text, color, bg) {
    return '<span style="display:inline-block;padding:2px 6px;border-radius:3px;font-size:8px;background:' + (bg||'rgba(6,247,233,.1)') + ';color:' + (color||'#06F7E9') + ';border:1px solid ' + (color||'rgba(6,247,233,.25)') + '">' + text + '</span>';
  }

  function shortAddr(a) {
    if (!a || a.length < 10) return a||'—';
    return a.slice(0,6) + '...' + a.slice(-4);
  }

  function fmtUSD(n) { return '$' + (Number(n)||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
  function fmtDate(iso) {
    if (!iso) return '—';
    try { var d = new Date(iso); return d.toLocaleDateString('en-US',{month:'short',day:'numeric'}) + ' ' + d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}); } catch(e){ return iso; }
  }

  /* ════════════════════════════════════════
     SECTION RENDERERS
  ════════════════════════════════════════ */
  function renderAvailableToSpend() {
    var m = calcAvailableToSpend();
    return card(
      ch('wallet', 'Available to Spend'),
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px">' +
        metricBox('Wallet Balance', fmtUSD(m.totalBalance), 'var(--teal)') +
        metricBox('Reserved', fmtUSD(m.reserved), 'var(--yellow)', 'locked+treasury') +
        metricBox('Scheduled Out', fmtUSD(m.scheduledOutgoing), 'var(--red)', 'due now') +
        metricBox('Receivables', fmtUSD(m.receivables), 'var(--green)', 'pending') +
      '</div>' +
      '<div style="background:rgba(6,247,233,.06);border:1px solid rgba(6,247,233,.15);border-radius:6px;padding:8px 12px;display:flex;justify-content:space-between;align-items:center">' +
        '<span style="font-size:9px;color:var(--muted2)">Available Today</span>' +
        '<span style="font-size:16px;font-weight:800;color:' + (m.available > 0 ? 'var(--green)' : 'var(--red)') + '">' + fmtUSD(m.available) + '</span>' +
      '</div>' +
      '<div style="font-size:8px;color:var(--muted2);margin-top:4px">Formula: Wallet − Reserved − Scheduled + Receivables</div>'
    );
  }

  function renderCashFlow() {
    var f = calcCashFlow();
    return card(
      ch('cash', 'Cash Flow'),
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px">' +
        metricBox('Today Out', fmtUSD(f.todayOut), 'var(--red)') +
        metricBox('Tomorrow', fmtUSD(f.tomorrowOut), 'var(--yellow)') +
        metricBox('7 Days Out', fmtUSD(f.weekOut), 'var(--orange)', 'projected') +
        metricBox('30 Days Out', fmtUSD(f.monthOut), 'var(--purple)', 'projected') +
      '</div>' +
      kv('Current Balance', fmtUSD(f.balance), 'var(--teal)') +
      kv('Receivables', fmtUSD(f.receivables), 'var(--green)') +
      kv('Projected (7 days)', fmtUSD(f.projected7d), f.projected7d >= 0 ? 'var(--green)' : 'var(--red)') +
      kv('Projected (30 days)', fmtUSD(f.projected30d), f.projected30d >= 0 ? 'var(--green)' : 'var(--red)')
    );
  }

  function renderReceivables() {
    var items = collectReceivables();
    if (!items.length) return card(ch('file-invoice', 'Pending Receivables'), '<div style="text-align:center;color:var(--muted2);font-size:9.5px;padding:12px">No pending receivables</div>');
    var total = items.reduce(function(s,i){ return s + i.amount; }, 0);
    var rows = items.slice(0, 8).map(function(r){
      var icon = r.type === 'invoice' ? 'file-invoice' : 'link';
      var color = r.status === 'Pending' || r.status === 'active' ? 'var(--yellow)' : 'var(--muted2)';
      return '<div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.03);font-size:8.5px">' +
        '<i class="ti ti-' + icon + '" style="color:' + color + ';font-size:10px;width:14px;text-align:center"></i>' +
        '<span style="flex:1;color:var(--text)">' + (r.customer||'—') + '</span>' +
        '<span style="color:' + color + '">' + r.status + '</span>' +
        '<span style="color:var(--text);font-weight:600;min-width:50px;text-align:right">' + fmtUSD(r.amount) + '</span>' +
        '<span style="color:var(--muted2);font-size:7.5px;min-width:55px;text-align:right">' + fmtDate(r.due) + '</span>' +
      '</div>';
    }).join('');
    return card(
      ch('file-invoice', 'Pending Receivables', {text: items.length + ' items · ' + fmtUSD(total), style: 'color:var(--yellow);background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.2)'}),
      rows
    );
  }

  function renderUpcomingPayments() {
    var items = collectUpcomingPayments();
    if (!items.length) return card(ch('calendar-event', 'Upcoming Payments'), '<div style="text-align:center;color:var(--muted2);font-size:9.5px;padding:12px">No upcoming payments</div>');
    var total = items.reduce(function(s,i){ return s + i.amount; }, 0);
    var rows = items.slice(0, 10).map(function(p){
      var typeIcon = p.type === 'multisend' ? 'stack' : p.type === 'swap' ? 'arrows-exchange' : p.type === 'bridge' || p.type === 'crosschain' ? 'topology-star-3' : 'send';
      var statusColor = p.status === 'Active' ? 'var(--green)' : 'var(--yellow)';
      return '<div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.03);font-size:8.5px">' +
        '<i class="ti ti-' + typeIcon + '" style="color:var(--muted2);font-size:10px;width:14px;text-align:center"></i>' +
        '<span style="flex:1;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (p.name||p.type) + '</span>' +
        '<span style="color:var(--muted2);font-size:7.5px">' + p.freq + '</span>' +
        '<span style="color:var(--text);font-weight:600;min-width:55px;text-align:right">' + fmtUSD(p.amount) + ' ' + p.token + '</span>' +
        '<span style="color:var(--muted2);font-size:7.5px;min-width:55px;text-align:right">' + fmtDate(p.date) + '</span>' +
        '<span style="color:' + statusColor + ';font-size:7px;min-width:45px;text-align:right">' + p.executor + '</span>' +
      '</div>';
    }).join('');
    return card(
      ch('calendar-event', 'Upcoming Payments', {text: items.length + ' scheduled · ' + fmtUSD(total), style: 'color:var(--blue);background:rgba(79,142,247,.1);border:1px solid rgba(79,142,247,.2)'}),
      rows
    );
  }

  function renderQuickActions() {
    // Send / Swap / Move open the matching MODE inside the Screen Live (never
    // navigate away). Other actions keep their existing page navigation.
    function mode(m) {
      return "try{if(typeof enterUnifiedBalanceMode==='function'){enterUnifiedBalanceMode('" + m + "');}}catch(e){}";
    }
    function page(p) {
      return "showPage('" + p + "')";
    }
    return card(
      ch('bolt', 'Quick Actions'),
      '<div style="display:flex;flex-wrap:wrap;gap:6px">' +
        '<button class="btn teal" onclick="' + mode('send') + '" style="font-size:8.5px;padding:5px 10px"><i class="ti ti-send"></i>Send</button>' +
        '<button class="btn purple" onclick="' + mode('swap') + '" style="font-size:8.5px;padding:5px 10px;color:var(--purple);border-color:rgba(167,139,250,.25)"><i class="ti ti-arrows-exchange"></i>Swap</button>' +
        '<button class="btn" onclick="' + mode('move') + '" style="font-size:8.5px;padding:5px 10px;color:var(--teal);border-color:rgba(45,212,191,.25)"><i class="ti ti-topology-star-3"></i>Move</button>' +
        '<button class="btn" onclick="' + page('batch') + '" style="font-size:8.5px;padding:5px 10px;color:var(--yellow);border-color:rgba(245,158,11,.25)"><i class="ti ti-stack"></i>Batch</button>' +
        '<button class="btn" onclick="' + page('bridge') + '" style="font-size:8.5px;padding:5px 10px;color:var(--blue);border-color:rgba(79,142,247,.25)"><i class="ti ti-world-share"></i>Bridge</button>' +
        '<button class="btn" onclick="showPage(\'links\')" style="font-size:8.5px;padding:5px 10px;color:var(--blue);border-color:rgba(79,142,247,.25)"><i class="ti ti-link"></i>Payment Link</button>' +
        '<button class="btn" onclick="showPage(\'invoices\')" style="font-size:8.5px;padding:5px 10px;color:#f59e0b;border-color:rgba(245,158,11,.25)"><i class="ti ti-file-invoice"></i>Invoice</button>' +
        '<button class="btn" onclick="showPage(\'schedule\')" style="font-size:8.5px;padding:5px 10px;color:var(--purple);border-color:rgba(167,139,250,.25)"><i class="ti ti-calendar-event"></i>Schedule</button>' +
        '<button class="btn" onclick="showPage(\'reports\')" style="font-size:8.5px;padding:5px 10px"><i class="ti ti-download"></i>Export</button>' +
        '<button class="btn" onclick="showPage(\'recipients\')" style="font-size:8.5px;padding:5px 10px;color:var(--teal);border-color:rgba(45,212,191,.25)"><i class="ti ti-users"></i>Contacts</button>' +
      '</div>'
    );
  }

  function renderMonthlyOverview() {
    var m = calcMonthlyOverview();
    return card(
      ch('chart-bar', 'Monthly Overview'),
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:4px">' +
        metricBox('Received', fmtUSD(m.received), 'var(--green)') +
        metricBox('Sent', fmtUSD(m.sent), 'var(--red)') +
        metricBox('Net Flow', fmtUSD(m.netFlow), m.netFlow >= 0 ? 'var(--green)' : 'var(--red)') +
        metricBox('Tx Count', String(m.totalTx), 'var(--blue)') +
        metricBox('Avg Daily', fmtUSD(m.avgDaily), 'var(--muted2)') +
      '</div>'
    );
  }

  function renderFundAllocation() {
    var vault = collectVault();
    var gasReserve = collectGasReserve();
    var balance = (UB && UB.state) ? UB.state.totalUSD : 0;
    var operational = Math.max(0, balance - (vault.locked||0) - (vault.automation||0) - (vault.treasury||0) - gasReserve);
    var total = balance || 1;
    return card(
      ch('chart-donut-3', 'Fund Allocation'),
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:4px">' +
        metricBox('Operational', fmtUSD(operational), 'var(--green)', (total > 0 ? Math.round(operational/total*100) : 0) + '%') +
        metricBox('Locked', fmtUSD(vault.locked||0), 'var(--red)', (total > 0 ? Math.round((vault.locked||0)/total*100) : 0) + '%') +
        metricBox('Automation', fmtUSD(vault.automation||0), 'var(--purple)', (total > 0 ? Math.round((vault.automation||0)/total*100) : 0) + '%') +
        metricBox('Treasury', fmtUSD(vault.treasury||0), 'var(--blue)', (total > 0 ? Math.round((vault.treasury||0)/total*100) : 0) + '%') +
        metricBox('Gas Reserve', fmtUSD(gasReserve), 'var(--yellow)', '') +
      '</div>'
    );
  }

  function renderContacts() {
    var contacts = collectContacts();
    if (!contacts.length) return card(ch('users', 'Recent Contacts'), '<div style="text-align:center;color:var(--muted2);font-size:9.5px;padding:12px">No recent contacts</div>');
    var rows = contacts.slice(0, 8).map(function(c){
      return '<div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.03);font-size:8.5px">' +
        '<span style="width:18px;height:18px;border-radius:50%;background:rgba(167,139,250,.15);display:flex;align-items:center;justify-content:center;font-size:7px;color:#a78bfa;flex-shrink:0">' + c.addr.slice(2,4).toUpperCase() + '</span>' +
        '<span style="flex:1;color:var(--text);font-family:JetBrains Mono,monospace">' + shortAddr(c.addr) + '</span>' +
        '<span style="color:var(--muted2);font-size:7.5px">' + c.count + ' tx</span>' +
        '<span style="color:var(--teal);font-weight:600;min-width:45px;text-align:right">' + fmtUSD(c.total) + '</span>' +
        '<span style="color:var(--muted2);font-size:7px;min-width:45px;text-align:right">' + (c.last ? fmtDate(new Date(c.last).toISOString()) : '—') + '</span>' +
      '</div>';
    }).join('');
    return card(
      ch('users', 'Recent Contacts', {text: contacts.length + ' unique', style: 'color:var(--purple);background:rgba(167,139,250,.1);border:1px solid rgba(167,139,250,.2)'}),
      rows
    );
  }

  function renderCustomerDirectory() {
    var invoices = collectInvoices();
    var links = collectPaymentLinks();
    var customers = {};
    invoices.list.forEach(function(i){
      var key = (i.clientName||i.to||'').toLowerCase().trim();
      if (!key) return;
      if (!customers[key]) customers[key] = { name: i.clientName||i.to, received: 0, count: 0, last: 0 };
      if (i.status === 'Paid' || i.status === 'Confirmed') customers[key].received += parseFloat(i.amount)||0;
      customers[key].count++;
      var d = new Date(i.createdAt||i.date||0);
      if (d.getTime() > customers[key].last) customers[key].last = d.getTime();
    });
    var list = Object.values(customers).sort(function(a,b){ return b.received - a.received; });
    if (!list.length) return card(ch('address-book', 'Customer Directory'), '<div style="text-align:center;color:var(--muted2);font-size:9.5px;padding:12px">No customer data yet</div>');
    var rows = list.slice(0, 8).map(function(c){
      return '<div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.03);font-size:8.5px">' +
        '<span style="flex:1;color:var(--text)">' + (c.name||'—') + '</span>' +
        '<span style="color:var(--muted2);font-size:7.5px">' + c.count + ' inv</span>' +
        '<span style="color:var(--green);font-weight:600;min-width:50px;text-align:right">' + fmtUSD(c.received) + '</span>' +
        '<span style="color:var(--muted2);font-size:7px;min-width:45px;text-align:right">' + (c.last ? fmtDate(new Date(c.last).toISOString()) : '—') + '</span>' +
      '</div>';
    }).join('');
    return card(
      ch('address-book', 'Customer Directory'),
      rows
    );
  }

  function renderFinancialSummary() {
    var m = calcMonthlyOverview();
    var scheds = collectSchedules();
    var scheduledTotal = scheds.active.reduce(function(s,sch){ return s + (parseFloat(sch.amount||sch.total||0)); }, 0);
    return card(
      ch('report', 'Financial Summary'),
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:4px">' +
        metricBox('Income (30d)', fmtUSD(m.received), 'var(--green)') +
        metricBox('Expenses (30d)', fmtUSD(m.sent), 'var(--red)') +
        metricBox('Net Profit', fmtUSD(m.received - m.sent), (m.received - m.sent) >= 0 ? 'var(--green)' : 'var(--red)') +
        metricBox('Scheduled Liabilities', fmtUSD(scheduledTotal), 'var(--yellow)') +
        metricBox('Avg Monthly Income', fmtUSD(m.received), 'var(--teal)') +
        metricBox('Avg Monthly Expenses', fmtUSD(m.sent), 'var(--red)') +
      '</div>'
    );
  }

  function renderReservedMoney() {
    var scheds = collectSchedules();
    var vault = collectVault();
    var now = Date.now();
    var day = 86400000;

    var reservedToday = scheds.due.reduce(function(s,sch){ return s + (parseFloat(sch.amount||sch.total||0)); }, 0);
    var reservedTomorrow = scheds.upcoming.filter(function(s){ var d = new Date(s.nextRun); return d.getTime() - now < day*2 && d.getTime() - now > day; }).reduce(function(s,sch){ return s + (parseFloat(sch.amount||sch.total||0)); }, 0);
    var reservedWeek = scheds.upcoming.filter(function(s){ var d = new Date(s.nextRun); return d.getTime() - now < day*7; }).reduce(function(s,sch){ return s + (parseFloat(sch.amount||sch.total||0)); }, 0);
    var reservedMonth = scheds.upcoming.filter(function(s){ var d = new Date(s.nextRun); return d.getTime() - now < day*30; }).reduce(function(s,sch){ return s + (parseFloat(sch.amount||sch.total||0)); }, 0);

    return card(
      ch('lock', 'Reserved Funds'),
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:4px">' +
        metricBox('Today', fmtUSD(reservedToday + (vault.locked||0)), 'var(--red)') +
        metricBox('Tomorrow', fmtUSD(reservedTomorrow), 'var(--yellow)') +
        metricBox('This Week', fmtUSD(reservedWeek), 'var(--orange)') +
        metricBox('This Month', fmtUSD(reservedMonth), 'var(--purple)') +
      '</div>' +
      '<div style="font-size:8px;color:var(--muted2)">Derived from scheduled payments, vault locks, and pending obligations</div>'
    );
  }

  function renderNetworkBreakdown() {
    var assets = (UB && UB.state) ? UB.state.assets : [];
    if (!assets.length) return card(ch('world', 'Network Breakdown'), '<div style="text-align:center;color:var(--muted2);font-size:9.5px;padding:12px">Connect wallet to view</div>');
    var chains = {};
    assets.forEach(function(a){
      var key = a.chainName || a.chainId || 'Unknown';
      if (!chains[key]) chains[key] = { name: key, usd: 0, tokens: 0 };
      chains[key].usd += a.usd;
      chains[key].tokens++;
    });
    var total = UB.state.totalUSD || 1;
    var rows = Object.values(chains).map(function(c){
      var pct = Math.round(c.usd / total * 100);
      return '<div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.03);font-size:9px">' +
        '<span style="width:8px;height:8px;border-radius:50%;flex-shrink:0;background:' + (c.name.toLowerCase().indexOf('arc') !== -1 ? '#ff0202' : c.name.toLowerCase().indexOf('base') !== -1 ? '#0052ff' : c.name.toLowerCase().indexOf('arbitrum') !== -1 ? '#28a0f0' : c.name.toLowerCase().indexOf('ethereum') !== -1 ? '#627eea' : c.name.toLowerCase().indexOf('optimism') !== -1 ? '#ff0420' : c.name.toLowerCase().indexOf('polygon') !== -1 ? '#8247e5' : '#888') + '"></span>' +
        '<span style="flex:1;color:var(--text)">' + c.name + '</span>' +
        '<span style="color:var(--muted2);font-size:8px">' + c.tokens + ' tokens</span>' +
        '<span style="color:var(--teal);font-weight:600;min-width:50px;text-align:right">' + fmtUSD(c.usd) + '</span>' +
        '<span style="display:inline-block;width:40px;height:3px;background:rgba(255,255,255,.08);border-radius:2px;overflow:hidden"><span style="display:block;width:' + pct + '%;height:100%;background:var(--teal);border-radius:2px"></span></span>' +
      '</div>';
    }).join('');
    return card(ch('world', 'Network Breakdown'), rows);
  }

  function renderBusinessHealth() {
    var vault = collectVault();
    var scheds = collectSchedules();
    var invoices = collectInvoices();
    var links = collectPaymentLinks();
    var balance = (UB && UB.state) ? UB.state.totalUSD : 0;
    var healthScore = 0;
    if (balance > 0) healthScore += 25;
    if (invoices.totalPending > 0) healthScore += 15;
    if (scheds.active.length > 0) healthScore += 10;
    if ((vault.treasury||0) > 0) healthScore += 15;
    if (links.active.length > 0) healthScore += 10;
    healthScore = Math.min(100, healthScore + 25);

    var grade = healthScore >= 80 ? 'A' : healthScore >= 60 ? 'B' : healthScore >= 40 ? 'C' : healthScore >= 20 ? 'D' : 'F';
    var gradeColor = healthScore >= 80 ? 'var(--green)' : healthScore >= 60 ? 'var(--teal)' : healthScore >= 40 ? 'var(--yellow)' : healthScore >= 20 ? 'var(--orange)' : 'var(--red)';

    return card(
      ch('heartbeat', 'Business Health'),
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">' +
        '<div style="width:48px;height:48px;border-radius:50%;border:3px solid ' + gradeColor + ';display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:' + gradeColor + '">' + grade + '</div>' +
        '<div><div style="font-size:12px;font-weight:700;color:var(--text)">Score: ' + healthScore + '/100</div><div style="font-size:8px;color:var(--muted2)">Based on: liquidity, obligations, receivables, treasury</div></div>' +
      '</div>' +
      kv('Liquidity (Balance)', fmtUSD(balance), balance > 0 ? 'var(--green)' : 'var(--red)') +
      kv('Upcoming Obligations', String(scheds.active.length) + ' schedules', scheds.due.length > 0 ? 'var(--yellow)' : 'var(--green)') +
      kv('Pending Receivables', String(invoices.pending.length + links.active.length) + ' items', invoices.totalPending > 0 ? 'var(--teal)' : 'var(--muted2)') +
      kv('Treasury Status', (vault.treasury||0) > 0 ? 'Active' : 'Empty', (vault.treasury||0) > 0 ? 'var(--green)' : 'var(--muted2)') +
      kv('Automation', (vault.automation||0) > 0 ? fmtUSD(vault.automation) + ' allocated' : 'Inactive', (vault.automation||0) > 0 ? 'var(--purple)' : 'var(--muted2)')
    );
  }

  function renderExports() {
    return card(
      ch('download', 'Export Financial Statements'),
      '<div style="display:flex;flex-wrap:wrap;gap:6px">' +
        '<button class="btn" onclick="UBMerchant.exportCSV()" style="font-size:8.5px;padding:5px 10px"><i class="ti ti-file-type-csv"></i>CSV</button>' +
        '<button class="btn" onclick="UBMerchant.exportJSON()" style="font-size:8.5px;padding:5px 10px"><i class="ti ti-file-type-json"></i>JSON</button>' +
      '</div>'
    );
  }

  /* ════════════════════════════════════════
     MAIN RENDER — three zones:
       1. #ub-financial-center  (inside Screen Live) — financial command center
       2. #ub-quick-actions     (immediately after Screen Live)
       3. #ub-merchant-hub      (below Assets) — extended merchant features
  ════════════════════════════════════════ */
  function renderFinancialCenter() {
    var html = '';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' + renderCashFlow() + renderReservedMoney() + '</div>';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' + renderMonthlyOverview() + renderFinancialSummary() + '</div>';
    return html;
  }

  function renderExtendedHub() {
    var html = '';
    html += renderAvailableToSpend();
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' + renderReceivables() + renderUpcomingPayments() + '</div>';
    html += renderFundAllocation();
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' + renderContacts() + renderCustomerDirectory() + '</div>';
    html += renderNetworkBreakdown();
    html += renderBusinessHealth();
    html += renderExports();
    return html;
  }

  function renderAll() {
    var qa = document.getElementById('ub-quick-actions');
    var hub = document.getElementById('ub-merchant-hub');

    if (!(UB && UB.state && UB.state.assets && UB.state.assets.length)) {
      if (hub) hub.style.display = 'none';
      if (qa) qa.style.display = 'none';
      return;
    }

    if (qa) { qa.innerHTML = renderQuickActions(); qa.style.display = 'block'; }
    if (hub) { hub.innerHTML = renderExtendedHub(); hub.style.display = 'flex'; }

    _rendered = true;
  }

  /* ════════════════════════════════════════
     EXPORT FUNCTIONS
  ════════════════════════════════════════ */
  function exportCSV() {
    try {
      var rows = [['Label','Amount (USD)']];
      var ats = calcAvailableToSpend();
      rows.push(['Wallet Balance', String(ats.totalBalance)]);
      rows.push(['Reserved Funds', String(ats.reserved)]);
      rows.push(['Scheduled Outgoing', String(ats.scheduledOutgoing)]);
      rows.push(['Pending Receivables', String(ats.receivables)]);
      rows.push(['Available Today', String(ats.available)]);
      var csv = rows.map(function(r){ return r.join(','); }).join('\n');
      var blob = new Blob([csv], {type: 'text/csv'});
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a'); a.href = url; a.download = 'elligentt_merchant_' + new Date().toISOString().slice(0,10) + '.csv';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      try { if (typeof toast === 'function') toast('CSV exported', 'success'); } catch(e) {}
    } catch(e) { try { if (typeof toast === 'function') toast('Export failed', 'error'); } catch(e2) {} }
  }

  function exportJSON() {
    try {
      var data = {
        exportDate: new Date().toISOString(),
        availableToSpend: calcAvailableToSpend(),
        cashFlow: calcCashFlow(),
        monthlyOverview: calcMonthlyOverview(),
        receivables: collectReceivables(),
        upcomingPayments: collectUpcomingPayments(),
        fundAllocation: collectVault(),
        contacts: collectContacts().slice(0, 20),
        networkBreakdown: (function(){
          var assets = (UB && UB.state) ? UB.state.assets : [];
          var chains = {};
          assets.forEach(function(a){ var k = a.chainName||a.chainId; chains[k] = (chains[k]||0) + a.usd; });
          return chains;
        })()
      };
      var json = JSON.stringify(data, null, 2);
      var blob = new Blob([json], {type: 'application/json'});
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a'); a.href = url; a.download = 'elligentt_merchant_' + new Date().toISOString().slice(0,10) + '.json';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      try { if (typeof toast === 'function') toast('JSON exported', 'success'); } catch(e) {}
    } catch(e) { try { if (typeof toast === 'function') toast('Export failed', 'error'); } catch(e2) {} }
  }

  /* ════════════════════════════════════════
     HOOK INTO ubRenderAll — surgically extend
  ════════════════════════════════════════ */
  function hook() {
    if (typeof ubRenderAll !== 'function') { setTimeout(hook, 500); return; }
    var _prev = ubRenderAll;
    ubRenderAll = function() {
      _prev();
      try { renderAll(); } catch(e) {}
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function(){ setTimeout(hook, 1000); });
  } else {
    setTimeout(hook, 1000);
  }

  /* ════════════════════════════════════════
     EXPORTS
  ════════════════════════════════════════ */
  var API = {
    renderAll: renderAll,
    calcAvailableToSpend: calcAvailableToSpend,
    calcCashFlow: calcCashFlow,
    collectReceivables: collectReceivables,
    collectUpcomingPayments: collectUpcomingPayments,
    collectContacts: collectContacts,
    exportCSV: exportCSV,
    exportJSON: exportJSON,
    version: '1.0.0'
  };

  if (typeof window !== 'undefined') window.UBMerchant = API;
  else if (typeof globalThis !== 'undefined') globalThis.UBMerchant = API;
})();