/**
 * CF Pages Function — POST /api/gateway/intent
 *
 * Phase 1.0.1D — server-bound Gateway intent identity (Gate A).
 *
 * Issues a durable, server-derived idempotency key for a Gateway transfer intent,
 * created BEFORE signing and bound to a client "intent session". The key is derived
 * deterministically (HMAC-SHA256 of the session + server secret), so concurrent
 * requests for the SAME session can never emit DIFFERENT identities (fixes the
 * non-atomic KV get-then-put race). The KV entry is a recovery index, not the
 * authority — the derivation is the authority.
 *
 * Semantics:
 *   - `intentSessionId` present → derive the key deterministically; RECOVER the
 *     original identity for a retry of the same intent.
 *   - `intentSessionId` present + `payloadHash` differs from a prior issue → 409
 *     (session reused for a mutated intent).
 *   - `intentSessionId` absent → a fresh (random) key for a new intent.
 *
 * Persistence is honest: `persisted:false` is returned when the KV write fails
 * (never silently swallowed). The key remains valid (derivation is authoritative);
 * callers in coordinated mode treat `persisted:false` as degraded.
 *
 * No financial effect. NOT flag-gated.
 */

const KV_PREFIX = 'gw:intent:';
const KV_TTL_SECS = 7 * 86400; // 7 days — preserves pending-operation recovery

function jsonResp(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function randomKey() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
  return 'gw-' + h;
}

// Deterministic key: HMAC-SHA256(secret, sessionId), truncated to 16 bytes (32 hex)
// to match the random-key format `gw-<32 hex>`. Same session → same key, so
// concurrent issuance is idempotent (no divergent identities).
async function deriveKey(sessionId, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(sessionId));
  return 'gw-' + Array.from(new Uint8Array(sig).slice(0, 16)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestPost(ctx) {
  const { request, env } = ctx;

  let body;
  try { body = await request.json(); } catch(_) { body = {}; }

  const sessionId   = typeof body.intentSessionId === 'string' ? body.intentSessionId : null;
  const payloadHash = typeof body.payloadHash === 'string' ? body.payloadHash : null;

  if (sessionId && !/^[A-Za-z0-9._-]{8,128}$/.test(sessionId)) {
    return jsonResp({ error: 'invalid_intent_session_id' }, 400);
  }

  const kv = env && env.GATEWAY_OPS_KV;
  const secret = (env && env.DO_INTERNAL_SECRET) || 'elligentt-gateway-intent-v1';

  let idempotencyKey;
  let recovered = false;
  if (sessionId) {
    idempotencyKey = await deriveKey(sessionId, secret);
    if (kv) {
      const existing = await kv.get(KV_PREFIX + sessionId, { type: 'json' }).catch(() => null);
      if (existing) {
        if (payloadHash && existing.payloadHash && existing.payloadHash !== payloadHash) {
          return jsonResp({ error: 'intent_session_payload_mismatch', detail: 'intent session reused with a different payload' }, 409);
        }
        recovered = true;
      }
    }
  } else {
    idempotencyKey = randomKey();
  }

  // Honest persistence: record whether the KV write actually succeeded.
  let persisted = false;
  if (kv) {
    try {
      await kv.put(KV_PREFIX + (sessionId || idempotencyKey), JSON.stringify({
        idempotencyKey, sessionId: sessionId || null, payloadHash, createdAt: new Date().toISOString(),
      }), { expirationTtl: KV_TTL_SECS });
      persisted = true;
    } catch(_) { /* persisted stays false */ }
  }

  return jsonResp({ idempotencyKey, recovered, persisted });
}

export async function onRequestGet()  { return jsonResp({ error: 'method_not_allowed' }, 405); }
export async function onRequestPut()  { return jsonResp({ error: 'method_not_allowed' }, 405); }
export async function onRequestDelete() { return jsonResp({ error: 'method_not_allowed' }, 405); }
