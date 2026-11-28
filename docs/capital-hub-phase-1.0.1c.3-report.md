# Capital Hub Phase 1.0.1C.3 — Final Execution Integrity & Activation Readiness

> Continuation of `work/capital-hub-phase-1.0.1` (base `0aa9a5f`). Final hardening
> of the GatewayExecutionCoordinator (isolated development — no production
> activation, no real transactions, no merge/deploy).

## Classification
**APPROVED FOR ISOLATED DEVELOPMENT** — all gates addressed with three honestly
documented limitations (see §Limitations).

---

## Root causes fixed (by gate)

### Gate A — Server-bound identity (FIXED, partial binding documented)
New endpoint `POST /api/gateway/intent` issues a **durable, server-persisted**
idempotency key (KV) bound to a client "intent session", with payload-hash
mismatch detection (`409 intent_session_payload_mismatch`). The frontend
`saExecGateway` now resolves the key via `_gwResolveIdemKey()` — cached in
`sessionStorage` (survives refresh), fetched from the server, with a local-UUID
fallback only when the endpoint is unreachable. This replaces the per-call UUID
generation. (`functions/api/gateway/intent.js`, `index.html`.)

### Gate B — Durable automatic reconciliation (FIXED)
`writeReconcileMarker` previously returned `reconciliationQueued:true` even without
persistence (best-effort KV, swallowed errors). Replaced with `enqueueReconcile`,
which registers a **durable obligation in the coordinator DO** (`POST /reconcile`)
independent of `GATEWAY_OPS_KV`, and returns `{ ok }` only on a durable ack. The
DO's `alarm()` retries with bounded backoff (`RECONCILE_BACKOFF_MS`) and escalates
exhausted markers to `requires_review`. `/confirm` now reports
`reconciliationQueued` only when durably enqueued. (`transfer.js`,
`gateway-execution-coordinator.do.js`.)

### Gate C — Circle response validation (verified, unchanged)
Per-item association by echoed salt, HTTP 200-without-valid-attestation staying
inconclusive, and 408/429/5xx → ambiguous were implemented in 1.0.1C.1/1.0.1A. No
change needed; re-verified by the 40 unit tests.

### Gate D — Snapshot consistency (FIXED)
The write-generation counter was not a freshness signal. Added **temporal validity**
(`BALANCE_TTL_MS` → `503 balance_expired`), kept `asOf`-based out-of-order rejection
and monotonic `generation`, and added a `GET /balance` metadata route (amount +
generation) so a caller can fence a later `/set-balance` against a stale query.
Settle bumps `asOf`/`generation` so pre-settlement snapshots are rejected.
(`gateway-execution-coordinator.do.js`.)

### Gate E — Rollback with evidence + fencing (FIXED)
`rollback:true` alone no longer proves non-submission. Added a durable `dispatched`
flag + `POST /dispatch` (set DURABLY right before the Circle POST). Rollback of a
dispatched op is refused (`409 cannot_rollback_dispatched`); it must resolve as
`ambiguous`. `coordinatorRollback` falls back to `ambiguous` for dispatched ops.
State persisted before the POST; no external calls inside storage transactions.
(`gateway-execution-coordinator.do.js`, `transfer.js`.)

### Gate F — Centralized network config (FIXED backend, frontend documented)
Corrected the backend Arc Testnet chainId `1777078` → `5042002` (official
Arc/Circle docs) in `GATEWAY_MINTER_ADDRESSES` + comment. The frontend
`GW_TESTNET_CHAINS` entry `2999` (also incorrect) is **not changed** because
`mainnet-migration.test.js` (a characterization test) asserts `index.html` must not
contain `5042002` — a dedicated reconciliation pass is deferred. EVM chainId (5042
mainnet / 5042002 testnet) vs Circle domain ID (26, shared) are documented.

### Gate G — Drain & safe deactivation (FIXED)
Added a third mode: `GATEWAY_EXECUTION_COORDINATOR_ENABLED` = `absent/false` →
disabled, `true` → enabled, `drain` → **draining**. During drain, NEW coordinated
operations are suspended (`503 coordinator_draining`, no legacy fallback), while
existing operations stay protected and reconciled (the `/confirm` path and the DO
alarm still run during drain). Flag ON/drain with a missing binding remains
fail-closed. (`transfer.js`.)

### Gate H — Tests (45 real tests)
40 unit/behavioral + 5 Miniflare/workerd (incl. on-disk restart). New coverage:
dispatched-rollback refusal, `/reconcile` durable obligation + idempotent replay,
snapshot TTL expiry, drain-mode suspension, and the intent-endpoint
issue/recover. No mocks on the logic under test.

---

## Files
- `functions/api/gateway/intent.js` (new) — server-bound identity endpoint.
- `functions/api/gateway/gateway-execution-coordinator.do.js` — `/dispatch`,
  `/reconcile`, `/balance`, `alarm()`, dispatched flag, TTL, rollback gating.
- `functions/api/gateway/transfer.js` — drain mode, durable enqueue, honest
  `reconciliationQueued`, dispatched-before-POST, 5042002 fix.
- `index.html` — `_gwResolveIdemKey` (server-bound, session-stable).
- `tests/gateway-execution-coordinator.test.js` — 40 tests.

## Baseline comparison
- New behavioral tests: **45 pass** (40 + 5).
- Gateway/UB regression — **4 pre-existing failures unchanged** (`gateway-balance`
  UI6.3, `gateway-ub-fase29`, `send-assets-mainnet-source`, `treasury-restoration`).
  **Zero new failures.**
- `npm run build` + `node --check` (×4) pass.

## Limitations (honest, no false completion)
1. **Gate A binding is partial**: the identity binds to a client "intent session",
   not yet the full authenticated user + wallet + environment + immutable params
   context (the endpoint accepts a `payloadHash` for mismatch detection but does not
   yet enforce a server-side user/wallet binding). Full server-bound intent identity
   is a 1.0.1D activation concern.
2. **Gate F frontend**: `2999` → `5042002` in `index.html` is blocked by the
   `mainnet-migration` characterization test; deferred for a dedicated
   reconciliation pass.
3. **Gate B edge**: when the coordinator DO is entirely unavailable, the obligation
   cannot be durably persisted (the durable store is the DO itself). The per-salt
   record remains authoritative; reconciliation re-derives on the next `/confirm` or
   alarm. This is the inherent two-DO atomicity limit (no distributed transaction).

Coordinator remains **disabled by default**. No merge/deploy, no real transactions,
no production Cloudflare changes.
