# Capital Hub Phase 1.0.1D.2.4 — Infrastructure Recovery, Real Execution & Form Layout Fix

> Continuation of `work/capital-hub-phase-1.0.1` (base `2f93513`). No merge/deploy, no
> production change, no real transactions.

## Classification
**INFRASTRUCTURE BLOCKED** (persistence) + **code fixes delivered** (preflight + layout).

The "Gateway persistence unavailable — transfer was not submitted" is an
infrastructure condition, not a code bug: the deployed environment has **no
persistence binding** configured. This cannot be resolved in code (it requires
Cloudflare configuration, which is not accessible from here). I did NOT declare FIXED;
I delivered the code-side fixes I can make and the exact configuration required.

---

## Root cause (proven, code evidence)

`functions/api/gateway/transfer.js` `tryReserve()`:
- Uses `GATEWAY_OP_LOCK` (Durable Object) first, then `GATEWAY_OPS_KV` (non-production
  fallback). When **neither** is bound — or KV is bound but `GATEWAY_ENV`/
  `CF_PAGES_ENV_NAME` is `production` (KV disabled) — it returns
  `{ ok:false, error:'persistence_unavailable' }` (HTTP 503, `blocked:true`), which the
  UI surfaces as "Gateway persistence unavailable — transfer was not submitted".

`wrangler.jsonc` shows `GATEWAY_OPS_KV` is commented out (placeholder) and
`GATEWAY_OP_LOCK` is documented as requiring external Cloudflare Dashboard
configuration. So the preview has **neither** binding → 503. This is the intended
fail-closed behavior; it must NOT be bypassed.

## Code fixes delivered

### P0.5 — Operational preflight (before signing)
New `functions/api/gateway/health.js` (`GET /api/gateway/health`) — a non-destructive
probe that reports `persistence: 'do' | 'kv' | 'none'` with a specific reason (DO
reachable / DO secret mismatch / KV fallback / none). `saExecGateway()` now calls it
**before** `eth_signTypedData_v4`, so an infrastructure failure is surfaced with its
specific reason BEFORE the user signs (no signed-but-unsubmittable operation). This
does not bypass persistence; it moves the failure earlier and makes it actionable.

### UI — Send / Cross-chain form layout (as specified)
`shared/capitalHubManage.js` reordered to:
- Row 1: Asset | Gateway available.
- Row 2: Destination network | Amount (Amount keeps value + symbol + MAX).
- Row 3: Recipient address (100% width, `full` class).
- Row 4: Review transfer button.

IDs, handlers, validation, internal state, and financial integration are unchanged.
Withdraw's "Connected wallet" also becomes full-width; no other cards were touched.

## Exact infrastructure requirements (to unblock)

Deploy a standalone Worker exporting `GatewayOpLock` from
`functions/api/gateway/gateway-op-lock.do.js`, then bind it in Pages:

1. **Worker** (`wrangler.toml`):
   ```toml
   [[durable_objects.bindings]]
   name = "GATEWAY_OP_LOCK"
   class_name = "GatewayOpLock"
   [[migrations]]
   tag = "v1"
   new_classes = ["GatewayOpLock"]
   ```
   `wrangler deploy` from that Worker directory.
2. **Pages → Settings → Functions → Durable Object bindings**: add
   `GATEWAY_OP_LOCK` → that namespace.
3. **Pages → Environment variables**: `DO_INTERNAL_SECRET = <openssl rand -hex 32>`.
   (Optional, non-production only: bind `GATEWAY_OPS_KV` to a KV namespace for the
   non-atomic fallback — NOT recommended for real funds.)
4. Re-deploy the Pages project.

`GATEWAY_OP_LOCK` (atomic, durable) is the correct primary; KV is only a non-production
fallback and must not be the substitute for concurrent real-funds operations.

## Tests
- Added `health` endpoint tests (persistence `none`/`kv`/`do`).
- **54 coordinator tests + 5 runtime + 7 native-execution pass.**
- Full regression — **4 pre-existing failures unchanged, zero new** (`gateway-balance`
  UI6.3, `gateway-ub-fase29`, `send-assets-mainnet-source`, `treasury-restoration`).
- `npm run build` + `node --check` pass.

## Files
- `functions/api/gateway/health.js` (new) — operational preflight.
- `index.html` — preflight call before signing.
- `shared/capitalHubManage.js` — Send/Cross-chain form layout.
- `tests/gateway-execution-coordinator.test.js` — health tests.

## Status per functionality
- Deposit: preserved (untouched).
- Send / Cross-chain / Withdraw: code path is complete and preflight-gated; **runtime
  execution remains blocked until `GATEWAY_OP_LOCK` is bound**.
- Charge in USDC: wired to Billing Payment Links.
- Preflight: surfaces the specific infra reason before signing.

## Honest statement
This is **not** another simulated "FIXED". Real transfers cannot complete until the
Cloudflare persistence binding (`GATEWAY_OP_LOCK` Durable Object) is deployed and
configured. No financial success is claimed.

No merge/deploy. No production Cloudflare changes. No real transactions.
