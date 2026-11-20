/**
 * Autonoma 1.2 — AI Provider Registry (server-side).
 * ═══════════════════════════════════════════════════════════════════════════════
 * Unified, extensible abstraction over AI providers. Each adapter exposes a common
 * `generate`/`buildRequest` contract while hiding provider-specific request shapes,
 * tool-calling formats, token accounting and error responses.
 *
 * SECURITY: API keys are read server-side from `env` only. This module MUST NEVER
 * be bundled into the browser. Provider differences (OpenAI-compatible vs Anthropic
 * `content_block_delta` streaming, `tool_calls` vs `tool_use`, token field names)
 * are normalised here so callers never branch on the provider.
 */

export const AI_PROVIDER_IDS = ['deepseek', 'openai', 'anthropic'];

const DEFAULT_MODEL = 'deepseek-chat';

// ── OpenAI-compatible adapter factory (DeepSeek + OpenAI share the chat/completions shape) ──
function openAiCompatibleAdapter(cfg) {
  return {
    id: cfg.id,
    displayName: cfg.displayName,
    defaultModel: cfg.defaultModel,
    models: cfg.models,
    apiKeyEnv: cfg.apiKeyEnv,
    baseUrl: cfg.baseUrl,
    streamCompatible: true, // emits OpenAI-style SSE (choices[].delta)
    isAvailable(env) { return !!(env && env[cfg.apiKeyEnv]); },
    apiKey(env) { return env ? (env[cfg.apiKeyEnv] || '') : ''; },
    isModelAllowed(model) { return cfg.models.indexOf(model) !== -1; },
    authHeaders(apiKey) { return { 'Authorization': 'Bearer ' + apiKey }; },

    buildRequest({ model, messages, tools, temperature, maxTokens, stream, toolChoice }) {
      const body = {
        model: model || cfg.defaultModel,
        messages,
        temperature: (temperature === undefined || temperature === null) ? 0.3 : temperature,
        max_tokens: maxTokens || 1024,
        stream: !!stream,
      };
      if (tools && tools.length) {
        body.tools = tools;
        body.tool_choice = _normalizeToolChoice(toolChoice);
      }
      // Request a trailing usage chunk on streaming so the server can record
      // provider-confirmed token counts (OpenAI-compatible `stream_options`).
      if (stream) body.stream_options = { include_usage: true };
      return { url: cfg.baseUrl + '/chat/completions', body };
    },

    normalizeResponse(json, requestId) {
      const choice = json && json.choices && json.choices[0];
      const msg = (choice && choice.message) || {};
      const toolCalls = (msg.tool_calls || []).map((tc) => ({
        id: tc.id || null,
        name: (tc.function && tc.function.name) || null,
        arguments: _safeParseArgs(tc.function && tc.function.arguments),
      })).filter((tc) => tc.name);
      const u = json && json.usage;
      // Distinguish MISSING usage (null tokens, present:false) from a valid
      // provider-confirmed zero (present:true). Never collapse missing → 0.
      const usage = u ? {
        inputTokens: u.prompt_tokens ?? u.input_tokens ?? null,
        outputTokens: u.completion_tokens ?? u.output_tokens ?? null,
        totalTokens: u.total_tokens ?? ((u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)),
        present: true,
      } : { inputTokens: null, outputTokens: null, totalTokens: null, present: false };
      return {
        provider: cfg.id,
        model: (json && json.model) || cfg.defaultModel,
        message: msg.content || '',
        toolCalls,
        usage,
        finishReason: (choice && choice.finish_reason) || null,
        requestId,
      };
    },
  };
}

// ── Anthropic adapter (different /v1/messages shape) ──
const anthropicAdapter = {
  id: 'anthropic',
  displayName: 'Anthropic Claude',
  defaultModel: 'claude-3-5-haiku-latest',
  models: ['claude-3-5-haiku-latest', 'claude-3-5-sonnet-latest'],
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  baseUrl: 'https://api.anthropic.com/v1',
  streamCompatible: false, // Anthropic streams content_block_delta (transformed by orchestrator)
  isAvailable(env) { return !!(env && env.ANTHROPIC_API_KEY); },
  apiKey(env) { return env ? (env.ANTHROPIC_API_KEY || '') : ''; },
  isModelAllowed(model) { return this.models.indexOf(model) !== -1; },
  authHeaders(apiKey) {
    return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  },

  buildRequest({ model, messages, tools, temperature, maxTokens, stream, toolChoice }) {
    // Map OpenAI-style messages → Anthropic messages.
    const systemParts = [];
    const anthropicMessages = [];
    for (const m of messages || []) {
      if (m.role === 'system') { systemParts.push(m.content || ''); continue; }
      anthropicMessages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content || '' });
    }
    const anthropicTools = (tools || []).map((t) => ({
      name: t.function && t.function.name,
      description: t.function && t.function.description,
      input_schema: (t.function && t.function.parameters) || { type: 'object', properties: {} },
    }));
    const body = {
      model: model || this.defaultModel,
      max_tokens: maxTokens || 1024,
      temperature: (temperature === undefined || temperature === null) ? 0.3 : temperature,
      stream: !!stream,
    };
    if (systemParts.length) body.system = systemParts.join('\n');
    body.messages = anthropicMessages;
    if (anthropicTools.length) body.tools = anthropicTools;
    const tc = _anthropicToolChoice(toolChoice);
    if (tc) body.tool_choice = tc;
    return { url: this.baseUrl + '/messages', body };
  },

  normalizeResponse(json, requestId) {
    const content = (json && json.content) || [];
    let message = '';
    const toolCalls = [];
    for (const block of content) {
      if (block.type === 'text') message += (block.text || '');
      else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id || null, name: block.name || null, arguments: block.input || {} });
      }
    }
    const u = json && json.usage;
    const usage = u ? {
      inputTokens: u.input_tokens ?? null,
      outputTokens: u.output_tokens ?? null,
      totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
      present: true,
    } : { inputTokens: null, outputTokens: null, totalTokens: null, present: false };
    return {
      provider: 'anthropic',
      model: json && json.model,
      message,
      toolCalls,
      usage,
      finishReason: (json && json.stop_reason) || null,
      requestId,
    };
  },
};

function _safeParseArgs(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

// Normalize an OpenAI-compatible tool_choice. Defaults to 'auto'; allows the
// supported scalar options and a well-formed single-function object. Unsupported
// values fall back to 'auto' (never silently enable a specific/forced tool).
function _normalizeToolChoice(tc) {
  if (tc === undefined || tc === null) return 'auto';
  if (tc === 'auto' || tc === 'none' || tc === 'required') return tc;
  if (typeof tc === 'object' && tc && tc.type === 'function' && tc.function && typeof tc.function.name === 'string') {
    return { type: 'function', function: { name: tc.function.name } };
  }
  return 'auto';
}

// Map an OpenAI-style tool_choice to Anthropic's tool_choice. Defaults to null
// (omit → provider default 'auto'). 'required' → 'any'; 'none' → { type:'none' };
// a specific function → { type:'tool', name }.
function _anthropicToolChoice(tc) {
  if (tc === undefined || tc === null || tc === 'auto') return null;
  if (tc === 'required') return { type: 'any' };
  if (tc === 'none') return { type: 'none' };
  if (typeof tc === 'object' && tc && tc.function && typeof tc.function.name === 'string') {
    return { type: 'tool', name: tc.function.name };
  }
  return null;
}

const REGISTRY = {
  deepseek: openAiCompatibleAdapter({
    id: 'deepseek', displayName: 'DeepSeek', defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'], apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseUrl: 'https://api.deepseek.com/v1',
  }),
  openai: openAiCompatibleAdapter({
    id: 'openai', displayName: 'OpenAI', defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o'], apiKeyEnv: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1',
  }),
  anthropic: anthropicAdapter,
};

export function getProvider(id) { return REGISTRY[id] || null; }

export function listProviders() { return Object.values(REGISTRY); }

/** Providers that are currently configured (have an API key). */
export function availableProviders(env) {
  return Object.values(REGISTRY).filter((p) => p.isAvailable(env));
}

/** Resolve the effective default provider id from env. */
export function defaultProviderId(env) {
  const requested = (env && env.AUTONOMA_DEFAULT_PROVIDER || '').toLowerCase();
  if (requested && REGISTRY[requested] && REGISTRY[requested].isAvailable(env)) return requested;
  if (REGISTRY.deepseek.isAvailable(env)) return 'deepseek';
  const first = availableProviders(env)[0];
  return first ? first.id : null;
}

export { DEFAULT_MODEL };
