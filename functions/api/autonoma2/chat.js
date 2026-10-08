/**
 * /api/autonoma2/chat — Autonoma 2 backend.
 * Streams DeepSeek responses directly to the client as SSE.
 * Uses the same session auth pattern as invoice.js / payment-links.js.
 */

const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';
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

  let body;
  try { body = await request.json(); } catch (_) { return errSSE(cors, 400, 'Invalid JSON'); }

  const { messages, tools, tool_choice, context: ctx } = body;
  if (!Array.isArray(messages) || messages.length === 0) return errSSE(cors, 400, 'messages required');

  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) return errSSE(cors, 503, 'LLM not configured');

  // Build context block for system prompt injection
  const ctxLines = [];
  if (ctx) {
    if (ctx.walletAddress) ctxLines.push('User EVM wallet: ' + ctx.walletAddress);
    if (ctx.circleWalletAddress) ctxLines.push('Circle AI wallet: ' + ctx.circleWalletAddress);
    if (ctx.chainId) ctxLines.push('Current chain: ' + ctx.chainId + ' (' + (ctx.chainName || '') + ')');
    if (ctx.needsProvision) ctxLines.push('Circle wallet: NOT provisioned — user should create one in Circle Agent');
    if (ctx.contacts && ctx.contacts.length) ctxLines.push('Saved contacts: ' + ctx.contacts.length);
  }

  // Inject context into system message
  const systemMsg = messages.find(m => m.role === 'system');
  const otherMessages = messages.filter(m => m.role !== 'system');
  const contextAppend = ctxLines.length ? '\n\nLIVE USER CONTEXT:\n' + ctxLines.join('\n') : '';
  const finalSystem = systemMsg
    ? { role: 'system', content: systemMsg.content + contextAppend }
    : { role: 'system', content: 'You are Autonoma 2, an AI financial agent on Arc Mainnet.' + contextAppend };

  const payload = {
    model: 'deepseek-chat',
    messages: [finalSystem, ...otherMessages.slice(-20)],
    max_tokens: 1024,
    temperature: 0.3,
    stream: true,
  };
  // Only pass tools if the client sent them and DeepSeek supports it
  if (tools && tools.length) {
    payload.tools = tools;
    payload.tool_choice = tool_choice || 'auto';
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

    const upstream = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      return errSSE(cors, 502, 'LLM error: ' + errText.slice(0, 200));
    }

    // Pass the SSE stream straight through to the client
    const { readable, writable } = new TransformStream();
    upstream.body.pipeTo(writable).catch(() => {});

    return new Response(readable, {
      status: 200,
      headers: {
        ...cors,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      },
    });

  } catch (err) {
    if (err.name === 'AbortError') return errSSE(cors, 504, 'LLM timeout');
    return errSSE(cors, 500, 'Internal error');
  }
}
