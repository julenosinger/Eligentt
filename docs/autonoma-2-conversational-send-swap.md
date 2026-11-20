# Autonoma 2 — Conversational Send & Swap

> Presentational change only: Send/Swap proposals are now conversational messages, not legacy "proposal cards". Financial execution, authorization and all other modules are unchanged.

## 1. Repository state

| Item | Value |
|---|---|
| Baseline | `feat/autonoma-1.2-multi-ai` @ `d5d990d` |
| Final | *(this commit)* |
| Production | `main` @ `ad5f527` — **PR #4 is NOT deployed**; this work is on the feature branch |
| PR | #4 (open, unmerged) |

## 2. Investigation findings

- The "SEND PROPOSAL" / "SWAP PROPOSAL" cards are rendered by `shared/agentCapabilityRouter.js` (`buildSendProposal` / `buildSwapProposal`), consumed by the **visible Autonoma chat** (`#page-autonoma`, via `AgentCapabilityRouter.createSurface(...)`) and by the Unified Balance panel (with `runtime._ubPanel: true`).
- Autonoma 2 (`#page-autonoma2`) is hidden (`display:none`); the primary Autonoma UI is `#page-autonoma`.
- Execution routing (`approve()` → `window.__autExecuteIntent` → `_executeIntent` → Circle Agent Wallet) and the `R` conversational renderer (`AIResponseRenderer`) are separate and unchanged.

## 3. Change (presentational only)

`shared/agentCapabilityRouter.js`:

- Added `buildSendConversational`, `buildSwapConversational`, `buildResultConversational` and `_convSurface` — natural-language summaries with a compact inline `Approve & …` / `Cancel` (same `AgentCapabilityRouter.approve/cancel` routing).
- `createSurface` routes `SEND_PAYMENT` / `SWAP_EXECUTE` to the conversational builders for the Autonoma chat; the **Unified Balance panel (`_ubPanel`) keeps the card format**.
- `approve()` returns a conversational result for Send/Swap in the Autonoma chat (card result preserved for UB panel and other operations).
- `_replaceSurface` now matches any `[data-prop]` element (conversational + executing indicator), so in-place replacement still works.

**No change** to: execution routing, `__autExecuteIntent`, authorization checks, fee calculation, on-chain tracking, `buildBridgeProposal`/`buildScheduleProposal`/`buildBatchProposal`/`buildCrossChainProposal`, or the standalone Send Assets / Swap / Multisend pages.

## 4. Behavioral contract

- Swap still retrieves a live estimate via `SwapAggregator.getBestEstimate` and presents it inline; when the quote is still computing it does **not** claim a route was found.
- Approval remains linked to the stored proposal (`propId` → `executeIntent`), preserving the user/operation/quote binding.
- No new approvals, no new restrictions, no new feature flags.

## 5. Tests

- `tests/agent-capability-router.test.js` — updated Send/Swap assertions to `not.toContain('SEND/SWAP PROPOSAL')` + conversational content; **31 pass**. 3 pre-existing failures remain: the "Agent Brain flag" suite reads the minified build output `public/index.html` (source strings `AUTONOMA_AGENT_BRAIN_ENABLED`, `agentCapabilityRouter.js`, `.das-wrap` are extracted/minified) — **unrelated to this change, present at baseline**.
- `tests/agent-wallet-integration.test.js` (node:test) — updated Send/Swap assertions; **30 pass**.
- `tests/autonoma-circle-identity.test.js`, `autonoma-wallet-identity-1.1`, `login-no-wallet-regression`, `no-internal-wallet-regression` — pass.
- `npm run build` — passes.

## 6. Remaining risks

- The 3 pre-existing "Agent Brain flag" failures (test reads build output instead of source) are not addressed here (out of scope).
- This is a presentational change; real Send/Swap execution via Circle Agent Wallet is unchanged but is not exercised in automated tests (no real funds).

## 7. PR status

PR #4 remains **open and unmerged**. No merge, no deploy.
