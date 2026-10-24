# GATEWAY_OPS_KV — Setup Instructions

## Purpose

`GATEWAY_OPS_KV` is a Cloudflare KV namespace used by `/api/gateway/transfer` to
provide **cross-session idempotence** for Circle Gateway transfer operations.

Before forwarding a transfer intent to Circle, the proxy writes a record keyed by
`gw:op:{salt}`. If the same salt is submitted again (e.g. after a page reload or
network crash), the proxy returns `409 already_submitted` instead of blindly forwarding
a potential duplicate — preventing double-spend at the infrastructure layer.

## Key format

```
gw:op:0x{64 hex chars}   →   { submittedAt, depositor, status, srcDomain, dstDomain }
```

**Status values:** `submitting` → `accepted` → `confirmed` | `rejected` | `failed`

TTL: 7 days (604800 seconds). Safe to expire since Circle's protocol rejects
     stale attestations after the transfer window closes.

## Without this binding

If `GATEWAY_OPS_KV` is not bound at runtime, `transfer.js` logs a warning and
falls back to **forward-only mode** — the transfer proceeds without replay protection
at the proxy layer. The in-browser `_inflight` lock and the cryptographic salt still
prevent duplicates within a single session, but a page reload after a timeout
could theoretically result in a duplicate submission attempt.

**Recommendation: always provision this binding in production.**

## How to create

```bash
# Create the namespace
wrangler kv namespace create GATEWAY_OPS_KV

# Output example:
# ✨  Created namespace "GATEWAY_OPS_KV"
# { binding: 'GATEWAY_OPS_KV', id: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' }
```

Then add to `wrangler.jsonc` under `kv_namespaces`:

```jsonc
{
  "binding": "GATEWAY_OPS_KV",
  "id": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

## Cloudflare Dashboard (alternative)

Pages → {project} → Settings → Functions → KV namespace bindings → Add binding:
- Variable name: `GATEWAY_OPS_KV`
- Namespace: (select the namespace you created above)

## DO vs KV

A Durable Object would provide true atomic `put-if-absent` semantics.
The project's existing `PaymentLock` DO pattern is described in `wrangler.jsonc`.

KV does NOT provide atomic CAS. The race window (between `get` and `put`) is
typically < 1ms in practice, but in theory two concurrent requests could both
see "not found" and both forward. For the Gateway use case, this is acceptable
because Circle's own salt uniqueness enforcement provides the final guarantee —
two successful submissions with the same salt produce only one transfer.

The KV layer is an additional guard, not the only one. The cryptographic salt
(random 32 bytes per transfer) is the ultimate replay prevention mechanism.
