# Capital Hub Phase 1.0.1D.2.1 — Emergency Send Regression Fix

> Continuation of `work/capital-hub-phase-1.0.1` (base `fe011a0`). Emergency fix for
> the "Intent identity unavailable — please retry" send regression.

## Classification
**FIXED** — the legacy send is restored; Pilot protections preserved. No merge/deploy,
no production change, no real transactions.

---

## Root cause (proven)

`functions/api/gateway/intent.js` (from 1.0.1D.1) required `DO_INTERNAL_SECRET`
unconditionally and returned **HTTP 503 `identity_secret_not_configured`** when
absent. The frontend `saExecGateway()` calls `_gwResolveIdemKey()` → `POST
/api/gateway/intent` **before every send, regardless of coordinator mode**. So:

1. Coordinator **disabled** (the normal legacy flow) → `/api/gateway/intent` → **503**
   (no secret configured).
2. `_gwResolveIdemKey` mapped 503 → `{ __intentError: 503 }`.
3. `saExecGateway` mapped `__intentError` → `{ status:'error', error:'intent_identity_unavailable' }`
   + toast **"Intent identity unavailable — please retry"**.

A new hard dependency (`/api/gateway/intent` + `DO_INTERNAL_SECRET`) had leaked into
the legacy flow, breaking Send Assets and native Capital Hub Send.

## Fix (surgical)

1. **`intent.js`** — added an authoritative `coordinatorMode(env)` (server-side, from
   `GATEWAY_EXECUTION_COORDINATOR_ENABLED`). When the mode is `disabled`, it returns
   `200 { identityNotRequired: true }` **without** requiring the secret. Only active
   modes (`pilot`/`enabled`/`draining`) require `DO_INTERNAL_SECRET`.
2. **`index.html` `_gwResolveIdemKey()`** — on `identityNotRequired` (200, no key), it
   returns a benign local idempotency key (no error), so the legacy per-salt
   idempotency remains the protection. Active-mode definitive errors (401/409/503)
   still block.

## Pilot security preserved (P0.3)
- Active modes still require `DO_INTERNAL_SECRET` (fail-closed 503 when absent).
- No public HMAC fallback; no local-UUID bypass in active mode.
- Per-intent deterministic identity, retry recovery, duplicate prevention — unchanged.

## Tests (P0.5)
- `tests/gateway-execution-coordinator.test.js` — updated + added 3 intent-endpoint
  cases: key issuance in pilot mode, `identityNotRequired` when disabled (no secret),
  and fail-closed 503 in pilot mode without a secret. **54 tests pass.**
- `tests/capital-hub-native-execution.test.js` — added the `identityNotRequired`
  legacy-no-block guard. **7 tests pass.**
- `npm run build` + `node --check` pass.
- Full regression — **4 pre-existing failures unchanged, zero new** (`gateway-balance`
  UI6.3, `gateway-ub-fase29`, `send-assets-mainnet-source`, `treasury-restoration`).

## Files
- `functions/api/gateway/intent.js` — legacy isolation (`identityNotRequired` when
  disabled).
- `index.html` — `_gwResolveIdemKey` handles `identityNotRequired` benignly.
- `tests/gateway-execution-coordinator.test.js`, `tests/capital-hub-native-execution.test.js`.

## Status
- Send Assets (legacy): restored.
- Capital Hub native Send / Cross-chain / Withdraw: restored (reuse `saExecGateway`).
- Deposit: preserved (untouched).
- Pilot (active) identity + secret enforcement: preserved.

No merge/deploy. No production Cloudflare changes. No real transactions.
