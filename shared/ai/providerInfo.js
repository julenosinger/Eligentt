/**
 * Autonoma 1.2 — Client-side AI provider catalog (NO SECRETS).
 * ═══════════════════════════════════════════════════════════════════════════════
 * Thin metadata mirror of the server-side provider registry, for the future
 * provider selector UI. Contains ONLY public metadata (ids, display names, model
 * allowlists). API keys and credentials are server-side ONLY and never present here.
 *
 * Availability/selection is enforced server-side (functions/api/_ai/orchestrator.js);
 * this module never grants access to a provider.
 *
 * Wiring into the UI is deferred to Phase 1.3 (see docs).
 */
(function () {
  'use strict';

  var PROVIDERS = [
    { id: 'deepseek',  displayName: 'DeepSeek',         defaultModel: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner'] },
    { id: 'openai',    displayName: 'OpenAI (GPT)',     defaultModel: 'gpt-4o-mini',    models: ['gpt-4o-mini', 'gpt-4o'] },
    { id: 'anthropic', displayName: 'Anthropic Claude', defaultModel: 'claude-3-5-haiku-latest', models: ['claude-3-5-haiku-latest', 'claude-3-5-sonnet-latest'] },
  ];

  function list() { return PROVIDERS.slice(); }
  function get(id) {
    for (var i = 0; i < PROVIDERS.length; i++) if (PROVIDERS[i].id === id) return PROVIDERS[i];
    return null;
  }

  window.AIProviders = { list: list, get: get };
})();
