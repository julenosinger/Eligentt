/**
 * GatewayOpLock — Durable Object for atomic Gateway operation idempotence.
 *
 * One DO instance per salt (keyed by salt). The CF runtime serialises all
 * requests to the same DO instance — the "check-then-write" reserve step is
 * inherently race-free without any compare-and-swap primitive.
 *
 * ── Activation ────────────────────────────────────────────────────────────────
 *   CF Pages cannot host Durable Object classes inline. Required steps:
 *   1. Deploy a separate Worker that exports GatewayOpLock from this file.
 *   2. In CF Dashboard → Pages project → Settings → Functions → DO bindings:
 *        Variable name: GATEWAY_OP_LOCK
 *        Namespace:     (the namespace from step 1)
 *   3. Re-deploy the Pages project to pick up the new binding.
 *   When GATEWAY_OP_LOCK is NOT bound:
 *   - Non-production: falls back to GATEWAY_OPS_KV (best-effort, not atomic).
 *   - Production: transfer.js returns 503 and blocks all transfers.
 *
 * ── State machine ─────────────────────────────────────────────────────────────
 *   States: submitting | accepted | rejected | ambiguous | confirmed | failed
 *
 *   (none)      → submitting     /reserve (POST)
 *   submitting  → accepted       internal (Circle 2xx)
 *   submitting  → rejected       internal (Circle 4xx — definitive refusal)
 *   submitting  → ambiguous      internal (timeout / network error)
 *   accepted    → confirmed      internal (on-chain verification — future)
 *   accepted    → failed         internal (verified mint failure)
 *   ambiguous   → accepted       reconciliation (Circle confirmed accept)
 *   ambiguous   → rejected       reconciliation (Circle confirmed reject)
 *   ambiguous   → failed         reconciliation (no on-chain activity verified)
 *   confirmed / failed / rejected:  TERMINAL — no further transitions
 *
 *   'rejected' is distinct from 'failed': it means Circle definitively refused
 *   the intent. The caller may retry with a NEW salt. 'failed' means the mint
 *   failed or the caller verified no on-chain activity.
 *
 *   'rollback:true' flag allows submitting→failed as a batch-rollback from
 *   transfer.js when a multi-salt batch fails to reserve all salts.
 *
 * ── Interface called by transfer.js ───────────────────────────────────────────
 *   POST /reserve   body: { salt, depositor, srcDomain, dstDomain, submittedAt }
 *     → 200 { reserved:true, record }
 *     → 409 { error:'already_reserved', record }
 *   GET  /status
 *     → 200 { record }
 *     → 404 { error:'not_found' }
 *   POST /update    body: { status, txHash?, httpStatus?, rollback? }
 *     → 200 { ok:true, record }
 *     → 400 { error:'invalid_transition', from, to, allowed }
 *     → 404
 *   DELETE /release  (only for terminal states: confirmed | failed | rejected)
 *     → 200 { ok:true }
 *     → 409 { error:'not_terminal', current }
 *
 * ── Security ──────────────────────────────────────────────────────────────────
 *   - Never stores private keys, passphrases, or raw signing material.
 *   - 'confirmed' may only be set by internal calls from transfer.js.
 *   - Client PATCH goes through transfer.js client-transition validation first.
 *   - TTL enforced via submittedAt + CF Storage alarm (optional enhancement).
 */

const VALID_TRANSITIONS = {
  submitting: ['accepted', 'rejected', 'ambiguous', 'failed'],  // 'failed' for rollback
  accepted:   ['confirmed', 'failed'],
  rejected:   [],   // terminal
  ambiguous:  ['accepted', 'rejected', 'failed', 'confirmed'],  // 'confirmed' via /confirm
  confirmed:  [],   // terminal
  failed:     [],   // terminal
};

const TERMINAL_STATES = new Set(['confirmed', 'failed', 'rejected']);
const KNOWN_STATES = new Set(['submitting', 'accepted', 'rejected', 'ambiguous', 'confirmed', 'failed']);

// ── Internal auth token ────────────────────────────────────────────────────────
// The DO checks for an Authorization header on every request.
// The caller (transfer.js) reads DO_INTERNAL_SECRET from env and sends it.
// If absent or wrong, the DO returns 401 and the operation is blocked.
// This prevents direct external access to DO routes even if someone discovers
// the DO URL or binding name.
//
// CONFIGURATION: set env.DO_INTERNAL_SECRET to a random 32+ char string
// in Cloudflare Pages → Settings → Environment Variables (Production only).
// Without this secret, all DO operations return 401 and all transfers are blocked.
//
// The secret is compared with a constant-time equivalent (avoids timing attack).
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class GatewayOpLock {
  constructor(state, env) {
    this.state   = state;
    this.storage = state.storage;
    this.env     = env || {};
  }

  async fetch(request) {
    const url    = new URL(request.url);
    const action = url.pathname.split('/').pop(); // reserve | status | update | release

    const json = (body, status) => new Response(JSON.stringify(body), {
      status:  status || 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });

    // ── Internal auth check ──────────────────────────────────────────────────
    // Every request to the DO must carry the server-side secret.
    // If DO_INTERNAL_SECRET is not set in env, all operations are blocked (fail-closed).
    const expectedSecret = this.env && this.env.DO_INTERNAL_SECRET;
    const providedSecret = request.headers.get('X-DO-Internal-Secret') || '';
    if (!expectedSecret || !timingSafeEqual(expectedSecret, providedSecret)) {
      return json({ error: 'unauthorized' }, 401);
    }

    // ── GET /status ──────────────────────────────────────────────────────────
    if (request.method === 'GET' && action === 'status') {
      const record = await this.storage.get('record');
      if (!record) return json({ error: 'not_found' }, 404);
      return json({ record });
    }

    // ── POST /reserve ────────────────────────────────────────────────────────
    if (request.method === 'POST' && action === 'reserve') {
      let body;
      try { body = await request.json(); } catch(_) {
        return json({ error: 'invalid_json' }, 400);
      }

      // Validate payload (fail-closed) — salt is 32-byte hex, depositor is 20-byte.
      if (typeof body.salt !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(body.salt)) {
        return json({ error: 'invalid_salt' }, 400);
      }
      if (typeof body.depositor !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(body.depositor)) {
        return json({ error: 'invalid_depositor' }, 400);
      }

      const existing = await this.storage.get('record');
      if (existing) {
        return json({ error: 'already_reserved', record: existing }, 409);
      }

      const record = {
        salt:        body.salt,
        depositor:   body.depositor,
        srcDomain:   body.srcDomain   || null,
        dstDomain:   body.dstDomain   || null,
        status:      'submitting',
        submittedAt: body.submittedAt || new Date().toISOString(),
        updatedAt:   new Date().toISOString(),
        txHash:      null,
        httpStatus:  null,
      };

      await this.storage.put('record', record);
      return json({ reserved: true, record });
    }

    // ── POST /update ─────────────────────────────────────────────────────────
    if (request.method === 'POST' && action === 'update') {
      let body;
      try { body = await request.json(); } catch(_) {
        return json({ error: 'invalid_json' }, 400);
      }

      const record = await this.storage.get('record');
      if (!record) return json({ error: 'not_found' }, 404);

      const toStatus = body.status;
      // Validate the requested status is a known state (fail-closed).
      if (typeof toStatus !== 'string' || !KNOWN_STATES.has(toStatus)) {
        return json({ error: 'unknown_status', detail: 'Unknown status: ' + toStatus }, 400);
      }
      const allowed  = VALID_TRANSITIONS[record.status] || [];

      if (!allowed.includes(toStatus)) {
        return json({
          error:   'invalid_transition',
          from:    record.status,
          to:      toStatus,
          allowed,
        }, 400);
      }

      // submitting → failed is ONLY allowed as a batch rollback (rollback:true).
      // A non-rollback update must not silently mark an in-flight operation failed.
      if (record.status === 'submitting' && toStatus === 'failed' && body.rollback !== true) {
        return json({ error: 'rollback_required', from: record.status, to: toStatus }, 400);
      }

      const updated = {
        ...record,
        status:     toStatus,
        updatedAt:  new Date().toISOString(),
        txHash:     body.txHash     || record.txHash     || null,
        httpStatus: body.httpStatus || record.httpStatus || null,
      };

      await this.storage.put('record', updated);
      return json({ ok: true, record: updated });
    }

    // ── DELETE /release ──────────────────────────────────────────────────────
    if (request.method === 'DELETE' && action === 'release') {
      const record = await this.storage.get('record');
      if (!record) return json({ error: 'not_found' }, 404);

      if (!TERMINAL_STATES.has(record.status)) {
        return json({ error: 'not_terminal', current: record.status }, 409);
      }

      await this.storage.delete('record');
      return json({ ok: true });
    }

    return json({ error: 'method_not_allowed' }, 405);
  }
}
