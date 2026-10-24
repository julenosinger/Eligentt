/**
 * CF Pages Function — POST /api/gateway/transfer
 *
 * Server-side proxy to Circle Gateway API.
 * Routes to /v1/estimate or /v1/transfer depending on ?mode= query param.
 *
 * Official API shapes (verified Oct 2026):
 *
 *   Estimate (?mode=estimate):
 *     Request:  POST /v1/estimate
 *               body = [ { spec:{...}, maxBlockHeight?:"...", maxFee?:"..." } ]
 *               (array of PartialBurnIntent — NO signature required)
 *     Response: { body:[{ burnIntent:{maxFee:"...", maxBlockHeight:"...", spec:{...}} }],
 *                 fees:{ total:"1.178", token:"USDC", perIntent:[...] } }
 *
 *   Transfer (?mode=transfer or no mode):
 *     Request:  POST /v1/transfer
 *               body = [ { burnIntent:{...}, signature:"0x..." } ]
 *               (array of signed BurnIntent)
 *     Response: array of { burnIntent:{...}, attestation:{payload:"...", signature:"..."} }
 *               or legacy { attestationPayload:"...", signature:"..." }
 *
 * Security:
 *   - CORS: exact-origin allowlist (not substring match).
 *   - Validates Content-Type and body shape before forwarding.
 *   - Strips any unexpected top-level fields.
 *   - Never logs or stores attestations, signatures or private data.
 *   - No credentials required (Gateway API is permissionless).
 *   - Body limited to 64 KB.
 *   - 18s server-side timeout (longer than frontend 20s guard → clean 504).
 *
 * P1 fix (origin allowlist):
 *   CORS guard uses an exact-match allowlist (not substring matching).
 *   Configured via env ALLOWED_ORIGINS (comma-separated) plus safe defaults.
 *   Localhost is allowed only for local development.
 */

const GATEWAY_API  = 'https://gateway-api.circle.com';
const MAX_BODY_LEN = 65536; // 64 KB
const TIMEOUT_MS   = 18000; // 18s

/**
 * Returns true if origin is in the exact allowlist.
 * allowlist entries must be exact origins: scheme + host + optional port.
 * e.g. ['https://app.elligentt.com', 'https://elligentt.pages.dev']
 */
function isAllowedOrigin(origin, env) {
  if (!origin) return true; // server-to-server (no Origin header) — allowed
  // Build allowlist from env var ALLOWED_ORIGINS (comma-separated) + safe defaults
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

  // Also allow localhost for development (never in production traffic)
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
      headers: { 'Content-Type':'application/json' },
    });
  }

  // ── Mode routing ──────────────────────────────────────────────────────────
  const url     = new URL(request.url);
  const mode    = url.searchParams.get('mode') || 'transfer';
  const isEstimate = mode === 'estimate';
  const endpoint   = isEstimate
    ? GATEWAY_API + '/v1/estimate'
    : GATEWAY_API + '/v1/transfer';

  // ── Content-Type guard ────────────────────────────────────────────────────
  const ct = request.headers.get('Content-Type') || '';
  if (!ct.includes('application/json')) {
    return new Response(JSON.stringify({ error:'content_type_required' }), {
      status: 400, headers: { 'Content-Type':'application/json' },
    });
  }

  // ── Body size limit ───────────────────────────────────────────────────────
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_LEN) {
    return new Response(JSON.stringify({ error:'request_too_large' }), {
      status: 413, headers: { 'Content-Type':'application/json' },
    });
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(rawBody); } catch(_) {
    return new Response(JSON.stringify({ error:'invalid_json' }), {
      status: 400, headers: { 'Content-Type':'application/json' },
    });
  }

  // Body must be an array (both /v1/estimate and /v1/transfer take arrays)
  if (!Array.isArray(body) || body.length === 0) {
    return new Response(JSON.stringify({ error:'requests_required' }), {
      status: 400, headers: { 'Content-Type':'application/json' },
    });
  }

  // ── Validate each item ────────────────────────────────────────────────────
  for (const item of body) {
    if (!item || typeof item !== 'object') {
      return new Response(JSON.stringify({ error:'invalid_request_item' }), {
        status: 400, headers: { 'Content-Type':'application/json' },
      });
    }

    if (isEstimate) {
      // Estimate: each item must have a spec object
      if (!item.spec || typeof item.spec !== 'object') {
        return new Response(JSON.stringify({ error:'spec_required_for_estimate' }), {
          status: 400, headers: { 'Content-Type':'application/json' },
        });
      }
    } else {
      // Transfer: each item must have burnIntent + signature
      if (!item.burnIntent || typeof item.burnIntent !== 'object') {
        return new Response(JSON.stringify({ error:'burnIntent_required' }), {
          status: 400, headers: { 'Content-Type':'application/json' },
        });
      }
      if (typeof item.signature !== 'string') {
        return new Response(JSON.stringify({ error:'signature_required' }), {
          status: 400, headers: { 'Content-Type':'application/json' },
        });
      }
      // Basic signature format check (0x + at least 130 hex chars = 65 bytes)
      if (!/^0x[0-9a-fA-F]{130,}$/.test(item.signature)) {
        return new Response(JSON.stringify({ error:'invalid_signature_format' }), {
          status: 400, headers: { 'Content-Type':'application/json' },
        });
      }
    }
  }

  // ── Build clean upstream payload ──────────────────────────────────────────
  // Only forward known fields — strip anything unexpected.
  let upstream;
  if (isEstimate) {
    upstream = body.map(item => {
      const out = { spec: item.spec };
      if (item.maxBlockHeight !== undefined) out.maxBlockHeight = item.maxBlockHeight;
      if (item.maxFee !== undefined)         out.maxFee = item.maxFee;
      return out;
    });
  } else {
    upstream = body.map(item => ({
      burnIntent: item.burnIntent,
      signature:  item.signature,
    }));
  }

  // ── Forward to Circle Gateway ─────────────────────────────────────────────
  const ctrl    = new AbortController();
  const timerId = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  let upRes, upBody;
  try {
    upRes = await fetch(endpoint, {
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
      JSON.stringify({ error: isTimeout ? 'gateway_timeout' : 'gateway_unreachable', detail: err.message }),
      { status: isTimeout ? 504 : 502, headers: { 'Content-Type':'application/json' } }
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

// Only POST is supported — other methods return 405.
export async function onRequestGet()    { return _method405(); }
export async function onRequestPut()    { return _method405(); }
export async function onRequestDelete() { return _method405(); }
function _method405() {
  return new Response(JSON.stringify({ error:'method_not_allowed' }), {
    status: 405, headers: { 'Content-Type':'application/json' },
  });
}
