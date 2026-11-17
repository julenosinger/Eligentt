# x402 Phase X402-2.1D.2A — Production Settlement Readiness, Durable Object Certification & Financial Reconciliation

> **PREPARATION ONLY.** Builds the durable settlement-attempt ledger, atomic
> claim, ambiguity protection and read-only reconciliation required for future
> production settlement. No settlement, no broadcast, no transfer, no deploy.

## 1. Baseline

| | Value |
|---|---|
| Initial HEAD | `4e7654a` — `docs(x402): phase 2.1D.1 … report` |
| Final HEAD (code) | `ad4cd0f` — `feat(x402): durable settlement ledger + atomic claim + reconciliation (X402-2.1D.2A)` |
| Branch / tree | `main`, clean at start |
| Baseline x402 | 441 passing / 0 failing |

## 2. Exact files changed

- `functions/api/x402/x402-settlement.mjs` (new) — pure settlement model:
  states/transitions, canonical authorization fingerprint, nonce namespace,
  attempt construction, transition validation, outcome classification.
- `functions/api/x402/x402-reconciliation.mjs` (new) — read-only reconciliation:
  pure evidence evaluation + `eth_call authorizationState` + provider status.
- `functions/api/x402/x402-intent.do.js` — settlement ledger actions
  (`/claim-settlement`, `/settlement-transition`, `/settlement-evidence`), inlined
  self-contained settlement model, verification-evidence fingerprint binding.
- `functions/api/x402/intent-service.mjs` — `doClaimSettlement`,
  `doSettlementTransition`, `doSettlementEvidence` wrappers.
- `tests/x402-settlement.test.js` (new, 12), `tests/x402-intent-do-runtime.test.js`
  (new, 3 — real workerd integration).
- `docs/x402-phase-2.1d2a.md` (this file).

## 3. Durable Object runtime certification

Introduced a real-workerd integration test (`x402-intent-do-runtime.test.js`)
that runs the actual `X402IntentStore` class inside Miniflare/workerd (the real
Cloudflare Workers runtime), exercising real storage, transactions,
`blockConcurrencyWhile`, alarms and single-instance serialization:

- Full lifecycle (create → prepare → reserve-nonce → re-read) against real DO storage.
- **50 concurrent creates → exactly one winner** (real single-instance semantics).
- Cross-wallet isolation (separate DO instances do not share state).

**Limitation (honestly documented):** this Miniflare build provides in-memory DO
storage (no SQLite file persistence via `persist`), so cross-process restart/
eviction durability is **NOT reproduced** and remains **UNVERIFIED**. The runtime
API compatibility (storage/transaction/alarm/concurrency) is certified for real;
persistence-across-restart is not claimed.

## 4. Facilitator contract findings (re-confirmed)

`GET /v1/facilitator/x402/supported`, `POST /v1/facilitator/x402/verify`
(non-settling), `POST /v1/facilitator/x402/settle` (disabled), `GET /status`.
Arc `eip155:5042` / USDC `0x3600…0000` / `exact` supported. A successful `/verify`
is NOT assumed to guarantee a future `/settle` — they are independent.

## 5. Verification-evidence integrity

`facilitatorVerification` now binds to the exact authorization via a canonical
SHA-256 `authorizationFingerprint` (chainId, token, authorizer, amount, payTo,
validAfter, validBefore, nonce, signature) plus `intentVersion`. Stale evidence
is guarded by `stateVersion`; contradictory evidence is never silently overwritten.

## 6. Settlement state machine (separate ledger)

Kept separate from the intent state machine (the signed intent stays `AUTHORIZED`):

```
SETTLEMENT_READY → SUBMITTING → SETTLEMENT_UNKNOWN → SETTLED | FAILED
                                  ↘ SETTLED | FAILED
```

Invariants (enforced): no READY→SETTLED (must pass SUBMITTING); SETTLED requires
authoritative evidence (transaction hash or confirmed provider ref); FAILED
requires a definitive rejection (never a timeout); SUBMITTING→SUBMITTING is an
idempotent re-entry (no new submission); terminal states absorb.

## 7. Atomic settlement claim

`/claim-settlement` atomically reserves the right to submit one authorization:
one claim per `(chainId, token, authorizer, nonce)`, immutable fingerprint, unique
`settlementAttemptId`, caller idempotency key, strict AUTHORIZED + stateVersion
checks. **50 concurrent claims → exactly one winner** (tested); a second caller
receives the existing attempt, not permission to submit again. No local mutex is
relied upon — the guarantee is the DO single-instance + transaction.

## 8. Ambiguous outcome protection

The "provider accepted but response lost" case is represented as
`SETTLEMENT_UNKNOWN`, never FAILED and never auto-retried. `classifySubmissionOutcome`
maps timeouts/network errors/lost responses to `ambiguous`. Reconciliation (below)
is required before any further transition.

## 9. Read-only reconciliation engine

`evaluateReconciliation` + `reconcileSettlement` evaluate the attempt against the
facilitator `/status` (read-only) and on-chain `authorizationState(owner, nonce)`
via `eth_call`. An on-chain "consumed" flag alone does **not** prove the intended
recipient received the amount — a provider-confirmed transaction reference is
required before recommending SETTLED; otherwise the unresolved state is retained.
No fabricated transaction hashes, no state mutation.

## 10. Evidence model & crash recovery

Append-only `evidence[]` on each attempt; a new `transactionHash` contradicting a
recorded one is rejected (`contradictory_evidence`). All settlement state is
durable (DO storage); a claim is never released on worker restart. Recovery paths
re-read the ledger and reconcile, preserving "at most one authorized submission
path without authoritative reconciliation".

## 11. Security

Settlement actions are trusted-internal (DO_INTERNAL_SECRET), never publicly
routed; no client can write SETTLED/FAILED/SUBMITTING; signatures remain redacted
from all browser responses; no open settlement proxy; `settleEnabled()` remains
hard-false; `/pay` = 503; all gates (`SETTLEMENT_IMPLEMENTED`, `X402_ENABLED`,
`X402_INTENT_PERSISTENCE`, `X402_SIGNING_ENABLED`, `X402_FACILITATOR_VERIFY`)
remain off.

## 12. Test results & baseline comparison

| Suite | Result |
|---|---|
| x402 (20 files incl. settlement + reconciliation + runtime) | **456 passed / 0 failed** |
| CI `test` job + precision + Circle Wallet | 283 passed |
| Production build | success |
| Syntax (`node -c`) | clean |
| Lockfile (`utf-8-validate@5.0.10`) | intact |

New coverage (15): atomic claim (50-concurrent + idempotent + non-authorized),
state machine (READY→SUBMITTING→UNKNOWN→SETTLED, evidence-required, definitive-
failure-required, idempotent re-entry), contradictory evidence rejection, outcome
classification, transition validation, reconciliation (provider-completed/failed/
on-chain-consumed-only), `authorizationState` read-only RPC, plus 3 real-workerd
integration tests.

Baseline 441 → **456** x402 passing; zero new failures in any touched file.

## 13. Unverified assumptions & remaining blockers

1. **Cross-restart DO durability UNVERIFIED** (in-memory Miniflare storage).
2. **Live facilitator `/verify`/`/settle` BLOCKED** (no credentials/authorization).
3. **`X402_INTENT_LOCK` binding not provisioned** — deployment instructions in
   `wrangler.jsonc`; not executed.
4. On-chain `authorizationState` verification is read-only and mock-tested; real
   Arc RPC finality/confirmation binding remains a future-phase certification.
5. The reconciliation recommendation must be applied by a trusted internal
   process (settlement-transition) — no automatic settlement exists.

**Verdict for X402-2.1D.2B:** the settlement-attempt ledger, atomic claim,
ambiguity handling, evidence model and read-only reconciliation are implemented,
durably serialized and tested; real provider settlement and cross-restart DO
persistence remain the explicit, gated remaining work.
