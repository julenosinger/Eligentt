# Autonoma Wallet Identity 1.1 — Clean Release & Legacy Signer Isolation

> Phase 1.1: clean release branch (no Gateway), definitive legacy-signer isolation, and durable provisioning coordination. No real wallet, no real transaction, no merge/deploy.

## 1. Repository state

| Item | Value |
|---|---|
| `main` HEAD | `6024d2e` |
| Release branch | `fix/autonoma-circle-wallet-identity-1.1` (created **from `main`**) |
| Parent branch (1.0) | `fix/autonoma-circle-wallet-identity-1.0` (`1e4fc65`) — preserved, untouched |
| PR #1 (Gateway) | preserved, not merged, not included |

## 2. Clean release — CONFIRMED

The 1.0 branch was created from `fix/gateway-send-3.1` and inherited 3 unrelated Gateway commits. 1.1 rebases the Autonoma work onto `main` by cherry-picking only the Autonoma commit (`1e4fc65` → `06f11a0`).

`git diff --name-only main...fix/autonoma-circle-wallet-identity-1.1` contains **zero** Gateway files. The `index.html` diff is limited to the auth modal + the `_signRelayerAuth` compatibility hook (no `saDispatchSend`, no `_execGatewayMint` exposure, no proxy routing).

## 3. Legacy signer isolation — CONFIRMED (fixed)

Root cause: `shared/auth.js:_buildRemoteSigner()` built a legacy custodial signer from `_profile.wallet.address`, and `shared/walletManager.js:activateFromAuth()` activated it as the app-wide "internal" wallet (`activeWalletType='intelligent'`).

Fix (compatibility layer — no global substitution, no key deletion):

1. **`shared/walletManager.js:activateFromAuth()`** → no-op (`return false`). It no longer mutates `window.walletAddress` / `window.signer` / `activeWalletType`. Autonoma therefore never surfaces the legacy wallet on login/session-restore.

2. **`index.html:_signRelayerAuth()`** → resolves the custodial remote signer **on-demand** from `AuthManager.getRemoteSigner()`, gated on `!signer` (only when no external/self-custody signer is present). This preserves x402/relayer silent server-side signing (`signOnServer`/`getWalletAddress`) without re-activating the internal wallet globally, and never overrides an external wallet.

`AuthManager.getRemoteSigner()` / `signOnServer()` / `getWalletAddress()` remain exported and unchanged — x402 compatibility preserved.

## 4. Durable provisioning coordination — CONFIRMED (improved)

`functions/api/agent/provision.js` replaces the non-atomic 60s KV lock with a durable per-user state machine:

- `provision_state:{userId}` with `status ∈ { provisioning, done, ambiguous }`.
- `done` (TTL 24h) is written **before** the user record, so a user-record write failure is reconciled on the next call.
- Fresh `provisioning` (<120s) → `409` (in-flight).
- Stale `provisioning` or `ambiguous` → fall through to `createUserWallet` with the **deterministic** idempotency key (`deterministicUUID('elligentt:provision-wallet:'+userId)`), which is a get-or-create at Circle (no duplicate).
- Circle failure → records `ambiguous` and returns `502 { reconcile: true }` — **never** blindly creates a replacement wallet.

KV is not atomic (documented); the deterministic Circle idempotency key remains the authoritative dedupe, with the state machine adding durable pending/done state + reconciliation.

## 5. Files changed (1.1, vs `main`)

| File | Change |
|---|---|
| `functions/api/auth/login.js` | Circle identity in login response + session (from 1.0) |
| `functions/api/agent-signer/_circle.js` | Deterministic idempotency keys (from 1.0) |
| `functions/api/agent/provision.js` | Durable provisioning state machine (1.1) |
| `index.html` | Auth-modal Circle-first labels (1.0) + `_signRelayerAuth` remote-signer compatibility hook (1.1) |
| `shared/walletManager.js` | `activateFromAuth()` → no-op (1.1) |
| `tests/autonoma-circle-identity.test.js` | Updated L3 (state machine) + L1/L2/L4 |
| `tests/autonoma-wallet-identity-1.1.test.js` | New (8 tests) |
| `tests/login-no-wallet-regression.test.js` | Updated `activateFromAuth` assertion |
| `docs/autonoma-circle-only-wallet-identity-1.0.md` | 1.0 report (from 1.0) |

## 6. Tests

Passing (vitest):
- `tests/autonoma-wallet-identity-1.1.test.js` (8), `tests/autonoma-circle-identity.test.js` (10),
  `tests/login-no-wallet-regression.test.js` (12), `tests/no-internal-wallet-regression.test.js` (11) — **41 pass**.
- `tests/relayer-auth.test.js`, `tests/relayer-eip712.test.js`, `tests/x402.test.js`,
  `tests/x402-intent.test.js`, `tests/agent-schedule-executor.test.js` — pass.

Passing (Node `node --test`):
- `tests/wallet-provision-regression.test.js` + `tests/agent-auth-flow.test.js` +
  `tests/agent-wallet-integration.test.js` — **70 pass**.

`npm run build` — passes.

Pre-existing failures (unchanged, verified on clean `main`):
- `tests/autonoma-6b-signer-provider.test.js` (4): SecureSignerProvider default `'circle'` vs `'browser'`, and `signer.signTransaction` string in `index.html`.
- `tests/autonoma2-phase2a.test.js`: missing `jsdom` dev dependency.
- `tests/autonoma-2-wallet-security.test.js`: `signer.signTransaction` string.

**Zero new regressions.**

## 7. Remaining risks

- **BLOCKED / UNVERIFIED** — Cloudflare production deployment requires the merge (not performed here) and manual smoke validation on `elligentttest.pages.dev`.
- **UNVERIFIED** — real OTP delivery, Circle wallet provisioning, signatures and on-chain transactions are NOT executed (manual checklist required with explicit authorization).
- **LOW** — KV provisioning coordination is best-effort (not atomic); deterministic Circle idempotency key is the authoritative dedupe. A Durable Object would be stronger but is a new infra dependency (out of scope here).

## 8. Classifications

- Clean release (no Gateway): **CONFIRMED**
- Legacy signer isolation: **CONFIRMED** (fixed, x402 preserved)
- Provisioning coordination: **CONFIRMED** (improved; deterministic idempotency + durable state machine)
- Production deployment: **NOT PERFORMED** (pending merge + authorization)
