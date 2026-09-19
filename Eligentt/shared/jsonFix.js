/**
 * Elligentt JSON Corruption Fix — Minimal Safe Version
 * Intercepts localStorage.setItem to prevent truncated JSON writes.
 * Uses direct _originalSetItem to avoid recursive calls.
 */
(function(){
  'use strict';
  var _originalSetItem = localStorage.setItem;
  var _wrapped = false;

  function _safeSetItem(key, value) {
    if (!key || value === undefined || value === null) {
      return _originalSetItem.call(localStorage, key, value);
    }
    var valStr = String(value);
    var trimmed = valStr.trim();

    // Block truncated JSON (array/object cut by substring)
    if (trimmed.length > 10) {
      var first = trimmed[0], last = trimmed[trimmed.length - 1];
      // Array truncation: [.... without ]
      if (first === '[' && last !== ']') {
        var fixed = _fixTruncated(trimmed);
        if (fixed) { _originalSetItem.call(localStorage, key, fixed); return; }
        return; // Drop corrupted data
      }
      // Object truncation: {.... without }
      if (first === '{' && last !== '}') {
        var fixed2 = _fixTruncated(trimmed);
        if (fixed2) { _originalSetItem.call(localStorage, key, fixed2); return; }
        return;
      }
    }
    // Pass through normal writes
    try { _originalSetItem.call(localStorage, key, value); } catch(e) {}
  }

  function _fixTruncated(str) {
    try {
      var depth = 0, inStr = false, esc = false, lastGood = 1;
      for (var i = 1; i < str.length; i++) {
        var ch = str[i];
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '{' || ch === '[') depth++;
        else if (ch === '}' || ch === ']') {
          depth--;
          if (depth === 0) lastGood = i + 1;
        }
      }
      if (lastGood <= 1) return null;
      var result = str.substring(0, lastGood).replace(/,\s*$/, '') + ']';
      JSON.parse(result); // validate
      return result;
    } catch(e) { return null; }
  }

  function install() {
    if (_wrapped) return false;
    localStorage.setItem = _safeSetItem;
    _wrapped = true;
    return true;
  }

  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', install); }
  else { install(); }

  window.JSONFix = { install: install, isInstalled: function(){ return _wrapped; } };
})();
