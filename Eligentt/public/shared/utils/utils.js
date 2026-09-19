/**
 * Elligentt Utils — Formatters & Validators (Phase 3)
 * Shared formatting and validation utilities extracted from index.html patterns.
 * Attached to: window.Utils
 */
(function () {
  'use strict';

  /* ════════════════════════════════════════
     ADDRESS UTILITIES
  ════════════════════════════════════════ */

  function isAddr(s) {
    return /^0x[a-fA-F0-9]{40}$/.test(String(s||''));
  }

  function isEns(s) {
    return /\.eth$/.test(String(s||'')) && s.length > 4;
  }

  function shortAddr(addr) {
    var a = String(addr||'');
    return a.length > 12 ? a.slice(0,6) + '\u2026' + a.slice(-4) : a;
  }

  /* ════════════════════════════════════════
     TOKEN UTILITIES
  ════════════════════════════════════════ */

  function getTokenAddress(chainId, symbol) {
    try {
      if (typeof CHAIN_REGISTRY !== 'undefined') {
        var c = CHAIN_REGISTRY[chainId];
        if (c && c.tokens && c.tokens[symbol]) return c.tokens[symbol].address;
      }
    } catch (_e) {}
    return null;
  }

  function getTokenDecimals(chainId, symbol) {
    try {
      if (typeof CHAIN_REGISTRY !== 'undefined') {
        var c = CHAIN_REGISTRY[chainId];
        if (c && c.tokens && c.tokens[symbol]) return c.tokens[symbol].decimals || 6;
      }
    } catch (_e) {}
    return 6;
  }

  /** Token symbol aliases normalization */
  function normalizeToken(sym) {
    var n = String(sym||'').toUpperCase().trim();
    var map = { 'USD': 'USDC', 'DOLLAR': 'USDC', 'EUR': 'EURC', 'EURO': 'EURC', 'BTC': 'cirBTC', 'BITCOIN': 'cirBTC' };
    return map[n] || n;
  }

  /* ════════════════════════════════════════
     NUMBER & CURRENCY FORMATTING
  ════════════════════════════════════════ */

  function fmtUsd(n) {
    var v = Number(n) || 0;
    return '$' + v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  function fmtAmount(n, decimals) {
    var d = decimals !== undefined ? decimals : 2;
    var v = Number(n) || 0;
    return v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
  }

  function fmtPercent(n) {
    return (Number(n)||0).toFixed(2) + '%';
  }

  function fromUsdc(raw) {
    try {
      if (typeof raw === 'bigint' || typeof raw === 'object') return Number(ethers.formatUnits(raw, 6)).toFixed(2);
    } catch (_e) {}
    return String(raw);
  }

  function toUsdc(num) {
    try { return ethers.parseUnits(String(num), 6); } catch (_e) { return 0n; }
  }

  /* ════════════════════════════════════════
     DATE FORMATTING
  ════════════════════════════════════════ */

  function fmtDateShort(d) {
    var date = d instanceof Date ? d : new Date(d);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function fmtDateLong(d) {
    var date = d instanceof Date ? d : new Date(d);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function fmtDateTime(d) {
    var date = d instanceof Date ? d : new Date(d);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' + date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }

  function fmtTimeAgo(ms) {
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  /* ════════════════════════════════════════
     CHAIN & NETWORK FORMATTING
  ════════════════════════════════════════ */

  function getChainName(chainId) {
    try {
      if (typeof CHAIN_REGISTRY !== 'undefined' && CHAIN_REGISTRY[chainId]) return CHAIN_REGISTRY[chainId].name || CHAIN_REGISTRY[chainId].id;
    } catch (_e) {}
    return 'Chain ' + chainId;
  }

  function getChainColor(chainId) {
    try {
      if (typeof CHAIN_REGISTRY !== 'undefined' && CHAIN_REGISTRY[chainId]) return CHAIN_REGISTRY[chainId].color || '#ff0202';
    } catch (_e) {}
    return '#ff0202';
  }

  /** Build an explorer URL from chainId + txHash */
  function explorerTxUrl(chainId, txHash) {
    try {
      if (typeof CHAIN_REGISTRY !== 'undefined' && CHAIN_REGISTRY[chainId] && CHAIN_REGISTRY[chainId].explorer) {
        return CHAIN_REGISTRY[chainId].explorer + '/tx/' + txHash;
      }
    } catch (_e) {}
    return 'https://testnet.arcscan.app/tx/' + txHash;
  }

  function explorerAddressUrl(chainId, addr) {
    try {
      if (typeof CHAIN_REGISTRY !== 'undefined' && CHAIN_REGISTRY[chainId] && CHAIN_REGISTRY[chainId].explorer) {
        return CHAIN_REGISTRY[chainId].explorer + '/address/' + addr;
      }
    } catch (_e) {}
    return 'https://testnet.arcscan.app/address/' + addr;
  }

  /* ════════════════════════════════════════
     GAS CALCULATIONS
  ════════════════════════════════════════ */

  /** Estimate gas cost in native token from receipt */
  function gasCostFromReceipt(receipt) {
    try {
      if (!receipt) return 0;
      var gasUsed = receipt.gasUsed;
      var gasPrice = receipt.gasPrice || receipt.effectiveGasPrice || 0n;
      return Number(ethers.formatUnits(gasUsed * gasPrice, 18));
    } catch (_e) { return 0; }
  }

  /* ════════════════════════════════════════
     HTML ESCAPING
  ════════════════════════════════════════ */

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function safeSetHTML(el, html) {
    try { if (typeof setSafeHTML === 'function') { setSafeHTML(el, html); return; } } catch (_e) {}
    if (!el) return;
    if (typeof DOMPurify !== 'undefined') {
      try { el.innerHTML = DOMPurify.sanitize(html, { ALLOWED_TAGS: ['b','i','em','strong','a','span','div','br','small','code','pre'], ALLOWED_ATTR: ['href','target','class','style','title','id'] }); return; } catch (_e2) {}
    }
    el.innerHTML = escHtml(html);
  }

  /* ════════════════════════════════════════
     MISCELLANEOUS
  ════════════════════════════════════════ */

  function generateId(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  function generateShortId(prefix) {
    return (prefix || 'ID') + '-' + Date.now().toString(36).toUpperCase();
  }

  /* ════════════════════════════════════════
     ERROR NORMALIZATION
  ════════════════════════════════════════ */

  function normalizeError(e) {
    if (!e) return { message: 'Unknown error', code: 'UNKNOWN', category: 'unknown' };
    var msg = e.shortMessage || e.reason || e.message || String(e);
    var code = e.code || 'UNKNOWN';
    var category = 'unknown';
    if (/insufficient funds|balance too low|not enough/.test(msg)) category = 'balance';
    else if (/user rejected|user denied|cancelled/.test(msg)) category = 'user_rejected';
    else if (/timeout|timed out|too long/.test(msg)) category = 'timeout';
    else if (/network|connection|offline|fetch/i.test(msg)) category = 'network';
    else if (/nonce|already known|replacement|underpriced/.test(msg)) category = 'nonce';
    else if (/revert|execution reverted/.test(msg)) category = 'revert';
    else if (/gas|underpriced|intrinsic/.test(msg)) category = 'gas';
    return { message: msg, code: code, category: category, original: e };
  }

  /** @public */
  window.Utils = {
    VERSION: '1.0.0',
    isAddr: isAddr,
    isEns: isEns,
    shortAddr: shortAddr,
    getTokenAddress: getTokenAddress,
    getTokenDecimals: getTokenDecimals,
    normalizeToken: normalizeToken,
    fmtUsd: fmtUsd,
    fmtAmount: fmtAmount,
    fmtPercent: fmtPercent,
    fromUsdc: fromUsdc,
    toUsdc: toUsdc,
    fmtDateShort: fmtDateShort,
    fmtDateLong: fmtDateLong,
    fmtDateTime: fmtDateTime,
    fmtTimeAgo: fmtTimeAgo,
    getChainName: getChainName,
    getChainColor: getChainColor,
    explorerTxUrl: explorerTxUrl,
    explorerAddressUrl: explorerAddressUrl,
    gasCostFromReceipt: gasCostFromReceipt,
    escHtml: escHtml,
    safeSetHTML: safeSetHTML,
    generateId: generateId,
    generateShortId: generateShortId,
    normalizeError: normalizeError
  };
})();
