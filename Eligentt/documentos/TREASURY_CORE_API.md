# Treasury Core API — Technical Documentation (Phase 2)

> **Status:** Phase 2 complete — infrastructure layer only. No client application
> (ExecDaat) is integrated yet. No existing flow (Turbo Bridge, Vault, Treasury,
> Circle CCTP, Settlement, Reimbursement, Smart Contracts, ABIs) was modified.

The **Treasury Core API** is an additive, modular, versioned services layer that
sits **on top of** the existing Treasury Engine. It provides a single, secure,
standardized entry point for current and future applications while **reusing**
100% of the existing financial logic.

```
Application
   ↓
Treasury Core API        ← NEW (this phase)  /api/core/v1/*
   ↓
Treasury Engine (existing: relayer, mint, vault ops)  ← UNCHANGED
   ↓
Vault → Circle CCTP → Settlement → Reimbursement       ← UNCHANGED
```

---

## 1. Architecture

The Core API is a layered pipeline. Every request flows through the same stages,
implemented in `functions/api/core/pipeline.mjs`:

```
Request
  → Correlation (requestId + correlationId)
  → CORS / Method guard
  → Body parse
  → Authentication Layer      (auth.mjs — Internal enabled)
  → Authorization Layer       (registry.mjs — status + permissions)
  → Rate Limit (record-only)  (rate-limit.mjs — never blocks in Phase 2)
  → Validation Layer          (validation.mjs)
  → Business handler          → Treasury Engine (existing services)
  → Ledger                    (ledger.mjs — Phase 1, reused)
  → Audit                     (audit.mjs)
  → Standardized Response     (response.mjs)
```

### Module map (`functions/api/core/`)

| Module | Responsibility |
|---|---|
| `response.mjs` | Standard envelope, CORS, deep sensitive-field masking, `CoreError` |
| `correlation.mjs` | `requestId` + `correlationId` generation / propagation |
| `logger.mjs` | Structured, masked, stage-based logs (complements existing logs) |
| `store.mjs` | KV helpers + Core intent store (`coreKv`, `ledgerKv`) |
| `validation.mjs` | Pure request validators per endpoint |
| `auth.mjs` | Modular authentication (Internal enabled; others prepared) |
| `registry.mjs` | Application Registry (seeds + KV overlay) |
| `application-secret.mjs` | Hashed application secrets (never plaintext) |
| `rate-limit.mjs` | Per-app/client/endpoint usage recording (non-blocking) |
| `audit.mjs` | Per-request audit trail (no sensitive data) |
| `quote-engine.mjs` | Route/fee/ETA projection from existing config |
| `metrics.mjs` | Aggregation over Ledger + Core intent store |
| `intent-service.mjs` | Intent id/record/timeline helpers |
| `pipeline.mjs` | The orchestrator that wires all layers together |

> **No duplication:** the Core API never re-implements bridge/treasury logic.
> `execute` delegates in-process to the existing `/api/relayer` handler.

---

## 2. Endpoints (versioned under `/api/core/v1/`)

The path is versioned (`v1`) so future breaking changes ship as `v2` without
disrupting existing consumers.

| Method | Path | Purpose | Permission |
|---|---|---|---|
| POST | `/api/core/v1/intents` | Create (register) an intent | `intents:create` |
| GET  | `/api/core/v1/intents/{intentId}` | Intent status/timeline | `intents:read` |
| POST | `/api/core/v1/quote` | Route quote (fee/ETA/receive) | `quote:read` |
| POST | `/api/core/v1/execute` | Execute Turbo Bridge (delegates) | `execute:write` |
| GET  | `/api/core/v1/history` | Filter/paginate/sort intents | `history:read` |
| GET  | `/api/core/v1/metrics` | Platform + per-app metrics | `metrics:read` |
| GET  | `/api/core/v1/health` | Component health | `health:read` |
| GET  | `/api/core/v1/applications` | Application Registry (read) | `health:read` |

### Standard response envelope

Every response (success or error) has the same shape:

```json
{
  "success": true,
  "requestId": "req_…",
  "correlationId": "cid_… (or the caller's X-Correlation-ID)",
  "timestamp": "2026-07-05T00:00:00.000Z",
  "version": "v1",
  "data": { },
  "errors": []
}
```

Errors are `{ code, message, field? }`. HTTP status codes: `200/201` success,
`401` auth not enabled, `403` app not active / missing permission, `404` not
found, `422` validation, `500/502` engine error.

---

## 3. Flow — Create Intent

`POST /api/core/v1/intents`

```
validate(asset, amount, wallet, chains)
  → attribute Application / Client / Version (Phase 1 context)
  → generate intentId (+ intentBytes32 = keccak256(intentId))
  → attach quote (bridge/fee/receive/eta)
  → persist Core intent record (KV: core:intent:*)
  → Ledger.record(stage = INTENT, status = Pending)
  → return { intentId, quote, … }   (HTTP 201)
```

**This endpoint does NOT execute the bridge.** It only registers the intention.

Request:
```json
{ "asset": "usdc", "amount": 100, "wallet": "0x…",
  "sourceChain": "11155111", "destChain": "5042002",
  "applicationId": "ELLIGENT", "clientId": "default", "version": "1" }
```

---

## 4. Flow — Execute

`POST /api/core/v1/execute`

```
validate(intentId)
  → load Core intent (or use provided fields)
  → resolve { intentBytes32, asset, grossAmount, feeAmount, userAddress }
  → (dryRun? → return preview, no chain interaction)
  → Ledger.record(stage = BRIDGE, Pending)
  → DELEGATE to existing operator relayer  (functions/api/relayer.js)
        → fulfillAndPayWithFee(...)   [UNCHANGED engine]
  → on success: update intent (Fulfilled + txHash + timeline)
                Ledger.record(stage = TREASURY_PAYMENT, Success)
  → return { transactionHash, blockNumber, status }
```

The Turbo Bridge / Arc Bridge execution is performed **exactly** by the existing
relayer — the Core API only orchestrates and records. Private keys never leave
the relayer's environment and are never referenced by the Core API.

---

## 5. Flow — Settlement & Reimbursement (unchanged)

Settlement/reimbursement continues to run through the **existing** path — the
Core API does not alter it:

```
Treasury pays user (fulfillAndPayWithFee)
   → CCTP burn on source chain
   → Circle attestation
   → /api/relayer/mint (receiveMessage via Memo contract)  [UNCHANGED]
   → USDC minted back to the Vault (reimbursement)
```

The Core API observes settlement via the intent timeline + Ledger. The
`correlationId` links create → execute → settlement → reimbursement → history.

---

## 6. Authentication (prepared, modular)

`functions/api/core/auth.mjs`

| Method | Phase 2 |
|---|---|
| `internal` | **Enabled** — same-origin / no external credential → resolved application (ELLIGENT) |
| `apikey` | Prepared — detected, fails closed (`not_enabled`) |
| `jwt` | Prepared — detected, fails closed |
| `hmac` | Prepared — detected, fails closed |
| `mtls` | Prepared — detected, fails closed |
| `bearer` | Prepared — detected, fails closed |

Only `internal` is active. Any external credential is **recognized but refused**
until Phase 3, so nothing can authenticate early. The layer is pluggable: new
schemes register without touching the pipeline.

---

## 7. Application Registry

`functions/api/core/registry.mjs` — built-in seeds + KV overlay.

Record shape:
```json
{
  "applicationId": "ELLIGENT",
  "displayName": "Elligent",
  "status": "active | prepared | suspended",
  "environment": "production",
  "createdAt": "…", "updatedAt": "…",
  "permissions": ["intents:create", "execute:write", …],
  "rateLimits": { "requestsPerMin": 600, "intentsPerMin": 120, "bridgePerMin": 60 },
  "authMode": "internal",
  "version": "1",
  "secret": { "fingerprint": "fp_…", "status": "active", "rotationDate": null }
}
```

Seeds: **ELLIGENT** (active/internal, core), **EXECDAAT** (prepared, for Phase 3),
**FUTURE_APP** (prepared). Unknown ids resolve to a conservative *prepared*
default (never active). Secrets are stored **only** as salted SHA-256 hashes with
a fingerprint — plaintext is never persisted or returned.

### Application Secret (`application-secret.mjs`)
`{ hash, salt, fingerprint, status, rotationDate, createdAt, updatedAt }` —
`createSecretRecord()` consumes the plaintext; `verifySecret()` compares hashes
and fails closed; `publicSecretView()` strips `hash`/`salt`.

---

## 8. Ledger (reused from Phase 1)

`functions/api/ledger.mjs` records accounting-only stages:

```
INTENT → VAULT_DEBIT → TREASURY_PAYMENT → BRIDGE → SETTLEMENT → VAULT_CREDIT
```

The Core API reuses this module. `aggregateLedger()` powers the metrics
breakdown (`treasuryOutstanding = TREASURY_PAYMENT − VAULT_CREDIT`, per app).

**KV strategy:** `ledgerKv = env.LEDGER_KV || env.CORE_KV || env.RATE_LIMIT_KV`.
Core data is namespaced and stored in `CORE_KV`/`RATE_LIMIT_KV` (accessed only by
exact key), never in `PAYMENT_LINKS`, so the existing `treasury/fees` scan is
unaffected. Setting a shared `LEDGER_KV` unifies Phase-1 relayer ledger writes
with the Core ledger for combined metrics.

---

## 9. Correlation, Audit, Rate Limit, Versioning

- **Correlation ID** — every request carries a `correlationId` (from the caller's
  `X-Correlation-ID` or generated) echoed in the envelope, response header, logs,
  ledger and intent timeline for end-to-end tracing.
- **Audit** (`audit.mjs`) — one entry per request: application, client, ip, user
  agent, endpoint, method, intentId, http status, result, latency, requestId,
  timestamp. **No** bodies, secrets, keys, tokens or signatures.
- **Rate Limit** (`rate-limit.mjs`) — records per-minute usage per
  application/client/endpoint. **Never blocks in Phase 2** (`blocked:false`,
  `enforced:false`); reports `exceeded` informationally so Phase 3 can enforce.
- **Versioning** — path version (`v1`) + optional `version` / `Application-Version`
  / `Client-Version` carried in context for future migrations.

---

## 10. Security

- Private keys (`OPERATOR/TURBO_RELAYER/TREASURY/VAULT`) live **only** in the
  relayer environment; the Core API never references or returns them.
- Responses are deep-masked: `privateKey`, `secret`, `token`, `signature`,
  `attestation`, `apiKey`, `hmac`, `salt`, `hash`, `session`, … → `***REDACTED***`.
- External auth schemes fail **closed** (nothing authenticates before Phase 3).
- Application secrets are hashed (salted SHA-256), never stored/returned in clear.

---

## 11. Performance

- `execute` delegates in-process to the existing relayer (no re-fetch, no extra
  RPC beyond what the engine already does).
- `quote` and `metrics` perform **no** RPC — derived from config + Ledger.
- `health` uses a **single** lightweight `eth_blockNumber` RPC call (mirrors the
  existing `/api/health`).

---

## 12. Backward Compatibility

- No existing file's behavior changed. Additions to `shared-config.mjs` are new
  constants only (fee references + CCTP domain map); no existing consumer reads
  them.
- All existing endpoints, the Turbo Bridge, Vault, Treasury, Circle, Settlement,
  Dashboard, History, Analytics and the Phase-1 Ledger continue to work unchanged.
- Verified by the full test suite (see below).

---

## 13. Versioning Strategy

- **URI versioning:** `/api/core/v{n}/…`. `v1` is the current stable contract.
- **Additive within a version:** new optional fields only; never remove/rename.
- **Breaking changes → new version** (`v2`) served side-by-side; `v1` stays live.
- **Payload versioning:** requests may carry `version`, `Application-Version`,
  `Client-Version`; the resolved context is attached to ledger/audit for
  migration analytics.

---

## 14. Phase 3 — ExecDaat Integration Plan

Phase 2 leaves the platform ready for ExecDaat with **no schema changes**:

1. **Enable an auth scheme** — add `apikey` (or `hmac`/`jwt`) to
   `auth.mjs → ENABLED_METHODS` and implement the strategy that verifies the
   presented credential against the registry's hashed secret
   (`verifySecret`). Internal stays for Elligent.
2. **Activate the application** — set `EXECDAAT` registry `status = active`,
   provision its `secret` (hash only) and `rateLimits`.
3. **Enforce rate limits** — flip `rate-limit.mjs` to enforcing (`blocked` when
   `exceeded`), keeping the same counters.
4. **Authorization** — the pipeline already gates non-active apps (`403`); once
   `EXECDAAT` is active + permissioned, its calls pass.
5. **Remote calls** — ExecDaat calls `/api/core/v1/*` with its `applicationId` +
   credential + `X-Correlation-ID`; ledger, metrics, history and audit segregate
   automatically by application (already implemented).
6. **No engine changes** — bridge/settlement/reimbursement remain the existing
   Treasury Engine; ExecDaat never holds keys and never duplicates Treasury logic.

---

## 15. Testing

Phase 2 adds `tests/core/*` (response, correlation, application-secret, registry,
auth, engine, endpoints) covering: envelope consistency, masking, correlation
propagation, registry seeds/overlay, hashed secrets, auth enablement matrix,
quote/rate-limit/validation, and full endpoint integration (create → status →
quote → execute dryRun → history → metrics → health → applications).

Run:
```bash
npm test
```
All suites pass with no regressions to the existing tests.
