# Capital Hub Phase 1.0.1D.2.3 — Open Development Mode & Functional Recovery

> Continuation of `work/capital-hub-phase-1.0.1` (base `c3ef41f`). Eliminates the
> remaining artificial development blockers. No merge/deploy, no production change,
> no real transactions.

## Classification
**FIXED in code** — the "Gateway transfer failed: forbidden" (403) is eliminated for
same-origin (dynamic preview) requests; the dev environment runs the open legacy
engine (no wallet whitelist, no Pilot activation, no artificial limits). Real-mainnet
execution remains manual and subject to the operator.

---

## Root cause of the persistent 403 (proven)

The previous phase added the static `CORE_ALLOWED_ORIGINS` domains to
`transfer.js`'s `isAllowedOrigin()`. But the development/preview environment is a
**Cloudflare Pages preview with a DYNAMIC URL** (`https://<hash>.elligentt.pages.dev`
or similar) — its Origin is never in any static allowlist, so every transfer POST
returned `403 forbidden` ("Gateway transfer failed: forbidden").

## Fix (surgical)

`isAllowedOrigin(origin, env, requestUrl)` now additionally allows **same-origin**
requests: when the request's `Origin` host equals the function's own host (the
`request.url`), the call is allowed — no per-preview-domain registration required.
Cross-origin calls still require the explicit allowlist (no wildcard, no unrestricted
CORS). All four handlers (POST/GET/PATCH/confirm) pass `request.url`.

This reuses the app's existing access policy: the frontend and the Pages Function
share a host in the preview, so same-origin is the legitimate communication path.

## Open Development Mode

The default `disabled` coordinator mode is already the open mode:
- No wallet whitelist (`GATEWAY_PILOT_ALLOWLIST` only applies in `pilot`).
- No per-user Pilot approval.
- No 1 USDC / 10 USDC / 1-concurrent limits (those defaults are `pilot`-only).
- No `/api/gateway/intent` + `DO_INTERNAL_SECRET` dependency in the legacy path
  (the endpoint returns `identityNotRequired` when disabled — see 1.0.1D.2.1).

The experimental Gateway Execution Coordinator remains isolated: it is disabled by
default and cannot block the legacy engine. A reserved/dispatched/indeterminate intent
is never moved to another engine; existing coordinated operations remain recoverable.

## Functional status
- Deposit: preserved (untouched).
- Send / Cross-chain / Withdraw: native via `saExecGateway` (no redirect) — unblocked
  by the same-origin CORS fix.
- Charge in USDC: wired to Billing Payment Links (launcher → `showPage('links')`).
- Manage Funds: enabled where a real service exists.

## Tests
- Added a same-origin (dynamic preview) CORS test (200) alongside the existing
  allow/deny tests.
- **58 gateway/coordinator/native tests pass.**
- Full regression — **4 pre-existing failures unchanged, zero new** (`gateway-balance`
  UI6.3, `gateway-ub-fase29`, `send-assets-mainnet-source`, `treasury-restoration`).
- `npm run build` + `node --check` pass.

## Files
- `functions/api/gateway/transfer.js` — same-origin CORS allowance.
- `tests/gateway-execution-coordinator.test.js` — same-origin + allow/deny CORS tests.

## Notes
- No wildcard origin; no unrestricted CORS on authenticated financial endpoints.
- No production config change; the coordinator and Pilot protections are preserved.
- No real transaction executed; no financial success claimed.

No merge/deploy. No production Cloudflare changes. No real transactions.
