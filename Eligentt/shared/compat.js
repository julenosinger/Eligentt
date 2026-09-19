/**
 * Elligentt Compatibility Layer — Backward Compatibility Wrappers (Phase 1 Architecture)
 *
 * Bridges new architecture to existing global APIs.
 * Ensures NO existing code breaks. All old global function calls continue to work.
 *
 * Does NOT replace any existing global. Only adds new aliases.
 *
 * @module compat
 * @version 1.0.0
 */
(function () {
  'use strict';

  // ── EventBus → Document Events bridge ─────────────────────────
  // Ensures existing code that uses document.dispatchEvent continues to work
  // alongside new EventBus listeners.
  try {
    if (typeof EventBus !== 'undefined' && EventBus.on) {
      // Bridge: EventBus events to document events for legacy consumers
      EventBus.on('WALLET_CONNECTED', function (payload) {
        try {
          if (typeof document !== 'undefined') {
            document.dispatchEvent(new CustomEvent('WALLET_CONNECTED', { detail: payload || {} }));
          }
        } catch (_e) {}
      });

      EventBus.on('WALLET_DISCONNECTED', function (payload) {
        try {
          if (typeof document !== 'undefined') {
            document.dispatchEvent(new CustomEvent('WALLET_DISCONNECTED', { detail: payload || {} }));
          }
        } catch (_e) {}
      });

      EventBus.on('PAGE_CHANGED', function (payload) {
        try {
          if (typeof document !== 'undefined') {
            document.dispatchEvent(new CustomEvent('PAGE_CHANGED', { detail: payload || {} }));
          }
        } catch (_e) {}
      });
    }
  } catch (_e) {}

  // ── Toast aliases ─────────────────────────────────────────────
  // showToast is already defined as a reference to toast() in index.html.
  // ToastManager delegates to toast(). No additional aliases needed.

  // ── Modal aliases ─────────────────────────────────────────────
  // openModal / closeModal are already defined as global functions in index.html.
  // ModalManager delegates to them. No additional aliases needed.

  // ── Wallet aliases ────────────────────────────────────────────
  // walletConnect, connectWallet, disconnectWallet are already global functions.
  // WalletService delegates to them. No additional aliases needed.

  // ── Settings aliases ──────────────────────────────────────────
  // If existing code calls loadSettings() / saveSettings(), those are already defined.
  // SettingsStore provides a new structured alternative.

  // ── Guarantee window.__App availability ────────────────────────
  // The __App object is defined in index.html line 11630.
  // If it somehow is not set, provide a fallback that reads from globals.
  try {
    if (typeof window.__App === 'undefined') {
      Object.defineProperty(window, '__App', {
        get: function () {
          return {
            get walletAddress() {
              try { return window.walletAddress || null; } catch (_e) { return null; }
            },
            get provider() {
              try { return window.provider || null; } catch (_e) { return null; }
            },
            get signer() {
              try { return window.signer || null; } catch (_e) { return null; }
            },
            get activeChainId() {
              try { return window.activeChainId || 5042002; } catch (_e) { return 5042002; }
            },
            get activeWalletType() {
              try { return window.activeWalletType || null; } catch (_e) { return null; }
            }
          };
        },
        configurable: true
      });
    }
  } catch (_e) {}

  console.log('[Compat] Phase 1 backward compatibility layer initialized ✓');
})();
