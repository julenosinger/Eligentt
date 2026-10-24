# Gateway Operations — Persistence Setup

## Required Environment Variables

| Variable | Where to set | Purpose |
|---|---|---|
| `GATEWAY_OPS_KV` | wrangler.jsonc kv_namespaces binding | KV fallback for non-production idempotence |
| `GATEWAY_OP_LOCK` | CF Pages DO binding | Primary atomic lock (required in production) |
| `DO_INTERNAL_SECRET` | CF Pages → Env Variables → Production | Shared secret between proxy and DO (min 32 chars) |
| `GATEWAY_ENV` | CF Pages → Env Variables → Production | Set to `'production'` to disable KV fallback |

### DO_INTERNAL_SECRET
The Durable Object verifies this secret on every internal request using a
constant-time comparison. Without it, **all DO operations return 401** and all
transfers are blocked (fail-closed). Generate with:
```
openssl rand -hex 32
```
Set it in CF Dashboard → Pages → Settings → Environment Variables → Production only.
**Never** commit this value to source control or expose it in frontend code.

## Atomicity Architecture (Two-layer)

### Layer 1 — Durable Object (GATEWAY_OP_LOCK) — Primary
Provides true atomic serialization. One DO instance per salt. The CF runtime queues
concurrent requests to the same DO instance, so the reserve-then-forward step is
inherently race-free without compare-and-swap.

**Setup:**
1. The DO class is in `functions/api/gateway/gateway-op-lock.do.js`.
2. Deploy a separate Worker that exports `GatewayOpLock` from that file.
3. In Cloudflare Dashboard → Pages → Settings → Functions → Durable Object bindings:
   - Variable name: `GATEWAY_OP_LOCK`
   - Durable Object namespace: (namespace from step 2)
4. Re-deploy the Pages project.

### Layer 2 — Workers KV (GATEWAY_OPS_KV) — Fallback
Best-effort idempotence. Strong protection for sequential/retried calls.
Best-effort for concurrent requests within the same millisecond window.

**Setup (wrangler.jsonc):**
```json
"kv_namespaces": [
  {
    "binding": "GATEWAY_OPS_KV",
    "id": "<create-with-wrangler-kv-namespace-create-GATEWAY_OPS_KV>"
  }
]
```

Create the namespace:
```bash
wrangler kv namespace create GATEWAY_OPS_KV
# Note the id from the output, add to wrangler.jsonc above
```

### Fail-safe Behaviour
If BOTH layers are unavailable: the POST to `/api/gateway/transfer` is **blocked with
HTTP 503** and the transfer is NOT forwarded to Circle. No transfer occurs without
at least one persistence layer confirmed active.

## State Machine

```
(none) → submitting → accepted → confirmed  [internal: POST on Circle 2xx]
                    → failed               [client: PATCH with status=failed]
submitting → failed                         [client or internal]
confirmed / failed: terminal
```

## Security Notes

- `status='confirmed'` can only be set by the proxy on a successful Circle response.
  The PATCH handler rejects `confirmed` from the client.
- GET and PATCH both require `?depositor=` — wrong depositor returns 404 (no existence leak).
- CORS: exact-origin allowlist + `env.ALLOWED_ORIGINS` for extensions.

## Pending

- `wrangler.jsonc` has CRLF line endings; add the binding manually in the Dashboard
  or via `wrangler kv namespace create` + manual JSON edit.
- Mainnet GW_WALLET / GW_MINTER addresses: verify at https://developers.circle.com/gateway
  before production use. Testnet: 0x0077.../0x0022... (confirmed Circle docs Oct 2026).
