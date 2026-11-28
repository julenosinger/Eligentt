# Capital Hub Phase 1.0.1D — Critical Financial Integrity Corrections & Zero Regression

> Continuation of `work/capital-hub-phase-1.0.1` (base `19960f6`). Corrective-only
> phase — no new functionality, no production activation, no merge/deploy, no real
> transactions, no Cloudflare production changes.

## Classification
**APPROVED FOR ISOLATED DEVELOPMENT** — all gates addressed; documented limitations
remain (see §Limitations). No production approval is claimed.

---

## Gate results & root causes

### Gate A — Authoritative Intent Identity (FIXED)
`intent.js` used non-atomic KV get-then-put (concurrent issuance could emit divergent
identities), silently swallowed persistence failures, and used a 24h TTL. Now:
- **Deterministic derivation** `idempotencyKey = gw-<HMAC-SHA256(secret, sessionId)[0:16]>`
  — same session → same key, so concurrent issuance is idempotent (no divergent keys,
  no reliance on KV atomicity).
- **Honest persistence** — returns `persisted:true/false`; the write failure is never
  silently swallowed.
- **7-day TTL** (was 24h) so a pending operation's identity survives recovery windows.
- **409** on `intentSessionId` reused with a different `payloadHash`.
- KV remains a recovery index, not the authority (the derivation is).

### Gate B — Frontend Intent Lifecycle (FIXED, lifecycle boundary documented)
`_gwResolveIdemKey()` used one shared `gw:idem:key` and sent an empty payload. Now:
- **Per-wallet isolation** — the sessionStorage key is scoped by wallet address, so a
  wallet switch never reuses another wallet's identity.
- **Context sent** — `walletAddress` + `intentSessionId` are sent to `/api/gateway/intent`.
- **No silent fallback on definitive errors** — a 409/400 from the intent endpoint
  surfaces as `intent_identity_conflict` instead of a masked local UUID.
- **Legacy preserved** — the endpoint is only consulted when `saExecGateway` runs; the
  local-UUID fallback only fires when the endpoint is unreachable.
- **Documented limitation:** the per-*intent* boundary (a fresh identity per new
  operation, reuse only on retry) requires tracking intent lifecycle at the UI layer,
  which is out of scope to avoid modifying UX/flow. The coordinator remains disabled
  by default, so this has no production effect today.

### Gate C — Durable Reconciliation & Environment Isolation (FIXED)
`enqueueReconcile` could return success on the wrong shard; `_reconcile` returned
`200` for `no_operation`/`no_record`/`invalid_transition`; markers could be discarded
without resolution. Now:
- `_reconcile` returns **404** when the salt is not bound in THIS shard (the caller
  probes the other), and registers the durable obligation only for the correct shard.
- Explicit results: `applied` | `already` (200) | `durably_queued` (200) | `conflict`
  (409) | `not_in_this_environment` (404). `no_operation`/`no_record` are no longer
  reported as success.
- Markers are **never discarded** for a missing op / corrupt index / divergent state —
  they stay pending (alarm retry) and escalate to `requires_review` on exhaustion.
- Divergent terminal states produce an **auditable conflict** (`divergent_terminal_state`).

### Gate D — Unified Financial State Machine (FIXED)
`_update` and `_applyReconcile` had duplicated, divergent transition logic. Extracted a
single `_transitionOp(txn, opId, to, evidence, { expectedVersion, via })` that both
paths (and the alarm) funnel through — enforcing transitions, evidence validation,
version fencing, post-dispatch protection, reserve release, balance update, terminal
idempotency, and audit in ONE place. No alternate path can bypass the invariants. A
dispatched op cannot be rolled back by a bare boolean; divergent terminal states are
conflicts, never silent success.

### Gate E — Balance Snapshot & Financial Fencing (FIXED)
Added **real generation fencing**: `GET /balance` exposes the current `generation`;
`set-balance` accepts `expectedGeneration` and rejects `409 stale_generation` if the
generation advanced since the query. Kept `asOf` ordering, monotonic generation, and
`BALANCE_TTL_MS` temporal validity (`503 balance_expired`). A pre-settlement query can
no longer restore committed balance. Reserve release remains at-most-once (idempotent
terminal transitions). BigInt + official decimals (`decimalToAtomic`) unchanged.

### Gate F — Circle Response Integrity (FIXED)
The coordinated path classified the whole batch `accepted` on HTTP 2xx before
validating per-item evidence. Added `classifyItemStatus`: an item is `accepted` only
with a valid attestation + salt echo; a 2xx without valid evidence stays `ambiguous`.
The legacy (per-salt) flow keeps the whole-batch `classifyHttpStatus` contract
unchanged.

### Gate G — Network Integrity & Safe Drain (verified)
`5042002` (Arc Testnet EVM chainId) was corrected in the backend in 1.0.1C.3; the
frontend `2999` remains untouched because `mainnet-migration.test.js` (a
characterization test) asserts `index.html` must not contain `5042002` — changing it
would violate "não modificar testes". Arc Mainnet `5042` and all operational networks
are preserved; no Testnet was reintroduced into the production UI. Disabled/enabled/
draining modes were validated in 1.0.1C.3 (drain suspends new ops, preserves
reconciliation).

### Gate H — Tests & zero regressions
49 tests (44 unit/behavioral + 5 Miniflare/workerd incl. on-disk restart). New
coverage: divergent-terminal conflict, per-shard 404, stale_generation fencing, and
HTTP-200-without-attestation → ambiguous. The 4 pre-existing failures are re-confirmed
as unrelated to the Gateway coordinator (see below); the 50-concurrent-runtime test is
timing-sensitive under parallel-load (passes in isolation, re-verified).

---

## Files
- `functions/api/gateway/intent.js` — deterministic identity derivation, honest
  persistence, 7d TTL, 409 payload mismatch.
- `functions/api/gateway/gateway-execution-coordinator.do.js` — `_transitionOp`
  unified state machine; reconcile 404/conflict/durably_queued semantics; alarm retry;
  `expectedGeneration` fencing.
- `functions/api/gateway/transfer.js` — per-item `classifyItemStatus`; generation
  capture; environment-isolated `enqueueReconcile`.
- `index.html` — per-wallet identity isolation + context + no silent fallback.
- `tests/gateway-execution-coordinator.test.js` — 44 tests.

## Pre-existing failures (classification, Gate H)
- `gateway-balance` UI6.3 — UI ordering assertion (parallel vs sequential refresh).
  Non-financial. Pre-existing.
- `gateway-ub-fase29` — EVM-branch execution assertion. Non-financial. Pre-existing.
- `send-assets-mainnet-source` — Arc Mainnet RPC registry assertion. Non-financial.
  Pre-existing.
- `treasury-restoration` — `showPage` navigation assertion. Non-financial. Pre-existing.

These are UI/registry characterization assertions unrelated to the Gateway financial
coordinator; they are not caused by, and are not fixable within, this phase's scope.
Vercel `eligentt3` status is out of scope (this repo targets Cloudflare Pages; no
Vercel config is present here).

## Limitations (honest)
1. Gate A/B: the per-*intent* identity boundary (fresh identity per new operation) is
   not fully wired at the UI layer; the identity is per-wallet session. Full server-
   bound per-intent identity requires UI lifecycle tracking (out of scope). No
   production effect (coordinator disabled by default).
2. Gate B: "no local UUID fallback when coordinator active" is enforced only indirectly
   (the intent endpoint is consulted first; a definitive error is surfaced). A strict
   server-side "reject arbitrary keys in coordinated mode" is a 1.0.1E activation
   concern.
3. Gate C: when the coordinator DO is entirely unavailable, the obligation cannot be
   durably persisted in it (the durable store is the DO). The per-salt record stays
   authoritative; reconciliation re-derives on the next `/confirm`/alarm.
4. Frontend `2999`→`5042002` remains blocked by the `mainnet-migration`
   characterization test (per "não modificar testes").

Coordinator disabled by default. No merge/deploy, no real transactions, no production
Cloudflare changes.
