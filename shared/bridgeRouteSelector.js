/**
 * Elligentt Bridge Route Selector — Phase 5+
 * Small inline pills inside the bridge card. Turbo (default) / CCTP v2.
 * Attached to window.BridgeRouteSelector
 */
(function(){
  'use strict';
  var _installed = false;
  var _selectedRoute = 'cctp';
  var _retries = 0;

  function render(col) {
    if (!col) return;
    var old = col.querySelector('.br-route-inline');
    if (old) old.remove();

    var turboActive = _selectedRoute === 'turbo';
    var cctpActive  = _selectedRoute === 'cctp';

    var wrap = document.createElement('div');
    wrap.className = 'br-route-inline';
    wrap.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 0;flex-shrink:0';

    var lbl = document.createElement('span');
    lbl.style.cssText = 'font-size:8.5px;color:var(--muted2);white-space:nowrap';
    lbl.textContent = 'Route:';

    var turbo = document.createElement('span');
    turbo.style.cssText = 'font-size:8.5px;padding:3px 8px;border-radius:4px;cursor:pointer;white-space:nowrap;transition:all .12s;' +
      (turboActive ? 'background:rgba(167,139,250,.18);color:var(--purple);border:1px solid rgba(167,139,250,.35);font-weight:600' : 'background:rgba(255,255,255,.03);color:var(--muted2);border:1px solid rgba(255,255,255,.07)');
    turbo.innerHTML = '<i class="ti ti-bolt" style="font-size:9px"></i> Turbo';
    turbo.addEventListener('click', function(){ _selectedRoute='turbo'; render(col); window.__bridgeSelectedRoute='turbo'; });

    var cctp = document.createElement('span');
    cctp.style.cssText = 'font-size:8.5px;padding:3px 8px;border-radius:4px;cursor:pointer;white-space:nowrap;transition:all .12s;' +
      (cctpActive ? 'background:rgba(45,212,191,.12);color:var(--teal);border:1px solid rgba(45,212,191,.3);font-weight:600' : 'background:rgba(255,255,255,.03);color:var(--muted2);border:1px solid rgba(255,255,255,.07)');
    cctp.innerHTML = '<i class="ti ti-circle-check" style="font-size:9px"></i> CCTP v2';
    cctp.addEventListener('click', function(){ _selectedRoute='cctp'; render(col); window.__bridgeSelectedRoute='cctp'; });

    wrap.appendChild(lbl);
    wrap.appendChild(turbo);
    wrap.appendChild(cctp);

    // Insert inside first swap-card, AFTER the first chain-row (From Chain), BEFORE the second (To Chain)
    var firstCard = col.querySelector('.swap-card');
    if (!firstCard) { col.appendChild(wrap); }
    else {
      var chainRows = firstCard.querySelectorAll('.chain-row');
      if (chainRows.length >= 2) {
        // Use insertAdjacentElement to not disrupt sibling order
        chainRows[0].insertAdjacentElement('afterend', wrap);
      } else if (chainRows.length === 1) {
        chainRows[0].insertAdjacentElement('afterend', wrap);
      } else {
        firstCard.appendChild(wrap);
      }
    }

    window.__bridgeSelectedRoute = _selectedRoute;

    // Patch executeBridge to always show steps when CCTP v2 route is selected
    if (typeof window.executeBridge === 'function' && !window.__brExecuteWrapped) {
      var _origBridge = window.executeBridge;
      window.executeBridge = function() {
        var result = _origBridge();
        // Override: executeBridge hides steps for non-Arc chains, we force them back
        if (_selectedRoute === 'cctp') {
          setTimeout(function() {
            var sc = document.getElementById('bridge-steps-card');
            var ss = document.getElementById('bridge-standard-steps');
            var tw = document.getElementById('turbo-steps-wrap');
            if (sc) { sc.style.display = ''; }
            if (ss) { ss.style.display = ''; }
            if (tw) { tw.style.display = 'none'; }
          }, 10);
        }
        return result;
      };
      window.__brExecuteWrapped = true;
    }

    // Wrap executeBridgeOrTurbo to respect route selection
    if (typeof window.executeBridgeOrTurbo === 'function' && !window.__brRouteWrapped) {
      var _origOrTurbo = window.executeBridgeOrTurbo;
      window.executeBridgeOrTurbo = function() {
        if (_selectedRoute === 'cctp' && typeof bridgeToIdx !== 'undefined' && typeof CHAINS !== 'undefined') {
          var toChain = CHAINS[bridgeToIdx];
          if (toChain && toChain.id === 'Arc_Testnet') {
            if (typeof executeBridge === 'function') {
              return executeBridge();
            }
          }
        }
        return _origOrTurbo();
      };
      window.__brRouteWrapped = true;
    }
  }

  function inject() {
    if (_installed) return;
    var bp = document.getElementById('page-bridge');
    if (!bp) { if(_retries<60){_retries++;setTimeout(inject,500);} return; }
    var col = bp.querySelector('.swap-col');
    if (!col) { if(_retries<60){_retries++;setTimeout(inject,500);} return; }

    render(col);

    new MutationObserver(function(ms){
      for(var i=0;i<ms.length;i++){
        if(ms[i].type==='attributes' && ms[i].attributeName==='class'){
          var el = ms[i].target;
          if(el.id==='page-bridge' && el.classList.contains('active')){
            setTimeout(function(){ var c=el.querySelector('.swap-col'); if(c)render(c); }, 200);
          }
        }
      }
    }).observe(bp, {attributes:true,attributeFilter:['class']});

    _installed = true;
  }

  setTimeout(inject, 2000);

  // ── Autonoma Chat: intercept _executeIntent to replace BRIDGE_TURBO with CCTP v2 ──
  var _chatRetries = 0;
  function patchAutonomaBridge() {
    _chatRetries++;
    if (typeof window._executeIntent === 'function' && !window.__autonomaBridgePatched) {
      var _origExecute = window._executeIntent;
      window._executeIntent = async function(intent, params, msg) {
        // Replace BRIDGE_TURBO with regular bridge (CCTP v2)
        if (intent === 'BRIDGE_TURBO') {
          var low = (msg || '').toLowerCase();
          var isFromOther = /\b(?:from|do|da)\s+(ethereum|sepolia|base|arbitrum|polygon|amoy|matic|optimism)\b/i.test(low);
          var isToArc = /\b(?:to|para)\s+(arc)\b/i.test(low);

          // Other chain → Arc: Navigate to Bridge page (user signs from source chain)
          if (isFromOther && isToArc) {
            try { if (typeof showPage === 'function') setTimeout(function(){ showPage('bridge'); }, 400); } catch(_e) {}
          }

          // Route through standard bridge handler (CCTP v2) instead of Turbo
          if (typeof autBridge === 'function') return autBridge(msg);
        }
        return _origExecute(intent, params, msg);
      };
      window.__autonomaBridgePatched = true;
      console.log('[BridgeRouteSelector] _executeIntent patched: BRIDGE_TURBO → CCTP v2.');
      return;
    }
    if (_chatRetries < 80) setTimeout(patchAutonomaBridge, 400);
  }
  setTimeout(patchAutonomaBridge, 4000);

  window.BridgeRouteSelector = {
    getRoute: function(){ return _selectedRoute; },
    setRoute: function(r){ _selectedRoute=r; var bp=document.getElementById('page-bridge'); if(bp){var c=bp.querySelector('.swap-col');if(c)render(c);} },
    isInstalled: function(){ return _installed; }
  };
})();
