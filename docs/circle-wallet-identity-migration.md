# Circle Wallet Identity Migration — Final Report

**Date**: 2025  
**Scope**: Finalize Circle Wallet (`CircleAgent.getCachedAddress()`) as the ONLY runtime Agent identity across all production modules.

---

## 1. Summary

Two source files still used `AgentWalletManager.getAgentAddress()` as the runtime Agent identity. Both have been corrected. All test fixtures have been updated to inject `CircleAgent` where they previously relied solely on `AgentWalletManager`. New tests prove all 15 migration invariants.

---

## 2. Surgical Source Changes

### 2a. `shared/financialContext.js` (+ `public/shared/financialContext.js` mirror)

**Before:**
```js
try {
  var awm = _agentWallet();
  if (awm && awm.getAgentAddress) ctx.agentAddress = awm.getAgentAddress() || null;
} catch(_e){}
```

**After:**
```js
// Agent identity is ALWAYS the Circle Wallet.
// AgentWalletManager.getAgentAddress() is intentionally NOT called here;
// it may resolve to the legacy browser EOA which is NOT the Agent identity.
try {
  if (typeof CircleAgent !== 'undefined' && CircleAgent.getCachedAddress) {
    ctx.agentAddress = CircleAgent.getCachedAddress() || null;
  }
} catch(_e){}
```

**Effect**: `getWalletContext().agentAddress` now returns the Circle Wallet address. When `CircleAgent` is unavailable it returns `null` — no silent fallback to the AWM EOA.

---

### 2b. `shared/autonomaExecutionGate.js` (+ `public/shared/autonomaExecutionGate.js` mirror)

**Before:**
```js
var agentAddr = null;
try { agentAddr = (typeof wm.getAgentAddress === 'function') ? wm.getAgentAddress() : null; } catch (e) { agentAddr = null; }
if (!_isAddr(agentAddr)) return _block('agent_wallet_unavailable');
```

**After:**
```js
var agentAddr = null;
// Resolve identity from CircleAgent (canonical). Never from AgentWalletManager.
try {
  if (typeof CircleAgent !== 'undefined' && typeof CircleAgent.getCachedAddress === 'function') {
    agentAddr = CircleAgent.getCachedAddress() || null;
  }
} catch (_e) { agentAddr = null; }
if (!_isAddr(agentAddr)) return _block('agent_wallet_unavailable');
```

`AgentWalletManager` is still used for `isShutdown()` / `isPaused()` checks immediately above this block — those are correct: they test the execution-layer pause state, not identity.

---

## 3. Modules confirmed already correct (no change needed)

| Module | Identity source | Notes |
|---|---|---|
| `shared/aiSmartWallet.js` | `CircleAgent.getCachedAddress()` via `circleWalletAddr()` | Correct pre-migration |
| `shared/agentScheduleExecutor.js` | `_agentIdentityAddr()` → `CircleAgent.getCachedAddress()` | Correct pre-migration |
| `shared/agentAuthorization.js` | `CircleAgent.getCachedAddress()` for `agentWallet`; `walletAddress` for `grantedBy` | Correct pre-migration |
| `shared/autonomaAgentBrain.js` | `CircleAgent.getCachedAddress()` for `agentWallet` in `buildContext()` | Correct pre-migration |
| `shared/CCTPV2InboundEngine.js` | `SecureSignerProvider` for signer; `mintRecipient` set by caller, not by AWM identity | Low-level signer only, not Agent identity |
| `shared/secureSignerProvider.js` | Circle mode: server-side signing; browser mode: AWM fallback for signing only | Fail-closed in Circle mode |

---

## 4. Test Results

### New test file: `tests/circle-wallet-identity.test.js`

**21 tests, 21 passed, 0 failed** (via `node --test`)

Covers 9 suites:
1. AI Smart Wallet: identity = Circle Wallet
2. AgentAuthorization: Circle Wallet = agentWallet, personal = grantedBy (4 assertions)
3. FinancialContext.getWalletContext: agentAddress = CircleAgent, not AWM (3 assertions)
4. AutonomaExecutionGate: agent identity = CircleAgent, not AWM (2 assertions)
5. AgentScheduleExecutor: Circle Wallet identity, SecureSignerProvider signing (2 assertions)
6. CCTPV2InboundEngine: no new Agent wallet creation (2 assertions)
7. Authorization is mandatory for fund movement (2 assertions)
8. Agent EOA never in balance surface HTML (2 assertions)
9. Operations remain authorization-protected (3 assertions)

### Updated test files (vitest)

All were previously blocking because `CircleAgent` was not injected — they used `AgentWalletManager.getAgentAddress()` as the only identity source. Each file's `boot()` function now injects `globalThis.CircleAgent = { getCachedAddress: () => AGENT_ADDR }` as the default, with a `circleOverrides` opt for tests that need a different value.

| File | Tests | Result |
|---|---|---|
| `tests/autonoma-0-execution-gate.test.js` | 29 | 29 passed |
| `tests/autonoma-1-execution-authority.test.js` | 14 | 14 passed |
| `tests/autonoma-2-wallet-security.test.js` | 25 | 25 passed |
| `tests/agent-schedule-executor.test.js` | 47 | 42 passed, 5 pre-existing failures* |
| `tests/ms2-execution-integrity.test.js` | 5 | 5 passed |
| `tests/ms3-failure-recovery.test.js` | 7 | 7 passed |
| `tests/ms4-lost-transaction-recovery.test.js` | 7 | 7 passed |

**Total (vitest): 134 tests — 129 passed, 5 pre-existing failures**

*The 5 pre-existing failures in `agent-schedule-executor.test.js` are all "Schedules tab + Autonoma wiring (index.html)" structural checks that search `public/index.html` for function bodies that only exist in the root `index.html`. These failures existed before this session; `public/index.html` was not modified and these tests were not in scope.

---

## 5. Architecture invariants confirmed

- **Circle Agent → Circle Wallet** is the single Agent identity across all modules.
- **AgentWalletManager** is isolated to: pause/shutdown state checks (gate), signer/provider compatibility (executor, CCTP), and internal key management only.
- **No silent production fallback** from Circle signing to AWM signing: the gate returns `agent_wallet_unavailable` when `CircleAgent` is absent.
- **Authorization is mandatory**: proven via tests 7 and 9.
- **User confirmation is mandatory** for write intents: proven via test 7 (AgentBrain `requiresConfirmation`).
- **Agent EOA never appears** in balance surface HTML: proven via test 8.
- **Personal wallet** remains `grantedBy` only, never `agentWallet`: proven via test 2.

---

## 6. Files changed this session

```
shared/financialContext.js                   (identity source fix)
shared/autonomaExecutionGate.js              (identity source fix)
public/shared/financialContext.js            (mirror sync)
public/shared/autonomaExecutionGate.js       (mirror sync)
tests/circle-wallet-identity.test.js         (new — 21 tests)
tests/autonoma-0-execution-gate.test.js      (inject CircleAgent in bootGate)
tests/autonoma-1-execution-authority.test.js (inject CircleAgent in boot)
tests/autonoma-2-wallet-security.test.js     (inject CircleAgent in boot)
tests/ms2-execution-integrity.test.js        (inject CircleAgent in boot)
tests/ms3-failure-recovery.test.js           (inject CircleAgent in boot)
tests/ms4-lost-transaction-recovery.test.js  (inject CircleAgent in boot)
```
