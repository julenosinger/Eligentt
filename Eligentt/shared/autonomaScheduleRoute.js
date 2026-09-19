/**
 * Elligentt Autonoma Schedule Routing — Minimal
 * Routes mass/cross-chain from Autonoma chat to Schedule Engine.
 */
(function(){
  'use strict';
  var _installed = false;

  function _createScheduleEntries(recipients, token, network, toNetwork) {
    if (typeof ScheduleEngine === 'undefined') return 0;
    var now = new Date().toISOString(), created = 0;
    for (var i = 0; i < recipients.length; i++) {
      var r = recipients[i];
      if (!r.addr || !r.amount) continue;
      try {
        ScheduleEngine.create({
          type: toNetwork ? 'crosschain' : 'multisend',
          name: 'Payment to ' + r.addr.slice(0,6) + '...',
          token: token || 'USDC', amount: r.amount, total: r.amount,
          network: network || 'Arc_Testnet', fromNetwork: 'Arc_Testnet',
          toNetwork: toNetwork || network || 'Arc_Testnet',
          recipients: [{ addr: r.addr, amount: r.amount }], address: r.addr,
          freq: 'once', maxEx: 1, gas: 0.10, nextRun: now,
          execCount: 0, executionHistory: [], status: 'Active', created: now,
          createdBy: 'autonoma', agentExecution: true,
          walletAddress: typeof walletAddress !== 'undefined' ? walletAddress : ''
        });
        created++;
      } catch(e) {}
    }
    return created;
  }

  function install() {
    if (_installed) return;
    var retries = 0;
    function tryInstall() {
      retries++;
      var ok = 0;

      if (typeof window._handleMassPayment === 'function' && !window.__massSchedPatched) {
        var _m = window._handleMassPayment;
        window._handleMassPayment = function(p, msg) {
          var recipients = [], token = 'USDC', amt = p.amount || 0;
          var m = msg.match(/\b(\d+(?:\.\d+)?)\s*(usdc|eurc|cirbtc)?\s*(?:each|cada|per)\b/i);
          if (m) { amt = parseFloat(m[1]); token = m[2] ? m[2].toUpperCase() : 'USDC'; }
          if (token === 'CIRBTC') token = 'cirBTC';
          var addrs = msg.match(/0x[a-fA-F0-9]{40}/g);
          if (addrs && addrs.length > 0) {
            addrs.slice(0, 50).forEach(function(a){ recipients.push({ addr: a, amount: amt || 10 }); });
          }
          if (recipients.length > 0) {
            _createScheduleEntries(recipients, token, 'Arc_Testnet', null);
            try { if (typeof showPage === 'function') setTimeout(function(){ showPage('schedule'); }, 200); } catch(_e) {}
          }
          return _m(p, msg);
        };
        window.__massSchedPatched = true; ok++;
      }

      if (ok > 0) { _installed = true; return; }
      if (retries < 40) setTimeout(tryInstall, 400);
    }
    setTimeout(tryInstall, 2000);
  }

  setTimeout(install, 1500);
  window.AutonomaScheduleRoute = { install: install, isInstalled: function(){ return _installed; } };
})();
