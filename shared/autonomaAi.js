/**
 * AutonomaAi — AI-first reasoning bridge for the visible Autonoma chat.
 * ═══════════════════════════════════════════════════════════════════════════════
 * Calls the multi-provider AI orchestrator (/api/autonoma2/chat) with the user's
 * message + recent conversation context, parses the SSE stream incrementally
 * (LF/CRLF/CR, multi-line data, multiple tool calls, [DONE], UTF-8 boundaries,
 * bounded buffer) into text and/or structured tool calls, and lets the caller
 * bridge those tool calls to the existing execution engine.
 *
 * SECURITY: API keys are server-side only. Tool calls are UNTRUSTED proposals —
 * callers must route them through the existing authorization gate + user approval.
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
   * Build the message list for the provider: a system role is NOT sent (the server
   * owns the trusted system prompt); recent conversation history (role/content
   * pairs) is prepended, then the current user message. History is bounded here
   * and re-bounded server-side.
   */
  function _buildMessages(msg, history) {
    var out = [];
    if (Array.isArray(history)) {
      for (var i = 0; i < history.length; i++) {
        var h = history[i];
        if (!h || !h.role || typeof h.content !== 'string') continue;
        if (h.role !== 'user' && h.role !== 'assistant') continue;
        out.push({ role: h.role, content: h.content.slice(0, 4000) });
      }
      out = out.slice(-20); // keep the most recent 20 turns
    }
    out.push({ role: 'user', content: String(msg).slice(0, 4000) });
    return out;
  }

  /**
   * chat(msg, opts) →
   *   { text } | { toolCalls:[{id,name,arguments}] } | { error, code } | null (fallback)
   * `opts.history` optionally provides prior turns for conversational context.
   * An interrupted stream (no [DONE]) returns { error, code:'interrupted' } rather
   * than a fabricated completed result.
   */
  async function chat(msg, opts) {
    if (!msg || !String(msg).trim()) return null;
    opts = opts || {};
    var provider = opts.provider || getProvider();
    var messages = _buildMessages(msg, opts.history);

    var headers = { 'Content-Type': 'application/json' };
    var tok = _sessionToken();
    if (tok) headers['Authorization'] = 'Bearer ' + tok;

    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 60000);
    var resp;
    try {
      resp = await fetch(API, {
        method: 'POST',
        headers: headers,
        credentials: 'include',
        body: JSON.stringify({ messages: messages, provider: provider }),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timeout);
      return { error: (e && e.name === 'AbortError') ? 'timeout' : 'network', code: (e && e.name === 'AbortError') ? 'timeout' : 'network' };
    }
    clearTimeout(timeout);

    if (!resp.ok) {
      var code = resp.status === 401 ? 'unauthorized' : resp.status === 503 ? 'unavailable' : 'provider_error';
      return { error: 'AI unavailable', code: code };
    }

    // Incremental SSE parse (fragmentation-safe).
    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    var dataLines = [];
    var fullText = '';
    var toolMap = {};   // index → { id, name, args }
    var sawDone = false;

    function finalizeEvent() {
      if (!dataLines.length) return;
      var payload = dataLines.join('\n');
      dataLines = [];
      if (!payload) return;
      if (payload === '[DONE]') { sawDone = true; return; }
      try {
        var parsed = JSON.parse(payload);
        var delta = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
        if (!delta) return;
        if (delta.content) fullText += delta.content;
        if (delta.tool_calls && delta.tool_calls.length) {
          for (var j = 0; j < delta.tool_calls.length; j++) {
            var tc = delta.tool_calls[j];
            var idx = (tc.index != null) ? tc.index : 0;
            if (!toolMap[idx]) toolMap[idx] = { id: tc.id || null, name: '', args: '' };
            if (tc.id) toolMap[idx].id = tc.id;
            if (tc.function && tc.function.name) toolMap[idx].name = tc.function.name;
            if (tc.function && tc.function.arguments) toolMap[idx].args += tc.function.arguments;
          }
        }
      } catch (_e) { /* malformed event — skip */ }
    }

    function handleLine(line) {
      if (line === '') { finalizeEvent(); return; }
      if (line[0] === ':') return; // comment
      var ci = line.indexOf(':');
      if (ci === -1) return;
      var field = line.slice(0, ci);
      var value = line.slice(ci + 1);
      if (value[0] === ' ') value = value.slice(1);
      if (field === 'data') dataLines.push(value);
    }

    try {
      while (true) {
        var r = await reader.read();
        if (r.done) break;
        buffer += decoder.decode(r.value, { stream: true });
        if (buffer.length > 256 * 1024) { dataLines = []; buffer = buffer.slice(-256 * 1024); } // bounded
        var parts = buffer.split(/\r\n|\n|\r/);
        var remainder = parts.pop();
        for (var i = 0; i < parts.length; i++) handleLine(parts[i]);
        buffer = remainder || '';
      }
      if (buffer.length) { for (var k = 0; k < buffer.split(/\r\n|\n|\r/).length; k++) handleLine(buffer.split(/\r\n|\n|\r/)[k]); buffer = ''; }
      finalizeEvent();
    } catch (_e) {
      // stream errored — treat as interrupted below
    }

    // Normalize tool calls (parse fragmented arguments JSON).
    var toolCalls = [];
    var idxs = Object.keys(toolMap).sort();
    for (var x = 0; x < idxs.length; x++) {
      var t = toolMap[idxs[x]];
      var args = {};
      try { args = JSON.parse(t.args); } catch (_e) { args = {}; }
      if (t.name) toolCalls.push({ id: t.id, name: t.name, arguments: args });
    }

    if (toolCalls.length) {
      return { toolCalls: toolCalls, completed: sawDone };
    }
    if (fullText && fullText.trim()) {
      return { text: fullText.trim(), completed: sawDone };
    }
    if (!sawDone) return { error: 'No content', code: 'interrupted' };
    return null;
  }

  window.AutonomaAi = { chat: chat, getProvider: getProvider, setProvider: setProvider };
})();
