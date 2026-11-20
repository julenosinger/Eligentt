# Autonoma 2.1 — Unified AI-Native Conversational Runtime

> Completes the AI-first conversational runtime: robust SSE streaming, conversation context, and removal of legacy authorization/result cards from the Autonoma chat. Financial execution, authorization and all other modules are unchanged.

## 1. Repository state

| Item | Value |
|---|---|
| Baseline | `feat/autonoma-1.2-multi-ai` @ `a8bf3b3` |
| Final | *(this commit)* |
| PR | #4 (open, unmerged, undeployed) |

## 2. Root causes & corrections

### PHASE 5 — Robust SSE streaming (FIXED)
**Root cause:** `shared/autonomaAi.js` used `chunk.split('\n')` — insufficient for CRLF, fragmented events, multi-line `data:`, and multiple tool calls.

**Correction:** incremental parser with a line buffer (`\r\n|\n|\r`), multi-line `data:` accumulation, per-index tool-call accumulation (id + name + fragmented `arguments`), `[DONE]` detection, UTF-8 via streaming `TextDecoder`, a 256 KB buffer cap, and an `interrupted` distinction when the stream ends without `[DONE]`.

### PHASE 6 — Conversation memory (FIXED)
**Root cause:** the frontend sent only the latest user message.

**Correction:** `_autConversationHistory()` builds prior turns (`{role,content}`) from the current Autonoma chat (assistant HTML stripped to text), bounded to 20 turns, excluding the current message; `AutonomaAi.chat(msg, { history })` prepends them.

### PHASE 3 — Remove legacy cards (FIXED)
- **"Agent Authorization Required"** → conversational "Your Circle Agent Wallet needs … authorization before proceeding" + the same compact spending-limit preset controls (mechanism preserved).
- **"Agent Ready"** (redundant post-authorization card) → "Authorization confirmed (… daily limit). Continuing your request…" conversational message.
- Send/Swap proposal cards were already converted to conversational in the prior phase.

### PHASE 2 — Unified pipeline (FIXED)
`_autAiProcess` now handles the AI's `{text}` / `{toolCalls[]}` / `{error,code}` result; provider/auth/interruption failures log and fall back to the legacy deterministic pipeline **observably** (no silent provider switch), and the AI remains the primary path before `AutonomaAgentBrain`/NLU/regex.

## 3. Changed files

- `shared/autonomaAi.js` — robust incremental SSE parser, multiple tool calls, conversation history, provider selection (persisted), error/interruption distinction.
- `index.html` — `_autAiProcess` (toolCalls array + error handling + history), `_autConversationHistory` + `_autStripHtml`, conversational authorization + "Agent Ready" replacement.
- `tests/autonoma-ai-first.test.js` — expanded to 12 tests.

## 4. AI → Circle architecture (unchanged)

User → Selected AI (`/api/autonoma2/chat`) → `AutonomaAi.chat()` (SSE → text | toolCalls) → `_autAiProcess` bridge → `AgentCapabilityRouter.createSurface` (conversational) → approve → `__autExecuteIntent` → Circle Agent Wallet. Tool calls remain untrusted proposals; deterministic validation/authorization/execution are unchanged.

## 5. Wallet / authorization / balance

- Circle Agent Wallet remains the canonical agent identity; balances read via `CircleAgent.getBalance()` → `/api/agent/balance` (never the personal EVM wallet). The `0.00 USDC` reading reflects the per-user Circle wallet's actual (unfunded) balance — not a data-source defect.
- Authorization reuse (`_agentRevalidateAuth`, `_cap_` executionIds) and resume (`window._lastPermissionMsg` → `_showPermissionCard`) are preserved.

## 6. Tests

- `tests/autonoma-ai-first.test.js` — **12 pass** (wiring, provider selection, SSE text/tool-call/fragmented/CRLF/multi-tool-call parsing, conversation history, failure → error).
- `tests/agent-capability-router.test.js` — **31 pass**; 3 pre-existing "Agent Brain flag" failures (read the minified build output `public/index.html`; unrelated, present at baseline).
- `tests/agent-wallet-integration.test.js` (node:test) — **30 pass**.
- Wallet identity regressions — pass.
- `npm run build` — passes.

## 7. Remaining risks

- Read tools (history/routes/schedules) still resolve via the legacy pipeline (the AI is primary; those are fallback-only).
- Provider selection is client-stored; actual availability/enforcement is server-side (unchanged policy).
- No real AI credits or blockchain transactions exercised in automated tests.

## 8. PR status

PR #4 remains **open and unmerged**. No merge, no deploy.
