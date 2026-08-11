/**
 * Elligentt UIStore — Centralized UI State Management (Phase 1 Architecture)
 *
 * Encapsulates all UI-related state. Emits through EventBus.
 * Backward-compatible: does NOT break existing window.* globals.
 *
 * State: activePage, sidebarCollapsed, modals, toasts, loading states.
 *
 * Attached to: window.UIStore
 *
 * @module uiStore
 * @version 1.0.0
 */
(function () {
  'use strict';

  /** @type {{ activePage: string, sidebarCollapsed: boolean, loadingCount: number, modalStack: string[] }} */
  var _state = {
    activePage: '',
    sidebarCollapsed: false,
    loadingCount: 0,
    modalStack: []
  };

  /* ════════════════════════════════════════════
     GETTERS
  ════════════════════════════════════════════ */

  /** @returns {string} */
  function getActivePage() { return _state.activePage; }

  /** @returns {boolean} */
  function isSidebarCollapsed() { return _state.sidebarCollapsed; }

  /** @returns {boolean} */
  function isLoading() { return _state.loadingCount > 0; }

  /** @returns {boolean} */
  function isModalOpen() { return _state.modalStack.length > 0; }

  /** @returns {number} */
  function getModalCount() { return _state.modalStack.length; }

  /** @returns {Object} Snapshot of current UI state */
  function getSnapshot() {
    return {
      activePage: _state.activePage,
      sidebarCollapsed: _state.sidebarCollapsed,
      loadingCount: _state.loadingCount,
      isModalOpen: _state.modalStack.length > 0,
      modalStack: _state.modalStack.slice()
    };
  }

  /* ════════════════════════════════════════════
     SETTERS — each emits an EventBus event
  ════════════════════════════════════════════ */

  /**
   * @param {string} pageId - The page identifier (e.g. 'send', 'swap', 'autonoma')
   * @emits PAGE_CHANGED
   */
  function setActivePage(pageId) {
    if (_state.activePage === pageId) return;
    var prev = _state.activePage;
    _state.activePage = pageId;
    try {
      if (typeof EventBus !== 'undefined' && EventBus.emit) {
        EventBus.emit('PAGE_CHANGED', { page: pageId, previous: prev });
      }
    } catch (_e) { /* isolation */ }
  }

  /**
   * @param {boolean} collapsed
   * @emits SIDEBAR_TOGGLED
   */
  function setSidebarCollapsed(collapsed) {
    if (_state.sidebarCollapsed === collapsed) return;
    _state.sidebarCollapsed = collapsed;
    try {
      if (typeof EventBus !== 'undefined' && EventBus.emit) {
        EventBus.emit('SIDEBAR_TOGGLED', { collapsed: collapsed });
      }
    } catch (_e) { /* isolation */ }
  }

  /**
   * Increment loading counter. Shows loading indicator when count > 0.
   * @emits LOADING_CHANGED
   */
  function startLoading() {
    _state.loadingCount += 1;
    try {
      if (typeof EventBus !== 'undefined' && EventBus.emit) {
        EventBus.emit('LOADING_CHANGED', { loading: true, count: _state.loadingCount });
      }
    } catch (_e) { /* isolation */ }
  }

  /**
   * Decrement loading counter. Hides loading indicator when count reaches 0.
   * @emits LOADING_CHANGED
   */
  function stopLoading() {
    _state.loadingCount = Math.max(0, _state.loadingCount - 1);
    try {
      if (typeof EventBus !== 'undefined' && EventBus.emit) {
        EventBus.emit('LOADING_CHANGED', { loading: _state.loadingCount > 0, count: _state.loadingCount });
      }
    } catch (_e) { /* isolation */ }
  }

  /**
   * Reset loading counter to 0. Use for emergency cleanup.
   */
  function resetLoading() {
    _state.loadingCount = 0;
    try {
      if (typeof EventBus !== 'undefined' && EventBus.emit) {
        EventBus.emit('LOADING_CHANGED', { loading: false, count: 0 });
      }
    } catch (_e) { /* isolation */ }
  }

  /**
   * Push a modal onto the stack.
   * @param {string} modalId
   * @emits MODAL_OPENED
   */
  function pushModal(modalId) {
    _state.modalStack.push(modalId);
    try {
      if (typeof EventBus !== 'undefined' && EventBus.emit) {
        EventBus.emit('MODAL_OPENED', { modalId: modalId, stackDepth: _state.modalStack.length });
      }
    } catch (_e) { /* isolation */ }
  }

  /**
   * Pop the top modal from the stack.
   * @returns {string|undefined}
   * @emits MODAL_CLOSED
   */
  function popModal() {
    var closed = _state.modalStack.pop();
    try {
      if (typeof EventBus !== 'undefined' && EventBus.emit) {
        EventBus.emit('MODAL_CLOSED', { modalId: closed, stackDepth: _state.modalStack.length });
      }
    } catch (_e) { /* isolation */ }
    return closed;
  }

  /**
   * Reset all UI state to defaults.
   */
  function reset() {
    _state.activePage = '';
    _state.sidebarCollapsed = false;
    _state.loadingCount = 0;
    _state.modalStack = [];
  }

  /** @public */
  window.UIStore = {
    VERSION: '1.0.0',
    getActivePage: getActivePage,
    isSidebarCollapsed: isSidebarCollapsed,
    isLoading: isLoading,
    isModalOpen: isModalOpen,
    getModalCount: getModalCount,
    getSnapshot: getSnapshot,
    setActivePage: setActivePage,
    setSidebarCollapsed: setSidebarCollapsed,
    startLoading: startLoading,
    stopLoading: stopLoading,
    resetLoading: resetLoading,
    pushModal: pushModal,
    popModal: popModal,
    reset: reset
  };
})();
