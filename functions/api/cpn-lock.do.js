/**
 * CpnLock — Durable Object for serialized CPN fiat-payout idempotency.
 * ═══════════════════════════════════════════════════════════════════════
 * Each DO instance handles exactly ONE idempotency key (userId:idempotencyKey).
 * Cloudflare guarantees a single active DO instance per key, serializing all
 * concurrent requests — providing TRUE atomic mutual exclusion that KV cannot
 * (KV has no compare-and-swap).
 *
 * State stored in DO storage (durable):
 *   key "claim" → { payloadHash, status, paymentId?, claimedAt }
 *   status ∈ "processing" | "committed" | "pending_reconciliation"
 *
 * API (POST body JSON):
 *   { action: "claim", payloadHash }
 *     → { ok:true, claimed: true }                       — this request won the lock
 *     → { ok:true, claimed: "same" }                     — same payloadHash in-flight retry
 *     → { ok:true, claimed: "committed", paymentId }     — already committed (replay)
 *     → { ok:true, claimed: false }                      — different payloadHash (key reuse)
 *   { action: "commit", payloadHash, paymentId }
 *     → { ok:true }  — upgrades to committed (permanent; alarm cancelled)
 *   { action: "markPending", payloadHash, paymentId? }
 *     → { ok:true }  — marks PENDING_RECONCILIATION (indeterminate outcome)
 *   { action: "release", payloadHash }
 *     → { ok:true }  — releases the lock on failure/rollback
 *
 * TTL: a "processing" claim auto-releases after 120 s via the DO alarm;
 *      "committed" and "pending_reconciliation" are persistent (alarm cancelled).
 *
 * NOTE (Cloudflare Pages): like payment-lock.do.js, this class must be deployed as
 * a separate Worker and bound to the Pages project as `CPN_LOCK` via the dashboard.
 * Until bound, the handler falls back to the KV write-then-verify reservation
 * (best-effort for concurrent; Circle's Idempotency-Key remains the authoritative dedup).
 */
export class CpnLock {
  constructor(state, _env) {
    this.state = state;
  }

  async fetch(request) {
    let body;
    try { body = await request.json(); } catch (_) {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 });
    }
    const { action, payloadHash, paymentId } = body || {};
    if (!action || !payloadHash || typeof payloadHash !== 'string') {
      return new Response(JSON.stringify({ error: 'action and payloadHash required' }), { status: 400 });
    }

    const existing = await this.state.storage.get('claim');

    if (action === 'claim') {
      if (!existing) {
        await this.state.storage.put('claim', { payloadHash, status: 'processing', claimedAt: Date.now() });
        await this.state.storage.setAlarm(Date.now() + 120_000);
        return new Response(JSON.stringify({ ok: true, claimed: true }));
      }
      if (existing.payloadHash === payloadHash) {
        if (existing.status === 'committed') {
          return new Response(JSON.stringify({ ok: true, claimed: 'committed', paymentId: existing.paymentId || null }));
        }
        if (existing.status === 'pending_reconciliation') {
          // Reconciliation: atomically re-claim the lock (transition back to a fresh
          // "processing" lease) so that only ONE concurrent reconciliation proceeds.
          await this.state.storage.put('claim', { payloadHash, status: 'processing', claimedAt: Date.now() });
          await this.state.storage.setAlarm(Date.now() + 120_000);
          return new Response(JSON.stringify({ ok: true, claimed: true }));
        }
        return new Response(JSON.stringify({ ok: true, claimed: 'same' }));
      }
      // Different payloadHash already claimed this key — reject.
      return new Response(JSON.stringify({ ok: true, claimed: false }));
    }

    if (action === 'commit') {
      if (!existing || existing.payloadHash !== payloadHash) {
        return new Response(JSON.stringify({ error: 'No matching claim to commit' }), { status: 409 });
      }
      await this.state.storage.put('claim', { payloadHash, status: 'committed', paymentId: paymentId || null, claimedAt: existing.claimedAt });
      await this.state.storage.deleteAlarm();
      return new Response(JSON.stringify({ ok: true }));
    }

    if (action === 'markPending') {
      if (!existing || existing.payloadHash !== payloadHash) {
        return new Response(JSON.stringify({ error: 'No matching claim to mark pending' }), { status: 409 });
      }
      await this.state.storage.put('claim', { payloadHash, status: 'pending_reconciliation', paymentId: paymentId || existing.paymentId || null, claimedAt: existing.claimedAt });
      await this.state.storage.deleteAlarm();
      return new Response(JSON.stringify({ ok: true }));
    }

    if (action === 'release') {
      if (existing && existing.payloadHash === payloadHash) {
        await this.state.storage.delete('claim');
        await this.state.storage.deleteAlarm();
      }
      return new Response(JSON.stringify({ ok: true }));
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400 });
  }

  // Alarm fires 120 s after a "processing" claim is written. If commit()/markPending()
  // was called, the alarm was cancelled — this only fires on abandoned/failed requests.
  async alarm() {
    const existing = await this.state.storage.get('claim');
    if (existing && existing.status === 'processing') {
      await this.state.storage.delete('claim');
    }
  }
}
