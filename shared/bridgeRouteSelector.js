/**
 * Elligentt Bridge Route Selector — CCTP primary / LI.FI fallback
 * Single inline pill that reflects the routing decision for the selected
 * bridge pair: "CCTP" for USDC/EURC between CCTP domains, "LI.FI" otherwise.
 * When CCTP is eligible, a "Use LI.FI" fallback button is shown next to the
 * pill so the user can explicitly route through LI.FI.
 */
(function(){
  'use strict';
  var _installed = false, _retries = 0;

  function isEligibleCctp() {
    try {
      if (typeof BridgeKitRouter !== 'undefined' && typeof bridgeFromIdx !== 'undefined' && typeof bridgeToIdx !== 'undefined' && typeof CHAINS !== 'undefined') {
        var fromChain = CHAINS[bridgeFromIdx];
        var toChain = CHAINS[bridgeToIdx];
        if (fromChain && toChain) {
          return BridgeKitRouter.route(fromChain.chainId, toChain.chainId, 'USDC').provider === 'cctp';
        }
      }
    } catch (_e) {}
    return false;
  }

  function currentRoute() {
    // Explicit user override: LI.FI forced (the fallback button).
    try { if (window.__bridgeForceLiFi) return 'lifi'; } catch (_e) {}
    return isEligibleCctp() ? 'cctp' : 'lifi';
  }

  function render(col) {
    if (!col) return;
    var old = col.querySelector('.br-route-inline');
    if (old) old.remove();

    var route = currentRoute();
    var isCctp = route === 'cctp';

    var wrap = document.createElement('div');
    wrap.className = 'br-route-inline';
    wrap.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 0;flex-shrink:0';

    var lbl = document.createElement('span');
    lbl.style.cssText = 'font-size:8.5px;color:var(--muted2);white-space:nowrap';
    lbl.textContent = 'Route:';

    var pill = document.createElement('span');
    var pillColor = isCctp ? 'rgba(45,212,191,.12)' : 'rgba(148,163,184,.12)';
    var pillTextColor = isCctp ? 'var(--teal)' : 'var(--muted2)';
    var pillBorder = isCctp ? 'rgba(45,212,191,.3)' : 'rgba(148,163,184,.3)';
    pill.style.cssText = 'font-size:8.5px;padding:3px 8px;border-radius:4px;white-space:nowrap;' +
      'background:' + pillColor + ';color:' + pillTextColor + ';border:1px solid ' + pillBorder + ';font-weight:600';
    pill.innerHTML = isCctp
      ? '<i class="ti ti-circle-dot" style="font-size:9px"></i> CCTP v2'
      : '<i class="ti ti-world" style="font-size:9px"></i> LI.FI';

    wrap.appendChild(lbl); wrap.appendChild(pill);

    // LI.FI fallback button — only offered when CCTP is the default route.
    if (isCctp) {
      var liFiBtn = document.createElement('button');
      liFiBtn.type = 'button';
      liFiBtn.style.cssText = 'font-size:8.5px;padding:3px 8px;border-radius:4px;white-space:nowrap;' +
        'background:transparent;color:var(--muted2);border:1px solid var(--border);cursor:pointer;font-weight:600';
      liFiBtn.innerHTML = '<i class="ti ti-world" style="font-size:9px"></i> Use LI.FI';
      liFiBtn.title = 'Route this bridge through LI.FI instead of CCTP';
      liFiBtn.addEventListener('click', function () {
        try { window.__bridgeForceLiFi = true; } catch (_e) {}
        var bp = document.getElementById('page-bridge');
        if (bp) { var c = bp.querySelector('.swap-col'); if (c) render(c); }
        toast('Bridge will use LI.FI for this route', 'info');
      });
      wrap.appendChild(liFiBtn);
    } else {
      // When LI.FI is active, allow returning to CCTP when eligible.
      if (isEligibleCctp()) {
        var cctpBtn = document.createElement('button');
        cctpBtn.type = 'button';
        cctpBtn.style.cssText = 'font-size:8.5px;padding:3px 8px;border-radius:4px;white-space:nowrap;' +
          'background:transparent;color:var(--teal);border:1px solid rgba(45,212,191,.3);cursor:pointer;font-weight:600';
        cctpBtn.innerHTML = '<i class="ti ti-circle-dot" style="font-size:9px"></i> Use CCTP';
        cctpBtn.title = 'Route this bridge through Circle CCTP v2';
        cctpBtn.addEventListener('click', function () {
          try { window.__bridgeForceLiFi = false; } catch (_e) {}
          var bp = document.getElementById('page-bridge');
          if (bp) { var c = bp.querySelector('.swap-col'); if (c) render(c); }
          toast('Bridge will use CCTP v2 for this route', 'info');
        });
        wrap.appendChild(cctpBtn);
      }
    }

    var card = col.querySelector('.swap-card');
    if (card) {
      var rows = card.querySelectorAll('.chain-row');
      if (rows.length >= 2) rows[0].insertAdjacentElement('afterend', wrap);
      else if (rows.length === 1) rows[0].insertAdjacentElement('afterend', wrap);
      else card.appendChild(wrap);
    } else col.appendChild(wrap);

    window.__bridgeSelectedRoute = route;
  }

  function inject() {
    if (_installed) return;
    var bp = document.getElementById('page-bridge');
    if (!bp) { if(_retries<40){_retries++;setTimeout(inject,500);} return; }
    var col = bp.querySelector('.swap-col');
    if (!col) { if(_retries<40){_retries++;setTimeout(inject,500);} return; }
    render(col);
    _installed = true;
  }

  setTimeout(inject, 1500);

  window.BridgeRouteSelector = {
    getRoute: function(){ return currentRoute(); },
    refresh: function(){ var bp=document.getElementById('page-bridge'); if(bp){ var c=bp.querySelector('.swap-col'); if(c) render(c); } },
    isInstalled: function(){ return _installed; }
  };
})();
