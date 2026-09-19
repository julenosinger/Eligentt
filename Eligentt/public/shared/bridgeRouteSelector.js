/**
 * Elligentt Bridge Route Selector — LI.FI only (FASE 1)
 * Single inline pill: "LI.FI" (the only bridge provider for /bridge).
 * Legacy CCTP v2 / Turbo pills are removed from the active bridge path.
 */
(function(){
  'use strict';
  var _installed = false, _selectedRoute = 'lifi', _retries = 0;

  function render(col) {
    if (!col) return;
    var old = col.querySelector('.br-route-inline');
    if (old) old.remove();

    var wrap = document.createElement('div');
    wrap.className = 'br-route-inline';
    wrap.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 0;flex-shrink:0';

    var lbl = document.createElement('span');
    lbl.style.cssText = 'font-size:8.5px;color:var(--muted2);white-space:nowrap';
    lbl.textContent = 'Route:';

    var pill = document.createElement('span');
    pill.style.cssText = 'font-size:8.5px;padding:3px 8px;border-radius:4px;white-space:nowrap;' +
      'background:rgba(45,212,191,.12);color:var(--teal);border:1px solid rgba(45,212,191,.3);font-weight:600';
    pill.innerHTML = '<i class="ti ti-world" style="font-size:9px"></i> LI.FI';

    wrap.appendChild(lbl); wrap.appendChild(pill);

    var card = col.querySelector('.swap-card');
    if (card) {
      var rows = card.querySelectorAll('.chain-row');
      if (rows.length >= 2) rows[0].insertAdjacentElement('afterend', wrap);
      else if (rows.length === 1) rows[0].insertAdjacentElement('afterend', wrap);
      else card.appendChild(wrap);
    } else col.appendChild(wrap);

    window.__bridgeSelectedRoute = _selectedRoute;
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
    getRoute: function(){ return _selectedRoute; },
    setRoute: function(r){ _selectedRoute = 'lifi'; var bp=document.getElementById('page-bridge'); if(bp){ var c=bp.querySelector('.swap-col'); if(c) render(c); } },
    isInstalled: function(){ return _installed; }
  };
})();
