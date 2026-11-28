# Capital Hub Phase 1.0.1C — Gateway Execution Coordinator & Infrastructure Readiness

> Continuation of `work/capital-hub-phase-1.0.1` (base `d8fb8d6`). Isolated
> development of the `GatewayExecutionCoordinator` Durable Object — no production
> activation, no real transactions, no merge/deploy.

## Classification
**APPROVED FOR ISOLATED DEVELOPMENT** — all gates of this phase are proven.
Production activation remains **BLOCKED** until explicit authorization + Phase
1.0.1D validation.

---

## Gate results

### Gate A — Baseline & architecture (PASS)
HEAD `d8fb8d6`, clean tree. Inspected `saExecGateway`, `saDispatchSend`,
`_execGatewayMint`, `execSend`, `GatewaySpendService`, `transfer.js`,
`gateway-op-lock.do.js`, `wrangler.jsonc`. Single authoritative source of state:
**GatewayOpLock remains the per-salt authority** (unchanged, historical records
preserved); the new `GatewayExecutionCoordinator` is **additive** — it adds a
cross-salt dedup gate, not a second concurrent executor.

### Gate B — Gateway Execution Coordinator (PASS — developed, isolated)
New DO `GatewayExecutionCoordinator`, keyed by `depositor:environment`:
- `operationId` (UUID) + `idempotencyKey` + `payloadHash` derived **server-side**
  from the burnIntent (`coordinator-util.js`).
- `canonicalPayloadHash(burnIntent)` = SHA-256 of the full immutable financial
  terms **excluding `salt`** → two intents with the same hash are the same
  financial operation regardless of salt.
- `idempotencyKeyFor(burnIntent)` = SHA-256 of the coarse "payment slot"
  (depositor, domains, token-pair, recipient).
- Dedup semantics (atomic, inside `storage.transaction`):
  - same key + same hash → **recover** existing operation (duplicate)
  - same key + different hash → **conflict** (slot reused with mutated terms)
  - terminal record → **allow new** (slot freed)
  - different recipient / chain / token → independent (never conflated)
- `environmentFor` distinguishes mainnet vs testnet via `sourceContract`
  (GatewayWallet address), with unknown → fail-closed (`null`).

### Gate C — State machine & persistence (PASS)
States: `reserved | submitting | accepted | ambiguous | requires_review |
confirmed | rejected | failed`. Atomic transitions with monotonic `version` +
fencing (`stale_version` on mismatch). Persists operationId, idempotencyKey,
payloadHash, depositor, environment, domains, token, value, recipient, maxFee,
salt, status, version, timestamps, transferId, expirationBlock, attestationHash,
signatureHash, txHash, evidence. Sensitive material (signature, attestation) is
stored only as a SHA-256 hash. Terminal transitions require evidence
(`confirmed` → txHash; `requires_review` → reason; `reserved/submitting → failed`
→ rollback flag). No external calls inside storage transactions.

### Gate D — Pending corrections (PASS for coordinator; finding recorded)
- The coordinator classifies 408/429/5xx as `ambiguous` (never a definitive
  rejection) — consistent with the existing `classifyHttpStatus`.
- **FINDING (not changed, deferred to 1.0.1D):** the frontend `GW_TESTNET_CHAINS`
  uses `2999` for Arc Testnet, while the rest of the codebase uses `5042002`
  (deploy/tests) and `transfer.js`'s `/confirm` comment references `1777078`.
  These three values are inconsistent. No change was made (to avoid breaking
  testnet flows); flagged for reconciliation in 1.0.1D.

### Gate E — Confirmation integrity (PASS — prepared, isolated)
The active `/confirm` flow is unchanged (positive receipt validation from 1.0.1A
is preserved). The coordinator's `confirmed`/`failed` transitions require
on-chain evidence and are wired for the post-forward status (`accepted`/
`ambiguous`). `/confirm` → coordinator terminal state is a documented 1.0.1D
follow-up (requires indexing coordinator records by salt).

### Gate F — Isolated integration & infrastructure (PASS)
Flag-gated integration in `transfer.js`, **disabled by default**:
- Active only when `GATEWAY_EXECUTION_COORDINATOR` binding present **AND**
  `GATEWAY_EXECUTION_COORDINATOR_ENABLED === 'true'`.
- When enabled but unavailable → fail-closed (503, `blocked:true`).
- Duplicate → 409 `already_submitted` (no forward); conflict → 409
  `coordinator_conflict` (no forward).
- When disabled → behavior is byte-for-byte identical to before.
- Proposed binding + worker + migration + activation/rollback documented in
  `wrangler.jsonc` (comments only — no production change).

### Gate G — Behavioral tests (PASS — 31 real tests)
`tests/gateway-execution-coordinator.test.js` exercises the **real** util, DO
class, and `transfer.js` handler (only external deps mocked): cross-salt dedup,
conflicting payload, independent payments, terminal slot-freeing, fencing,
evidence requirements, rollback gating, release gating, concurrent reserves,
mainnet/testnet isolation, and the flag-gated integration (disabled-preserves,
enabled-fail-closed, duplicate/conflict block, status updates).

### Gate H — App protection (PASS)
No UI/layout/flow change; no contract/fee/network/asset change; no production
config change; `GatewaySpendService` not activated; Capital Hub native execution
not enabled; no generalized mainnet blocking (fail-closed only when the
coordinator is explicitly enabled but unavailable).

### Gate I — Validation (PASS)
`npm run build` passes; `node --check` passes for all three files; full gateway
regression shows **only the 4 pre-existing failures** (below), **zero new**.

---

## Tests & baseline comparison
- New: `tests/gateway-execution-coordinator.test.js` — **31 pass**.
- Gateway/Send/UB regression — **4 pre-existing failures unchanged**:
  `gateway-balance` UI6.3, `gateway-ub-fase29` EVM branch,
  `send-assets-mainnet-source` Arc RPC, `treasury-restoration` (plus the
  Windows-path `gateway-spend-service`). **Zero new failures.**
- `gateway-fase18.test.js` (exercises `transfer.js` directly) passes — confirming
  the flag-gated integration is a strict no-op when disabled.

## Files
- `functions/api/gateway/coordinator-util.js` (new) — canonical hashing helpers.
- `functions/api/gateway/gateway-execution-coordinator.do.js` (new) — the DO.
- `functions/api/gateway/transfer.js` (modified) — flag-gated integration.
- `wrangler.jsonc` (modified) — binding/migration/activation/rollback docs (comments).
- `tests/gateway-execution-coordinator.test.js` (new) — 31 behavioral tests.

## Activation & rollback plan
- Activation: deploy the standalone Worker → add the DO binding → set
  `GATEWAY_EXECUTION_COORDINATOR_ENABLED='true'` (controlled roll-out).
- Rollback: set the flag to `'false'` (or remove the binding). Pending operations
  remain readable via `/status`; the per-salt `GATEWAY_OP_LOCK` records are
  untouched.

## Remaining risks / limitations
1. `/confirm` → coordinator terminal state is a 1.0.1D follow-up (currently the
   coordinator persists `accepted`/`ambiguous`; terminal `confirmed`/`failed` from
   `/confirm` is not yet wired). The slot-freed-by-terminal semantics is fully
   implemented and tested at the DO layer.
2. Testnet chain-id list (`2999` vs `5042002` vs `1777078`) needs reconciliation
   (Gate D finding) — no change made to avoid regressions.
3. The coordinator is not activated anywhere; it is proven only in isolated tests
   and local concurrency simulation.

No merge/deploy. No real transactions. No production Cloudflare changes.
