/**
 * CpnLock — Durable Object for serialized CPN fiat-payout idempotency.
 * ═══════════════════════════════════════════════════════════════════════
 * Each DO instance handles exactly ONE idempotency key (userId:idempotencyKey).
 * Cloudflare guarantees a single active DO instance per key, serializing all
 * concurrent requests — providing TRUE atomic mutual exclusion that KV cannot
 * (KV has no compare-and-swap).
 *
 * Fase 1.6 — atomic state transitions:
 *   Every read-modify-write (claim/commit/markPending/release, and the alarm) runs
 *   inside `state.storage.transaction()` so the get→check→put is a single atomic
 *   unit with no interleaving. The alarm no longer DELETES a "processing" claim
 *   (which would silently release the lock and allow a duplicate) — instead it
 *   transitions to "pending_reconciliation" so the outcome stays guarded and a
 *   retry must reconcile through Circle's Idempotency-Key.
 *
 * State stored in DO storage (durable):
 *   key "claim" → { payloadHash, status, paymentId?, claimedAt }
 *   status ∈ "processing" | "committed" | "pending_reconciliation"
 *
 * API (POST body JSON):
 *   { action: "claim", payloadHash }
 *     → { ok:true, claimed: true }                       — this request won the lock
 *     → { ok:true, claimed: "same" }                     — same payloadHash in-flight
 *     → { ok:true, claimed: "committed", paymentId }     — already committed (replay)
 *     → { ok:true, claimed: false }                      — different payloadHash (key reuse)
 *   { action: "commit", payloadHash, paymentId }         → { ok:true } (permanent)
 *   { action: "markPending", payloadHash, paymentId? }   → { ok:true } (indeterminate)
 *   { action: "release", payloadHash }                   → { ok:true } (rollback)
 *
 * NOTE (Cloudflare Pages): like payment-lock.do.js, this class must be deployed as a
 * separate Worker and bound to the Pages project as `CPN_LOCK` via the dashboard.
 * See wrangler.jsonc / the handler for the fail-safe behavior when the binding is
 * absent.
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

    const result = await this.state.blockConcurrencyWhile(async () => {
      // Atomic read-modify-write (single transaction; no interleaving with the alarm).
      const outcome = await this.state.storage.transaction(async (txn) => {
        const existing = await txn.get('claim');

        if (action === 'claim') {
          if (!existing) {
            await txn.put('claim', { payloadHash, status: 'processing', claimedAt: Date.now() });
            return { alarmMs: 120000, status: 200, body: { ok: true, claimed: true } };
          }
          if (existing.payloadHash === payloadHash) {
            if (existing.status === 'committed') {
              return { status: 200, body: { ok: true, claimed: 'committed', paymentId: existing.paymentId || null } };
            }
            if (existing.status === 'pending_reconciliation') {
              // Reconciliation: atomically re-claim the lock (fresh processing lease)
              // so only ONE concurrent reconciliation proceeds.
              await txn.put('claim', { payloadHash, status: 'processing', claimedAt: Date.now() });
              return { alarmMs: 120000, status: 200, body: { ok: true, claimed: true } };
            }
            return { status: 200, body: { ok: true, claimed: 'same' } };
          }
          return { status: 200, body: { ok: true, claimed: false } };
        }

        if (action === 'commit') {
          if (!existing || existing.payloadHash !== payloadHash) {
            return { status: 409, body: { error: 'No matching claim to commit' } };
          }
          await txn.put('claim', { payloadHash, status: 'committed', paymentId: paymentId || null, claimedAt: existing.claimedAt });
          return { deleteAlarm: true, status: 200, body: { ok: true } };
        }

        if (action === 'markPending') {
          if (!existing || existing.payloadHash !== payloadHash) {
            return { status: 409, body: { error: 'No matching claim to mark pending' } };
          }
          await txn.put('claim', { payloadHash, status: 'pending_reconciliation', paymentId: paymentId || existing.paymentId || null, claimedAt: existing.claimedAt });
          return { deleteAlarm: true, status: 200, body: { ok: true } };
        }

        if (action === 'release') {
          if (existing && existing.payloadHash === payloadHash) {
            await txn.delete('claim');
          }
          return { deleteAlarm: true, status: 200, body: { ok: true } };
        }

        return { status: 400, body: { error: 'Unknown action' } };
      });

      // Alarm bookkeeping happens OUTSIDE the storage transaction (setAlarm/deleteAlarm
      // are not part of the transactional storage API).
      if (outcome.alarmMs) await this.state.storage.setAlarm(Date.now() + outcome.alarmMs);
      if (outcome.deleteAlarm) await this.state.storage.deleteAlarm();
      return outcome;
    });

    return new Response(JSON.stringify(result.body), { status: result.status });
  }

  // Alarm fires 120 s after a "processing" claim was written (only when the owning
  // fetch never reached commit/markPending/release — i.e. it was abandoned/crashed).
  // The outcome is UNCERTAIN, so we do NOT delete the claim: we transition it to
  // pending_reconciliation so the operation stays guarded and a retry must reconcile.
  async alarm() {
    await this.state.blockConcurrencyWhile(async () => {
      await this.state.storage.transaction(async (txn) => {
        const existing = await txn.get('claim');
        if (existing && existing.status === 'processing') {
          await txn.put('claim', { ...existing, status: 'pending_reconciliation' });
        }
      });
    });
  }
}
