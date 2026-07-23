/**
 * Elligentt JSON Corruption Fix — Phase 5 Remediation
 * Monkey-patches localStorage to prevent JSON corruption from substring truncation.
 * Load this BEFORE any other shared module.
 * Attached to window.JSONFix
 */
(function(){
  'use strict';

  var _originalSetItem = localStorage.setItem;
  var _wrapped = false;

  /**
   * Intercepts all localStorage.setItem calls and prevents:
   * 1. Truncated JSON (can't be parsed)
   * 2. Items exceeding 5MB (chunks automatically via StorageManager)
   */
  function _safeSetItem(key, value) {
    if (!key || value === undefined || value === null) {
      _originalSetItem.call(localStorage, key, value);
      return;
    }

    var valStr = String(value);

    // Check if value is truncation-corrupted JSON
    if (_isTruncatedJSON(valStr)) {
      // Try to salvage by trimming to last valid element
      var salvaged = _salvageTruncatedArray(valStr);
      if (salvaged !== null) {
        try {
          // Verify it's valid JSON
          var parsed = JSON.parse(salvaged);
          if (typeof window.StorageManager !== 'undefined') {
            window.StorageManager.safeSet(key, parsed);
          } else {
            _originalSetItem.call(localStorage, key, salvaged);
          }
          return;
        } catch(e) {}
      }
      // If salvage failed and it's a history/audit key, try closing brackets
      var closed = _closeBrackets(valStr);
      if (closed !== null) {
        try {
          var closedParsed = JSON.parse(closed);
          if (typeof window.StorageManager !== 'undefined') {
            window.StorageManager.safeSet(key, closedParsed);
          } else {
            _originalSetItem.call(localStorage, key, closed);
          }
          return;
        } catch(e) {}
      }
      // Nothing worked — don't write corrupted data
      return;
    }

    // If value is very large, try chunking
    if (valStr.length > 400000 && typeof window.StorageManager !== 'undefined') {
      try {
        var chunkParsed = JSON.parse(valStr);
        window.StorageManager.safeSet(key, chunkParsed);
        return;
      } catch(e) {}
    }

    // Normal write
    try {
      _originalSetItem.call(localStorage, key, value);
    } catch(e) {
      if ((e.name === 'QuotaExceededError' || (e.message && e.message.indexOf('quota') !== -1)) && typeof window.StorageManager !== 'undefined') {
        try {
          var pv = JSON.parse(valStr);
          window.StorageManager.safeSet(key, pv);
        } catch(e2) { throw e2; }
      } else {
        throw e;
      }
    }
  }

  /**
   * Salvage a truncated JSON array by finding the last complete element
   * and trimming to that point. Used for history/audit arrays that get
   * substring(0, N) truncated.
   */
  function _salvageTruncatedArray(str) {
    if (!str || typeof str !== 'string') return null;
    var trimmed = str.trim();
    if (trimmed[0] !== '[') return null;

    // Walk through the string tracking depth to find the last complete element
    var depth = 0;
    var inString = false;
    var escaped = false;
    var lastValidEnd = 1; // position after '['

    for (var i = 1; i < trimmed.length; i++) {
      var ch = trimmed[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;

      if (ch === '{' || ch === '[') { depth++; }
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) {
          // Found a complete top-level element
          lastValidEnd = i + 1;
          // Skip optional comma/whitespace
          var j = lastValidEnd;
          while (j < trimmed.length && (trimmed[j] === ',' || trimmed[j] === ' ' || trimmed[j] === '\n' || trimmed[j] === '\r' || trimmed[j] === '\t')) {
            j++;
          }
          if (j < trimmed.length && trimmed[j] !== ']') {
            lastValidEnd = j; // ready for next element
          }
        }
      }
    }

    if (lastValidEnd <= 1) return null;

    var result = trimmed.substring(0, lastValidEnd);
    // Remove trailing comma
    result = result.replace(/,\s*$/, '');
    result += ']';

    try {
      JSON.parse(result);
      return result;
    } catch(e) {
      return null;
    }
  }

  /**
   * Fallback: close unclosed brackets in truncated JSON.
   * Less precise than salvageTruncatedArray but works for objects.
   */
  function _closeBrackets(str) {
    if (!str || typeof str !== 'string') return null;
    try {
      var fixed = str.trim();
      var stack = [];
      var inString = false;
      var escaped = false;

      for (var i = 0; i < fixed.length; i++) {
        var ch = fixed[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;

        if (ch === '{' || ch === '[') stack.push(ch);
        else if (ch === '}') { if (stack[stack.length-1] === '{') stack.pop(); }
        else if (ch === ']') { if (stack[stack.length-1] === '[') stack.pop(); }
      }

      for (var j = stack.length - 1; j >= 0; j--) {
        fixed += (stack[j] === '{' ? '}' : ']');
      }

      JSON.parse(fixed);
      return fixed;
    } catch(e) {
      return null;
    }
  }

  function _isTruncatedJSON(str) {
    if (!str || typeof str !== 'string') return false;
    var trimmed = str.trim();

    // Array truncation: starts with [ but doesn't end with ]
    if (trimmed[0] === '[' && trimmed[trimmed.length - 1] !== ']') {
      return true;
    }

    // Object truncation: starts with { but doesn't end with }
    if (trimmed[0] === '{' && trimmed[trimmed.length - 1] !== '}') {
      return true;
    }

    // Check for trailing comma before end (indicates substring cut)
    if (trimmed[trimmed.length - 2] === ',' && trimmed[trimmed.length - 1] !== '}') {
      return true;
    }

    return false;
  }

  function install() {
    if (_wrapped) return false;
    localStorage.setItem = _safeSetItem;
    _wrapped = true;
    return true;
  }

  function uninstall() {
    if (!_wrapped) return false;
    localStorage.setItem = _originalSetItem;
    _wrapped = false;
    return true;
  }

  function isInstalled() { return _wrapped; }

  // Auto-install on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }

  window.JSONFix = {
    install: install,
    uninstall: uninstall,
    isInstalled: isInstalled,
    isTruncatedJSON: _isTruncatedJSON,
    salvageTruncatedArray: _salvageTruncatedArray,
    closeBrackets: _closeBrackets
  };
})();
