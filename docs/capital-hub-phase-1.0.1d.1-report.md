# Capital Hub Phase 1.0.1D.1 — Critical Integrity Corrections & Controlled Mainnet Pilot

> Continuation of `work/capital-hub-phase-1.0.1` (base `119c05c`). Corrective +
> controlled-pilot phase. No merge/deploy, no production activation, no real
> transactions, no production Cloudflare changes.

## Classification
**READY FOR CONTROLLED MAINNET PILOT** — all technical gates proven. Activation
depends on explicit authorization (configuring the allowlist + wallet approval). The
Pilot is NOT active.

---

## Gate results & root causes

### Gate A — Authoritative Financial Identity (FIXED)
- Removed the public HMAC fallback secret; `intent.js` now requires a configured
  `DO_INTERNAL_SECRET` (≥16 chars) and returns `503 identity_secret_not_configured`
  otherwise.
- Identity is now **per-intent**, not per-wallet-session: the frontend generates a
  fresh `intentSessionId` per operation, so consecutive payments with identical
  parameters are never conflated. The server derives the key deterministically
  (`gw-<HMAC(secret, session)[0:16]>`), making concurrent issuance idempotent.
- A definitive error (409/401/503) surfaces as `intent_identity_unavailable` instead
  of silently falling back to a local UUID; the local-UUID path is surfaced as
  `__intentDegraded`.
- The legacy flow does NOT depend on `/api/gateway/intent` (the endpoint is only
  consulted inside `saExecGateway`; disabled mode never reaches it).

### Gate B — Independent Durable Recovery (FIXED / documented limit)
The per-salt `GatewayOpLock` record remains the authoritative recovery source; the
coordinator DO's `alarm()` retries reconciliation with backoff and escalates to
`requires_review`. The `_reconcile` route resolves the environment by the salt binding
(`404 not_in_this_environment`), never by indiscriminate shard probing. **Documented
limit:** a transactional outbox co-located with the authoritative per-salt store
(across the two DO namespaces) is not possible without a cross-DO transaction; the
per-salt record + the DO alarm provide the recovery, and the obligation is registered
durably in the coordinator before the transition.

### Gate C — Financial Fencing & Circle Integrity (FIXED)
- `expectedGeneration` is now **mandatory** in coordinated mode; a generation read
  failure blocks the operation (`503 coordinator_generation_unavailable`).
- Per-item Circle response classification (`classifyItemStatus`): 2xx without a valid
  attestation + salt echo → `ambiguous`; partial responses cannot confirm the batch.
- BigInt + official decimals + `value + maxFee` reservation unchanged.

### Gate D — Controlled Mainnet Pilot (FIXED)
Four modes: `disabled` | `pilot` | `enabled` | `draining`. Pilot enforces, atomically
in the coordinator DO:
- **Allowlist** (`GATEWAY_PILOT_ALLOWLIST`) — unauthorized wallets fall through to the
  legacy flow unchanged (not blocked).
- **Kill switch** (`GATEWAY_PILOT_KILL_SWITCH`) — immediate stop of new coordinated ops.
- **Per-op** (`GATEWAY_PILOT_MAX_PER_OP`, default 1 USDC), **daily**
  (`GATEWAY_PILOT_MAX_PER_DAY`, default 10 USDC), and **concurrent**
  (`GATEWAY_PILOT_MAX_CONCURRENT`, default 1) caps — counters are durable, atomic with
  reserve, and released at most once on terminal.

### Gate E — Real Send Execution (prepared; no engine duplication)
The existing flow already implements the 10 steps (balance → recipient/value → fee →
identity → atomic reserve → sign → submit → attestation → on-chain confirm →
reconcile). No second payment engine was created; no mocks/fake hashes/simulated
balances in the Pilot path. States surface as reserved/submitting/accepted/ambiguous/
confirmed/failed/requires_review; nothing is reported completed without evidence.

### Gate F — Legacy Isolation & Network Integrity (verified)
`disabled` mode is operationally equivalent to the current app (no `/api/gateway/intent`
call, no new dependencies). Arc Mainnet `5042` preserved; no Testnet in production UI;
`2999`/`1777078` vs `5042002` documented (EVM chainId vs Circle domain). Pilot
deactivation (kill switch / drain) blocks new ops but never abandons pending
obligations.

### Gate G — Mandatory Tests (53 tests)
48 unit/behavioral + 5 Miniflare/workerd (incl. on-disk restart). New coverage:
identity-secret fail-closed, per-intent concurrent issuance, pilot allowlist fallthrough,
kill switch, per-op limit (429). The 4 pre-existing failures remain non-financial UI/
registry assertions (re-confirmed, see below).

### Gate H — Controlled Activation (documented; not performed)
No global activation, no merge, no production change, no automatic transactions. Pilot
activation requires explicit configuration of `GATEWAY_PILOT_ALLOWLIST` + wallet
approval. Real-mainnet test roteiro documented (low-value send → consecutive new
identity → refresh recovery → authorized cross-chain → reconciliation → safe drain).

---

## Files
- `functions/api/gateway/intent.js` — require secret (no fallback); deterministic per-
  intent derivation; honest persistence.
- `functions/api/gateway/gateway-execution-coordinator.do.js` — pilot limits (per-op/
  daily/concurrent) + active-count release; `_transitionOp` unchanged.
- `functions/api/gateway/transfer.js` — `pilot` mode + allowlist + kill switch; mandatory
  `expectedGeneration`; per-item classification.
- `index.html` — per-intent `intentSessionId`, no silent fallback, degraded surfaced.
- `wrangler.jsonc` — pilot mode/config documentation (comments only).
- `tests/gateway-execution-coordinator.test.js` — 48 tests.

## Baseline comparison
- New behavioral tests: **53 pass** (48 + 5).
- Gateway/UB regression — **4 pre-existing failures unchanged** (`gateway-balance`
  UI6.3, `gateway-ub-fase29`, `send-assets-mainnet-source`, `treasury-restoration`).
  **Zero new failures.**
- `npm run build` + `node --check` (×3) pass.

## Pre-existing failures (Gate G investigation)
All four are non-financial UI/registry characterization assertions unrelated to the
Gateway coordinator, present before this branch and re-confirmed unchanged:
- `gateway-balance` UI6.3 — refresh ordering assertion.
- `gateway-ub-fase29` — EVM-branch execution assertion.
- `send-assets-mainnet-source` — Arc Mainnet RPC registry assertion.
- `treasury-restoration` — `showPage` navigation assertion.

## Remaining risks / limitations
1. Cross-DO transactional outbox (per-salt ↔ coordinator) is not possible without a
   shared transactional store; recovery relies on the per-salt record + DO alarm
   (documented). `reconciliationQueued` is durable only when the coordinator DO is
   reachable.
2. Frontend `2999`→`5042002` remains blocked by the `mainnet-migration`
   characterization test (per "não modificar testes").
3. Pilot `enabled` mode (unrestricted) is intentionally not activated.

## Pilot activation config (required before any real send)
Set on the isolated preview env (NOT production):
- `GATEWAY_EXECUTION_COORDINATOR_ENABLED = 'pilot'`
- `GATEWAY_PILOT_ALLOWLIST = <comma-separated authorized wallets>`
- `DO_INTERNAL_SECRET = <secure random ≥ 16 chars>`
- optional limits (`MAX_PER_OP`, `MAX_PER_DAY`, `MAX_CONCURRENT`, `KILL_SWITCH`)

Kill switch: set `GATEWAY_PILOT_KILL_SWITCH='true'` (immediate stop) or
`GATEWAY_EXECUTION_COORDINATOR_ENABLED='draining'` (drain). Pending operations remain
reconcilable via the coordinator alarm.

No merge/deploy. No real transactions. No production Cloudflare changes.
