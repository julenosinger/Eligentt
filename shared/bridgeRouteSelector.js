/**
 * Elligentt Bridge Route Selector — Minimal
 * Small inline pills: CCTP v2 (default) / Turbo. Bridge page only.
 */
(function(){
  'use strict';
  var _installed = false, _selectedRoute = 'cctp', _retries = 0;

  function render(col) {
    if (!col) return;
    var old = col.querySelector('.br-route-inline');
    if (old) old.remove();

    var tA = _selectedRoute === 'turbo', cA = _selectedRoute === 'cctp';
    var wrap = document.createElement('div');
    wrap.className = 'br-route-inline';
    wrap.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 0;flex-shrink:0';

    var lbl = document.createElement('span');
    lbl.style.cssText = 'font-size:8.5px;color:var(--muted2);white-space:nowrap';
    lbl.textContent = 'Route:';

    var t = document.createElement('span');
    t.style.cssText = 'font-size:8.5px;padding:3px 8px;border-radius:4px;cursor:pointer;white-space:nowrap;transition:all .12s;'+
      (tA?'background:rgba(167,139,250,.18);color:var(--purple);border:1px solid rgba(167,139,250,.35);font-weight:600':'background:rgba(255,255,255,.03);color:var(--muted2);border:1px solid rgba(255,255,255,.07)');
    t.innerHTML='<i class="ti ti-bolt" style="font-size:9px"></i> Turbo';
    t.addEventListener('click',function(){_selectedRoute='turbo';render(col);window.__bridgeSelectedRoute='turbo';});

    var c = document.createElement('span');
    c.style.cssText = 'font-size:8.5px;padding:3px 8px;border-radius:4px;cursor:pointer;white-space:nowrap;transition:all .12s;'+
      (cA?'background:rgba(45,212,191,.12);color:var(--teal);border:1px solid rgba(45,212,191,.3);font-weight:600':'background:rgba(255,255,255,.03);color:var(--muted2);border:1px solid rgba(255,255,255,.07)');
    c.innerHTML='<i class="ti ti-circle-check" style="font-size:9px"></i> CCTP v2';
    c.addEventListener('click',function(){_selectedRoute='cctp';render(col);window.__bridgeSelectedRoute='cctp';});

    wrap.appendChild(lbl); wrap.appendChild(t); wrap.appendChild(c);

    var card = col.querySelector('.swap-card');
    if (card) {
      var rows = card.querySelectorAll('.chain-row');
      if (rows.length >= 2) rows[0].insertAdjacentElement('afterend', wrap);
      else if (rows.length === 1) rows[0].insertAdjacentElement('afterend', wrap);
      else card.appendChild(wrap);
    } else col.appendChild(wrap);

    window.__bridgeSelectedRoute = _selectedRoute;

    // Patch executeBridgeOrTurbo
    if (typeof window.executeBridgeOrTurbo === 'function' && !window.__brRouteWrapped) {
      var _o = window.executeBridgeOrTurbo;
      window.executeBridgeOrTurbo = function() {
        if (_selectedRoute === 'cctp' && typeof bridgeToIdx !== 'undefined' && typeof CHAINS !== 'undefined') {
          var tc = CHAINS[bridgeToIdx];
          if (tc && tc.id === 'Arc_Testnet' && typeof executeBridge === 'function') return executeBridge();
        }
        return _o();
      };
      window.__brRouteWrapped = true;
    }

    // Force steps visible for CCTP v2
    if (typeof window.executeBridge === 'function' && !window.__brExecWrapped) {
      var _ob = window.executeBridge;
      window.executeBridge = function() {
        var r = _ob();
        if (_selectedRoute === 'cctp') setTimeout(function(){
          var s = document.getElementById('bridge-steps-card');
          var d = document.getElementById('bridge-standard-steps');
          var t = document.getElementById('turbo-steps-wrap');
          if (s) s.style.display = '';
          if (d) d.style.display = '';
          if (t) t.style.display = 'none';
        }, 10);
        return r;
      };
      window.__brExecWrapped = true;
    }
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
    setRoute: function(r){_selectedRoute=r;var bp=document.getElementById('page-bridge');if(bp){var c=bp.querySelector('.swap-col');if(c)render(c);}},
    isInstalled: function(){ return _installed; }
  };
})();
