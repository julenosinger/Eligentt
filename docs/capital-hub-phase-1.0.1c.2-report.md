# Capital Hub Phase 1.0.1C.2 — Financial Invariants & End-to-End Execution Readiness

> Continuation of `work/capital-hub-phase-1.0.1` (base `0e18a13`). Hardening of the
> GatewayExecutionCoordinator financial invariants (isolated development — no
> production activation, no real transactions, no merge/deploy).

## Classification
**APPROVED FOR ISOLATED DEVELOPMENT** — all gates of this phase are proven, with
two honestly-documented limitations (frontend cross-refresh identity; network-list
reconciliation deferred for zero-regression).

---

## Root causes fixed (by gate)

### Gate A — Permanent idempotency (FIXED)
`_reserve` allowed reusing an idempotency key after a terminal state (the "terminal
→ allow new" branch). Now: same key + same payload → recover the ORIGINAL operation
**even after confirmed/rejected/failed**; same key + different payload → conflict; a
new intent MUST use a new key. An idem index pointing to a missing record now fails
safe (`500 corrupt_idempotency_index`) instead of silently recreating. Releasing
balance never releases the identity. (`gateway-execution-coordinator.do.js` `_reserve`.)

### Gate B — Monetary normalization (FIXED)
Circle `/v1/balances` returns `balance` as a **decimal string** (`"10.000000"`, per
the official `non-usdc-assets` docs), NOT atomic — while burn-intent amounts are
atomic. `fetchGatewayBalance` was returning the decimal string raw (mismatch with the
atomic `value+maxFee`). Now: `decimalToAtomic` (strict BigInt decimal parsing) +
`tokenDecimalsFor` (USDC/EURC=6, cirBTC=8) normalize the balance to atomic; invalid,
incomplete, or missing responses return `null` (fail-closed), never a fake zero.
(`coordinator-util.js`, `transfer.js`.)

### Gate C — Snapshot consistency (FIXED)
`_setBalance` now enforces **monotonic snapshot ordering**: a `generation` counter +
caller-provided `asOf` (fetch-start time). An older snapshot (`asOf < current`) is
rejected (`409 stale_snapshot`), so a slow/out-of-order fetch can never restore
already-committed balance. On a settled terminal transition the snapshot is
decremented conservatively and its `asOf`/`generation` are bumped, so in-flight
pre-settlement snapshots are rejected. (`gateway-execution-coordinator.do.js`.)

### Gate D — Replay protection & history (FIXED)
`_release` no longer deletes the `idem:`/`salt:` bindings — those are permanent
replay-protection + audit links. Release only marks the record `released:true`
(separating financial-reservation release from historical identity). `_reserve`
now atomically checks `salt` and `operationId` collisions (rejecting a salt bound to
a different operation). (`gateway-execution-coordinator.do.js`.)

### Gate E — Durable rollback/compensation (FIXED)
`submitting → failed` was disallowed by the state machine, so `rollbackAll` failed
on an op already persisted as `submitting`. `submitting → failed` is now allowed
**only with `rollback:true`** (batch aborted before the POST) — never
indiscriminately. Rollback stays idempotent. (`gateway-execution-coordinator.do.js`.)

### Gate F — /confirm reconciliation (FIXED)
The best-effort `coordinatorWarning` is replaced by **durable, idempotent, replayable
reconciliation**: on a partial confirmation (per-salt updated, coordinator not yet),
a durable KV marker `gw:reconcile:<salt>` is written; the next `/confirm` for the same
depositor replays it (no new manual user action). `coordinatorConfirm` re-reads the
record version, so replay is idempotent and safe after restart. (`transfer.js`.)

### Gate G — Frontend idempotency key (PARTIAL, documented)
`saExecGateway` now generates a caller-provided `idempotencyKey` **before signing** and
sends it with the request (wired end-to-end: frontend → transfer.js → coordinator).
It is ignored when the coordinator is disabled. **Limitation:** the key is per-call,
not yet stable across page refresh/module-switch — a server-bound intent identity is
required for full stability and is deferred to 1.0.1D. (`index.html`.)

### Gate H — Circle response validation (verified, unchanged)
Per-item classification by echoed salt (never the first item's transferId for all),
HTTP 200-without-valid-attestation staying inconclusive, and 408/429/5xx → ambiguous
were already implemented in 1.0.1C.1/1.0.1A. No change needed.

### Gate I — Network isolation (documented)
Official docs confirm **Arc Testnet EVM chainId = `5042002`** (Arc/Circle docs); the
Circle domain ID `26` is shared between Arc mainnet and testnet, and the environment
is determined by the API base URL / GatewayWallet address (which `environmentFor`
already uses). The frontend `GW_TESTNET_CHAINS` entry `2999` and `transfer.js`'s
`1777078` are incorrect references to Arc Testnet. **No code change was made** (per
"no network changes based on assumptions" + zero-regression), documented for a
dedicated 1.0.1D reconciliation pass.

### Gate J — Real durability (FIXED)
Added an **on-disk SQLite persistence** test (`durableObjectsPersist` + `useSQLite`)
that writes a reservation (advancing to `ambiguous`), disposes the runtime, creates a
NEW runtime on the same directory, and verifies the operation record, idempotency
binding, salt binding, and non-terminal `ambiguous` state survive the restart.

### Gate K — Tests (40 real tests)
35 unit/behavioral tests + 5 Miniflare/workerd tests (4 in-memory + 1 on-disk
restart). No mocks on the logic under test; only external deps (fetch/DO binding/KV)
are mocked.

---

## Files
- `functions/api/gateway/coordinator-util.js` — `tokenDecimalsFor`, `decimalToAtomic`.
- `functions/api/gateway/gateway-execution-coordinator.do.js` — permanent idempotency,
  collision checks, snapshot ordering, release-preserves-identity, submitting→failed.
- `functions/api/gateway/transfer.js` — decimal→atomic balance, snapshot `asOf`,
  durable reconciliation markers.
- `index.html` — caller idempotency key (before signing, sent with request).
- `tests/gateway-execution-coordinator.test.js` (35), `...runtime.test.js` (5).

## Baseline comparison
- New behavioral tests: **40 pass** (35 + 5).
- Gateway/UB regression — **4 pre-existing failures unchanged** (`gateway-balance`
  UI6.3, `gateway-ub-fase29`, `send-assets-mainnet-source`, `treasury-restoration`).
  **Zero new failures.** (`unified-balance-engine` 3 failures are pre-existing, verified
  against base `80734f2`.)
- `npm run build` + `node --check` (×3) pass.

## Remaining risks / limitations
1. Frontend idempotency key is per-call (not cross-refresh) — needs a server-bound
   intent identity (1.0.1D).
2. Arc Testnet chain-id references (`2999`/`1777078`) not yet corrected — deferred to
   1.0.1D for zero-regression reconciliation.
3. Reconcile markers use `GATEWAY_OPS_KV` (non-prod); a production cron/alarm trigger
   is a 1.0.1D concern.
4. Coordinator remains disabled by default; no production activation.

No merge/deploy. No real transactions. No production Cloudflare changes.
