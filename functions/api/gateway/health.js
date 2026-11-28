/**
 * CF Pages Function — GET /api/gateway/health
 *
 * Phase 1.0.1D.2.4 — non-destructive operational preflight (P0.5).
 *
 * Reports the Gateway transfer persistence availability WITHOUT performing any
 * financial operation, so the UI can surface an infrastructure problem BEFORE
 * asking the user to sign.
 *
 *   persistence: 'do'  → GATEWAY_OP_LOCK Durable Object is bound and reachable.
 *   persistence: 'kv'  → GATEWAY_OPS_KV fallback (non-production only).
 *   persistence: 'none'→ no persistence binding — transfers will fail closed.
 *
 * The DO probe is a read on a non-existent salt (a 404 from the DO = reachable and
 * authorized); it never reserves or mutates state.
 */

function jsonResp(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function isProduction(env) {
  const e = (env && (env.GATEWAY_ENV || env.CF_PAGES_ENV_NAME || '')).toLowerCase();
  return e === 'production' || e === 'prod';
}

export async function onRequestGet(ctx) {
  const { env } = ctx;
  const doBinding = env && env.GATEWAY_OP_LOCK;
  const kvBinding = env && env.GATEWAY_OPS_KV;
  const prod = isProduction(env);

  // ── DO probe (non-destructive) ───────────────────────────────────────────
  if (doBinding && typeof doBinding.idFromName === 'function' && typeof doBinding.get === 'function') {
    try {
      const doId   = doBinding.idFromName('__health_probe__');
      const doStub = doBinding.get(doId);
      const headers = { 'Content-Type': 'application/json' };
      if (env && env.DO_INTERNAL_SECRET) headers['X-DO-Internal-Secret'] = env.DO_INTERNAL_SECRET;
      // Probe with a well-formed salt that has no record → a 404 means reachable.
      const probeSalt = '0x' + '00'.repeat(32);
      const res = await doStub.fetch('https://internal/status?salt=' + probeSalt, { headers });
      // 404 (no record) = reachable; 401 = bound but DO_INTERNAL_SECRET missing/mismatched.
      if (res.status === 404) return jsonResp({ ok: true, persistence: 'do', detail: 'GATEWAY_OP_LOCK is reachable.' });
      if (res.status === 401) return jsonResp({ ok: false, persistence: 'do', detail: 'DO_INTERNAL_SECRET is missing or mismatched (DO returned 401).' }, 503);
      return jsonResp({ ok: false, persistence: 'do', detail: 'GATEWAY_OP_LOCK probe returned HTTP ' + res.status + '.' }, 503);
    } catch(_) {
      return jsonResp({ ok: false, persistence: 'do', detail: 'GATEWAY_OP_LOCK is bound but unreachable.' }, 503);
    }
  }

  // ── KV fallback (non-production only) ────────────────────────────────────
  if (kvBinding && !prod) {
    return jsonResp({ ok: true, persistence: 'kv', detail: 'GATEWAY_OPS_KV fallback (non-production).' });
  }

  if (prod && !doBinding) {
    return jsonResp({ ok: false, persistence: 'none', detail: 'GATEWAY_OP_LOCK is required in production and is not bound.' }, 503);
  }

  return jsonResp({ ok: false, persistence: 'none', detail: 'No persistence binding (GATEWAY_OP_LOCK or GATEWAY_OPS_KV). Transfers will fail closed.' }, 503);
}

export async function onRequestPost()  { return jsonResp({ error: 'method_not_allowed' }, 405); }
export async function onRequestPut()   { return jsonResp({ error: 'method_not_allowed' }, 405); }
export async function onRequestDelete(){ return jsonResp({ error: 'method_not_allowed' }, 405); }
