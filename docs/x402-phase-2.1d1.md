# x402 Phase X402-2.1D.1 — Circle Facilitator Integration, Settlement Safety & Zero-Regression Hardening

> Isolated, disabled-by-default Circle Facilitator Service adapter + a
> verification-only pipeline. **No settlement, no broadcast, no transfer, no
> deploy, no real payments.**

## 1. Baseline

| | Value |
|---|---|
| Initial HEAD | `994717a` — `docs(x402): phase 2.1C … report` |
| Final HEAD (code) | `d998892` — `feat(x402): Circle Facilitator adapter + verification-only pipeline (X402-2.1D.1)` |
| Branch / tree | `main`, clean at start |
| Baseline x402 | 410 passing; CI/precision/Circle Wallet 283 passing |
| Full repo | ~149–151 pre-existing failures in unrelated modules |

## 2. Exact files changed

- `functions/api/x402/x402-facilitator.mjs` (new) — isolated transport: `/supported`
  (capabilities), `/verify` (non-settling), `/settle` (transport method, always
  disabled), `/status`; parsing, capability validation, payload construction,
  error classification. Transport is dependency-injected.
- `functions/api/x402/x402-verification.mjs` (new) — verification pipeline:
  local signature revalidation + gated provider `/verify` + evidence persistence.
- `functions/api/x402/x402-intent.do.js` — `/record-verification` internal action
  (non-destructive, version-guarded) + `facilitatorVerification` field.
- `functions/api/x402/intent-service.mjs` — `facilitatorVerification` field +
  `doRecordVerification` wrapper.
- `tests/x402-facilitator.test.js`, `tests/x402-verification.test.js` (new),
  `tests/x402-intent-do.test.js`, `tests/x402-signing.test.js` (fixture field).
- `.dev.vars.example` — `X402_FACILITATOR_VERIFY`, `FACILITATOR_BASE_URL`.
- `docs/x402-phase-2.1d1.md` (this file).

## 3. Circle Facilitator capability evidence (verified)

Official API (developers.circle.com/facilitator-service), base `https://api.circle.com`:

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /v1/facilitator/x402/supported` | none | capabilities (`x402Version`, `kinds[]`, `extensions[]`, `signers`) |
| `POST /v1/facilitator/x402/verify` | Bearer Circle API key | **verify signed authorization without creating a payment or submitting onchain** |
| `POST /v1/facilitator/x402/settle` | Bearer Circle API key | settle (submits USDC transfer onchain) — **disabled in this phase** |
| `GET /v1/facilitator/x402/status` | Bearer Circle API key | reconciliation |

**Arc Mainnet is supported:** network `eip155:5042`, USDC `0x3600…0000`,
schemes `exact` + `upto`, decimals 6, EIP-3009 exact payload
`{ signature, authorization: { from, to, value, validAfter, validBefore, nonce } }`.
`/verify` response is `{ isValid, invalidReason?, payer? }`.

A dedicated **verify-only** endpoint exists — so the verification pipeline can be
backed by a real, non-settling provider call (mocked by default in this phase;
live verification requires explicit authorization).

## 4. Authentication strategy

- `/supported`: no auth (read-only).
- `/verify` + `/status`: `Authorization: Bearer <CIRCLE_API_KEY>`.
- No Circle API key / entity secret / signature is ever exposed to the browser.
  Only error codes are logged; sensitive material (signatures, keys) is never logged.

## 5. Verification pipeline (verification ≠ settlement)

```
Authenticated request → load persisted intent → ownership/state/wallet checks
→ LOCAL EIP-712 revalidation (signature + window, BigInt) → capability check
(/supported, read-only) → gated /verify → persist non-destructive evidence → safe status
```

- Gated: `X402_FACILITATOR_VERIFY` (default off). When off, the pipeline reports
  `unverified` and **never calls the provider**.
- The executable signature is used only server-side to build the `/verify` request
  and never appears in the returned status.
- A `verified` result never transitions the intent to SETTLED and never submits a
  transfer. `settleEnabled()` is hard-wired false.

## 6. Signature security audit

- The signature is stored only in DO storage (`authorizationSignature`), redacted
  from every browser-facing response via `redactIntent` (create/get/prepare/cancel).
- No signature in public API responses, browser state, analytics, logs, exception
  messages, or debug endpoints (there are none). The DO is not publicly routable
  (separate Worker class + `DO_INTERNAL_SECRET`).
- A browser can never request an arbitrary executable signature: the only internal
  verification path is the server-side `verifyIntent`, which loads the intent's own
  signature and returns a safe status.

## 7. Durable state machine extension

The core state machine is preserved. No new core state was introduced: the Circle
`/verify` is a stateless, read-only check, so new `VERIFYING`/`VERIFIED` states are
**not justified** by provider semantics. Instead, a **non-destructive**
`facilitatorVerification` metadata field (`{ status, isValid, invalidReason, checkedAt }`)
is recorded via the trusted internal `/record-verification` action:

- Only on `AUTHORIZED` intents (409 `not_authorized` otherwise).
- Optimistic `stateVersion` guard (409 `stale_version`).
- Never changes `state` or `stateVersion`; idempotent for identical results.
- Never overwrites signed authorization terms. No state regression.

## 8. Concurrency & replay guarantees

Wallet-address DO sharding and the `(chainId, token, authorizer, nonce)` namespace
are preserved. Nonce reservations are never released on verification failure/timeout.
Verification evidence writes are atomic (single transaction) and idempotent; a
duplicate verification re-records the same evidence without version churn. Cancel/
verify and stale-version races are guarded by the state machine + version checks.

## 9. DO deployment prerequisites (not performed)

`X402_INTENT_LOCK` remains unprovisioned (binding instructions in `wrangler.jsonc`).
The DO class exports `X402IntentStore`, uses SQLite-backed `state.storage` +
`transaction()` + `blockConcurrencyWhile()` + a re-arming alarm. Real restart/
eviction durability is **not integration-verified** (no Miniflare/workerd here) and
is **not claimed** from in-memory mocks. `X402_INTENT_PERSISTENCE` stays off.

## 10. CI/CD status

The `utf-8-validate@5.0.10` lockfile repair from 2.1C remains intact
(`package-lock.json` line 3456). Verified locally: `npm ci` (npm 10.8.2) succeeds,
CI `test` job + precision/Circle Wallet suites pass (283), production build succeeds,
syntax checks clean. A remote GitHub Actions run was not triggered from this
environment — not claimed green.

## 11. Test results & baseline comparison

| Suite | Result |
|---|---|
| x402 (18 files incl. facilitator + verification) | **441 passed / 0 failed** |
| CI `test` job + precision + Circle Wallet | 283 passed |
| Production build | success |
| Syntax (`node -c`) | clean |

New coverage (31 tests): capabilities parsing/validation (wrong network/scheme/
asset/decimals/version, malformed), payload binding (exact atomic amount), verify
transport (valid/invalid/401/403/429/5xx/malformed/missing-creds), settle always
disabled, error classification, local revalidation (wrong signer, modified
amount/recipient/nonce, expired/not-yet-valid), gate + ownership, provider flow
(verified/rejected/unknown/capability-unsupported), non-destructive evidence,
idempotent duplicate verification, signature-not-in-response.

Baseline vs final: x402 410 → 441 passing; no new failures in any touched file.
The full-repository pre-existing failures remain confined to unrelated modules
(agent/autonoma/gateway/tax/swap/unified-portfolio), with run-to-run variance.

## 12. Unresolved risks & blockers for X402-2.1D.2

1. **Live facilitator `/verify` not certified** (Level 3 BLOCKED — no credentials/authorization).
2. **Settlement remains fully disabled** (`settleEnabled()` = false; `/pay` = 503;
   `SETTLEMENT_IMPLEMENTED=false`).
3. **DO restart/eviction durability not integration-verified** (no workerd/Miniflare).
4. **`X402_INTENT_LOCK` binding not provisioned.**
5. On-chain `authorizationState` verification and the trusted settlement
   reconciliation path (driving `/settle` + `/status`) remain future work.

**Verdict for X402-2.1D.2:** the facilitator transport, capability verification,
verification-only pipeline, signature-confidentiality enforcement, and nonce-safe
durable state are implemented and tested. Live provider verification and real
settlement are explicitly deferred and gated.
