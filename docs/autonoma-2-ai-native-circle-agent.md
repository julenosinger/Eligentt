# Autonoma 2 — AI-Native Circle Agent Integration

> Makes the external multi-provider AI the primary reasoning layer for the visible Autonoma chat, with provider selection and a tool-call bridge to the existing Circle Agent Wallet execution engine. Financial execution, authorization and all other modules are unchanged.

## 1. Root cause of legacy routing

The visible Autonoma (`#page-autonoma`, `autProcess`) was **regex-first**:

1. `AutonomaAgentBrain.run()` (local regex/NLU intent classification) ran **before** any external AI.
2. The only external-AI path, `AutonomaLLM.ask()` → `/api/deepseek/chat`, is a **dead endpoint** (no `functions/api/deepseek/` exists), so the real multi-provider AI (`/api/autonoma2/chat`) was never reached.
3. Result: Autonoma was effectively keyword/regex-driven, not AI-driven.

## 2. Files changed

- `shared/autonomaAi.js` (new) — `AutonomaAi` bridge: provider selection (`getProvider`/`setProvider`, persisted in localStorage), `chat(msg, {provider})` → streams `/api/autonoma2/chat` and returns `{ text }` or `{ toolCall:{name,arguments} }` (or `null` for fallback).
- `index.html` — added the module script tag; added `_autAiProcess` + `_autAiFormat`; made `autProcess` call the AI **first** (falling back to the existing `AutonomaAgentBrain`/NLU/regex pipeline on `null`); added the AI provider selector UI (`#aut-ai-provider` + `autSetAiProvider` + sync in `autonomaInit`).
- `tests/autonoma-ai-first.test.js` (new) — 8 behavioral/source tests.

## 3. AI → Circle execution architecture

```
User → Selected AI (DeepSeek/OpenAI/Anthropic via /api/autonoma2/chat)
     → AutonomaAi.chat() (SSE parse → text | toolCall)
     → _autAiProcess() bridge:
         text       → conversational message
         send/swap/bridge/create_* → AgentCapabilityRouter.createSurface (conversational) → approve → __autExecuteIntent → Circle Agent Wallet
         balance    → buildBalanceSurface (Circle Agent Wallet balances)
         unknown/error → fall back to the legacy pipeline
```

The AI is the reasoning layer; deterministic tool dispatch, authorization (`AutonomaExecutionGate` / `AgentAuthorization`) and execution (`_executeIntent` → Circle Agent Wallet) remain unchanged. Tool calls are untrusted proposals — no auto-execution.

## 4. Before/after user flows

**Before:** regex/NLU classified the intent locally; the AI (dead endpoint) never ran; proposal cards rendered.

**After:** the selected AI interprets the message, returns text or a tool call, and the bridge presents a conversational approval (via the conversational `AgentCapabilityRouter` from the prior phase). The same authorization + execution path runs on approval.

## 5. Authorization reuse

- `_agentGateCheck` → `AutonomaExecutionGate.authorizeAutonomaExecution` (the centralized gate).
- `_agentRevalidateAuth` → `AgentAuthorization.validateExecution` re-checks scope at signing time; executionIds prefixed `_cap_` reuse the approved authorization without re-prompting.
- `autProcess` already persists `window._lastPermissionMsg` and `_showPermissionCard` resumes the original request after authorization (unchanged).

## 6. Wallet balance verification

Balances are read from the **Circle Agent Wallet** via `CircleAgent.getBalance()` → `GET /api/agent/balance` (per-user Circle wallet, resolved server-side via `resolveUserWallet`), never from the connected personal EVM wallet. The `buildBalanceSurface` labels the Circle wallet as CANONICAL and shows the personal wallet separately. The "0.00 USDC" reading is therefore the per-user Circle wallet balance (correct source); if it shows 0.00, the Circle wallet simply has no funded USDC on Arc Mainnet.

## 7. Tests

- `tests/autonoma-ai-first.test.js` (new) — **8 pass** (wiring, provider selection, SSE text + tool-call parsing, failure fallback).
- `tests/agent-capability-router.test.js` — **31 pass**; 3 pre-existing failures remain ("Agent Brain flag" reads the minified build output `public/index.html`; unrelated, present at baseline).
- `tests/agent-wallet-integration.test.js` (node:test) — **30 pass**.
- `tests/autonoma-circle-identity`, `autonoma-wallet-identity-1.1`, `login-no-wallet-regression`, `no-internal-wallet-regression` — pass.
- `npm run build` — passes.

## 8. Remaining risks

- The AI-first bridge reuses `AgentCapabilityRouter` for Send/Swap/Bridge/create_*; read tools (history/routes/schedules) still resolve through the legacy pipeline (acceptable — the AI is primary and those paths are fallback-only).
- Provider selection is client-stored (localStorage); actual provider resolution/availability is enforced server-side (unchanged policy). A provider with no configured key returns `no_provider` → the legacy pipeline handles it.
- No real AI credits or blockchain transactions were exercised in automated tests.

## 9. PR status

PR #4 remains **open and unmerged**. No merge, no deploy.
