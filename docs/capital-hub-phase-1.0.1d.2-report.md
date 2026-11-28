# Capital Hub Phase 1.0.1D.2 — Native Execution Integration & Functional Unlock

> Continuation of `work/capital-hub-phase-1.0.1` (base `3c25fa0`). Functional-unlock
> phase: the Capital Hub's Send / Cross-chain / Withdraw now execute natively through
> the existing Circle Gateway engine, without redirecting to Send Assets. No merge/
> deploy, no production activation, no real transactions.

## Classification
**READY FOR CONTROLLED MAINNET TESTING** — the technical unlock is proven; real
mainnet sends depend on the authorized Pilot configuration (allowlist + wallet
approval), which is not performed here.

---

## Gate results

### Gate A — Preserve Working Deposit (PASS)
The Deposit flow is untouched: it remains a launcher to the existing `ubGwDepOpen`
window (the flow that already confirmed `0x246b08f6…622d` on Arc Mainnet). No change
to its approval/signing/execution/confirmation/balance logic.

### Gate B — Native Send Execution (FIXED)
Root cause: `capitalHubManage.js` was a presentation-only UI — the primary button was
hardcoded `disabled` with "Native execution is not enabled yet", and the only action
was `UI.qaOpen` → `UI.launch('transfer')` → `showPage('send')` (redirect to Send
Assets). Fix:
- `saExecGateway()` now accepts an optional explicit-parameter object
  (`arguments[0]` = `{ recipient, amount, asset, chainId, destChainId }`), with the
  legacy Send Assets DOM fallback preserved unchanged.
- `capitalHubManage.js` gained `UI.qaExec(k)` — a native executor that calls
  `saExecGateway({…})` with the Capital Hub form's values (no hidden Send Assets DOM
  fields). The `send` button becomes `data-ch-exec`, enabled only when
  `isReady(k, g)` (valid amount ≤ Gateway balance, valid recipient).
- The delegated listener dispatches `data-ch-exec` → `UI.qaExec`. Execution stays
  entirely inside the Capital Hub (Review → Sign → Processing → Confirm), with real
  status (`pending`/`ambiguous`/`error`) surfaced and the Gateway cache refreshed.

### Gate C — Native Cross-chain Execution (FIXED)
Cross-chain uses the SAME `saExecGateway` engine with a different destination network
(the form's destination select). No second cross-chain engine; Bridge/LI.FI/CCTP
Turbo untouched. chainId/domain/token are validated by the existing engine.

### Gate D — Native Withdraw Execution (FIXED, semantics distinguished)
Withdraw executes a Gateway transfer to the connected wallet
(`recipient = wallet`) — a **mint to the user's own address**, NOT the trustless
`initiateWithdrawal` 7-day flow. The UI keeps the honest label "Not a trustless
withdrawal" and never reports a pending withdraw as completed (only `pending`/
`ambiguous` until verified confirmation). The trustless-withdrawal path is not
implemented and is not conflated.

### Gate E — Manage Funds & Charge in USDC
- Send / Cross-chain / Withdraw: now native (above).
- Deposit: preserved (existing deposit window).
- Charge in USDC: remains disabled with the precise reason "Payment links are created
  in Billing today" — it is not a Gateway balance operation and depends on the
  existing Billing/Payment Links infrastructure (out of this phase's engine scope;
  not invented here).

### Gate F — Financial Integrity & Pilot Corrections (preserved)
All 1.0.1D.1 invariants are preserved: per-intent identity, no local-UUID fallback in
pilot, kill switch, allowlist, per-op/daily/concurrent limits, mandatory
`expectedGeneration`, unified `_transitionOp`, durable reconciliation, no automatic
resubmission. No regression to these protections.

### Gate G — Live Transaction Details & Execution Steps (wired)
The static "Steps stay inactive" footer is replaced with a real-state note; the
`data-ch-exec` button drives a real execution with a live status line (submitted /
indeterminate / failed). Real values (amount, destination, recipient) come from the
Capital Hub form + `CH` data layer; the engine surfaces real salt/transferId/txHash.

### Gate H — Controlled Mainnet Functional Unlock (prepared)
Pilot config (Arc Mainnet 5042 · USDC · allowlist · 1 USDC/op · 10 USDC/day · 1
concurrent · manual sign · kill switch) is unchanged from 1.0.1D.1. Not activated;
no merge, no production change, no automatic execution.

### Gate I — Tests (59 gateway/coordinator + 6 native)
Added `tests/capital-hub-native-execution.test.js` (6 source-level guards): explicit-
opts engine, native executor wiring, `data-ch-exec` dispatch, deposit preserved,
withdraw semantics. Existing 53 coordinator tests + characterization tests pass.
The 4 pre-existing UI/registry failures remain unchanged (non-financial).

---

## Files
- `index.html` — `saExecGateway` accepts explicit `opts` (arguments[0]) with DOM
  fallback preserved.
- `shared/capitalHubManage.js` — `UI.qaExec`, `isReady`, native `data-ch-exec` button
  for send/cross-chain/withdraw; deposit/charge launchers preserved.
- `shared/capitalHubUI.js` — delegated listener dispatches `data-ch-exec`.
- `shared/capitalHub.js` — the transfer journal hook reads explicit `opts`.
- `tests/capital-hub-native-execution.test.js` — 6 guards.

## Services reused (no new engine)
- `saExecGateway` (Circle Gateway /v1/transfer) — the existing active executor.
- `CH` (Capital Hub data layer) + `_ubGwCache` — real Gateway balances.
- `ubGatewaySyncRefresh` — post-send balance refresh.
- Deposit window (`ubGwDepOpen`) — preserved.

## Baseline comparison
- New: 6 native-execution tests pass.
- Coordinator: 53 pass (48 + 5 runtime).
- Characterization: `gateway-fase2` (saExecGateway signature) passes.
- **4 pre-existing failures unchanged** (`gateway-balance` UI6.3, `gateway-ub-fase29`,
  `send-assets-mainnet-source`, `treasury-restoration`). **Zero new.**
- `npm run build` + `node --check` pass.

## Pre-existing failures (re-confirmed, non-financial)
Same four UI/registry characterization assertions, unrelated to the Gateway
coordinator, present before this branch and unchanged.

## Limitations / residual risks
1. **Charge in USDC** remains disabled — it depends on the existing Billing/Payment
   Links flow, which is a separate integration surface (not the Gateway transfer
   engine) and is not connected in this phase (no invented endpoint).
2. The native execution is source-level verified + built; end-to-end browser signing
   is exercised only in the authorized Pilot (real wallet required), not in the test
   sandbox (no wallet/DOM).
3. The trustless `initiateWithdrawal` 7-day flow is not implemented (Withdraw uses the
   Gateway mint-to-own-wallet mechanism, correctly labelled).

## Pilot activation (unchanged from 1.0.1D.1)
Set on an isolated preview env (not production): `GATEWAY_EXECUTION_COORDINATOR_ENABLED
='pilot'`, `GATEWAY_PILOT_ALLOWLIST=<wallets>`, `DO_INTERNAL_SECRET=<secret>`, optional
limits. Kill switch: `GATEWAY_PILOT_KILL_SWITCH='true'` or
`GATEWAY_EXECUTION_COORDINATOR_ENABLED='draining'`.

No merge/deploy. No real transactions. No production Cloudflare changes.
