/**
 * Elligentt Swap Isolation — Phase 21 Production Hardening
 * Validates SWAP_ROUTER_ADDRESS. Blocks execution when placeholder.
 * Attached to window.SwapIsolation
 */
(function(){
  'use strict';

  var _installed = false;
  var _swapBlocked = false;
  var PLACEHOLDER_ADDRESS = '0x0000000000000000000000000000000000000001';

  function _getSwapRouterAddress() {
    try {
      if (window.SystemConfig && window.SystemConfig.SWAP_ROUTER_ADDRESS) {
        return window.SystemConfig.SWAP_ROUTER_ADDRESS;
      }
      if (typeof SWAP_ROUTER_ADDRESS !== 'undefined') {
        return SWAP_ROUTER_ADDRESS;
      }
    } catch(e) {}
    return PLACEHOLDER_ADDRESS;
  }

  function isPlaceholder() {
    var addr = _getSwapRouterAddress();
    if (!addr) return true;
    var cleaned = addr.toLowerCase().replace(/^0x/, '');
    var placeholder = PLACEHOLDER_ADDRESS.toLowerCase().replace(/^0x/, '');
    return cleaned === placeholder || cleaned === '' || /^0+$/.test(cleaned) || cleaned.length < 40;
  }

  function _disableSwapUI() {
    var attempts = 0;
    var maxAttempts = 30;
    var interval = setInterval(function() {
      attempts++;
      try {
        var swapButtons = document.querySelectorAll(
          '#page-swap button, .swap-execute, [data-action="swap"], ' +
          '.swap-submit, .swap-confirm, #btn-swap-execute'
        );
        for (var i = 0; i < swapButtons.length; i++) {
          swapButtons[i].disabled = true;
          swapButtons[i].style.opacity = '0.45';
          swapButtons[i].style.cursor = 'not-allowed';
          swapButtons[i].title = 'Swap disabled: router contract not deployed';
        }
        var banner = document.createElement('div');
        banner.id = 'p21-swap-warning';
        banner.innerHTML = 'Swap temporarily unavailable. Router contract pending deployment. Liquidity is preserved and safe.';
        banner.style.cssText = 'background:#2d1f0a;color:#e8a838;padding:12px 18px;margin:12px 0;border-left:4px solid #e8a838;border-radius:4px;font-size:14px;font-family:inherit;';
        var swapPage = document.getElementById('page-swap');
        if (swapPage && !document.getElementById('p21-swap-warning')) {
          swapPage.insertBefore(banner, swapPage.firstChild);
        }
        clearInterval(interval);
      } catch(e) {
        if (attempts >= maxAttempts) clearInterval(interval);
      }
    }, 300);
  }

  function install() {
    if (_installed) return;
    _installed = true;

    if (isPlaceholder()) {
      _swapBlocked = true;
      console.warn('[SwapIsolation] SWAP_ROUTER_ADDRESS is placeholder (' + _getSwapRouterAddress() + '). Swap execution BLOCKED to prevent gas loss.');
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() { setTimeout(_disableSwapUI, 1000); });
      } else {
        setTimeout(_disableSwapUI, 500);
      }
    } else {
      console.log('[SwapIsolation] Swap execution ENABLED. Router: ' + _getSwapRouterAddress());
    }
  }

  function isSwapBlocked() { return _swapBlocked; }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { setTimeout(install, 1000); });
  } else {
    setTimeout(install, 500);
  }

  window.SwapIsolation = {
    install: install,
    isInstalled: function() { return _installed; },
    isSwapBlocked: isSwapBlocked,
    isPlaceholder: isPlaceholder
  };
})();
