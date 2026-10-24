/**
 * CF Pages Function — POST /api/gateway/transfer
 *
 * Server-side proxy to Circle Gateway /v1/transfer endpoint.
 *
 * Official API shape (Circle docs, Oct 2026):
 *   Request:  POST https://gateway-api.circle.com/v1/transfer
 *             body = array of { burnIntent:{...}, signature:"0x..." }
 *   Response: array of { burnIntent:{...}, attestation:{payload:"...", signature:"..."} }
 *
 * IMPORTANT:
 *   Circle does not publish a /v1/estimate endpoint in their official documentation.
 *   The previous /v1/estimate proxy route has been removed. maxFee is a conservative
 *   constant set by the service (per the official Circle how-to example). If Circle
 *   publishes an official fee-estimation API in the future, add it here.
 *
 * Security:
 *   - CORS: exact-origin allowlist (configurable via env ALLOWED_ORIGINS).
 *   - Content-Type and body shape validated before forwarding.
 *   - Only known fields forwarded (burnIntent, signature) — extra fields stripped.
 *   - Body limited to 64 KB.
 *   - 18s server-side timeout (frontend uses 20s, so CF times out first → clean 504).
 *   - Cache-Control: no-store on all responses.
 *   - No authentication required (Circle Gateway API is permissionless).
 *   - Never logs attestations, signatures, or private data.
 *
 * Proxy isolation note:
 *   Circle's API is permissionless — any valid signed intent can be submitted.
 *   The proxy cannot enforce "depositor = authenticated user" without server-side
 *   session auth (not present in this architecture). Replay protection is at the
 *   protocol level: each salt can only be used once per Circle's contracts. A
 *   different depositor address cannot be forged without their private key.
 *
 * Allowlist note:
 *   Uses exact-match allowlist (not substring matching) to prevent spoofing with
 *   origins like evil-prefix-elligentt.com.
 */

const GATEWAY_API  = 'https://gateway-api.circle.com';
const MAX_BODY_LEN = 65536; // 64 KB
const TIMEOUT_MS   = 18000; // 18s

/**
 * Returns true if origin is in the exact allowlist.
 * Allowlist entries must be exact origins: scheme + host + optional port.
 * e.g. ['https://app.elligentt.com', 'https://elligentt.pages.dev']
 */
function isAllowedOrigin(origin, env) {
  if (!origin) return true; // server-to-server (no Origin header) — allowed
  const defaults = [
    'https://elligentt.com',
    'https://www.elligentt.com',
    'https://app.elligentt.com',
    'https://elligentt.pages.dev',
  ];
  const envList = env && env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  const allowlist = [...new Set([...defaults, ...envList])];
  // Allow localhost for local development only
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return true;
  if (/^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return true;
  return allowlist.includes(origin);
}

export async function onRequestPost(ctx) {
  const { request, env } = ctx;

  // ── CORS: exact-origin allowlist ──────────────────────────────────────────
  const origin = request.headers.get('Origin') || '';
  if (!isAllowedOrigin(origin, env)) {
    return new Response(JSON.stringify({ error:'forbidden' }), {
      status: 403,
      headers: {
        'Content-Type':  'application/json',
        'Cache-Control': 'no-store',
      },
    });
  }

  // ── Content-Type guard ────────────────────────────────────────────────────
  const ct = request.headers.get('Content-Type') || '';
  if (!ct.includes('application/json')) {
    return new Response(JSON.stringify({ error:'content_type_required' }), {
      status: 400,
      headers: { 'Content-Type':'application/json', 'Cache-Control':'no-store' },
    });
  }

  // ── Body size limit ───────────────────────────────────────────────────────
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_LEN) {
    return new Response(JSON.stringify({ error:'request_too_large' }), {
      status: 413,
      headers: { 'Content-Type':'application/json', 'Cache-Control':'no-store' },
    });
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(rawBody); } catch(_) {
    return new Response(JSON.stringify({ error:'invalid_json' }), {
      status: 400,
      headers: { 'Content-Type':'application/json', 'Cache-Control':'no-store' },
    });
  }

  // Body must be a non-empty array
  if (!Array.isArray(body) || body.length === 0) {
    return new Response(JSON.stringify({ error:'requests_required' }), {
      status: 400,
      headers: { 'Content-Type':'application/json', 'Cache-Control':'no-store' },
    });
  }

  // ── Validate each item ────────────────────────────────────────────────────
  for (const item of body) {
    if (!item || typeof item !== 'object') {
      return new Response(JSON.stringify({ error:'invalid_request_item' }), {
        status: 400,
        headers: { 'Content-Type':'application/json', 'Cache-Control':'no-store' },
      });
    }
    if (!item.burnIntent || typeof item.burnIntent !== 'object') {
      return new Response(JSON.stringify({ error:'burnIntent_required' }), {
        status: 400,
        headers: { 'Content-Type':'application/json', 'Cache-Control':'no-store' },
      });
    }
    if (typeof item.signature !== 'string') {
      return new Response(JSON.stringify({ error:'signature_required' }), {
        status: 400,
        headers: { 'Content-Type':'application/json', 'Cache-Control':'no-store' },
      });
    }
    // Basic signature format: 0x + at least 130 hex chars (65 bytes = r+s+v)
    if (!/^0x[0-9a-fA-F]{130,}$/.test(item.signature)) {
      return new Response(JSON.stringify({ error:'invalid_signature_format' }), {
        status: 400,
        headers: { 'Content-Type':'application/json', 'Cache-Control':'no-store' },
      });
    }
  }

  // ── Build clean upstream payload (only known fields forwarded) ────────────
  const upstream = body.map(item => ({
    burnIntent: item.burnIntent,
    signature:  item.signature,
  }));

  // ── Forward to Circle Gateway /v1/transfer ────────────────────────────────
  const ctrl    = new AbortController();
  const timerId = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  let upRes, upBody;
  try {
    upRes = await fetch(GATEWAY_API + '/v1/transfer', {
      method:  'POST',
      headers: { 'Content-Type':'application/json' },
      body:    JSON.stringify(upstream, (_k, v) =>
                 typeof v === 'bigint' ? v.toString() : v),
      signal:  ctrl.signal,
    });
    upBody = await upRes.text();
  } catch(err) {
    clearTimeout(timerId);
    const isTimeout = err.name === 'AbortError';
    return new Response(
      JSON.stringify({
        error:  isTimeout ? 'gateway_timeout' : 'gateway_unreachable',
        detail: err.message,
      }),
      {
        status:  isTimeout ? 504 : 502,
        headers: { 'Content-Type':'application/json', 'Cache-Control':'no-store' },
      }
    );
  }
  clearTimeout(timerId);

  // ── Parse and relay response ──────────────────────────────────────────────
  let parsed;
  try { parsed = JSON.parse(upBody); } catch(_) { parsed = { raw: upBody }; }

  return new Response(JSON.stringify(parsed), {
    status: upRes.status,
    headers: {
      'Content-Type':  'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

// Only POST is supported
export async function onRequestGet()    { return _method405(); }
export async function onRequestPut()    { return _method405(); }
export async function onRequestDelete() { return _method405(); }
function _method405() {
  return new Response(JSON.stringify({ error:'method_not_allowed' }), {
    status: 405,
    headers: { 'Content-Type':'application/json', 'Cache-Control':'no-store' },
  });
}
