/**
 * /api/autonoma2/chat — Autonoma 2 backend (multi-provider).
 * Routes through the unified AI orchestrator (functions/api/_ai/orchestrator.js).
 * Defaults to DeepSeek to preserve existing behaviour; OpenAI/Anthropic become
 * available when their API keys are configured and multi-provider is enabled.
 *
 * The model-generated tool calls are returned to the client as UNTRUSTED data;
 * the frontend execution gate (Autonoma 2) validates and gates every operation.
 */

import { stream, flags } from '../_ai/orchestrator.js';

const TIMEOUT_MS = 35000;

function getCorsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || 'https://elligentttest.pages.dev').split(',').map(s => s.trim());
  const origin = request.headers.get('Origin') || '';
  const corsOrigin = allowed.includes(origin) ? origin : allowed[0];
  return { 'Access-Control-Allow-Origin': corsOrigin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
}

function extractSessionToken(request) {
  const auth = request.headers.get('Authorization') || '';
  const bearer = auth.replace('Bearer ', '').trim();
  if (bearer && bearer.length >= 32) return bearer;
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/elligente_sid=([^;]+)/);
  return m ? m[1].trim() : '';
}

async function requireSession(request, env) {
  if (!env.AUTH_KV) {
    if (env.DEV_AUTH_BYPASS === 'true') return { ok: true, user: null };
    return { ok: false, status: 503, error: 'Authentication service unavailable' };
  }
  const token = extractSessionToken(request);
  if (!token || token.length < 32) return { ok: false, status: 401, error: 'Unauthorized' };
  const raw = await env.AUTH_KV.get('session:' + token);
  if (!raw) return { ok: false, status: 401, error: 'Session expired' };
  let session;
  try { session = JSON.parse(raw); } catch (_) { return { ok: false, status: 401, error: 'Session corrupt' }; }
  if (!session.userId) return { ok: false, status: 401, error: 'Session invalid' };
  return { ok: true, user: session };
}

function errSSE(cors, status, msg) {
  const body = 'data: ' + JSON.stringify({ error: msg }) + '\n\ndata: [DONE]\n\n';
  return new Response(body, { status, headers: { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: getCorsHeaders(context.request, context.env) });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = getCorsHeaders(request, env);

  const auth = await requireSession(request, env);
  if (!auth.ok) return errSSE(cors, auth.status, auth.error);

  const f = flags(env);
  if (!f.aiEnabled) return errSSE(cors, 503, 'AI is disabled');

  let body;
  try { body = await request.json(); } catch (_) { return errSSE(cors, 400, 'Invalid JSON'); }

  const { messages, tools, tool_choice, context: ctx, provider, model } = body;
  if (!Array.isArray(messages) || messages.length === 0) return errSSE(cors, 400, 'messages required');

  // Build context block for system prompt injection (unchanged).
  const ctxLines = [];
  if (ctx) {
    if (ctx.walletAddress) ctxLines.push('User EVM wallet: ' + ctx.walletAddress);
    if (ctx.circleWalletAddress) ctxLines.push('Circle AI wallet: ' + ctx.circleWalletAddress);
    if (ctx.chainId) ctxLines.push('Current chain: ' + ctx.chainId + ' (' + (ctx.chainName || '') + ')');
    if (ctx.needsProvision) ctxLines.push('Circle wallet: NOT provisioned — user should create one in Circle Agent');
    if (ctx.contacts && ctx.contacts.length) ctxLines.push('Saved contacts: ' + ctx.contacts.length);
  }

  const systemMsg = messages.find(m => m.role === 'system');
  const otherMessages = messages.filter(m => m.role !== 'system');
  const contextAppend = ctxLines.length ? '\n\nLIVE USER CONTEXT:\n' + ctxLines.join('\n') : '';
  const finalSystem = systemMsg
    ? { role: 'system', content: systemMsg.content + contextAppend }
    : { role: 'system', content: 'You are Autonoma 2, an AI financial agent on Arc Mainnet.' + contextAppend };

  const toolsList = (tools && tools.length) ? tools : undefined;

  const result = await stream(env, {
    provider: provider || undefined,
    model: model || undefined,
    messages: [finalSystem, ...otherMessages.slice(-20)],
    tools: toolsList,
    toolChoice: tool_choice || 'auto',
    maxTokens: 1024,
    temperature: 0.3,
    timeoutMs: TIMEOUT_MS,
    userId: auth.user ? auth.user.userId : null,
    operationType: 'chat',
  });

  if (!result.ok) {
    const statusMap = { ai_disabled: 503, multi_provider_disabled: 503, no_provider: 503, budget_exceeded: 429, timeout: 504, auth_error: 502, rate_limited: 502 };
    const status = statusMap[result.code] || 502;
    return errSSE(cors, status, result.error || 'AI error');
  }

  const headers = { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' };
  if (result.provider) headers['X-AI-Provider'] = result.provider;
  return new Response(result.response.body, { status: 200, headers });
}
