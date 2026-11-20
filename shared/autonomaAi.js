/**
 * AutonomaAi — AI-first reasoning bridge for the visible Autonoma chat.
 * ═══════════════════════════════════════════════════════════════════════════════
 * Calls the multi-provider AI orchestrator (/api/autonoma2/chat) with the user's
 * message and the configured provider, parses the SSE stream into text or a
 * structured tool call, and lets the caller bridge that tool call to the existing
 * execution engine. The external AI is the reasoning layer; deterministic tool
 * dispatch + execution stay in the existing services.
 *
 * SECURITY: API keys are server-side only. This module never sees credentials.
 * Tool calls returned here are UNTRUSTED proposals — callers must route them
 * through the existing authorization gate + user approval (no auto-execution).
 */
(function () {
  'use strict';

  var API = '/api/autonoma2/chat';
  var PROVIDER_KEY = 'autonoma_ai_provider_v1';
  var DEFAULT_PROVIDER = 'deepseek';
  var _provider = null;

  function getProvider() {
    if (_provider) return _provider;
    try { _provider = localStorage.getItem(PROVIDER_KEY) || DEFAULT_PROVIDER; } catch (_) { _provider = DEFAULT_PROVIDER; }
    return _provider;
  }

  function setProvider(id) {
    _provider = String(id || DEFAULT_PROVIDER);
    try { localStorage.setItem(PROVIDER_KEY, _provider); } catch (_) {}
  }

  function _sessionToken() {
    try {
      if (typeof AuthManager !== 'undefined' && typeof AuthManager.getSessionToken === 'function') {
        var t = AuthManager.getSessionToken(); if (t) return t;
      }
      return sessionStorage.getItem('elligente_st') || null;
    } catch (_) { return null; }
  }

  /**
   * chat(msg, opts) → { text } | { toolCall:{name,arguments} } | null (fallback)
   * Streams the AI response and returns either conversational text or a single
   * structured tool call. Returns null on any failure so the caller can fall back
   * to the existing deterministic pipeline.
   */
  async function chat(msg, opts) {
    if (!msg || !String(msg).trim()) return null;
    opts = opts || {};
    var provider = opts.provider || getProvider();

    var headers = { 'Content-Type': 'application/json' };
    var tok = _sessionToken();
    if (tok) headers['Authorization'] = 'Bearer ' + tok;

    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 30000);
    var resp;
    try {
      resp = await fetch(API, {
        method: 'POST',
        headers: headers,
        credentials: 'include',
        body: JSON.stringify({ messages: [{ role: 'user', content: String(msg) }], provider: provider }),
        signal: controller.signal,
      });
    } catch (_e) { clearTimeout(timeout); return null; }
    clearTimeout(timeout);
    if (!resp.ok) return null;

    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    var fullText = '';
    var toolName = '';
    var toolArgs = '';
    try {
      while (true) {
        var r = await reader.read();
        if (r.done) break;
        var chunk = decoder.decode(r.value, { stream: true });
        var lines = chunk.split('\n');
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (!line.startsWith('data: ')) continue;
          var data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            var parsed = JSON.parse(data);
            var delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
            if (!delta) continue;
            if (delta.content) fullText += delta.content;
            if (delta.tool_calls && delta.tool_calls[0]) {
              var tc = delta.tool_calls[0];
              if (tc.function && tc.function.name) toolName = tc.function.name;
              if (tc.function && tc.function.arguments) toolArgs += tc.function.arguments;
            }
          } catch (_e) { /* skip malformed */ }
        }
      }
    } catch (_e) { /* stream interrupted — return what we have */ }

    if (toolName) {
      var args = {};
      try { args = JSON.parse(toolArgs); } catch (_e) { args = {}; }
      return { toolCall: { name: toolName, arguments: args } };
    }
    if (fullText && fullText.trim()) return { text: fullText.trim() };
    return null;
  }

  window.AutonomaAi = { chat: chat, getProvider: getProvider, setProvider: setProvider };
})();
