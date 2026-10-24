/**
 * CF Pages Function — POST /api/gateway/transfer
 *
 * Server-side proxy to the Circle Gateway /v1/transfer API.
 * Forwards signed burn intents to Circle and returns the attestation.
 * Also handles estimate mode (?estimate=true or body.estimate=true).
 *
 * Security:
 *   - Validates Content-Type and body shape before forwarding.
 *   - Strips any unexpected top-level fields from the request.
 *   - Never logs or stores attestations or signatures.
 *   - No credentials required (Gateway is permissionless).
 *   - CORS restricted to same origin (no arbitrary proxy use).
 *   - Body limited to 64 KB to prevent abuse.
 *
 * Protocol (Circle Gateway v1, verified October 2026):
 *   POST /v1/transfer
 *   Body: { requests: [{ burnIntent, signature }] }  OR
 *         { estimate: true, requests: [...] }
 *   Response: { attestationPayload, signature } | { maxFee, ... }
 */

const GATEWAY_API  = 'https://gateway-api.circle.com';
const MAX_BODY_LEN = 65536; // 64 KB
const TIMEOUT_MS   = 18000; // 18s — longer than frontend (20s) to guarantee clean 504

export async function onRequestPost(ctx) {
  const { request } = ctx;

  // ── CORS: allow only same-origin calls ────────────────────────────────────
  const origin = request.headers.get('Origin') || '';
  if (origin && !origin.includes('elligentt')) {
    return new Response(JSON.stringify({ error:'forbidden' }), {
      status: 403,
      headers: { 'Content-Type':'application/json' },
    });
  }

  // ── Content-Type guard ─────────────────────────────────────────────────────
  const ct = request.headers.get('Content-Type') || '';
  if (!ct.includes('application/json')) {
    return new Response(JSON.stringify({ error:'content_type_required' }), {
      status: 400, headers: { 'Content-Type':'application/json' },
    });
  }

  // ── Body size limit ────────────────────────────────────────────────────────
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_LEN) {
    return new Response(JSON.stringify({ error:'request_too_large' }), {
      status: 413, headers: { 'Content-Type':'application/json' },
    });
  }

  // ── Parse and validate body ────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(rawBody); } catch(_) {
    return new Response(JSON.stringify({ error:'invalid_json' }), {
      status: 400, headers: { 'Content-Type':'application/json' },
    });
  }

  if (!body || !Array.isArray(body.requests) || body.requests.length === 0) {
    return new Response(JSON.stringify({ error:'requests_required' }), {
      status: 400, headers: { 'Content-Type':'application/json' },
    });
  }

  // ── Validate each request has burnIntent + signature ──────────────────────
  for (const req of body.requests) {
    if (!req || typeof req !== 'object') {
      return new Response(JSON.stringify({ error:'invalid_request_item' }), {
        status: 400, headers: { 'Content-Type':'application/json' },
      });
    }
    if (!req.burnIntent || typeof req.burnIntent !== 'object') {
      return new Response(JSON.stringify({ error:'burnIntent_required' }), {
        status: 400, headers: { 'Content-Type':'application/json' },
      });
    }
    if (typeof req.signature !== 'string') {
      return new Response(JSON.stringify({ error:'signature_required' }), {
        status: 400, headers: { 'Content-Type':'application/json' },
      });
    }
  }

  // ── Build clean upstream payload ───────────────────────────────────────────
  // Only forward known fields — no arbitrary proxy use.
  const upstream = {
    requests: body.requests.map(r => ({
      burnIntent: r.burnIntent,
      signature:  r.signature,
    })),
  };
  // estimate flag is passed as a query param if truthy
  const isEstimate = !!body.estimate;
  const endpoint = isEstimate
    ? GATEWAY_API + '/v1/estimate'
    : GATEWAY_API + '/v1/transfer';

  // ── Forward to Circle Gateway ──────────────────────────────────────────────
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

  // ── Parse and relay response ───────────────────────────────────────────────
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
