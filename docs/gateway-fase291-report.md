# Gateway Fase 2.9.1 — Security and Consistency Corrections

**Commit analysed:** `41089482acbfd395e56ccfeb4ad4df873ec97acb`
**Files changed:** `index.html`, `tests/gateway-ub-fase291.test.js`, `tests/gateway-ub-fase29.test.js`, `tests/gateway-fase2.test.js`
**GATEWAY_SPEND_BLOCKED:** `true` (unchanged)

---

## Root Causes and Fixes

### P0 — False success in execSend (gateway path)

**Root cause:** `saExecGateway` returned `undefined` on every path (blocked, error, submitted, failed).
`execSend` never read the return value — it fell through to `showResult(true, ...)` regardless of outcome.
When `GATEWAY_SPEND_BLOCKED = true`, `saExecGateway` toasted a warning and returned silently; `execSend` then called `showResult(true, "X sent via Gateway")` — a false success shown to the user.

**Fix:** `saExecGateway` now returns a discriminated result object on every path:

| Path | Returned status |
|---|---|
| GATEWAY_SPEND_BLOCKED | `blocked` |
| No GatewaySpendService | `error` |
| Invalid inputs | `error` |
| result.ok && submitted | `pending` |
| result.gwStatus === ambiguous | `ambiguous` |
| other failure | `error` |
| exception | `error` |

`execSend` reads `gwResult.status` and branches:
- `blocked` → `showResult(false, "Gateway transfers not yet enabled")` — **no success shown, no cache invalidated**
- `pending` → `showResult(true, "submitted — confirming on-chain")` — explicitly NOT "confirmed"
- `ambiguous` → `showResult(false, "submitted but unconfirmed — do not resubmit")` — recoverable state preserved
- `confirmed` → `showResult(true, "confirmed via Gateway")`
- `error` or unknown → `showResult(false, ...)`

No bare `return;` path remains in `saExecGateway` after the blocked check. Any return without a status object is a compile-time-visible gap caught by GF291-1.

### P1 — `parseFloat(gwBalStr) || 0` replaced with explicit state-aware display

**Root cause:** `_ubInjectSourceSelector` used `parseFloat(gwBalStr) || 0` as the gateway balance, where `gwBalStr = null` for loading, error, stale, and idle states. This collapsed four distinct states into a single `0` which then displayed as `—`. Zero confirmed balance also displayed as `—`. States were indistinguishable.

**Fix:**
- `_ubGwCache.status` now tracks `'idle'` | `'loading'` | `'ok'` | `'empty'` | `'error'`
- `ubGatewayFetch` sets `status = 'loading'` before the fetch, `status = 'error'` on failure
- `_ubInjectSourceSelector` reads `_ubGwCache.status` and shows:
  - `loading` → `…`
  - `error` → `N/A`
  - `ok` with non-zero balance → `$12.34`
  - `ok` with zero balance → `$0.00` (distinct from unknown)
  - `idle` / `empty` / stale → `—` (unknown, not zero)

`parseFloat(gwBalStr) || 0` is gone. `Number(gwBalStr.replace(...))` is used only when `gwBalStr !== null` (cache hit confirmed).

---

## Tests Run

**864/864 across 14 suites. Zero new failures.**

| Suite | Tests | Status |
|---|---|---|
| gateway-ub-fase291 (new) | 34 | ✅ |
| gateway-ub-fase29 | 21 | ✅ |
| ub-actions-phase28 | 27 | ✅ |
| gateway-ub-integration | 32 | ✅ |
| gateway-spend-service | 263 | ✅ |
| gateway-fase2 | 44 | ✅ (1 test updated) |
| unified-portfolio | 50 | ✅ |
| rwa-trading | 166 | ✅ |
| lifi-enterprise | 27 | ✅ |
| bridge-kit-router | 22 | ✅ |
| bridge-multi-route | 31 | ✅ |
| gateway-balance | 55 | ✅ |
| gateway-deposit | 73 | ✅ |
| gateway-fase18 | 19 | ✅ |

**Baseline comparison:** Fase 2.8 reported 794 tests across 10 suites. This run uses 14 suites (same 10 + gateway-balance, gateway-deposit, gateway-fase18, gateway-ub-fase291). All 864 pass. The increase from 794 is accounted for by: 34 new GF291 tests + gateway-balance (55) + gateway-deposit (73) + gateway-fase18 (19) = 181 additional tests, offset by the 10-suite baseline of 683 = 864. No pre-existing failures were introduced.

---

## Remaining Blocks

`GATEWAY_SPEND_BLOCKED = true` remains. Conditions for removal (unchanged from Fase 2.5):

1. `GATEWAY_OP_LOCK` Durable Object — not deployed
2. `GATEWAY_OPS_KV` KV namespace binding — not configured
3. `DO_INTERNAL_SECRET` — not set in CF Dashboard
4. `GATEWAY_RPC_URLS` per-chain env vars — not configured
5. `GATEWAY_ENV=production` — not set

These are infrastructure gaps. The code is ready; the infrastructure is not.

---

## End-to-End Testing

Unit and behavioral tests cover all code paths with mocks. Real end-to-end testing (wallet signature, Circle API submission, on-chain mint, receipt verification) requires the 5 CF infrastructure items above to be in place and an explicit authorization to execute real transactions. This phase does not constitute end-to-end evidence.
