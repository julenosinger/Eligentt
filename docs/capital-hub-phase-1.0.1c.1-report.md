# Capital Hub Phase 1.0.1C.1 — Coordinator Financial Integrity & Lifecycle Hardening

> Continuation of `work/capital-hub-phase-1.0.1` (base `08734da`). Hardening of the
> `GatewayExecutionCoordinator` (isolated development — no production activation,
> no real transactions, no merge/deploy).

## Classification
**APPROVED FOR ISOLATED DEVELOPMENT** — all gates of this phase are proven.
Production activation remains **BLOCKED** until explicit authorization + Phase
1.0.1D validation.

---

## Root causes fixed (by gate)

### Gate B — Fail-closed (FIXED)
`coordinatorEnabled()` returned `flag && binding`, so a flag set ON with a missing
binding silently disabled the coordinator and fell back to the legacy per-salt-only
flow. Fixed: intent (`GATEWAY_EXECUTION_COORDINATOR_ENABLED`) is now separated from
availability (`GATEWAY_EXECUTION_COORDINATOR` binding shape). Flag ON + binding
absent/invalid → `503 coordinator_not_configured` BEFORE any reservation or
submission. (`transfer.js` `coordinatorDesired` / `coordinatorAvailable` + the
early check in `onRequestPost`.)

### Gate C — Per-intent identity (FIXED)
`idempotencyKeyFor` derived the key from the payment "slot" (depositor + domains +
token + recipient), conflating two independent identical payments (same recipient,
same amount). Fixed: the idempotency key is now a **caller-provided, explicit,
stable identifier** (validated by `isValidIdempotencyKey`); `canonicalPayloadHash`
(excludes salt) remains only the conflict-detection fingerprint. Same key + same
payload → recover; same key + different payload → conflict; new key → independent.
Two identical independent payments use two keys and both proceed.

### Gate D — Atomic financial reservation (FIXED)
The coordinator now enforces a **quantitative balance reservation** per scope
(`sourceToken:sourceDomain`), in BigInt, counting `value + maxFee` (worst-case).
A trusted `/set-balance` route stores the authoritative snapshot (server-fetched by
transfer.js from Circle `/v1/balances` — never client-supplied). `/reserve` rejects
`insufficient_available_balance` (422) or `balance_not_synced`/`balance_stale`
(503). Terminal transitions release the reservation; settled (confirmed / failed
post-accept) transitions additionally decrement the snapshot conservatively and mark
it stale. Ambiguous / requires_review reservations are never released on timeout.

### Gate E — Lifecycle & /confirm (FIXED)
- `reserved → submitting` is persisted **before** the Circle POST (recoverable
  `submitting` record on an interrupted POST).
- Durable `salt → operationId` binding (`KEY_SALT`) links salt/depositor/environment.
- `/confirm` now advances the coordinated operation to `confirmed`/`failed` after
  the per-salt record is verified (best-effort, with `coordinatorWarning` surfaced).

### Gate F — Recoverable persistence (FIXED)
The coordinator stores the raw `attestationPayload` + `attestationSignature`
(protected: DO-authenticated access only, never a public route) alongside their
SHA-256 integrity hashes, so the mint can be recovered after refresh. Circle's
official IRIS API is noted as an additional recovery path in the DO header. Never
invents transferId/evidence; never auto-generates a new salt/signature.

### Gate G — Batch integrity (FIXED)
Per-item evidence is now matched to its response **by the echoed burnIntent salt**
(the verifiable link), never "the first item's transferId for all records".
Unmatched/partial/out-of-order responses get no attestation/transferId (no invented
correspondence). Batch rollback uses a shared `rollbackAll` that rolls back salts +
coordinator reservations and records failures. No distributed atomicity is assumed
across DOs.

### Gate H — History & safe rollback (FIXED)
`_release` no longer deletes the operation record or the audit index: it marks the
record `released:true` and only unbinds the idempotency/salt mappings (verified
atomically to still point at THIS operation), so an old operation can never remove a
newer operation's binding. Disabling the flag or removing the binding never releases
ambiguous reservations or permits resubmission of started operations.

### Gate I — Classification, precision, networks (documented)
408/429/5xx/timeout → `ambiguous` (preserved, backend `classifyHttpStatus` + the
1.0.1B frontend `blocked:true` contract); 503 distinguishes pre-POST (`blocked:true`)
from post-POST indeterminate; 200-without-attestation stays inconclusive. BigInt/
padEnd preserved. **ChainId reconciliation (official docs):** Arc Testnet chainId is
`5042002` (Arc/Circle official docs). The frontend `GW_TESTNET_CHAINS` uses `2999`
(incorrect) and `transfer.js` uses `1777078` (incorrect). No code change was made
here (per "no changes to networks based on assumptions" + zero-regression mandate);
flagged for a dedicated 1.0.1D reconciliation pass.

### Gate J — Behavioral tests (33 real + 4 Miniflare)
`tests/gateway-execution-coordinator.test.js` (29) + a **real workerd runtime**
suite `tests/gateway-execution-coordinator.runtime.test.js` (4, Miniflare) exercise
the actual DO storage/transaction/`blockConcurrencyWhile` semantics: cross-salt
dedup, independent identical payments, insufficient-balance under concurrency
(50-concurrent single-winner), reservation-with-fees, fencing, terminal release,
release-history preservation, mainnet/testnet isolation, and the flag-gated
transfer.js integration (flag-ON-no-binding fail-closed, duplicate/conflict block,
per-item transferId, over-balance 422).

### Gate K — App protection (PASS)
No UI/layout/flow change; no contract/fee/network/asset change; coordinator remains
disabled by default; no production Cloudflare change; `GatewaySpendService` not
activated; Capital Hub native execution not enabled.

---

## Files
- `functions/api/gateway/coordinator-util.js` (modified) — removed the payment-
  characteristic-derived `idempotencyKeyFor`; added `isValidIdempotencyKey`,
  `scopeKeyFor`, `tokenSymbolFor`.
- `functions/api/gateway/gateway-execution-coordinator.do.js` (modified) — schema v2;
  caller idempotency key; quantitative balance reservation; `/set-balance`;
  submitting-before-POST; salt index; release-preserves-history.
- `functions/api/gateway/transfer.js` (modified) — fail-closed config; idempotencyKey
  pass-through; balance sync; per-item evidence; /confirm terminal transition.
- `wrangler.jsonc` (modified) — activation/rollback docs (comments only).
- `tests/gateway-execution-coordinator.test.js` (modified) — 29 tests.
- `tests/gateway-execution-coordinator.runtime.test.js` (new) — 4 Miniflare tests.

## Baseline comparison
- New behavioral tests: **33 pass** (29 + 4 runtime).
- Gateway/Send/UB regression — **4 pre-existing failures unchanged**:
  `gateway-balance` UI6.3, `gateway-ub-fase29` EVM branch,
  `send-assets-mainnet-source` Arc RPC, `treasury-restoration` (plus the Windows-path
  `gateway-spend-service`). **Zero new failures.**
- `gateway-fase18.test.js` (exercises `transfer.js` directly) passes — the flag-gated
  integration is a strict no-op when disabled.
- `npm run build` + `node --check` (×3) pass.

## Remaining risks / limitations
1. `/confirm` → coordinator terminal state is best-effort (surfaced via
   `coordinatorWarning`); a coordinator unavailable at confirm time leaves the record
   non-terminal (safe/conservative — reservation is not released, no over-spend).
2. Cross-process restart durability is NOT reproduced (Miniflare uses in-memory DO
   storage, no SQLite `persist`) — documented as UNVERIFIED.
3. ChainId reconciliation (`2999`→`5042002`, `1777078`→`5042002`) deferred to 1.0.1D
   (no network changes made here).
4. The frontend does not yet emit the caller idempotency key — required only when the
   coordinator is activated (currently disabled by default).

No merge/deploy. No real transactions. No production Cloudflare changes.
