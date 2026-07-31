# PHASE 22 — FINANCIAL RISK REPORT
## Date: 2026-07-31 | Project: Elligentt (elligentt-full)

---

## CRITICAL RISKS (CRIT)

### CRIT-1: Rate Limiter Race Condition — KV GET+PUT Not Atomic
- **Module:** `functions/api/rate-limit.mjs`, `functions/api/core/rate-limit.mjs`
- **Production Impact:** Rate limits can be exceeded by bursty concurrent requests. Two concurrent requests both reading count=19 (limit=20) both pass. Attacker can 2x-5x exceed limits via parallelism.
- **Likelihood:** HIGH — trivial to exploit with concurrent fetch requests
- **Mitigation:** Replace GET+PUT with Durable Objects atomic counter or Cloudflare WAF edge rate limiting
- **Recommended Action:** P0 — implement before production

### CRIT-2: Replay Protection Race Condition
- **Module:** `functions/api/core/replay.mjs`
- **Production Impact:** Two concurrent requests with same nonce both pass the existence check before either writes. Replay protection defeated by racing identical signed requests.
- **Likelihood:** MEDIUM — requires precise timing but exploitable
- **Mitigation:** Atomic nonce check via Durable Objects or `kv.put` with conditional `metadata.oldValue === null`
- **Recommended Action:** P0

### CRIT-3: Rate Limiter Fails OPEN on KV Failure
- **Module:** `functions/api/rate-limit.mjs:2`, `functions/api/core/rate-limit.mjs:96`
- **Production Impact:** If KV is degraded, rate limiting silently disables. All endpoints become unlimited.
- **Likelihood:** MEDIUM — KV outages are rare but attacker-triggerable (cache-busting, KV key flooding)
- **Mitigation:** Fail-closed: when KV unavailable, use in-memory fallback counter or return 503
- **Recommended Action:** P0

### CRIT-4: Hardcoded Encryption Fallback Key
- **Module:** `functions/api/settings/_validation.mjs:340`
- **Production Impact:** String `'elligentt-default-key-change-me'` used when `SETTINGS_ENCRYPTION_KEY` env var missing. All "encrypted" settings decryptable by anyone reading the source.
- **Likelihood:** HIGH — the key is in plaintext in the codebase
- **Mitigation:** Remove fallback. Make `SETTINGS_ENCRYPTION_KEY` required, fail closed if absent.
- **Recommended Action:** P0

### CRIT-5: Replay Protection Fails OPEN on KV Failure
- **Module:** `functions/api/core/replay.mjs:33-34`
- **Production Impact:** KV unavailable → replay protection is completely bypassed.
- **Likelihood:** MEDIUM
- **Mitigation:** Same as CRIT-3
- **Recommended Action:** P0

### CRIT-6: No Authentication on Invoice/Payment-Link Creation
- **Module:** `functions/api/invoice.js`, `functions/api/payment-links.js`
- **Production Impact:** Anyone can create arbitrary invoices/payment links. Could fill KV with junk, exhaust storage quota, create phishing payment links.
- **Likelihood:** HIGH — public endpoints with no auth
- **Mitigation:** Require session token or HMAC auth
- **Recommended Action:** P1

### CRIT-7: Swap Router Placeholder — Zero-byte Address
- **Module:** `config/system.js:21`, `config/contracts.js:19`, `config/runtime.js:36`
- **Production Impact:** `SWAP_ROUTER_ADDRESS = 0x00...01`. Any swap transaction sent to this address will revert on-chain, wasting user gas. Currently mitigated by `swapIsolation.js` (Phase 21).
- **Likelihood:** CERTAIN without Phase 21 mitigation
- **Mitigation:** SwapIsolation blocks UI execution; router contract must be deployed for production
- **Recommended Action:** P2 — deploy real router contract

---

## HIGH RISKS (HIGH)

### H-1: Plaintext Private Key in localStorage
- **Module:** `shared/permitEngine.js` — `elligentt_session_wallet_v1`
- **Production Impact:** Session wallet private key stored as plaintext hex in localStorage. Any XSS or browser extension can steal the key.
- **Likelihood:** HIGH — localStorage is trivially readable
- **Mitigation:** Already partially mitigated by `keyMigration.js` (encrypts → deletes v1). Ensure migration runs before any wallet usage.
- **Recommended Action:** P1 — verify keyMigration completes first in all flows

### H-2: Global ethers.Contract Monkey-Patching
- **Module:** `shared/bridgeInboundFix.js:189`
- **Production Impact:** All ethers.Contract instances go through this wrapper. Fee taken as separate transaction BEFORE depositForBurn. If fee succeeds but burn fails, money lost. If contract creation in another module is affected by this patch, unforeseen bugs.
- **Likelihood:** MEDIUM — works correctly for intended flow but fragile
- **Mitigation:** Scope the patching more narrowly or use Proxy pattern
- **Recommended Action:** P1 — add integration tests for the patched flow

### H-3: Private Key Exposure in CCTPV2InboundEngine
- **Module:** `shared/CCTPV2InboundEngine.js:122`
- **Production Impact:** Creates `new ethers.Wallet(privateKey, provider)` from raw key. Key held in browser RAM. If other scripts access the signer object, key exposed.
- **Likelihood:** LOW — requires script injection or browser extension
- **Mitigation:** Use provider-based signing (e.g., MetaMask) instead of raw key injection
- **Recommended Action:** P2 — consider relayer-based signing for cross-chain

### H-4: All Authorization/Permissions Client-Side Only
- **Module:** `shared/aiSmartWallet.js`, `shared/agentAuthorization.js`, `shared/policyEngine.js`
- **Production Impact:** All spending limits, token allowlists, operation allowlists stored in localStorage. User or attacker can modify localStorage to bypass all controls.
- **Likelihood:** MEDIUM — requires user action but trivially done via DevTools
- **Mitigation:** Server-side enforcement of critical limits. At minimum, validate daily spending against on-chain data.
- **Recommended Action:** P2 — add server-side limit enforcement for agent wallet operations

### H-5: No Rate Limiting on CORS Preflight (OPTIONS)
- **Module:** All endpoints with `onRequestOptions` handlers
- **Production Impact:** OPTIONS requests return 204 with no rate limiting. Attacker can flood OPTIONS to consume Worker CPU budget.
- **Likelihood:** LOW — Workers have built-in flood protection at Cloudflare edge
- **Mitigation:** Add rate limiting wrapper to onRequestOptions or configure edge-level OPTIONS rate limit
- **Recommended Action:** P2

### H-6: Wildcard CORS on Legacy Health Endpoint
- **Module:** `functions/api/health/index.js:2`
- **Production Impact:** `Access-Control-Allow-Origin: *` allows any origin to read health data (circuit breaker status, latency, error rates).
- **Likelihood:** LOW — health data has limited sensitivity
- **Mitigation:** Replace with allowlist like Core API health endpoint
- **Recommended Action:** P2

### H-7: Login Throttle Race Condition
- **Module:** `functions/api/auth/login.js:78-81`
- **Production Impact:** 2 concurrent login attempts both pass the 5-attempt throttle check. Allows +2 extra attempts per burst window.
- **Likelihood:** LOW — requires scripting + knowledge of valid email
- **Mitigation:** Atomic counter or shorter window increment
- **Recommended Action:** P3

### H-8: Circle/Iris Proxy Has No Timeout
- **Module:** `functions/index.js:58,90`
- **Production Impact:** `fetch()` without `AbortController` — if Circle API hangs, Worker hangs until CF kills it (~30s). Blocks other requests on same isolate.
- **Likelihood:** LOW — Circle API uptime is high
- **Mitigation:** Add AbortController with 10s timeout
- **Recommended Action:** P2

---

## MEDIUM RISKS (MED)

### M-1: Config Duplication — 6 Sources of Same Values
- **Modules:** `config/system.js`, `config/contracts.js`, `config/runtime.js`, `config/fees.js`, `functions/api/shared-config.mjs`, inline in index.html
- **Impact:** Address/fee drift across files. Updating a contract address in one place doesn't propagate.
- **Mitigation:** Single source of truth with imports or generated config

### M-2: lpAnalytics Reserve Distribution Bug
- **Module:** `shared/lpAnalytics.js`
- **Bug:** `(rA / rA + (rB || 1) * 67000) * 100` — operator precedence. Parentheses missing around denominator. Calculates ~6,700,000% for tokenB distribution.
- **Impact:** LP analytics display incorrect portfolio distribution
- **Mitigation:** Fix: `(rA / (rA + (rB || 1) * 67000)) * 100`

### M-3: liquidityHealth Arbitrary Scoring
- **Module:** `shared/liquidityHealth.js`
- **Impact:** Stability ratio compares different-unit tokens (USDC vs BTC) without normalization. Reserve A/B ratio is dimensionless but meaningless without price normalization.
- **Mitigation:** Normalize reserves to USD before ratio calculation

### M-4: CCTPFinalityEngine — 1-Block Confirmation
- **Module:** `shared/CCTPFinalityEngine.js`
- **Impact:** All chains configured with `minConfirmations: 1`. Zero reorg protection. Cross-chain settlements could be reversed by a 1-block reorg.
- **Mitigation:** Increase to 6+ blocks for testnet, 12+ for mainnet

### M-5: poolHealthCheck Ignores Placeholder Router
- **Module:** `shared/poolHealthCheck.js:106`
- **Impact:** If router is placeholder (`0x00...01`), check still passes. Pool appears healthy but swaps will revert.
- **Mitigation:** Add placeholder check to router validation

### M-6: treasurySync Uses Stale Hardcoded Prices
- **Module:** `shared/treasurySync.js`
- **Impact:** BTC price hardcoded at $67,000. Displayed TVL will be inaccurate against market prices.
- **Mitigation:** Use oracle or at minimum configurable price

### M-7: Agent Wallet Auto-Creates On First Access
- **Module:** `shared/agentWalletManager.js`
- **Impact:** `_scheduleAutoCreate()` generates a wallet without user consent. User might not expect or want an internal wallet.
- **Mitigation:** Add explicit opt-in step in UI flow

---

## LOW RISKS (LOW)

### L-1: `bridgeInboundFix` Fee-Before-Burn Ordering
- Fee transfer happens BEFORE depositForBurn. If burn fails after fee taken, user loses the fee amount.
- Fee is small (50 bps, max $100) but still a loss.
- Mitigation: Swap order — burn first, fee after confirmation.

### L-2: Error Messages Leak Internal State
- Multiple API endpoints return `e.message` including RPC errors and stack traces.
- Low sensitivity on testnet but should be sanitized for production.
- Mitigation: Return generic "Operation failed" with server-side detailed logging.

### L-3: `circle_attestation_monitor` XSS Vector
- `renderTimelineHtml()` renders `h.detail` without HTML escaping.
- Low risk — data sourced from internal state, not user input.
- Mitigation: Escape or use textContent.

### L-4: Payment Scan Counter Lost on Concurrent GET
- `payment/[token].js` increments scan counter between GET and PUT.
- Low impact — scan count is non-critical analytics.
- Mitigation: Accept approximate counts or use atomic increment.

---

## SUMMARY

| Severity | Count | Must Fix Before Production |
|---|---|---|
| CRITICAL | 7 | 5 (CRIT-1 to CRIT-5) |
| HIGH | 8 | 3 (H-1, H-2, H-6) |
| MEDIUM | 7 | 2 (M-2, M-5) |
| LOW | 4 | 0 |

**Overall Financial Risk Score: 52/100** (moderately high risk for testnet; needs P0 fixes before mainnet)
