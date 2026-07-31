export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  if (url.pathname.startsWith('/api/circle/')) {
    return handleCircleProxy(request, env, url);
  }

  if (url.pathname.startsWith('/api/iris/')) {
    return handleIrisProxy(request, env, url);
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
    const controller = new AbortController();
    const timeout = setTimeout(function() { controller.abort(); }, 15000);
    const resp = await fetch(circleUrl, {
      method: request.method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: request.method !== 'GET' && request.method !== 'HEAD'
        ? await request.text() : undefined,
      signal: controller.signal,
    });
    clearTimeout(timeout);

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
  const irisUrl = 'https://iris-api-sandbox.circle.com' + irisPath + url.search;

  try {
    const controller2 = new AbortController();
    const timeout2 = setTimeout(function() { controller2.abort(); }, 15000);
    const resp = await fetch(irisUrl, { method: request.method, signal: controller2.signal });
    clearTimeout(timeout2);
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
