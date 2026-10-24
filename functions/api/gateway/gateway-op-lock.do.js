/**
 * GatewayOpLock — Durable Object for atomic Gateway operation idempotence.
 *
 * Each DO instance is keyed by salt (one DO per transfer operation).
 * The DO provides true serialized access: concurrent POST requests for the
 * same salt are queued by the CF runtime and executed one at a time, so the
 * "check then write" step is inherently race-free — no compare-and-swap needed.
 *
 * Activation (Cloudflare Pages cannot host inline DO classes):
 *   1. Deploy a separate Worker that exports GatewayOpLock from this file.
 *   2. In Cloudflare Dashboard → Pages → Settings → Functions → Durable Object
 *      bindings, add:
 *        Variable name: GATEWAY_OP_LOCK
 *        Durable Object namespace: (the DO namespace from step 1)
 *   3. Re-deploy the Pages project.
 *
 * When GATEWAY_OP_LOCK is NOT bound (e.g. local dev, staging without the DO),
 * transfer.js falls back to KV-sentinel mode (strong for sequential calls,
 * best-effort for concurrent). See transfer.js for fallback behaviour.
 *
 * Interface called by transfer.js:
 *   POST /reserve   { salt, depositor, srcDomain, dstDomain, submittedAt }
 *     → 200 { reserved: true, record }   — first caller gets the lock
 *     → 409 { error: 'already_reserved', record }  — duplicate blocked
 *   GET  /status
 *     → 200 { record } | 404 { error: 'not_found' }
 *   POST /update    { status, txHash? }
 *     → 200 { ok: true }
 *     → 400 { error: 'invalid_transition' }
 *     → 404
 *   DELETE /release   (only allowed for terminal states: confirmed | failed)
 *     → 200 { ok: true }
 *     → 409 { error: 'not_terminal' }
 *
 * State machine (server-enforced):
 *   (none) → submitting → accepted → confirmed
 *                       → failed
 *   submitting → failed  (timeout / rejection path)
 *
 * Security:
 *   - The DO never stores private keys, mnemonic phrases, or raw transaction signatures.
 *   - 'confirmed' can only be set by internal calls (transfer.js on 2xx from Circle),
 *     never by the browser client (PATCH /update is validated in transfer.js).
 *   - TTL is enforced via the stored submittedAt + periodic alarm (optional).
 */

export class GatewayOpLock {
  constructor(state) {
    this.state   = state;
    this.storage = state.storage;
  }

  async fetch(request) {
    const url    = new URL(request.url);
    const action = url.pathname.split('/').pop(); // 'reserve' | 'status' | 'update' | 'release'

    const json = (body, status) => new Response(JSON.stringify(body), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });

    // ── GET /status ────────────────────────────────────────────────────────────
    if (request.method === 'GET' && action === 'status') {
      const record = await this.storage.get('record');
      if (!record) return json({ error: 'not_found' }, 404);
      return json({ record });
    }

    // ── POST /reserve ──────────────────────────────────────────────────────────
    if (request.method === 'POST' && action === 'reserve') {
      let body;
      try { body = await request.json(); } catch(_) {
        return json({ error: 'invalid_json' }, 400);
      }

      const existing = await this.storage.get('record');
      if (existing) {
        // Already reserved — block duplicate
        return json({ error: 'already_reserved', record: existing }, 409);
      }

      const record = {
        salt:        body.salt,
        depositor:   body.depositor,
        srcDomain:   body.srcDomain,
        dstDomain:   body.dstDomain,
        status:      'submitting',
        submittedAt: body.submittedAt || new Date().toISOString(),
        updatedAt:   new Date().toISOString(),
      };

      await this.storage.put('record', record);
      return json({ reserved: true, record });
    }

    // ── POST /update ───────────────────────────────────────────────────────────
    if (request.method === 'POST' && action === 'update') {
      let body;
      try { body = await request.json(); } catch(_) {
        return json({ error: 'invalid_json' }, 400);
      }

      const record = await this.storage.get('record');
      if (!record) return json({ error: 'not_found' }, 404);

      // Validate state machine transitions
      const VALID_TRANSITIONS = {
        submitting: ['accepted', 'failed'],
        accepted:   ['confirmed', 'failed'],
        // Terminal states — no further transitions
        confirmed:  [],
        failed:     [],
      };

      const allowed = VALID_TRANSITIONS[record.status] || [];
      if (!allowed.includes(body.status)) {
        return json({
          error:      'invalid_transition',
          from:       record.status,
          to:         body.status,
          allowed,
        }, 400);
      }

      const updated = {
        ...record,
        status:    body.status,
        updatedAt: new Date().toISOString(),
        txHash:    body.txHash || record.txHash || null,
        httpStatus: body.httpStatus || record.httpStatus || null,
      };

      await this.storage.put('record', updated);
      return json({ ok: true, record: updated });
    }

    // ── DELETE /release ────────────────────────────────────────────────────────
    if (request.method === 'DELETE' && action === 'release') {
      const record = await this.storage.get('record');
      if (!record) return json({ error: 'not_found' }, 404);

      const TERMINAL = ['confirmed', 'failed'];
      if (!TERMINAL.includes(record.status)) {
        return json({ error: 'not_terminal', current: record.status }, 409);
      }

      await this.storage.delete('record');
      return json({ ok: true });
    }

    return json({ error: 'method_not_allowed' }, 405);
  }
}
