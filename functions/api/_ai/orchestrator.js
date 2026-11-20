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

  // ── Multi-provider DISABLED: DeepSeek is the ONLY permitted provider. ──────
  // AUTONOMA_DEFAULT_PROVIDER must NOT bypass this; no fallback to another
  // provider; an explicit non-deepseek request is rejected.
  if (!f.multiProviderEnabled) {
    if (req && req !== 'deepseek') {
      return { ok: false, code: 'multi_provider_disabled', message: 'Multi-provider routing is disabled' };
    }
    if (!getProvider('deepseek').isAvailable(env)) {
      return { ok: false, code: 'no_provider', message: 'DeepSeek is not configured' };
    }
    return { ok: true, provider: getProvider('deepseek'), model: getProvider('deepseek').defaultModel };
  }

  // ── Multi-provider ENABLED: explicit must be a valid, configured provider ──
  if (req) {
    const p = getProvider(req);
    if (!p) return { ok: false, code: 'invalid_provider', message: 'Unknown provider: ' + req };
    if (!p.isAvailable(env)) return { ok: false, code: 'provider_not_configured', message: 'Provider not configured: ' + req };
    return { ok: true, provider: p, model: p.defaultModel };
  }

  // Automatic: honor AUTONOMA_DEFAULT_PROVIDER, then DeepSeek, then first available.
  const id = defaultProviderId(env);
  if (!id) return { ok: false, code: 'no_provider', message: 'No AI provider configured' };
  return { ok: true, provider: getProvider(id), model: getProvider(id).defaultModel };
}

/**
 * Resolve the model for a request against the provider's allowlist.
 * An unsupported model is an EXPLICIT error — never silently substituted with a
 * default (which could change cost or capabilities).
 */
function resolveModel(provider, requestedModel) {
  if (!requestedModel) return { ok: true, model: provider.defaultModel };
  if (provider.isModelAllowed(requestedModel)) return { ok: true, model: requestedModel };
  return { ok: false, code: 'invalid_model', message: 'Unsupported model for ' + provider.id + ': ' + requestedModel };
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

  const m = resolveModel(resolution.provider, requestedModel);
  if (!m.ok) return { ok: false, error: m.message, code: m.code };
  const model = m.model;

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

  const m = resolveModel(resolution.provider, opts.model);
  if (!m.ok) return { ok: false, error: m.message, code: m.code };
  const model = m.model;
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
  // `usage` chunk. Usage is recorded asynchronously (never blocking the stream).
  const tracked = _usageTrackingStream(upstream.body, ({ usage, completed }) => {
    const recordPromise = (async () => {
      try {
        const r = await recordUsage(env, {
          requestId,
          userId,
          provider: resolution.provider.id,
          model,
          inputTokens: usage ? usage.inputTokens : inputEstimate,
          outputTokens: usage ? usage.outputTokens : null,
          operationType: opts.operationType || 'chat',
          operationId: opts.operationId || null,
          confirmed: !!usage,
          status: usage ? (completed ? 'confirmed' : 'interrupted') : 'unknown_usage',
        });
        // Sanitized observability: log only the fixed failure code, never content.
        if (!r.ok) console.warn('[autonoma-ai] usage record failed:', r.error || 'unknown');
      } catch (e) {
        // Never log the error message (may embed sensitive data) — type only.
        console.warn('[autonoma-ai] usage record exception:', (e && e.name) || 'unknown');
      }
    })();
    // Non-blocking persistence: extend the worker lifetime via waitUntil (Cloudflare)
    // when available; otherwise fire-and-forget (best-effort, documented).
    if (typeof opts.waitUntil === 'function') {
      try { opts.waitUntil(recordPromise); } catch (_) { /* ignore */ }
    }
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
// through unchanged (preserving exact bytes + event ordering) and (2) parses SSE
// incrementally per the event-stream spec (LF / CRLF / CR line endings incl.
// cross-chunk CRLF, multi-line `data:`, comment lines, arbitrary UTF-8 chunk
// boundaries) to extract a provider `usage` object and track `[DONE]` completion.
// `onUsage({ usage, completed })` is called once at stream end and NOT awaited.
function _usageTrackingStream(upstreamBody, onUsage) {
  const decoder = new TextDecoder();
  let buffer = '';
  let pendingCR = false; // previous chunk ended with a lone \r (possible CRLF split)
  let dataLines = [];
  let dataSize = 0;
  let usage = null;
  let sawDone = false;
  const MAX_BUFFER = 256 * 1024; // cap on the line buffer
  const MAX_EVENT = 256 * 1024;  // cap on the accumulated event data

  function finalizeEvent() {
    if (!dataLines.length) return;
    const payload = dataLines.join('\n');
    dataLines = [];
    dataSize = 0;
    if (!payload) return;
    if (payload === '[DONE]') { sawDone = true; return; }
    try {
      const parsed = JSON.parse(payload);
      if (parsed && parsed.usage) usage = parsed.usage;
    } catch (_) { /* malformed metadata — never treated as confirmed usage */ }
  }

  function handleLine(line) {
    if (line === '') { finalizeEvent(); return; }
    if (line[0] === ':') return; // comment
    const ci = line.indexOf(':');
    if (ci === -1) return;
    const field = line.slice(0, ci);
    let value = line.slice(ci + 1);
    if (value[0] === ' ') value = value.slice(1); // strip single leading space
    if (field === 'data') {
      dataLines.push(value);
      dataSize += value.length;
      if (dataSize > MAX_EVENT) { dataLines = []; dataSize = 0; } // oversized event: drop parse state
    }
    // other fields (event/id/retry) are ignored for usage extraction
  }

  function processBuffer(final) {
    // Cross-chunk CRLF: a lone \r at the end of the previous chunk + a leading \n
    // here form ONE CRLF terminator — skip the \n.
    if (pendingCR && buffer.length) {
      if (buffer.charCodeAt(0) === 10) buffer = buffer.slice(1);
      pendingCR = false;
    }
    let start = 0;
    let i = 0;
    while (i < buffer.length) {
      const ch = buffer.charCodeAt(i);
      if (ch === 10) { // LF
        handleLine(buffer.slice(start, i)); i++; start = i;
      } else if (ch === 13) { // CR
        const next = buffer.charCodeAt(i + 1);
        if (next === 10) { // CRLF
          handleLine(buffer.slice(start, i)); i += 2; start = i;
        } else if (i + 1 < buffer.length) { // lone CR mid-buffer
          handleLine(buffer.slice(start, i)); i++; start = i;
        } else { // trailing lone CR — emit line, defer CR to next chunk
          handleLine(buffer.slice(start, i)); i++; start = i; pendingCR = true;
        }
      } else { i++; }
    }
    buffer = buffer.slice(start);
    if (final) {
      if (buffer.length) { handleLine(buffer); buffer = ''; }
      finalizeEvent();
    }
  }

  const transform = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      if (buffer.length > MAX_BUFFER) { dataLines = []; dataSize = 0; buffer = buffer.slice(-MAX_BUFFER); pendingCR = false; }
      processBuffer(false);
      controller.enqueue(chunk);
    },
    flush() {
      processBuffer(true);
      const completed = sawDone;
      onUsage({
        usage: usage ? { inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? null, outputTokens: usage.completion_tokens ?? usage.output_tokens ?? null } : null,
        completed,
      });
    },
  });

  upstreamBody.pipeTo(transform.writable).catch(() => {});
  return transform.readable;
}
