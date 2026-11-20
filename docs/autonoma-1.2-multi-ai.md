# Autonoma 1.2 — Multi-AI Provider Foundation

> Foundation phase. Server-side provider abstraction + usage metering. No financial execution, no billing, no deploy.

## 1. Repository state

| Item | Value |
|---|---|
| Baseline `main` | `ad5f527` |
| Branch | `feat/autonoma-1.2-multi-ai` |
| Final HEAD | *(this commit)* |

## 2. Existing architecture findings

- **Autonoma 2 (production chat)** — `functions/api/autonoma2/chat.js` hardcoded DeepSeek and streamed SSE pass-through; `shared/autonoma2/` (Autonoma2.js orchestrator, ToolRegistry.js, Planner.js, ContextEngine.js, ExecutionMonitor.js, tools/send.js).
- **Autonoma 1 (legacy)** — `shared/autonomaLLM.js` → `/api/deepseek/chat` (endpoint absent from the functions tree; dead path).
- **Fees** — `config/fees.js` (frontend constants) + `functions/api/treasury/fees.js` (server, reads `RELAYER_CONFIG`). Not modified.
- No prior `shared/ai/` or `functions/api/_ai/` existed.

## 3. New provider architecture (server-side, additive)

`functions/api/_ai/` (leading underscore → not routed, imported only):

| File | Purpose |
|---|---|
| `providerRegistry.js` | Adapters (DeepSeek, OpenAI, Anthropic) with a common `buildRequest`/`normalizeResponse`/`authHeaders` contract; model allowlists; availability by env key; `defaultProviderId`. |
| `orchestrator.js` | Feature flags, provider resolution (explicit/auto), non-streaming `generate()` (normalized + metered), streaming `stream()`, bounded safe fallback, error mapping, timeout. |
| `usageLedger.js` | Server-side usage metering (KV, idempotent by requestId, per-user daily token budget). |
| `toolSchema.js` | Server-side validation of model-generated tool calls (names, addresses, chains, amounts) — untrusted input. |
| `pricing.js` | Authoritative server-side provider pricing (ESTIMATED USD/1M tokens; never charged). |

`shared/ai/providerInfo.js` — thin client catalog (ids/display names/model allowlists; NO secrets) for the future provider selector UI.

### Provider contract
```
generate({ model, messages, tools, temperature, maxTokens, stream, requestId })
```
Normalized output:
```
{ provider, model, message, toolCalls, usage:{inputTokens,outputTokens,totalTokens}, finishReason, requestId }
```
Provider differences handled: OpenAI-compatible `chat/completions` + `tool_calls` (DeepSeek/OpenAI) vs Anthropic `messages` + `content`/`tool_use` + `x-api-key`; token field mapping; streaming (OpenAI-compatible SSE pass-through vs Anthropic materialised to a single SSE chunk).

## 4. Supported models & limitations

- **DeepSeek** — `deepseek-chat`, `deepseek-reasoner` (default, fully streaming).
- **OpenAI** — `gpt-4o-mini`, `gpt-4o` (streaming pass-through).
- **Anthropic** — `claude-3-5-haiku-latest`, `claude-3-5-sonnet-latest` (non-streaming normalization; streaming materialised to one chunk — full `content_block_delta` interleaving is a Phase 1.3 refinement).

Missing API keys disable only that provider; DeepSeek path preserved as default.

## 5. Authentication & security controls

- Session auth preserved (`AUTH_KV`, no `DEV_AUTH_BYPASS` in production).
- API keys server-side only (`env`); never in browser.
- Model tool calls are untrusted → `toolSchema.validateToolCall` allowlists operation names + validates addresses/chains/amounts.
- Prompt-injection resistance: model output is treated as a proposal, gated by the existing Autonoma 2 execution gate + user confirmation (unchanged).
- Bounded fallback (primary + 1) on transient 5xx/429 only — never on 4xx; fallback never re-runs tools.
- Sensitive-data redaction: ledger stores token counts/metadata only, never conversation content.
- Audit: `requestId` idempotency + `X-AI-Provider` header.

## 6. Usage metering (Treasury billing readiness)

`recordUsage` writes `ai_usage:{requestId}` (idempotent) with `{ requestId, userId, provider, model, inputTokens, outputTokens, estimatedProviderCost, operationType, operationId, status, confirmed, timestamp }`.

- Token counts + cost computed server-side (never client-trusted).
- `confirmed` distinguishes provider-confirmed usage from estimates.
- `estimatedProviderCost` is ESTIMATED only — never treated as settled Treasury revenue.
- Per-user daily token budget (`AUTONOMA_AI_DAILY_TOKEN_LIMIT`).
- Financial states (`quoted/authorized/pending/settled/failed/refunded/ambiguous`) are designed for the future billing engine but **NOT** implemented/activated.

## 7. Feature flags (server-enforced, default off)

```
AUTONOMA_AI_ENABLED=true                 (preserve current behaviour)
AUTONOMA_MULTI_PROVIDER_ENABLED=false
AUTONOMA_AI_BILLING_ENABLED=false
AUTONOMA_AI_FINANCIAL_EXECUTION_ENABLED=false
AUTONOMA_DEFAULT_PROVIDER=(unset → deepseek)
```
Client cannot override these (no URL/localStorage/globals path — enforced in `orchestrator.js`).

## 8. Multisend / Send / Swap / Bridge

Untouched. AI interpretation adapter for Multisend and chat-first Send/Swap are deferred to Phase 1.3 (per spec §6–§7). No execution engine, routing, fee, or contract change.

## 9. Tests

New `tests/autonoma-1.2-multi-ai.test.js` — **28 pass** (behavioral, mocked `fetch`): pricing, adapter normalization (OpenAI-compatible + Anthropic), provider resolution/availability, feature flags, generate success/auth-error/rate-limit/fallback/malformed/timeout, usage ledger idempotency + cost + budget, tool-schema validation.

Regression sweep: `autonoma-circle-identity`, `autonoma-wallet-identity-1.1`, `login-no-wallet-regression`, `no-internal-wallet-regression`, `per-user-circle-wallet` — pass.

`npm run build` — passes.

Pre-existing failure (unchanged): `tests/autonoma2.test.js` — Windows path bug (`C:\C:\...` + `%20`), unrelated.

## 10. Classification

| Deliverable | Status |
|---|---|
| Multi-provider architecture | **PASS** (foundation; DeepSeek default, OpenAI/Anthropic adapters) |
| Existing Autonoma operational | **PASS** (chat.js routes through orchestrator, DeepSeek default) |
| Circle Wallet Identity 1.1 intact | **PASS** (no wallet/auth changes) |
| Multisend/Send/Swap/Bridge unchanged | **PASS** |
| Usage metering | **PASS** (metering only; billing NOT activated) |
| Feature flags | **PASS** (server-enforced, default off) |
| Real financial execution / billing / deploy | **NOT IMPLEMENTED** (by design) |

## 11. Remaining risks

- Anthropic streaming is materialised (not true incremental streaming) — acceptable for foundation.
- Provider pricing values are ESTIMATES (public list prices, 2026) — must be reviewed before any billing.
- Usage metering is recorded but not surfaced to the UI yet.

## 12. Next steps (Phase 1.3)

1. Wire `shared/ai/providerInfo.js` into the Autonoma UI provider selector.
2. Incremental Anthropic streaming (content_block_delta interleave).
3. Fee-quote interface + billing state machine (quoted→settled) behind `AUTONOMA_AI_BILLING_ENABLED`.
4. Chat-first Send/Swap + Multisend AI interpretation adapter.
5. Surface usage/budget in the UI.
