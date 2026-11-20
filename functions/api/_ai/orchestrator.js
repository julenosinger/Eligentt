/**
 * Autonoma 1.2 — AI Orchestrator (server-side).
 * ═══════════════════════════════════════════════════════════════════════════════
 * Single routing layer over the provider registry. Enforces feature flags,
 * resolves a provider (explicit or automatic), applies timeouts, bounded safe
 * fallback, error mapping, and (optionally) usage metering.
 *
 * SECURITY:
 *  - Model-generated tool calls are returned as UNTRUSTED data; callers validate
 *    operation names, schemas and parameters before any execution.
 *  - Provider fallback is bounded and never duplicates tool execution or charges.
 *  - AI is never given private keys, entity secrets, or session tokens.
 */

import { getProvider, listProviders, defaultProviderId, DEFAULT_MODEL } from './providerRegistry.js';
import { recordUsage, checkDailyBudget } from './usageLedger.js';

const DEFAULT_TIMEOUT_MS = 35000;
const MAX_FALLBACK_PROVIDERS = 2; // primary + at most 1 fallback

// ── Feature flags (server-enforced; never overridable from the client) ──────
export function flags(env) {
  const bool = (v, dflt) => {
    if (v === undefined || v === null || v === '') return dflt;
    return String(v).toLowerCase() === 'true';
  };
  return {
    aiEnabled: bool(env && env.AUTONOMA_AI_ENABLED, true),
    multiProviderEnabled: bool(env && env.AUTONOMA_MULTI_PROVIDER_ENABLED, false),
    billingEnabled: bool(env && env.AUTONOMA_AI_BILLING_ENABLED, false),
    financialExecutionEnabled: bool(env && env.AUTONOMA_AI_FINANCIAL_EXECUTION_ENABLED, false),
    defaultProvider: (env && env.AUTONOMA_DEFAULT_PROVIDER) || null,
    dailyTokenLimit: Number(env && env.AUTONOMA_AI_DAILY_TOKEN_LIMIT) || 0,
  };
}

/**
 * Resolve the provider for a request.
 * - explicit `requestedId` is honoured only when configured + allowed.
 * - otherwise the default provider is used (DeepSeek first).
 * When multi-provider is disabled, non-default explicit requests are rejected
 * (the caller may fall back to the default).
 */
export function resolveProvider(env, requestedId) {
  const f = flags(env);
  const req = (requestedId || '').toLowerCase();

  if (req && getProvider(req) && getProvider(req).isAvailable(env)) {
    if (!f.multiProviderEnabled && req !== 'deepseek') {
      return { ok: false, code: 'multi_provider_disabled', message: 'Multi-provider routing is disabled' };
    }
    return { ok: true, provider: getProvider(req), model: req === 'deepseek' ? 'deepseek-chat' : getProvider(req).defaultModel };
  }

  if (!f.aiEnabled) return { ok: false, code: 'ai_disabled', message: 'AI is disabled' };

  const id = defaultProviderId(env);
  if (!id) return { ok: false, code: 'no_provider', message: 'No AI provider configured' };
  return { ok: true, provider: getProvider(id), model: getProvider(id).defaultModel };
}

function mapProviderError(status, bodyText) {
  const snippet = (bodyText || '').slice(0, 200);
  if (status === 401 || status === 403) return { code: 'auth_error', status: 502, message: 'AI provider auth failed', detail: snippet };
  if (status === 429) return { code: 'rate_limited', status: 502, message: 'AI provider rate limited', detail: snippet };
  if (status >= 500) return { code: 'provider_error', status: 502, message: 'AI provider error', detail: snippet };
  return { code: 'provider_error', status: 502, message: 'AI provider error (' + status + ')', detail: snippet };
}

/**
 * Non-streaming generation with normalized output + usage metering.
 * Returns { ok:true, result } or { ok:false, error, code }.
 */
export async function generate(env, opts) {
  const f = flags(env);
  const requestId = opts.requestId || ('req_' + Math.random().toString(36).slice(2, 10));
  const requestedModel = opts.model;

  const resolution = resolveProvider(env, opts.provider);
  if (!resolution.ok) return { ok: false, error: resolution.message, code: resolution.code };

  const model = requestedModel && resolution.provider.isModelAllowed(requestedModel)
    ? requestedModel
    : resolution.model;

  // Daily budget check (best-effort; only when a limit is configured).
  if (opts.userId) {
    const budget = await checkDailyBudget(env, opts.userId, f.dailyTokenLimit);
    if (!budget.ok) return { ok: false, error: 'Daily AI usage limit reached', code: 'budget_exceeded', used: budget.used, limit: budget.limit };
  }

  const apiKey = resolution.provider.apiKey(env);
  const req = resolution.provider.buildRequest({ model, messages: opts.messages, tools: opts.tools, temperature: opts.temperature, maxTokens: opts.maxTokens, stream: false });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(req.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...resolution.provider.authHeaders(apiKey) },
      body: JSON.stringify(req.body),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') return { ok: false, error: 'AI provider timeout', code: 'timeout' };
    return { ok: false, error: 'AI provider unreachable', code: 'network_error' };
  }
  clearTimeout(timer);

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '');
    const mapped = mapProviderError(upstream.status, errText);
    // Safe bounded fallback on transient failures (never on 4xx auth errors).
    if (upstream.status >= 500 || upstream.status === 429) {
      const fb = await _fallbackGenerate(env, opts, resolution.provider.id, requestId);
      if (fb.ok) return fb;
    }
    return { ok: false, error: mapped.message, code: mapped.code, detail: mapped.detail };
  }

  const json = await upstream.json().catch(() => null);
  if (!json) return { ok: false, error: 'Malformed AI response', code: 'malformed_response' };

  const result = resolution.provider.normalizeResponse(json, requestId);

  // Usage metering (server-side; never trusts client numbers).
  if (opts.userId) {
    await recordUsage(env, {
      requestId,
      userId: opts.userId,
      provider: result.provider,
      model: result.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      operationType: opts.operationType || 'chat',
      operationId: opts.operationId || null,
      confirmed: true,
      status: 'recorded',
    }).catch(() => {});
  }

  return { ok: true, result };
}

async function _fallbackGenerate(env, opts, failedProviderId, requestId) {
  // Try the next available provider (bounded) — text-only, never re-runs tools.
  const candidates = listProviders().filter((p) => p.id !== failedProviderId && p.isAvailable(env));
  if (!candidates.length) return { ok: false };
  const fb = candidates[0];
  const apiKey = fb.apiKey(env);
  const model = fb.defaultModel;
  const req = fb.buildRequest({ model, messages: opts.messages, tools: opts.tools, temperature: opts.temperature, maxTokens: opts.maxTokens, stream: false });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(req.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...fb.authHeaders(apiKey) },
      body: JSON.stringify(req.body),
      signal: ctrl.signal,
    });
  } catch (_) { clearTimeout(timer); return { ok: false }; }
  clearTimeout(timer);
  if (!upstream.ok) return { ok: false };
  const json = await upstream.json().catch(() => null);
  if (!json) return { ok: false };
  const result = fb.normalizeResponse(json, requestId);
  if (opts.userId) {
    await recordUsage(env, {
      requestId, userId: opts.userId, provider: result.provider, model: result.model,
      inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
      operationType: opts.operationType || 'chat', operationId: opts.operationId || null,
      confirmed: true, status: 'recorded',
    }).catch(() => {});
  }
  return { ok: true, result, fallback: true };
}

/**
 * Streaming generation. OpenAI-compatible providers stream SSE directly;
 * Anthropic (content_block_delta) is materialised non-streaming and emitted as a
 * single OpenAI-style SSE chunk so the client never branches on provider format.
 *
 * Returns { ok:true, response } or { ok:false, error, code }.
 */
export async function stream(env, opts) {
  const resolution = resolveProvider(env, opts.provider);
  if (!resolution.ok) return { ok: false, error: resolution.message, code: resolution.code };

  const model = opts.model && resolution.provider.isModelAllowed(opts.model) ? opts.model : resolution.model;
  const apiKey = resolution.provider.apiKey(env);

  if (!resolution.provider.streamCompatible) {
    // Anthropic: non-streaming → single SSE chunk.
    const g = await generate(env, { ...opts, provider: resolution.provider.id, model });
    if (!g.ok) return { ok: false, error: g.error, code: g.code };
    const body = 'data: ' + JSON.stringify({ choices: [{ delta: { content: g.result.message } }] }) + '\n\ndata: [DONE]\n\n';
    return { ok: true, response: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } }), provider: resolution.provider.id };
  }

  const req = resolution.provider.buildRequest({ model, messages: opts.messages, tools: opts.tools, temperature: opts.temperature, maxTokens: opts.maxTokens, stream: true });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(req.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...resolution.provider.authHeaders(apiKey) },
      body: JSON.stringify(req.body),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') return { ok: false, error: 'AI provider timeout', code: 'timeout' };
    return { ok: false, error: 'AI provider unreachable', code: 'network_error' };
  }
  clearTimeout(timer);

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '');
    const mapped = mapProviderError(upstream.status, errText);
    return { ok: false, error: mapped.message, code: mapped.code };
  }

  const { readable, writable } = new TransformStream();
  upstream.body.pipeTo(writable).catch(() => {});
  return {
    ok: true,
    response: new Response(readable, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' },
    }),
    provider: resolution.provider.id,
  };
}
