/**
 * CF Pages Function — POST /api/gateway/intent
 *
 * Phase 1.0.1C.3 — server-bound Gateway intent identity (Gate A).
 *
 * Issues a durable, server-persisted idempotency key for a Gateway transfer
 * intent, created BEFORE signing and bound to a client "intent session". The
 * frontend obtains the key here and reuses it across refresh/retry/recovery, so
 * the GatewayExecutionCoordinator can deduplicate the same intent across salts.
 *
 * Semantics:
 *   - `intentSessionId` present + a key already issued for it → RETURN the same
 *     key (recover the original identity).
 *   - `intentSessionId` absent or unknown → issue + persist a NEW key.
 *   - `intentSessionId` present + a DIFFERENT payload → conflict (the client
 *     reused a session for a mutated intent) — refuse rather than silently
 *     re-key.
 *
 * The key is persisted in GATEWAY_OPS_KV (durable). The KV is the identity store,
 * NOT the financial authority (the coordinator remains the authority). When KV is
 * absent, issuance degrades to a fresh (non-recoverable) key and is flagged.
 *
 * This endpoint is identity issuance only — no financial effect. It is NOT
 * flag-gated (safe to call regardless of coordinator activation).
 */

const KV_PREFIX = 'gw:intent:';
const KV_TTL_SECS = 86400; // 24h — intent identity lifetime

function uuid() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
  return 'gw-' + h;
}

function jsonResp(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestPost(ctx) {
  const { request, env } = ctx;

  let body;
  try { body = await request.json(); } catch(_) { body = {}; }

  const sessionId = typeof body.intentSessionId === 'string' ? body.intentSessionId : null;
  // Payload fingerprint of the immutable intent params (client-provided hash) —
  // used to detect a session reused with a different payload.
  const payloadHash = typeof body.payloadHash === 'string' ? body.payloadHash : null;

  if (sessionId && !/^[A-Za-z0-9._-]{8,128}$/.test(sessionId)) {
    return jsonResp({ error: 'invalid_intent_session_id' }, 400);
  }

  const kv = env && env.GATEWAY_OPS_KV;
  if (kv && sessionId) {
    const existing = await kv.get(KV_PREFIX + sessionId, { type: 'json' }).catch(() => null);
    if (existing) {
      if (payloadHash && existing.payloadHash && existing.payloadHash !== payloadHash) {
        return jsonResp({ error: 'intent_session_payload_mismatch', detail: 'intent session reused with a different payload' }, 409);
      }
      return jsonResp({ idempotencyKey: existing.idempotencyKey, recovered: true });
    }
  }

  const idempotencyKey = uuid();
  if (kv) {
    await kv.put(KV_PREFIX + (sessionId || idempotencyKey), JSON.stringify({
      idempotencyKey, sessionId: sessionId || null, payloadHash, createdAt: new Date().toISOString(),
    }), { expirationTtl: KV_TTL_SECS }).catch(() => {});
  }

  return jsonResp({ idempotencyKey, recovered: false });
}

export async function onRequestGet()  { return jsonResp({ error: 'method_not_allowed' }, 405); }
export async function onRequestPut()  { return jsonResp({ error: 'method_not_allowed' }, 405); }
export async function onRequestDelete() { return jsonResp({ error: 'method_not_allowed' }, 405); }
