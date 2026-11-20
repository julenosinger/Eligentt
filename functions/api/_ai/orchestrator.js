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
import { recordUsage } from './usageLedger.js';

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

  // GLOBAL GATE FIRST — AUTONOMA_AI_ENABLED=false blocks ALL provider calls,
  // even an explicit provider request. Must run before any resolution.
  if (!f.aiEnabled) return { ok: false, code: 'ai_disabled', message: 'AI is disabled' };

  if (req && getProvider(req) && getProvider(req).isAvailable(env)) {
    if (!f.multiProviderEnabled && req !== 'deepseek') {
      return { ok: false, code: 'multi_provider_disabled', message: 'Multi-provider routing is disabled' };
    }
    return { ok: true, provider: getProvider(req), model: getProvider(req).defaultModel };
  }

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

  // NOTE: no hard per-user budget gate here — the KV daily counter is approximate
  // telemetry, not an atomic spend limit (see usageLedger.js). Hard rate limiting /
  // billing guarantees are disabled in this phase.

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
    // Fallback is permitted ONLY when multi-provider routing is enabled — when
    // disabled, the approved legacy DeepSeek path is the only provider.
    if ((upstream.status >= 500 || upstream.status === 429) && f.multiProviderEnabled) {
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
  // Fallback is only allowed when multi-provider routing is enabled (defence in
  // depth — the caller already gates, but this must never switch providers while
  // the legacy DeepSeek-only path is active).
  if (!flags(env).multiProviderEnabled) return { ok: false };

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
 * Streaming generation. OpenAI-compatible providers stream SSE directly (with
 * usage tracked from the final `usage` chunk); Anthropic (content_block_delta)
 * is materialised non-streaming and emitted as a single OpenAI-style SSE chunk
 * (preserving both text AND tool calls) so the client never branches on provider
 * format.
 *
 * Returns { ok:true, response } or { ok:false, error, code }.
 */
export async function stream(env, opts) {
  const requestId = opts.requestId || ('req_' + Math.random().toString(36).slice(2, 10));
  const resolution = resolveProvider(env, opts.provider);
  if (!resolution.ok) return { ok: false, error: resolution.message, code: resolution.code };

  const model = opts.model && resolution.provider.isModelAllowed(opts.model) ? opts.model : resolution.model;
  const apiKey = resolution.provider.apiKey(env);
  const userId = opts.userId || null;
  const inputEstimate = _estimateInputTokens(opts.messages);

  if (!resolution.provider.streamCompatible) {
    // Anthropic: non-streaming → single SSE chunk (preserve text + tool calls).
    const g = await generate(env, { ...opts, provider: resolution.provider.id, model, requestId });
    if (!g.ok) return { ok: false, error: g.error, code: g.code };
    const delta = {};
    if (g.result.message) delta.content = g.result.message;
    if (g.result.toolCalls && g.result.toolCalls.length) {
      delta.tool_calls = g.result.toolCalls.map((tc, i) => ({
        index: i,
        id: tc.id || null,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments || {}) },
      }));
    }
    const body = 'data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n';
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

  // Pass the stream through unchanged while parsing it for a provider-confirmed
  // `usage` chunk. Usage is recorded (best-effort) when the stream completes.
  const tracked = _usageTrackingStream(upstream.body, async (usage) => {
    try {
      await recordUsage(env, {
        requestId,
        userId,
        provider: resolution.provider.id,
        model,
        inputTokens: usage ? usage.inputTokens : inputEstimate,
        outputTokens: usage ? usage.outputTokens : null,
        operationType: opts.operationType || 'chat',
        operationId: opts.operationId || null,
        confirmed: !!usage,
        status: usage ? 'confirmed' : 'unknown_usage',
      });
    } catch (_) { /* telemetry must never break the user-facing response */ }
  });

  return {
    ok: true,
    response: new Response(tracked, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' },
    }),
    provider: resolution.provider.id,
  };
}

// Rough input-token estimate from message content (~4 chars/token). Used only as
// an UNCONFIRMED estimate when the provider returns no usage metadata.
function _estimateInputTokens(messages) {
  let chars = 0;
  for (const m of messages || []) {
    chars += String(m.content || '').length;
    chars += 4; // role overhead
  }
  return Math.max(1, Math.round(chars / 4));
}

// Wrap an upstream SSE body in a TransformStream that (1) passes every chunk
// through unchanged (preserving event ordering + content) and (2) parses SSE
// events (split safely across chunks) to extract a provider `usage` object.
// `onUsage` is invoked once at stream end with the extracted usage or null.
function _usageTrackingStream(upstreamBody, onUsage) {
  const decoder = new TextDecoder();
  let buffer = '';
  let usage = null;

  const transform = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of event.split('\n')) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed && parsed.usage) usage = parsed.usage;
            } catch (_) { /* skip malformed event */ }
          }
        }
      }
      controller.enqueue(chunk);
    },
    async flush() {
      if (usage) {
        await onUsage({
          inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? null,
          outputTokens: usage.completion_tokens ?? usage.output_tokens ?? null,
        });
      } else {
        await onUsage(null);
      }
    },
  });

  upstreamBody.pipeTo(transform.writable).catch(() => {});
  return transform.readable;
}
