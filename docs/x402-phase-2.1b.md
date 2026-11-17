# x402 Phase X402-2.1B — Persistent Payment Intent, Idempotency & Replay Protection

> P0 financial-integrity foundation: a durable, auditable, replay-resistant
> payment-intent layer for x402 on Arc Mainnet (5042). **No signing, no
> settlement, no broadcast, no deploy, no real payments.**

## A. Baseline

| | Value |
|---|---|
| Initial HEAD | `cfb6601` — `docs(x402): phase 2.1A financial precision & validation hardening report` |
| Final HEAD (code) | `c58ed03` — `feat(x402): durable payment-intent DO + idempotency + replay protection (X402-2.1B)` |
| Branch | `main` |
| Working tree | clean at start |
| Baseline x402 tests | 322 (321 passed + 1 pre-existing phase126 string-match failure) |
| Phase X402-2.1A | present (`parseDecimalUnits` / `parseAtomicUnits`, BigInt cap, Arc `eip3009Compatible:true`) |

## B. Architecture

```
Authenticated HTTP (AUTH_KV session)
        │  resolveUserWallet()  (reused, exported from x402/index.js)
        ▼
/api/x402/intent*  (intent.js — gate: X402_INTENT_PERSISTENCE, default OFF)
        │
        ▼
intent-service.mjs  (canonicalize + SHA-256 digests + DO invocation)
        │
        ▼
X402_INTENT_LOCK Durable Object  (x402-intent.do.js — one instance per userId)
        │
        ▼
state.storage (SQLite-backed on modern CF) + transaction() + alarms
```

**Coordinator scope (sharding proof).** One Durable Object per authenticated
`userId`. Every intent belongs to exactly one user; the idempotency key is
scoped to `(user, wallet, requestDigest)`; the EIP-3009 nonce namespace is
`(chainId, token, wallet, nonce)` and `wallet → user` is a function. Therefore
**all** operations that could conflict — same idempotency key, same nonce —
route to the **same** DO and are serialized by the Cloudflare runtime. This
avoids both an unbounded global singleton and per-intent sharding (which would
let two intents reserve the same nonce on different coordinators).

**Deployment deviation (documented, not invented).** This repository is
Cloudflare **Pages Functions**, which cannot declare DO classes inline (see
`wrangler.jsonc`). The `X402IntentStore` class therefore ships as a
separate-Worker class bound via the Dashboard — exactly the pattern already
used by `GatewayOpLock`, `PaymentLock` and `CpnLock`. No new runtime binding was
invented.

**Storage.** The existing repo DO idiom — `state.storage` KV API (SQLite-backed
on modern CF) + `storage.transaction()` (atomic read-modify-write) +
`blockConcurrencyWhile()` (serialize fetch vs alarm) + a single re-arming alarm.
No raw `state.storage.sql` (not used anywhere in this repo); no `storage.list()`
(an explicit `index:intents` key is maintained instead).

**Financial precision.** The DO and service never reimplement amount parsing;
they consume `parseAtomicUnits` / `parseDecimalUnits` / `validateRequirement`
from `_x402.mjs` (the 2.1A authoritative contract). Amounts are persisted as
canonical decimal strings; BigInt is never JSON-serialized.

## C. Persistence model

Intent record (`intent:<intentId>`):

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | int | = 1 |
| `intentId` | string | `crypto.randomUUID()` |
| `userId` | string | session-bound UUID |
| `walletAddress` | string | lowercase hex |
| `walletProvider` | string | `circle` |
| `resourceUrl` / `resourceFingerprint` | string | offer identity (SHA-256) |
| `requirementDigest` | string | SHA-256 of canonical requirement |
| `scheme` / `network` / `chainId` | — | exact scheme only |
| `assetAddress` / `tokenDecimals` | — | trusted asset allowlist |
| `amountAtomic` | **string** | canonical decimal (atomic units) |
| `payTo` | string | lowercase hex |
| `maxTimeoutSeconds` | int | validated |
| `authorizationNonce` | string\|null | set on reserve |
| `idempotencyKey` | string | `[A-Za-z0-9._-]{8,128}` |
| `state` / `stateVersion` | — | machine + optimistic version |
| `createdAt` / `updatedAt` / `expiresAt` | ISO | trusted server clock |
| `authorizedAt` / `settlementAttemptId` / `settlementStatus` / `transactionHash` / `settlementEvidence` / `lastErrorCode` | null | future phases — inactive now |

Storage keys: `intent:<id>`, `idem:<key>`, `nonce:<chainId>:<token>:<wallet>:<nonce>`,
`index:intents`. Amounts are never stored as Number/float. No private keys,
Circle credentials, raw session tokens, or unnecessary evidence are stored.

## D. State machine

```
CREATED ──prepare──▶ PREPARED ──reserve-nonce──▶ AWAITING_AUTHORIZATION
   │                    │  │                           │  │
   └─cancel/expire──────┘  └────────cancel/expire───────┘  └─cancel/expire
```

- **Active (this phase):** `CREATED`, `PREPARED`, `AWAITING_AUTHORIZATION`,
  `EXPIRED`, `CANCELLED`.
- **Reserved (future, not publicly callable):** `AUTHORIZED`, `SUBMITTING`,
  `SETTLEMENT_UNKNOWN`, `SETTLED`, `FAILED`.
- **Terminal:** `EXPIRED`, `CANCELLED`, `SETTLED`, `FAILED`.

Allowlisted transition table:

| From | To |
|---|---|
| `CREATED` | `PREPARED`, `CANCELLED`, `EXPIRED` |
| `PREPARED` | `AWAITING_AUTHORIZATION`, `CANCELLED`, `EXPIRED` |
| `AWAITING_AUTHORIZATION` | `CANCELLED`, `EXPIRED` |
| `EXPIRED` / `CANCELLED` | — (terminal) |
| `AUTHORIZED` / `SUBMITTING` / `SETTLEMENT_UNKNOWN` / `SETTLED` / `FAILED` | — (reserved, no public transitions) |

- The client transition surface (`/transition`) only accepts `PREPARED` and
  `CANCELLED`; any other target — including `SETTLED`, `FAILED`, `AUTHORIZED`,
  `SUBMITTING`, `SETTLEMENT_UNKNOWN`, `EXPIRED` — is rejected `403 forbidden_transition`.
- Invalid/backward transitions → `400 invalid_transition`; stale version →
  `409 stale_version`; transition after expiry → `409 intent_expired`.
- Every successful transition increments `stateVersion` exactly once; repeated
  identical requests are idempotent (already-in-target-state → current record).
- Expiry only applies to unsigned states; a future signed/submitted intent is
  never auto-expired.

## E. Idempotency

- Key scope: `(userId, walletAddress, requestDigest)` — the digest is
  `SHA-256(CREATE_DOMAIN, { requirementDigest, resourceFingerprint, walletAddress })`.
- `idempotencyKey` validated `[A-Za-z0-9._-]{8,128}`.
- Atomic create-or-return (single `transaction`):
  - same key + same digest → returns the existing intent (`idempotent: true`);
  - same key + different digest → `409 idempotency_conflict` (never silently replaces);
  - different key → new intent (subject to per-user record cap).
- Different users/wallets with identical keys do not collide (per-user shard +
  wallet bound into the digest).

## F. Replay protection

- Nonce namespace (authoritative): `(chainId, token, wallet, nonce)`.
- Nonce is an EIP-3009 authorization identifier (canonical decimal string,
  ≤ 78 digits); distinct from transaction nonces and ERC-2612 permits.
- `reserveAuthorizationNonce` is atomic: one nonce → at most one owning intent.
  Repeated reservation by the same intent is idempotent; by another intent →
  `409 nonce_already_reserved`.
- **Never released on timeout/expiry** — the reservation is retained until
  authoritative reconciliation establishes the outcome (future phase).
- No on-chain nonce consumption in this phase.

## G. Recovery

- **Trusted server clock** (`Date.now()`), never client timestamps.
- **Lazy expiration** on read: an expired unsigned intent becomes `EXPIRED`
  atomically before the read/transition result is returned.
- **Alarm** (single, re-arming, idempotent): sweeps `index:intents`, transitions
  expired unsigned intents, re-arms to the next earliest `expiresAt` (or clears).
- **Restart-safe**: all state is in DO storage; in-memory caches are absent.
- **No deletion**: expired/cancelled intents and their nonce reservations are
  retained. Record count is bounded by `X402_INTENT_MAX_PER_USER` (default 200);
  archival GC is a future concern (documented, not implemented).

## H. Security

- **Auth**: identity/wallet resolved from the AUTH_KV session (never the body);
  per-user DO makes cross-user access structurally impossible.
- **DO internal auth**: `X-DO-Internal-Secret` (constant-time compare); absent
  secret → 401, DO never exposed as a public route.
- **Fail-closed**: `X402_INTENT_PERSISTENCE=false` (default) or missing DO
  binding → 503 for the whole surface.
- **Input hardening**: bounded string lengths, regex-validated IDs/keys/nonces/
  amounts, canonical lowercase addresses, record-count cap, no internal error
  stacks to clients.
- **Precision**: BigInt exact comparisons; canonical decimal-string amounts;
  never `Number`/`parseFloat`/`Math.round` for authorization.
- **Intent/substitution protection**: digest binds offer + wallet + operation;
  no silent replacement of financial evidence (terminal fields are null and
  cannot be set by clients).

## I. Cloudflare integration

- New DO class `X402IntentStore` (unique namespace `X402_INTENT_LOCK`), deployed
  as a separate Worker and bound via Dashboard (like `GATEWAY_OP_LOCK`/`CPN_LOCK`).
- SQLite-backed (new namespace, migration tag `v1`); no existing namespace or
  migration is modified.
- Reuses `DO_INTERNAL_SECRET`; no new dependency added.
- Until bound (and while the flag is off), routes fail closed with 503.
- **Not deployed** (per directive).

## J. Test evidence

| Suite | Result |
|---|---|
| x402 (14 files incl. `x402-intent`, `x402-intent-do`) | **382 passed / 0 failed** |
| `send-assets-precision` + circle wallet (3 files) | 70 passed |
| Production build (`npm run build`) | success (4.2s) |
| Full repo suite | 4671 passed / **149 pre-existing failed** / 4 skipped (was 150) |

New coverage (60 tests):
- `x402-intent-do.test.js` (35): state machine, idempotency, nonce reservation,
  50-concurrent-create → 1 intent, concurrent nonce race → 1 owner, expiry sweep,
  duplicate alarm idempotency, nonce retained on expiry, reserved states
  unreachable, cross-user shard isolation, malformed/adversarial records.
- `x402-intent.test.js` (25): canonicalization + digest determinism, gate
  fail-closed, HTTP create/get/prepare/cancel, idempotency, conflict, stale
  version, cross-user 404, unauthenticated 401, wallet-not-provisioned 400,
  client-cannot-settle.

Adversarial scenarios exercised: persistence-failure path (missing binding →
503), duplicate retry after lost response (idempotent create), restart between
create/prepare (state read from storage), concurrent nonce reservation,
conflicting idempotency payload, expiration racing prepare, cancel racing
prepare, stale stateVersion, cross-user access, invalid wallet/chain/token
binding, duplicate alarm, malformed record, unknown schemaVersion, client set
SETTLED (403/404), nonce reuse, extremely large amount.

**Not integration-verified:** the mock storage serializes concurrent requests
(matching the DO single-instance guarantee) but does **not** exercise SQLite
durability across a real worker restart. That guarantee is carried by the
Cloudflare runtime + `transaction()` and is documented, not unit-proven.

## K. Regression analysis

Initial → final: full-suite failures **150 → 149** (no new failures).

Changed files:

- `functions/api/x402/x402-intent.do.js` (new) — `X402IntentStore` DO.
- `functions/api/x402/intent-service.mjs` (new) — canonicalization, SHA-256
  digests, gate, DO invocation.
- `functions/api/x402/intent.js` (new) — gated HTTP routes.
- `functions/api/x402/index.js` — `export` on `resolveUserWallet` (additive).
- `functions/api/x402/_x402.mjs` — removed a stale "Arc blocked" comment.
- `tests/x402-intent-do.test.js`, `tests/x402-intent.test.js` (new).
- `tests/x402-send-assets-phase126.test.js` — **test-only** fix: `REAL_SA_BODY`
  leading indent + `patchSrc` CRLF→LF normalization. No assertion weakened; the
  test still proves production settlement stays disabled (`sa402RawSrc` and
  disk HTML never contain `__testSettlement`). This is the §17 pre-existing
  failure, fixed independently.
- `wrangler.jsonc`, `.dev.vars.example` — documentation of the new binding/env.

**Not modified:** `index.html` (SA_X402), Send Assets, Swap/Bridge/CCTP/LI.FI/
Circle Gateway/CPN/Treasury/Autonoma/Unified Balance/Scheduler/Recipients/wallet
creation/token registry/contracts/RPC/fees/UI.

Preserved: `SETTLEMENT_IMPLEMENTED=false`, `X402_ENABLED=false` default,
`/api/x402/pay` 503, no signing/settlement/broadcast.

## L. Remaining blockers for X402-2.1C

1. **Provision the `X402_INTENT_LOCK` DO binding** (separate Worker + Dashboard
   binding) before enabling `X402_INTENT_PERSISTENCE`.
2. **Circle Wallet EIP-712 signing** on the Arc USDC domain (not yet confirmed).
3. **Facilitator `/verify` + `/settle`** integration (not implemented).
4. **Authorized/submitted state transitions** + reconciliation process (the
   reserved states remain unreachable, by design).
5. **Nonce reservation release/retention reconciliation** with on-chain
   `authorizationState` once real signing lands.

This phase does **not** claim production payment readiness.
