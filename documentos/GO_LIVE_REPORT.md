# Treasury Core API — GO LIVE Report (Production)

**Date:** 2026-07-05 · **Project:** `elligente` (Cloudflare Pages) · **Status:** ✅ LIVE

The Elligent Treasury Core API is officially published and operating as the
central financial infrastructure. ExecDaat is registered and can consume it via
strong HMAC authentication, with **no access to private keys or internal
secrets**. No existing functionality (Turbo Bridge, Vault, Treasury Engine,
Circle CCTP, Settlement, Reimbursement, Ledger, Smart Contracts, ABIs, existing
APIs) was changed — all go-live controls apply only to the `/api/core/*` surface.

---

## 1. Official Endpoint

- **Production (official, permanent):** `https://elligente.pages.dev/api/core/v1/`
- Not experimental, not temporary — the Pages production domain.
- **Custom domain (optional, requires DNS action):** to expose
  `https://core.elligentt.xyz` or `https://api.elligentt.xyz`, add a **Pages
  custom domain** (Cloudflare Dashboard → Pages → elligente → Custom domains) for
  a hostname on a zone in this account. Cloudflare auto-provisions the CNAME +
  TLS. See §12 (this step needs account/DNS access the deploy token lacks).

### Published endpoints (all versioned `v1`)
| Method | Path | Auth |
|---|---|---|
| GET | `/api/core/v1/health` | public |
| POST | `/api/core/v1/quote` | HMAC |
| POST | `/api/core/v1/intents` | HMAC |
| POST | `/api/core/v1/execute` | HMAC |
| GET | `/api/core/v1/intents/{id}` | HMAC |
| GET | `/api/core/v1/history` | HMAC |
| GET | `/api/core/v1/metrics` | HMAC |
| GET | `/api/core/v1/applications` | HMAC |

---

## 2. DNS / TLS

- HTTPS enforced by Cloudflare Pages (automatic).
- **HSTS**: `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` (public/_headers).
- CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, COOP,
  Permissions-Policy already set (public/_headers).
- HTTP/2 + HTTP/3 provided by the Cloudflare edge automatically.

---

## 3. Workers / Cloudflare Configuration

- **Functions bundle** compiled & deployed (`wrangler pages deploy`).
- **KV bindings:** `AUTH_KV`, `PAYMENT_LINKS`, `RATE_LIMIT_KV`. Core state
  (nonces / rate counters / audit / registry overrides / cache / latency) uses
  `RATE_LIMIT_KV` (accessed only by exact key — no interference with existing
  endpoints). A dedicated `CORE_KV` is optional (recommended) and requires KV
  admin access to create.
- **Feature flags** (wrangler.jsonc `vars`, verified live):
  `AUTH_MODE=strict`, `RATE_LIMIT_MODE=enforce`, `CIRCUIT_BREAKER=on`,
  `OBSERVABILITY=on`, `AUDIT=on`, `CORE_ALLOWED_ORIGINS=https://execdaat.xyz,https://elligentt.xyz`.

---

## 4. Secrets (values never exposed)

Cloudflare Pages Secrets (encrypted at rest, never in git/logs/HTML/bundles):

| Secret | Purpose | Set |
|---|---|---|
| `EXECDAAT_APP_SECRET` | ExecDaat HMAC shared secret (256-bit) | ✅ this deploy |
| `TURBO_RELAYER_PRIVATE_KEY` | Relayer operator key | pre-existing |
| `OPERATOR_PRIVATE_KEY`, `AUTH_SECRET`, `KIT_KEY`, `TEST_API_KEY`, `RESEND_API_KEY` | existing | pre-existing |

Only the **fingerprint** (`fp_a63d8098…b23a`) of the ExecDaat secret is stored in
the Registry (for display/audit). The plaintext exists only as the Cloudflare
Secret and is handed to the ExecDaat operator once, out-of-band.

---

## 5. Application Registry — EXECDAAT (official)

```
applicationId : EXECDAAT
displayName   : ExecDaat
status        : ACTIVE
environment   : production
version       : v1
authMode      : hmac
permissions   : quote:read, intents:create, intents:read, execute:write,
                history:read, metrics:read, health:read
allowedOrigins: https://execdaat.xyz, https://elligentt.xyz
allowedIps    : (none — origin-bound)
rateLimits    : requests 300/min, intents 60/min, quote 120/min, execute 30/min,
                history 120/min, metrics 60/min, health 120/min
secret        : source=cloudflare_secret (EXECDAAT_APP_SECRET),
                fingerprint=fp_a63d8098…b23a, lastRotation=2026-07-05
```

The secret is masked (`***REDACTED***`) in all API responses.

---

## 6. HMAC Scheme (canonical request)

```
signingString = METHOD "\n" PATH "\n" TIMESTAMP "\n" NONCE "\n" RAW_BODY
signature     = hex( HMAC_SHA256( EXECDAAT_APP_SECRET, signingString ) )
```

Required headers: `X-Application-Id`, `X-Timestamp` (epoch ms), `X-Nonce`
(unique), `X-Signature` (hex). Optional `X-Correlation-ID` (propagated).
Verification: timestamp window (±60s) → origin/IP binding → signature (current +
previous during rotation grace) → single-use nonce.

---

## 7. Replay Protection — validated

- Timestamp window 60s (`AUTH_TIMESTAMP` outside).
- Single-use nonce cache (KV, 120s TTL) → duplicate = `AUTH_REPLAY`.
- Nonce consumed only after a valid signature.

---

## 8. CORS — validated

Strict allowlist (`https://execdaat.xyz`, `https://elligentt.xyz`,
`https://elligente.pages.dev` + registered). Never `*`; unknown origins are never
reflected.

---

## 9. Rate Limiting — active

`RATE_LIMIT_MODE=enforce`, per Application / Client / IP / endpoint, separate
buckets (request/intent/quote/execute/history/metrics/health). 429 + `Retry-After`
on breach. Limits are generous so authorized traffic is unaffected in normal use.

---

## 10. WAF — active

In-Worker sanity (method, body size, content-type, malformed headers) + Cloudflare
edge ruleset blueprint (`waf.mjs → CLOUDFLARE_WAF_RULES`) to block bots, flood,
scanning, replay, malformed requests/headers/payloads at the edge (§12 to apply).

---

## 11. Circuit Breaker / Health / Metrics / Observability / Audit / Cache

- **Circuit breaker** (rpc/circle/vault/treasury/relayer): fail-fast 503 +
  `Retry-After`; Workers never crash; auto half-open after cooldown.
- **Health** (public, real-time): components + circuit states + averageLatency +
  errorRate + p50/p95/p99 + applicationCount.
- **Metrics**: P50/P95/P99, throughput, outstanding, pending settlement,
  liquidity, settlement/bridge time, success rate, requests/min, error rate,
  retry, per-application breakdown.
- **Observability**: correlationId + requestId + intentId across logs / ledger /
  timeline; secrets never logged.
- **Audit**: per-request (application, client, correlationId, intent, endpoint,
  latency, status, timestamp) — no keys/secrets/tokens/seeds.
- **Cache**: only health/metrics/applications (short TTL); never
  execute/intent/settlement/status/real-time history.

---

## 12. Production Verification (live, elligente.pages.dev)

| Test | Expected | Result |
|---|---|---|
| `GET /api/core/v1/health` (public) | 200 | ✅ 200 |
| `POST /api/core/v1/quote` unsigned | 401 | ✅ 401 (strict) |
| `POST /api/core/v1/quote` signed (EXECDAAT) | 200 | ✅ 200 |
| Replay same nonce | 401 | ✅ 401 `AUTH_REPLAY` |
| Invalid signature | 401 | ✅ 401 `AUTH_SIGNATURE` |
| `GET /api/core/v1/applications` signed | 200 | ✅ 200 |
| CORS `execdaat.xyz` | echoed | ✅ echoed |
| CORS `evil.example` | not reflected | ✅ never `*` |
| Legacy `/api/health` (existing) | 200 | ✅ 200 (unaffected) |
| Test suite | green | ✅ 275 passing, 0 regressions |
| ESLint / Workers build | clean | ✅ clean / compiled |

**Evidence ExecDaat can consume the Treasury Core:** a request signed with
`EXECDAAT_APP_SECRET` returned `200` with a valid quote, while unsigned / bad-sig
/ replayed requests were rejected.

---

## 13. Remaining account-level actions (need DNS/WAF/KV admin — not the deploy token)

1. **Custom domain:** Pages → elligente → Custom domains → add
   `core.elligentt.xyz` (or `api.elligentt.xyz`). Auto CNAME + TLS.
2. **Edge WAF:** apply `CLOUDFLARE_WAF_RULES` (see `functions/api/core/waf.mjs`)
   as WAF custom rules + rate-limiting rules + Bot Fight Mode.
3. **(Optional) Dedicated `CORE_KV`:** create a KV namespace and add the binding
   to `wrangler.jsonc` for isolated core persistence.
4. **Secret rotation:** to rotate, set `EXECDAAT_APP_SECRET` to the new value and
   (optionally) `EXECDAAT_APP_SECRET_PREVIOUS` to the old one during the grace
   window, then remove the previous.

---

## 14. Files changed (Go Live phase)

| File | Change |
|---|---|
| `functions/api/core/service-auth.mjs` | Resolve the app secret from a Cloudflare Secret env var (`<APP>_APP_SECRET` + `_PREVIOUS`), keeping the sealed-at-rest fallback |
| `functions/api/core/pipeline.mjs` | `public` endpoint support (health stays reachable under strict auth) |
| `functions/api/core/v1/health.js` | Marked `public: true` |
| `functions/api/core/registry.mjs` | EXECDAAT seed → ACTIVE / hmac / permissions / origins / rate limits / secret fingerprint |
| `wrangler.jsonc` | Production feature-flag `vars` |
| `tests/core/registry.test.js` | Updated EXECDAAT expectations (active) + secret-masking test |
| `tests/core/golive.test.js` | New — strict HMAC go-live e2e (signed/unsigned/replay/bad-sig/public health) |
| `documentos/GO_LIVE_REPORT.md` | This report |

No changes to Turbo Bridge, Vault, Treasury Engine, Circle CCTP, Settlement,
Reimbursement, Ledger, Smart Contracts, ABIs, or any existing endpoint.

---

## 15. Production Checklist

- [x] Official endpoint published (versioned `/api/core/v1/`)
- [x] HTTPS + HSTS + modern TLS + HTTP/2/3 (Cloudflare)
- [x] Workers/Functions deployed; KV bound
- [x] Secrets configured as Cloudflare Secrets (no plaintext anywhere)
- [x] Application Registry: EXECDAAT ACTIVE / PRODUCTION / v1
- [x] HMAC authentication active & validated (strict)
- [x] Replay protection validated
- [x] CORS restricted (never `*`) validated
- [x] Rate limiting enforced
- [x] Circuit breaker active
- [x] WAF (in-Worker) active + edge blueprint provided
- [x] Health operational (public, real-time)
- [x] Metrics operational
- [x] Observability + Audit active (no sensitive data)
- [x] ExecDaat can consume the Core (signed 200; unsigned/replay/bad-sig 401)
- [x] Zero regressions · zero build errors · zero lint warnings
- [ ] Custom domain `core.elligentt.xyz` (account/DNS action — §13)
- [ ] Edge WAF rules applied in dashboard (account action — §13)
