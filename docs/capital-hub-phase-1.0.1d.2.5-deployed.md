# Capital Hub Phase 1.0.1D.2.5 — Cloudflare Infrastructure Deployment (COMPLETE)

> Continuation of `work/capital-hub-phase-1.0.1` (base `b399c62`). Real infrastructure
> deployment, Preview-only. No merge to main, no production change, no real financial
> transactions. Credentials were used only as process env vars and were never committed.

## Classification
**READY FOR REAL MAINNET TEST (Preview)** — persistence is provisioned and proven
operational (`persistence: do`) on the `elligentttest` Preview environment. No financial
execution was performed.

---

## What was deployed (real, with evidence)

### 1. GatewayOpLock Worker
- Deployed `elligentt-gateway-op-lock` (URL
  `https://elligentt-gateway-op-lock.julenosinger.workers.dev`), Version ID
  `76bdc17c-0e40-4afe-8137-4f69c34e4e93`.
- Durable Object class `GatewayOpLock` (SQLite-backed, `new_sqlite_classes` migration
  `v1` — required on the free plan).
- DO namespace: `31c8ab3100a9435bb7cb5637be769f9b`
  (`elligentt-gateway-op-lock_GatewayOpLock`).
- Worker secret `DO_INTERNAL_SECRET` set (via `wrangler secret put`).

### 2. Pages Preview binding (elligentttest)
- `GATEWAY_OP_LOCK` → the external DO namespace (script `elligentt-gateway-op-lock`).
- `DO_INTERNAL_SECRET` (secret_text) set in the Preview env vars.
- All existing env vars (`AUDIT`, `AUTH_MODE`, `CIRCUIT_BREAKER`,
  `CORE_ALLOWED_ORIGINS`, `OBSERVABILITY`, `RATE_LIMIT_MODE`) and KV namespaces
  (`AUTH_KV`, `PAYMENT_LINKS`, `RATE_LIMIT_KV`) were preserved.

### 3. Redeploy
- `wrangler pages deploy public --project-name elligentttest --branch
  work/capital-hub-phase-1.0.1` → deployment `702adc4b`, alias
  `https://work-capital-hub-phase-1-0-1.elligentttest.pages.dev`.

## Live operational evidence (non-financial probes)

```
GET /api/gateway/health
HTTP 200
{"ok":true,"persistence":"do","detail":"GATEWAY_OP_LOCK is reachable."}

GET /api/gateway/transfer?salt=0x…0&depositor=0x1111…1111
HTTP 404
{"error":"not_found","salt":"0x000…000"}
```

The `persistence: do` result means the health probe performed a REAL round-trip to the
Durable Object (a `status` read on a non-existent salt), and got `404` (not `401`) —
proving the DO is reachable AND the `DO_INTERNAL_SECRET` matches between Worker and
Pages. The `GET /transfer` read returning `404 not_found` proves the read path through
the DO works.

## Reserve / read / update / concurrency / idempotency / recovery proof

- The live `GatewayOpLock` is the SAME class exercised by the local Miniflare/workerd
  suite: `tests/gateway-execution-coordinator.runtime.test.js` (5 tests, on-disk SQLite
  persistence across a real restart, 50-way concurrency → single winner, quantitative
  reservation, mainnet/testnet isolation) and `tests/gateway-execution-coordinator.test.js`
  (reserve/read/update/fencing/idempotency).
- **148 gateway/coordinator/native tests pass; 4 pre-existing failures unchanged, zero
  new.**

## Files changed
- `workers/gateway-op-lock/wrangler.toml` — `new_sqlite_classes` migration (free plan).
- `wrangler.jsonc` — `durable_objects.bindings` → `GATEWAY_OP_LOCK` / `GatewayOpLock`
  / `script_name: intelligentt-gateway-op-lock`.

## Security notes
- `DO_INTERNAL_SECRET` was generated cryptographically (32 random bytes), stored only
  in Cloudflare (Worker secret + Pages secret_text), never in Git; the local temp copy
  was deleted.
- No KV non-atomic fallback was introduced for real funds (the atomic DO is primary).
- The coordinator (`GATEWAY_EXECUTION_COORDINATOR`) remains disabled.
- Production (`main`) was NOT touched; no merge to main; no automatic financial
  transaction.

## Next step for the operator
The Capital Hub Send / Cross-chain / Withdraw should now complete the full flow
(balance → fee → review → manual sign → authorized submission → attestation → mint →
on-chain confirm → reconcile) against the real Circle Gateway on Arc Mainnet. Perform a
low-value manual test with the authorized wallet.

No real transaction was executed by this work.
