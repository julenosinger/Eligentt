export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  if (url.pathname === '/api/deepseek/chat') {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': getAllowedOrigin(request, env),
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        }
      });
    }
    return handleDeepSeekProxy(request, env);
  }

  if (url.pathname === '/api/openai/chat') {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': getAllowedOrigin(request, env),
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        }
      });
    }
    return handleOpenAIProxy(request, env);
  }

  if (url.pathname === '/api/anthropic/chat') {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': getAllowedOrigin(request, env),
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version',
          'Access-Control-Max-Age': '86400',
        }
      });
    }
    return handleAnthropicProxy(request, env);
  }

  if (url.pathname.startsWith('/api/circle/')) {
    return handleCircleProxy(request, env, url);
  }

  if (url.pathname.startsWith('/api/iris/')) {
    return handleIrisProxy(request, env, url);
  }

  if (url.pathname.startsWith('/api/agent')) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin': getAllowedOrigin(request, env),
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400'
      }});
    }
    return handleAgentWallet(request, env, url);
  }

  const isApiPath = url.pathname.startsWith('/api/');
  const hasExtension = /\.\w+$/.test(url.pathname);
  const isSpaRoute = !isApiPath && !hasExtension;
  if (!isSpaRoute) {
    return next();
  }

  const response = await next();
  let html = await response.text();

  const wcProjectId = env.WC_PROJECT_ID || '';
  const googleClientId = env.GOOGLE_CLIENT_ID || '';

  html = html.replaceAll('__WC_PROJECT_ID_PLACEHOLDER__', wcProjectId);
  html = html.replaceAll('__GOOGLE_CLIENT_ID_PLACEHOLDER__', googleClientId);
  html = html.replaceAll('__KIT_KEY_PLACEHOLDER__', '');
  html = html.replaceAll('__TEST_API_KEY_PLACEHOLDER__', '');

  return new Response(html, {
    status: response.status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  });
}

function getAllowedOrigin(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || 'https://elligente.pages.dev').split(',').map(s => s.trim());
  const origin = request.headers.get('Origin') || '';
  return allowed.includes(origin) ? origin : allowed[0];
}

async function handleCircleProxy(request, env, url) {
  const apiKey = env.TEST_API_KEY || env.KIT_KEY || '';
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'API key not configured' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  const circlePath = url.pathname.replace('/api/circle', '');
  const circleUrl = 'https://api.circle.com' + circlePath + url.search;

  try {
    const resp = await fetch(circleUrl, {
      method: request.method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: request.method !== 'GET' && request.method !== 'HEAD'
        ? await request.text() : undefined,
    });

    const data = await resp.text();
    const corsOrigin = getAllowedOrigin(request, env);
    return new Response(data, {
      status: resp.status,
      headers: {
        'Content-Type': resp.headers.get('Content-Type') || 'application/json',
        'Access-Control-Allow-Origin': corsOrigin,
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Circle API unavailable' }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleIrisProxy(request, env, url) {
  const corsOrigin = getAllowedOrigin(request, env);
  const irisPath = url.pathname.replace('/api/iris', '');
  const irisUrl = 'https://iris-api.circle.com' + irisPath + url.search;

  try {
    const resp = await fetch(irisUrl, { method: request.method });
    const data = await resp.text();
    return new Response(data, {
      status: resp.status,
      headers: {
        'Content-Type': resp.headers.get('Content-Type') || 'application/json',
        'Access-Control-Allow-Origin': corsOrigin,
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Iris API unavailable' }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleDeepSeekProxy(request, env) {
  const apiKey = env.DEEPSEEK_API_KEY || '';
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'DeepSeek API key not configured on server' }), {
      status: 503, headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': getAllowedOrigin(request, env),
      }
    });
  }

  try {
    const body = await request.text();
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: body,
    });
    const data = await resp.text();
    return new Response(data, {
      status: resp.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': getAllowedOrigin(request, env),
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'DeepSeek API unavailable' }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleOpenAIProxy(request, env) {
  const apiKey = env.OPENAI_API_KEY || '';
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'OpenAI API key not configured on server' }), {
      status: 503, headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': getAllowedOrigin(request, env),
      }
    });
  }

  try {
    const body = await request.text();
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: body,
    });
    const data = await resp.text();
    return new Response(data, {
      status: resp.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': getAllowedOrigin(request, env),
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'OpenAI API unavailable' }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ══════════════════════════════════════════════════════════
//  CIRCLE AGENT WALLET — Developer-Controlled Wallets API
//  Uses: CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_WALLET_ID
//  All secrets live server-side only (Cloudflare Secrets).
//  Endpoints:
//    GET  /api/agent/status          — wallet info + USDC balance
//    GET  /api/agent/balance         — USDC balance on Arc + supported chains
//    POST /api/agent/transfer        — initiate USDC transfer (requires body)
//    GET  /api/agent/transactions    — recent tx history
//    POST /api/agent/validate        — validate a transfer intent before execution
// ══════════════════════════════════════════════════════════
async function handleAgentWallet(request, env, url) {
  const corsOrigin = getAllowedOrigin(request, env);
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin };

  const apiKey = env.CIRCLE_API_KEY || env.TEST_API_KEY || '';
  const entitySecret = env.CIRCLE_ENTITY_SECRET || '';
  const walletId = env.CIRCLE_WALLET_ID || '';
  const walletAddress = env.CIRCLE_WALLET_ADDRESS || '';
  const paused = (env.AGENT_SIGNER_PAUSED || '').toLowerCase() === 'true';

  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Circle API key not configured', configured: false }), { status: 503, headers });
  }

  const action = url.pathname.replace('/api/agent', '').replace(/^\//, '') || 'status';

  // ── Shared Circle API call helper ──
  async function circleAPI(path, method = 'GET', body = null) {
    const resp = await fetch('https://api.circle.com' + path, {
      method,
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await resp.text();
    try { return { ok: resp.ok, status: resp.status, data: JSON.parse(text) }; }
    catch(_) { return { ok: false, status: resp.status, data: { error: text } }; }
  }

  // ── GET /api/agent/status ──
  if (action === 'status' || action === '') {
    try {
      // Wallet details
      const walletRes = walletId
        ? await circleAPI('/v1/w3s/wallets/' + walletId)
        : { ok: false, data: { error: 'CIRCLE_WALLET_ID not set' } };

      // USDC balances on all chains for this wallet
      const balRes = walletId
        ? await circleAPI('/v1/w3s/wallets/' + walletId + '/balances')
        : { ok: false, data: { error: 'CIRCLE_WALLET_ID not set' } };

      return new Response(JSON.stringify({
        configured: true,
        paused,
        walletId: walletId || null,
        walletAddress: walletAddress || null,
        wallet: walletRes.ok ? walletRes.data.data : null,
        balances: balRes.ok ? balRes.data.data : null,
        entitySecretSet: !!entitySecret,
        error: !walletRes.ok ? walletRes.data : null,
      }), { status: 200, headers });
    } catch(e) {
      return new Response(JSON.stringify({ error: e.message, configured: true }), { status: 500, headers });
    }
  }

  // ── GET /api/agent/balance ──
  if (action === 'balance') {
    if (!walletId) return new Response(JSON.stringify({ error: 'CIRCLE_WALLET_ID not configured' }), { status: 503, headers });
    try {
      const res = await circleAPI('/v1/w3s/wallets/' + walletId + '/balances');
      return new Response(JSON.stringify(res.ok ? res.data : { error: res.data }), { status: res.ok ? 200 : res.status, headers });
    } catch(e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
    }
  }

  // ── GET /api/agent/transactions ──
  if (action === 'transactions') {
    if (!walletId) return new Response(JSON.stringify({ error: 'CIRCLE_WALLET_ID not configured' }), { status: 503, headers });
    try {
      const res = await circleAPI('/v1/w3s/transactions?walletIds=' + walletId + '&pageSize=20');
      return new Response(JSON.stringify(res.ok ? res.data : { error: res.data }), { status: res.ok ? 200 : res.status, headers });
    } catch(e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
    }
  }

  // ── POST /api/agent/transfer ──
  if (action === 'transfer' && request.method === 'POST') {
    if (paused) return new Response(JSON.stringify({ error: 'Agent signer is paused (kill switch active)' }), { status: 403, headers });
    if (!walletId || !entitySecret) {
      return new Response(JSON.stringify({ error: 'Agent wallet not fully configured (walletId or entitySecret missing)' }), { status: 503, headers });
    }
    try {
      let body;
      try { body = await request.json(); } catch(_) { return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers }); }
      const { to, amount, tokenAddress, blockchain, idempotencyKey } = body;
      if (!to || !amount || !tokenAddress || !blockchain) {
        return new Response(JSON.stringify({ error: 'Missing required fields: to, amount, tokenAddress, blockchain' }), { status: 400, headers });
      }
      // Circle developer-controlled wallets transfer endpoint
      const payload = {
        idempotencyKey: idempotencyKey || crypto.randomUUID(),
        walletId,
        tokenId: tokenAddress,  // Circle uses tokenId (contract address) for ERC-20 transfers
        destinationAddress: to,
        amounts: [String(amount)],
        blockchain: blockchain || 'ARC',
        entitySecretCiphertext: entitySecret,  // server-side only — never reaches browser
        fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
      };
      const res = await circleAPI('/v1/w3s/developer/transactions/transfer', 'POST', payload);
      return new Response(JSON.stringify(res.ok ? res.data : { error: res.data }), { status: res.ok ? 201 : res.status, headers });
    } catch(e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
    }
  }

  // ── POST /api/agent/validate ──
  if (action === 'validate' && request.method === 'POST') {
    try {
      let body;
      try { body = await request.json(); } catch(_) { return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers }); }
      const { to, amount } = body;
      const valid = to && /^0x[a-fA-F0-9]{40}$/.test(to) && amount && parseFloat(amount) > 0;
      return new Response(JSON.stringify({
        valid,
        checks: {
          addressFormat: /^0x[a-fA-F0-9]{40}$/.test(to || ''),
          amountPositive: parseFloat(amount || 0) > 0,
          agentConfigured: !!walletId && !!apiKey,
          agentNotPaused: !paused,
        }
      }), { status: 200, headers });
    } catch(e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
    }
  }

  return new Response(JSON.stringify({ error: 'Unknown agent action: ' + action }), { status: 404, headers });
}

async function handleAnthropicProxy(request, env) {
  const apiKey = env.ANTHROPIC_API_KEY || '';
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Anthropic API key not configured on server' }), {
      status: 503, headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': getAllowedOrigin(request, env),
      }
    });
  }

  try {
    const body = await request.text();
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: body,
    });
    const data = await resp.text();
    return new Response(data, {
      status: resp.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': getAllowedOrigin(request, env),
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Anthropic API unavailable' }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }
}
