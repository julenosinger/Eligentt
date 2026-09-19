# Treasury Core API — Production Hardening (Phase 4)

> **Status:** Phase 4 complete. Purely COMPLEMENTARY to the Phase 2 Core API. No
> change to Turbo Bridge, Treasury Engine, Vault, Circle CCTP, Settlement,
> Reimbursement, Ledger, Smart Contracts, ABIs, the financial flow, or any
> existing endpoint. Everything is layered behind feature flags with safe,
> backward-compatible defaults.

This phase turns the Treasury Core API into resilient, secure, observable
production infrastructure: strong service-to-service authentication, replay
protection, effective rate limiting, strict CORS, a circuit breaker, expanded
health/metrics, structured observability, alert scaffolding and intelligent
caching.

---

## 1. Authentication Architecture (HMAC service-to-service)

`functions/api/core/service-auth.mjs`

The pipeline replaces "internal only" with a modular verifier while staying
backward compatible:

- **internal** — same-origin / no external credential → resolved application
  (ELLIGENT). Still works unless `AUTH_MODE=strict`.
- **hmac** — signed service-to-service requests (ExecDaat, partners).
- External schemes with no valid signature → fail closed (`AUTH_NOT_ENABLED`).

### Required headers (signed request)

| Header | Meaning |
|---|---|
| `X-Application-Id` | Registered application id (e.g. `EXECDAAT`) |
| `X-Timestamp` | Unix epoch **ms** — must be within ±60s |
| `X-Nonce` | Unique per request (single-use) |
| `X-Signature` | Hex HMAC-SHA256 of the canonical string |
| `Correlation-ID` / `X-Correlation-ID` | Optional trace id (propagated) |

### HMAC flow

```
canonical =  METHOD "\n" PATH "\n" TIMESTAMP "\n" NONCE "\n" RAW_BODY
signature =  HMAC_SHA256(secret, canonical)  →  hex
```

Server verification:
1. Validate timestamp window (±60s) → else `AUTH_TIMESTAMP`.
2. Load the application from the Registry; open its **sealed** secret (see §3).
3. Enforce `allowedOrigins` / `allowedIps` when configured → `AUTH_ORIGIN` / `AUTH_IP`.
4. Recompute HMAC over the canonical string; compare in constant time against the
   **current** and (within grace) **previous** secret → else `AUTH_SIGNATURE`.
5. Consume the nonce (single-use) → replay → `AUTH_REPLAY`.

The body is part of the signature, so any tampering invalidates the request.

---

## 2. Replay Protection

`functions/api/core/replay.mjs`

- **Timestamp window:** max skew **60s** (`MAX_SKEW_MS`).
- **Nonce cache:** the nonce is stored single-use in KV with a 120s TTL
  (`core:nonce:{app}:{nonce}`). A repeat within the TTL is rejected
  (`AUTH_REPLAY`). Nonces are consumed only **after** a valid signature, so a bad
  signature cannot burn a legitimate nonce.

---

## 3. Application Secrets — Sealed at Rest + Rotation

`functions/api/core/application-secret.mjs`

HMAC needs the shared secret, so it cannot be a one-way hash. Secrets are
therefore **encrypted at rest** with **AES-256-GCM** using an environment master
key `CORE_SECRET_KEY` (32-byte hex, or any string hashed to 32 bytes). The
plaintext is never persisted or returned; a non-reversible `fingerprint` is kept
for display.

```
sealed = { alg:'AES-256-GCM', iv, ciphertext, fingerprint, status,
           rotationDate, lastRotation, createdAt, updatedAt, previous? }
```

### Rotation without downtime (`rotateServiceSecret`)

```
current  → becomes `previous` (verifiable until now + gracePeriodMs, default 24h)
newSecret → becomes the active secret
```

During the grace window both signatures verify, so a client can roll its secret
with zero downtime. `publicSecretView()` strips `ciphertext`/`iv`/`hash`/`salt`
and exposes only `fingerprint`, `status`, `rotationDate`, `lastRotation`,
`hasPrevious`.

---

## 4. Application Registry (expanded)

`functions/api/core/registry.mjs`

Each application record now carries:

```
applicationId, displayName, status (active|prepared|suspended), permissions,
secret (sealed, fingerprint only in public view), fingerprint, allowedOrigins,
allowedIps, rateLimits, environment, version, createdAt, updatedAt, lastRotation
```

Seeds: **ELLIGENT** (active/internal), **EXECDAAT** & **FUTURE_APP** (prepared).
`setApplicationSecret()` persists a rotated sealed secret; secrets are never
stored in plaintext.

---

## 5. Rate Limiting (effective)

`functions/api/core/rate-limit.mjs` — `applyRateLimit()`

Enforced per-minute across **Application / Client / IP** dimensions, with
separate buckets per endpoint kind:

| kind | default/min | source |
|---|---|---|
| request | 240 | `rateLimits.requestsPerMin` |
| intent | 60 | `rateLimits.intentsPerMin` |
| quote | 120 | `rateLimits.quotePerMin` |
| execute | 10 | `rateLimits.bridgePerMin` |
| history | 120 | `rateLimits.historyPerMin` |
| metrics | 120 | `rateLimits.metricsPerMin` |
| health | 240 | `rateLimits.healthPerMin` |

Controlled by `RATE_LIMIT_MODE`:
- `off` — skip.
- `record` — count only, never block (Phase 2 behavior).
- `enforce` (default) — block over-limit with **429** + `Retry-After`.

Limits are generous and per-application configurable, so authorized traffic
under normal operation is never affected. ELLIGENT (internal core) has elevated
limits (600 req/min).

---

## 6. CORS (strict)

`functions/api/core/cors.mjs`

Never emits `*`. The echoed origin must be in the allowlist:
`env.ALLOWED_ORIGINS` ∪ `env.CORE_ALLOWED_ORIGINS` ∪ first-party domains
(`https://execdaat.xyz`, `https://elligentt.xyz`, `https://elligente.pages.dev`).
Unknown origins are never reflected. Per-application origin binding is
additionally enforced during HMAC auth (`allowedOrigins`).

---

## 7. WAF

`functions/api/core/waf.mjs`

In-Worker sanity checks (method allowlist, body size ≤256KB, JSON content-type on
writes, malformed/oversized security headers) complement the authoritative
Cloudflare edge WAF. `CLOUDFLARE_WAF_RULES` documents the edge ruleset blueprint
to block **bots, scanning, flood, replay, malformed requests / headers /
payloads** (rate limiting, bot score, managed challenge).

---

## 8. Circuit Breaker

`functions/api/core/circuit-breaker.mjs`

Per-dependency (`circle`, `rpc`, `vault`, `treasury`, `relayer`) KV-backed
breaker:

```
closed → (≥5 failures / 60s) → open → (30s cooldown) → half_open
half_open → success → closed | failure → open
```

`guard(env, dep, fn)` fails fast (throws a `circuitOpen` marker) when open; the
pipeline converts it to a standardized **503** with `Retry-After` and emits a
`circuit_open` alert. **Workers are never crashed**, and unrelated endpoints keep
serving. Financial operations are never auto-retried.

---

## 9. Health (expanded, real-time)

`GET /api/core/v1/health` now reports:
`circle, rpc, vault, treasury, ledger, kv, storage, workers, bridgeEngine` +
`circuitBreaker` snapshot + `averageLatency`, `errorRate`, `requestsPerMin`,
`p50/p95/p99`, `applicationCount`. Uses one lightweight RPC probe (breaker-aware,
skipped when the RPC breaker is open) and is short-TTL cached.

---

## 10. Observability & Logs

`functions/api/core/logger.mjs` (flag `OBSERVABILITY`)

Structured, masked, stage-based events:
`request → auth → authorization → validation → rate_limit → ledger → treasury →
settlement → response`, each carrying `correlationId`, `requestId`, `application`,
`client`, `endpoint`, `status`, `latency`. Secrets/keys/tokens/signatures are
never logged. Complements — never replaces — existing logs.

---

## 11. Metrics

`GET /api/core/v1/metrics` adds:
`P50 / P95 / P99`, `averageLatency`, `requestsPerMin`, `errorRate`, `retryCount`,
`bridgeThroughput`, `settlementThroughput` — alongside `totalVolume`, `tvl`,
`outstandingLiquidity`, `pendingSettlement`, `bridgeSuccessRate` and the
per-application `applicationBreakdown`. Latency percentiles derive from a rolling
KV sample window (`functions/api/core/latency.mjs`); throughput derives from the
Ledger. Read-only + short-TTL cached, no extra RPC.

---

## 12. Alerts (structured, not delivered)

`functions/api/core/alerts.mjs`

Catalog: `error_rate_high, rpc_slow, settlement_delayed, vault_unavailable,
circle_unavailable, rate_limit_exceeded, replay_detected, invalid_signature,
circuit_open` with default severities. Events are emitted (structured, masked)
into the log stream with `delivered:false` — **no delivery channel is wired**;
Phase 5 can attach email/webhook/pager.

---

## 13. Auditing

`functions/api/core/audit.mjs` (flag `AUDIT`)

One entry per request: `application, client, correlationId, requestId, intent,
timestamp, status, endpoint, method, result, latencyMs`. Never records private
keys, secrets, tokens or wallet seeds. Stored under `core:audit:*` (30-day TTL).

---

## 14. Cache

`functions/api/core/cache.mjs`

Short-TTL read-through cache for **metrics (10s), health (5s), applications
(30s)** only. **Never** caches execute, intent creation, settlement or real-time
history. Cache miss / KV failure falls through to a fresh computation.

---

## 15. Timeouts & Retry

`functions/api/core/timeout.mjs`

Standardized timeouts (`quote 5s, execute 30s, history 8s, health 6s, metrics 8s,
rpc 5s`). `withRetry` (exponential backoff) is applied **only** to idempotent
reads. **Financial operations (execute) are never retried automatically.**

---

## 16. Feature Flags

`functions/api/core/flags.mjs` — all environment-configurable:

| Flag | Values | Default | Effect |
|---|---|---|---|
| `AUTH_MODE` | internal \| strict | internal | strict requires a valid HMAC signature |
| `RATE_LIMIT_MODE` | off \| record \| enforce | enforce | request throttling behavior |
| `CIRCUIT_BREAKER` | on \| off | on | dependency fail-fast |
| `OBSERVABILITY` | on \| off | on | structured stage logs |
| `AUDIT` | on \| off | on | per-request audit trail |

Defaults are backward compatible: with `AUTH_MODE=internal`, existing internal
traffic behaves exactly as before; hardening is enabled progressively via env.

---

## 17. Standardized Errors (hardening)

All returned via the standard envelope `{ success:false, errors:[{code,message}] }`:

| Code | HTTP | Meaning |
|---|---|---|
| `AUTH_TIMESTAMP` | 401 | Timestamp outside the 60s window |
| `AUTH_NO_SECRET` | 401 | No secret configured / master key missing |
| `AUTH_SIGNATURE` | 401 | Invalid HMAC signature |
| `AUTH_REPLAY` | 401 | Nonce already used |
| `AUTH_ORIGIN` / `AUTH_IP` | 403 | Origin/IP not allowlisted for the app |
| `AUTH_SIGNATURE_REQUIRED` | 401 | strict mode, no signature |
| `AUTH_NOT_ENABLED` | 401 | External scheme presented but not enabled |
| `APP_NOT_ACTIVE` | 403 | Application not active in the Registry |
| `FORBIDDEN` | 403 | Missing permission |
| `RATE_LIMITED` | 429 | Rate limit exceeded (`Retry-After`) |
| `CIRCUIT_OPEN` | 503 | Dependency temporarily unavailable (`Retry-After`) |
| `WAF_*` | 400/405/413/415 | Request rejected by in-Worker WAF |

---

## 18. Operations Plan

### Environment (Cloudflare Pages → Settings → Variables & Secrets)

| Name | Type | Purpose |
|---|---|---|
| `CORE_SECRET_KEY` | secret | AES master key for sealed application secrets (32-byte hex). **Required to enable HMAC.** |
| `CORE_KV` | KV binding | Dedicated store for registry/intents/audit/nonces/rate/breaker/cache/latency (falls back to `RATE_LIMIT_KV`). |
| `AUTH_MODE` | var | `internal` (default) → `strict` once all consumers sign. |
| `RATE_LIMIT_MODE` | var | `enforce` (default). |
| `CIRCUIT_BREAKER` / `OBSERVABILITY` / `AUDIT` | var | `on` (default). |
| `CORE_ALLOWED_ORIGINS` | var | Extra CORS origins (comma list). |

### Rollout

1. **Deploy** (flags at safe defaults) — internal traffic unaffected.
2. **Provision** `CORE_SECRET_KEY` + bind `CORE_KV`.
3. **Register** the consumer app (e.g. EXECDAAT) `status=active`, set its sealed
   secret (`setApplicationSecret`) and `allowedOrigins`/`allowedIps`.
4. **Client integration** — sign requests (HMAC headers). Verify via `/health`
   and audit logs.
5. **Tighten** — once all consumers sign, set `AUTH_MODE=strict`.
6. **Rotate** secrets periodically via `rotateServiceSecret` (24h grace) — no
   downtime.
7. **Edge WAF** — apply `CLOUDFLARE_WAF_RULES` at the Cloudflare dashboard.
8. **Monitor** `/metrics` (P95/P99, error rate, throughput) and `/health`
   (circuit breaker). Alerts are structured in logs, ready for delivery wiring.

### Incident behavior

- Dependency degradation → circuit opens → fail-fast **503** + `Retry-After`;
  Workers stay up; other endpoints keep serving; auto-recovers after cooldown.
- Abuse → **429** (rate limit) / WAF rejection / `AUTH_*` — all standardized,
  audited and alert-structured.

---

## 19. Compatibility & Tests

Backward compatible with Turbo Bridge, Vault, Settlement, Circle, the existing
Core API and (future) ExecDaat. Verified by `tests/core/*`:
`hardening-basics`, `hardening-infra`, `application-secret-seal`, `service-auth`,
`hardening-endpoints` (plus all Phase 2 suites) — HMAC valid/invalid/tamper,
timestamp window, replay, rotation grace, rate-limit enforce/record/off, CORS,
circuit breaker open/closed/guard, cache, latency percentiles, and full pipeline
integration. `npm test` is green with no regressions; ESLint clean; Workers
bundle compiles.
