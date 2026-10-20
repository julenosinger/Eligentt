# Bridge Multi-Token — Audit 1.3
**Date:** 2026-10-20  
**Audited commit (HEAD at audit start):** `feat(swap): remove Recent Swaps panel, add History slide-in with real on-chain data`  
**Branch:** local (uncommitted changes to `index.html`; `shared/bridgeKitRouter.js` committed via earlier session)  
**Scope:** `index.html` (Bridge tab functions), `shared/bridgeKitRouter.js`, `shared/LiFiAdapter.js`

---

## 1. Files Inspected

| File | Role |
|---|---|
| `index.html` | All Bridge UI, `_fetchBridgeRoutes`, `_fetchBridgeQuote`, `executeBridgeOrTurbo`, `executeBridgeViaCCTP`, `executeBridgeViaLiFi`, `_bridgeReadBal`, `_bridgeGetTokenMeta`, `_bridgeToRaw`, `_bridgeFromRaw`, `_bridgeUpdateTokenSelectors`, `_bridgeAvailableTokens`, `_brsShowNoRoute` |
| `shared/bridgeKitRouter.js` | CCTP eligibility (`isEligible`, `isEurcCctpChain`, `EURC_CCTP_CHAINS`) |
| `shared/LiFiAdapter.js` | `getQuote`, `getRoutes`, `validateRoute`, `_resolveTokenAddr`, `_resolveDecimals` |

---

## 2. Test Results — Before (Baseline)

All 264 pre-existing bridge tests passed at audit start:

| Suite | Tests |
|---|---|
| `bridge-multi-token.test.js` | 74/74 |
| `bridge-hardening.test.js` | 64/64 |
| `bridge-kit-router.test.js` | 22/22 |
| `bridge-multi-route.test.js` | 23/23 |
| `bridge-network-picker.test.js` | 72/72 |
| `swap-standard-legacy-ui.test.js` | 8/8 |
| **Baseline total** | **264/264** |

---

## 3. Defects Found and Fixed

### D1 — `executeBridgeViaLiFi`: Silent USDC fallback address (CRITICAL)

**Location:** `index.html` — `executeBridgeViaLiFi()`, lines ~39034–39036  
**Severity:** Critical — security/correctness  
**Before:**
```js
const srcToken = getTokenAddressForChain(fromChain.chainId, _lifiFromSym) || getTokenAddressForChain(fromChain.chainId, 'USDC');
const dstToken = getTokenAddressForChain(toChain.chainId,   _lifiToSym)   || getTokenAddressForChain(toChain.chainId,   'USDC');
if (!srcToken || !dstToken) { toast(_lifiFromSym + ' not available on this route', 'error'); return; }
```
**Problem:** If `_lifiFromSym` (e.g. `cirBTC`) has no address on the chain, it silently falls back to the USDC address. The `if (!srcToken || !dstToken)` guard below it is then always dead code (USDC always has an address). The ERC-20 `approve()` call would use the USDC contract address but show the selected token's symbol, and the `amountInRaw` was computed from the selected token's decimals. The mismatch between displayed token, approved contract, and calldata is a correctness and security defect.

**Fix:** Removed the `|| getTokenAddressForChain(...)` fallbacks. Two separate per-chain guards with clear messages.
```js
const srcToken = getTokenAddressForChain(fromChain.chainId, _lifiFromSym);
const dstToken = getTokenAddressForChain(toChain.chainId,   _lifiToSym);
if (!srcToken) { toast(_lifiFromSym + ' is not available on ' + fromChain.name + '. Select a supported token.', 'error'); return; }
if (!dstToken) { toast(_lifiToSym   + ' is not available on ' + toChain.name   + '. Select a supported token.', 'error'); return; }
```

**Note:** In the normal UI flow, `_fetchBridgeRoutes` already blocks when a token has no address on a chain (it returns `[]`), and `_brsShowNoRoute` shows a "token unavailable" message. The defect was only exploitable when the user directly clicked Bridge without going through the route picker — but that path is still reachable and must be safe.

---

### D2 — History entries hardcode "USDC" (all bridge paths)

**Location:** `index.html` — 5 `addToHistory` calls in `executeBridgeViaCCTP` and `executeBridgeViaLiFi`  
**Severity:** Low — incorrect display  
**Before:** All five history label template literals used `` `${amt} USDC: ${fromChain.name} → ${toChain.name}` ``  
**Fix:** CCTP paths now use `` `${amt} ${token}: ...` ``; LiFi paths now use `` `${amt} ${_lifiFromSym}: ...` ``

Affected contexts: CCTP success, CCTP fail, LiFi completed, LiFi FAILED status, LiFi source-confirmed-settling.

---

### D4 — `executeBridgeOrTurbo` fallback uses `BridgeKitRouter.route()` instead of `isEligible()`

**Location:** `index.html` — `executeBridgeOrTurbo()` fallback branch  
**Severity:** Medium — EURC per-chain routing error  
**Before:**
```js
BridgeKitRouter.route(fromChain.chainId, toChain.chainId, token).provider === 'cctp'
```
**Problem:** `BridgeKitRouter.route()` checks only `isCCTPToken + isCCTPChain`. It does NOT call `isEligible()` which includes the `EURC_CCTP_CHAINS` per-chain check. For EURC Arc → Ethereum, `.route()` could return `provider: 'cctp'` (because Arc and Ethereum are both CCTP chains), but `isEligible()` correctly returns false (Ethereum has no EURC address in `EURC_CCTP_CHAINS`). The bridge would then enter `executeBridgeViaCCTP` which has its own `isEligible` guard and fall through to LiFi — so the final outcome was correct, but only due to the secondary guard. The routing decision at `executeBridgeOrTurbo` was wrong.

**Fix:** Replaced the `.route()` call with `BridgeKitRouter.isEligible(fromChain.chainId, toChain.chainId, token)`.

---

## 4. Defects Investigated and Not Confirmed

| ID | Description | Conclusion |
|---|---|---|
| D3 | `_bridgeReadBal` silent USDC fallback | Fixed in 1.1 — already shows `—` for tokens with no address |
| D5 | `_bridgeGetTokenMeta` zero-address filter | Correct — filters `0x000...000` and null in both `_bridgeAvailableTokens` and `_bridgeGetTokenMeta` |
| D6 | `_bridgeToRaw`/`_bridgeFromRaw` decimal precision | Correct — uses `Math.round`, defaults to 6 |
| D7 | `_fetchBridgeRoutes` no-fallback on missing token | Correct — returns `[]` immediately when `fromMeta` or `toMeta` is null |
| D8 | `LiFiAdapter._resolveTokenAddr` cross-chain fallback | Not triggered when called from `_fetchBridgeRoutes` (token objects with explicit addresses are passed) |
| D9 | `_bridgeUpdateTokenSelectors` USDC fallback on chain change | By design — when selected token is unavailable on a new chain, the selector resets to USDC and updates state; this is explicit and visible to the user (not silent) |
| D10 | `validateRoute` uses correct token addresses | Confirmed correct — `srcToken` and `dstToken` are passed directly |

---

## 5. Token Status by Chain

| Token | Chain | Address in CHAIN_REGISTRY | CCTP eligible | Notes |
|---|---|---|---|---|
| USDC | Arc (5042) | `0x3600...0000` | Yes | Primary; CCTP on all supported chain pairs |
| USDC | Ethereum (1) | `0xA0b8...eB48` | Yes | CCTP eligible |
| USDC | Base (8453) | `0x8335...913` | Yes | CCTP eligible |
| USDC | Arbitrum (42161) | `0xaf88...831` | Yes | CCTP eligible |
| USDC | Optimism (10) | `0x0b2C...085` | Yes | CCTP eligible |
| USDC | Polygon (137) | `0x3c49...359` | Yes | CCTP eligible |
| EURC | Arc (5042) | `0xbEf5...21c1` | Arc↔Base only | EURC_CCTP_CHAINS: {5042, 8453}; amber badge shown |
| EURC | Base (8453) | `0x60a3...b42` | Arc↔Base only | Not sandbox-verified with real funds |
| EURC | Ethereum/Arb/OP/Poly | no address | No — LiFi | LiFi route required for all EURC pairs except Arc↔Base |
| cirBTC | Arc (5042) | `0x171A...AA0` | No — LiFi | Non-CCTP token; always LiFi |

---

## 6. Pre-Sign Validation Coverage

| Check | Where | Status |
|---|---|---|
| Wallet connected | `executeBridgeOrTurbo`, `executeBridgeViaCCTP`, `executeBridgeViaLiFi` | Present |
| Amount > 0 | All three functions | Present |
| Not same-chain | All three functions | Present |
| Token/chain mismatch (route stamping) | `executeBridgeOrTurbo` | Present (belt-and-suspenders) |
| Quote expiry (LiFi 160s grace) | `executeBridgeOrTurbo` | Present |
| Route availability | `executeBridgeOrTurbo` | Present |
| CCTP eligibility for selected token | `executeBridgeViaCCTP`, `executeBridgeOrTurbo` fallback | Present (now uses `isEligible`) |
| Source token has valid address | `executeBridgeViaLiFi` | Fixed (D1) |
| Destination token has valid address | `executeBridgeViaLiFi` | Fixed (D1) |
| Provider chain verification | `executeBridgeViaLiFi` (`ensureNetwork` + `getNetwork`) | Present |
| Chain ID in transactionRequest matches | `executeBridgeViaLiFi` (passed to `sendTransaction`) | Present |
| LiFi calldata `validateRoute` | `executeBridgeViaLiFi` | Present |

---

## 7. Routing Verification — Level Distinction

| Claim | Verification level | Confirmed? |
|---|---|---|
| USDC CCTP routes defined in `CHAIN_REGISTRY` | Unit/static | Yes |
| EURC CCTP only Arc↔Base | Unit/static | Yes |
| `isEligible` returns correct value for all pairs | Unit test | Yes (183 tests) |
| Token address passed correctly to LiFi API | Unit/static code audit | Yes |
| `validateRoute` blocks bad calldata | Unit/static | Yes (structural) |
| LiFi API returns a real quote | Integration (live API) | NOT verifiable in sandbox (no `LIFI_API_KEY`) |
| CCTP burn → attestation → mint completes | Wallet + on-chain | NOT testable in sandbox |
| EURC CCTP Arc→Base completes on mainnet | On-chain | NOT verified (amber badge in UI) |

---

## 8. Test Results — After

| Suite | Tests | Delta |
|---|---|---|
| `bridge-audit-1.3.test.js` (new) | 34/34 | +34 |
| `bridge-multi-token.test.js` | 74/74 | 0 |
| `bridge-hardening.test.js` | 64/64 | 0 (1 test message updated for D1) |
| `bridge-kit-router.test.js` | 22/22 | 0 (1 test description updated for D4) |
| `bridge-multi-route.test.js` | 23/23 | 0 |
| `bridge-network-picker.test.js` | 72/72 | 0 |
| `swap-standard-legacy-ui.test.js` | 8/8 | 0 |
| **Total** | **306/306** | **+34** |

**Zero regressions.** No Swap, Send Assets, Billing, Unified Balance, Autonoma, Treasury, or CPN files were modified.

---

## 9. Limitations and Blockers

1. **LiFi API**: No live `LIFI_API_KEY` in the sandbox. Route and quote validation can only be confirmed structurally. All assertions about LiFi behavior are static/unit only.
2. **EURC CCTP Arc↔Base**: Eligible per code and CHAIN_REGISTRY addresses. Not verified with real funds. Amber "not sandbox-verified" badge remains in the UI.
3. **On-chain execution**: No wallet connection. No transactions were broadcast. All execution-path validation is code-level only.
4. **`BridgeKitRouter.route()`**: This function still exists and is still used by `saExecuteCrossChain` (Send Assets). That function was intentionally NOT in scope and was not modified. Its eligibility logic for EURC is also less strict than `isEligible`, but fixing that is outside this audit's scope.
5. **Legacy `executeBridge` function** (line ~25590): This function has `label: '${amt} USDC: ...'` and was NOT modified — it is the legacy/deprecated CCTP execution path (preserved for future reactivation, not in the active UI flow). Left untouched per scope constraint.

---

## 10. Changed Files

| File | Change type |
|---|---|
| `index.html` | 3 targeted surgical fixes (D1, D2, D4) |
| `tests/bridge-audit-1.3.test.js` | New — 34 audit tests |
| `tests/bridge-hardening.test.js` | 1 test message updated (D1 guard message) |
| `tests/bridge-kit-router.test.js` | 1 test description updated (D4 routing check) |

No other files modified.
