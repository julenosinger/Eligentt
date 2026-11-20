# Autonoma 2.2 — Professional Inline Transaction Steps

> Presentation-only improvement: transaction progress is now a single, minimal, continuously-updated inline timeline inside the Autonoma conversation — no cards, panels, borders or per-step message blocks. Financial execution, authorization and all other modules are unchanged.

## 1. Repository state

| Item | Value |
|---|---|
| Baseline | `feat/autonoma-1.2-multi-ai` @ `80fdbae` |
| Final | *(this commit)* |
| PR | #4 (already merged into `main` as `decfb85`; this work continues on the feature branch) |

## 2. Root cause

`_agentStateMsg(execId, state, detail)` mapped each execution state (PLANNING, BROADCASTING, SUBMITTED, CONFIRMING, COMPLETED, FAILED, …) to a small colored block and called `_addAgentResultMsg(...)`, which appended a **new assistant message** per state change — producing a sequence of separate progress blocks.

## 3. Correction (presentation-only)

- `_agentStateMsg` now updates a single persistent inline timeline keyed by `execId` (created once, updated in place via `_agentRenderTimeline`).
- New borderless timeline CSS (`.aut-step-timeline` / `.aut-step-item` / `.aut-step-dot`) — thin vertical connecting line, small status icons (✓ done / ◉ active / ○ upcoming / ✕ failed), compact typography, `prefers-reduced-motion` support, theme-agnostic (uses design tokens).
- State→step mapping (`_agentStepIndex`): PLANNING→Preparing, BROADCASTING→Broadcasting, SUBMITTED/CONFIRMING/VERIFYING/ATTESTING/MINTING/CONFIRMED→Awaiting confirmation, COMPLETED→Completed. Failure states (FAILED/REJECTED/REVERTED/DROPPED/…) mark the active step as failed.
- `_addAgentResultMsg` (the final natural-language result + transaction hashes + explorer links) is **unchanged** — detailed results and step confirmations are preserved.

## 4. Financial execution (unchanged)

No change to `__autExecuteIntent`, Circle Agent Wallet signing/broadcast, `_agentGateCheck`, `_agentRevalidateAuth`, spending limits, fees, contract interactions, or reconciliation. `_agentStateMsg` is purely a UI renderer; it only maps states to timeline steps and never advances on timers or animation.

## 5. Tests

- `tests/autonoma-2.2-timeline.test.js` (new) — **6 pass** (single timeline, borderless, 4 steps, state mapping, no per-state block append, reduced-motion, failure states).
- `tests/autonoma-ai-first.test.js` (12), `tests/agent-capability-router.test.js` (31), wallet identity regressions — pass.
- `tests/agent-wallet-integration.test.js` (node:test) — **30 pass**.
- `npm run build` — passes.
- Pre-existing failures (unchanged): `tests/autonoma2.test.js` (Windows path), `tests/autonoma2-phase2a.test.js` (jsdom), `tests/autonoma-6b-signer-provider` / `autonoma-2-wallet-security`, and 3 "Agent Brain flag" (read minified build output). None introduced by this change.

## 6. Remaining risks / limitations

- Progress state is in-memory (`_agentExecState`), matching the prior behavior; the timeline is not persisted across full page reloads (no regression vs baseline).
- The detailed per-step transaction hashes/block numbers remain as separate `_addAgentResultMsg` messages (preserved "transaction details"), while the high-level steps are unified into the timeline.

## 7. Scope isolation

Only `index.html` (Autonoma timeline CSS + `_agentStateMsg`) and the new test were modified. No changes to Send/Swap/Bridge pages, Multisend, Unified Balance, Gateway, CCTP, LI.FI, x402, Treasury, Billing, wallets, or AI provider orchestration.
