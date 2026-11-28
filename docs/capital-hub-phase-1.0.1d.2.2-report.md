# Capital Hub Phase 1.0.1D.2.2 — Gateway Authorization & Functional Recovery

> Continuation of `work/capital-hub-phase-1.0.1` (base `9dcfd5f`). Fixes the
> mainnet-testing failures (403 forbidden, disabled cross-chain, Charge disabled,
> unavailable fee/time/net). No merge/deploy, no production change, no real
> transactions.

## Classification
**FIXED in code** — Send/Withdraw/Cross-chain are unblocked and Charge is wired to the
existing Payment Links flow. Real-mainnet execution remains subject to the authorized
Pilot configuration (not performed here). No financial success is claimed.

---

## Root causes & fixes

### P0 — "Gateway transfer failed: forbidden" (403)
Root cause: `transfer.js` `isAllowedOrigin()` allowlist was **stale** — it listed
`elligentt.com`/`www`/`app`/`elligentt.pages.dev`/`elligentttest.pages.dev` but omitted
the authoritative app domains configured in `wrangler.jsonc` `CORE_ALLOWED_ORIGINS`
(`execdaat.xyz`, `elligentt.xyz`, `elligente.pages.dev`). A send from any of those
domains sent an Origin not in the allowlist → `403 forbidden`.
Fix: aligned `isAllowedOrigin()` with `CORE_ALLOWED_ORIGINS` — added the three missing
legitimate domains explicitly (no wildcard) AND now reads BOTH `ALLOWED_ORIGINS` and
`CORE_ALLOWED_ORIGINS` from env. Unauthorized origins remain rejected (restrictive
policy preserved).

### P0 — Restore Send & Withdraw
Send and Withdraw share `saExecGateway()`; both were failing only on the 403 above
(signing succeeded, the POST to `/api/gateway/transfer` returned 403). The CORS fix
restores both. `saExecGateway()` remains the single shared engine (no rebuild); the
discriminated status contract (`pending`/`ambiguous`/`error`) and manual-signing flow
are unchanged.

### P0 — Unblock Cross-chain (button disabled)
Root cause: `isReady()` used `f.to === null ? '' : f.to` for the recipient, but the
cross-chain form **prefills** the recipient with the connected wallet while leaving
`f.to === null`. So a prefilled (valid) recipient still failed `isAddr('')` → button
stayed disabled. Additionally, `sync()` updated details/hint but NOT the button, so the
button did not react to typing.
Fix: added a single `recipientOf(k)` (withdraw → wallet; send/cross-chain → `f.to` or
wallet when empty) used by both `isReady()` and `UI.qaExec()`; `sync()` now updates the
native button's disabled state reactively on every input/change.

### P1 — Charge in USDC
Wired to the existing Billing Payment Links flow (no second charge engine). The Charge
action now carries a launcher ("Create in Billing (Payment Links)") and `UI.launch
('charge')` navigates to `showPage('links')` (the existing Payment Links page), where a
real link is created via the existing `POST /api/payment-links`. The Billing fee/rule
logic is untouched.

### P1 — Transaction details (fee/time/net)
The "Not available" placeholders for non-deposit transfers are replaced with real
values: `Estimated fee = ≤ 2.01 USDC` (or `≤ 0.000021 cirBTC` — the Circle Gateway
authorizes a conservative maxFee ceiling; there is no /v1/estimate endpoint),
`Estimated time = Typically under 30s`, and `Net amount = the transfer amount` (the
recipient receives the full value; the fee is deducted from the source balance).

---

## Files
- `functions/api/gateway/transfer.js` — CORS allowlist aligned with
  `CORE_ALLOWED_ORIGINS` (+ reads that env var).
- `shared/capitalHubManage.js` — `recipientOf`, reactive `sync()`, fee/time/net,
  Charge launcher.
- `shared/capitalHubUI.js` — `launch('charge')` → `showPage('links')`.
- `tests/gateway-execution-coordinator.test.js` — CORS allow/deny test.
- `tests/capital-hub-native-execution.test.js` — updated withdraw guard.

## Tests
- Added a CORS behavioral test (legitimate origins 200, unauthorized origin 403).
- **62 gateway/coordinator/native tests pass.**
- Full regression — **4 pre-existing failures unchanged, zero new** (`gateway-balance`
  UI6.3, `gateway-ub-fase29`, `send-assets-mainnet-source`, `treasury-restoration`).
- `npm run build` + `node --check` pass.

## Status
- Send / Withdraw: unblocked (403 fixed).
- Cross-chain: button now enables correctly (recipient default + reactivity).
- Charge in USDC: connected to Billing Payment Links.
- Fee/time/net: real conservative values shown.
- Deposit: preserved (untouched).

## Residual notes
- The exact production/preview domain must still be present in `CORE_ALLOWED_ORIGINS`
  or `ALLOWED_ORIGINS` (it already is for `execdaat.xyz`, `elligentt.xyz`,
  `elligente.pages.dev`, `elligentttest.pages.dev`). No wildcard was added.
- No real transaction was executed; financial success is not declared.

No merge/deploy. No production Cloudflare changes. No real transactions.
