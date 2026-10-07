/**
 * PaymentLock — Durable Object for serialized idempotency on chainId+txHash.
 *
 * Each DO instance handles exactly ONE idempotency key (txused:<chainId>:<txHash>).
 * Cloudflare DO guarantees a single active instance per key, serializing all
 * concurrent requests — providing true atomicity without external CAS.
 *
 * API (POST body JSON):
 *   { action: "claim", token: "<invoice-or-paylink-token>" }
 *     → 200 { ok: true, claimed: true, claimant: token }   — this request wins
 *     → 200 { ok: true, claimed: false, claimant: existing } — already claimed (different token)
 *     → 200 { ok: true, claimed: "same", claimant: token }  — same token retry (idempotent)
 *
 *   { action: "commit", token: "<token>" }
 *     → 200 { ok: true }  — upgrades processing sentinel to permanent (7-day TTL)
 *
 *   { action: "release", token: "<token>" }
 *     → 200 { ok: true }  — releases the processing sentinel on failure/rollback
 *
 * State stored in DO storage (durable):
 *   key "claim"   → { token, status: "processing"|"committed", claimedAt }
 *
 * TTL: processing sentinel auto-expires after 60 s via Durable Object alarm;
 *      committed claim is permanent (alarm cancelled).
 */
export class PaymentLock {
  constructor(state, _env) {
    this.state = state;
  }

  async fetch(request) {
    const body = await request.json();
    const { action, token } = body;

    if (!action || !token) {
      return new Response(JSON.stringify({ error: 'action and token required' }), { status: 400 });
    }

    const existing = await this.state.storage.get('claim');

    if (action === 'claim') {
      if (!existing) {
        // No claim yet — write processing sentinel and set 60-second alarm.
        await this.state.storage.put('claim', { token, status: 'processing', claimedAt: Date.now() });
        await this.state.storage.setAlarm(Date.now() + 60_000);
        return new Response(JSON.stringify({ ok: true, claimed: true, claimant: token }));
      }

      if (existing.token === token) {
        // Same token re-submitting — idempotent.
        return new Response(JSON.stringify({ ok: true, claimed: 'same', claimant: token }));
      }

      // Different token already claimed this txHash — reject.
      return new Response(JSON.stringify({ ok: true, claimed: false, claimant: existing.token }));
    }

    if (action === 'commit') {
      if (!existing || existing.token !== token) {
        return new Response(JSON.stringify({ error: 'No matching claim to commit' }), { status: 409 });
      }
      // Upgrade to committed and cancel the alarm (permanent claim).
      await this.state.storage.put('claim', { token, status: 'committed', claimedAt: existing.claimedAt });
      await this.state.storage.deleteAlarm();
      return new Response(JSON.stringify({ ok: true }));
    }

    if (action === 'release') {
      if (existing && existing.token === token) {
        await this.state.storage.delete('claim');
        await this.state.storage.deleteAlarm();
      }
      return new Response(JSON.stringify({ ok: true }));
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400 });
  }

  // Alarm fires 60 s after a "processing" claim is written.
  // If commit() was called the alarm was cancelled — this only fires on abandoned/failed requests.
  async alarm() {
    const existing = await this.state.storage.get('claim');
    if (existing && existing.status === 'processing') {
      // Auto-release expired processing sentinel so the payment can be retried.
      await this.state.storage.delete('claim');
    }
  }
}
