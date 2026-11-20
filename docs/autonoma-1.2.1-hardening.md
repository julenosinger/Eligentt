# Autonoma 1.2.1 — Streaming Integrity, Provider Policy & Usage Accounting Hardening

> Corrective phase on PR #4 (branch `feat/autonoma-1.2-multi-ai`). No deploy, no billing, no financial execution.

## 1. Repository state

| Item | Value |
|---|---|
| Baseline | `feat/autonoma-1.2-multi-ai` @ `0be9233` |
| Final | *(this commit)* |
| Production `main` | `ad5f527` (unchanged) |

## 2. Root cause & correction (per finding)

### P0 — Streaming usage metering (FIXED)
**Root cause:** `orchestrator.js:stream()` did a raw `pipeTo` pass-through and never recorded usage; only `generate()` metered. Production chat uses `stream()`, so streaming requests bypassed accounting and budget checks.

**Correction:**
- OpenAI-compatible `buildRequest` now sets `stream_options: { include_usage: true }` (provider returns a trailing `usage` chunk).
- `stream()` wraps the upstream body in `_usageTrackingStream` (a `TransformStream`) that parses SSE events (split-safe across chunks, multi-event per chunk) to extract the provider `usage`, passes every chunk through unchanged, and records usage in `flush()` — never consuming the body twice, never buffering the whole response.
- Provenance: `confirmed:true/status:'confirmed'` when provider usage present; otherwise `confirmed:false/status:'unknown_usage'` with an estimated input-token count and `outputTokens:null` (never a confirmed zero).
- Usage recording is best-effort and cannot block/corrupt the client response.

### P0 — Provider flags & fallback policy (FIXED)
**Root cause:** `resolveProvider()` resolved an explicitly requested provider before checking `AUTONOMA_AI_ENABLED`; `_fallbackGenerate()` switched providers regardless of `AUTONOMA_MULTI_PROVIDER_ENABLED`.

**Correction:**
- `resolveProvider()` enforces `AUTONOMA_AI_ENABLED=false` as the **first** gate (blocks all providers, including explicit deepseek).
- Fallback (in `generate()` and `_fallbackGenerate()`) is gated on `AUTONOMA_MULTI_PROVIDER_ENABLED=true` — when disabled, the approved legacy DeepSeek path is the only provider (no silent switching). Fallback remains bounded (primary + 1), transient-only (5xx/429), never after a partial response, and never duplicates tool execution.

### P1 — Tool-call preservation across providers (FIXED)
**Root cause:** the Anthropic compatibility path emitted only `content`, discarding normalized `toolCalls`.

**Correction:** the Anthropic branch of `stream()` now emits `delta.content` AND `delta.tool_calls` (OpenAI-style `{index,id,type,function:{name,arguments}}`) from the normalized result, matching the frontend's existing SSE parser in `shared/autonoma2/Autonoma2.js`. DeepSeek/OpenAI `tool_calls` already flow through unchanged. Tool calls remain untrusted proposals (no execution in this phase).

### P1 — Usage ledger concurrency assumptions (FIXED)
**Root cause:** `recordUsage` used a `KV.get()`→`KV.put()` "idempotency" check (not atomic) and daily counters used read-modify-write (lossy under concurrency).

**Correction:**
- `recordUsage` is documented as **telemetry only** (KV has no CAS) — best-effort dedup, never a financial guarantee.
- Cross-user `requestId` reuse is now detected (`requestId_reused_by_other_user`).
- Null token counts are preserved (unknown/partial usage) instead of being coerced to a confirmed zero; `estimatedProviderCost` is null when tokens are unknown.
- Daily counter is approximate telemetry; the hard `checkDailyBudget` gate was **removed from `generate()`** and `checkDailyBudget` is documented as non-authoritative. Hard budget/billing guarantees are explicitly disabled (a Durable Object is the correct mechanism, deferred).

### Security — request validation (FIXED)
`chat.js` now rejects invalid message structures and oversized requests (≤40 messages, ≤100 KB) before any provider call. Session auth remains mandatory; API keys remain server-side; provider errors never expose upstream bodies (only a 200-char snippet in server logs, never to the client).

## 3. SSE compatibility contract

The client (`shared/autonoma2/Autonoma2.js`) expects OpenAI-style SSE:
```
data: {"choices":[{"delta":{"content":"…","tool_calls":[{"index":0,"id":"…","type":"function","function":{"name":"…","arguments":"{…}"}}]}}]}
data: [DONE]
```
DeepSeek/OpenAI stream this natively (pass-through). Anthropic is materialised to this shape (single chunk). `[DONE]` terminates. Usage is read from the trailing `usage` chunk server-side and never forwarded to the client as credential/sensitive data.

## 4. Confirmed vs estimated usage

| status | confirmed | inputTokens | outputTokens |
|---|---|---|---|
| `confirmed` | true | provider value | provider value |
| `unknown_usage` | false | estimate (~4 chars/token) | null |

## 5. Tests

- New `tests/autonoma-1.2.1-hardening.test.js` — **12 pass** (streaming usage confirmed/unknown/split-chunk/pass-through; provider policy flags; Anthropic tool-call preservation; ledger cross-user reuse/null tokens/missing KV).
- `tests/autonoma-1.2-multi-ai.test.js` — **29 pass** (updated fallback policy).
- Regression sweep (circle-identity, wallet-identity-1.1, login-no-wallet, no-internal-wallet) — pass.
- `npm run build` — passes.

Pre-existing failure (unchanged): `tests/autonoma2.test.js` (Windows path bug `C:\C:\...`).

## 6. Classification

| Finding | Status |
|---|---|
| Streaming usage metering | **PASS** |
| Provider flag/fallback enforcement | **PASS** |
| Tool-call preservation (Anthropic) | **PASS** |
| Ledger concurrency/atomicity assumptions | **PASS** (telemetry-only, hard guarantees disabled) |
| Request validation | **PASS** |
| Financial billing / execution / deploy | **NOT IMPLEMENTED** (by design) |

## 7. Remaining risks

- KV usage counters remain approximate (not a hard spend limit); a Durable Object is required before any billing guarantee.
- Anthropic streaming is still materialised (single chunk), not incremental `content_block_delta` interleaving.
- Hard rate limiting is deferred (no atomic budget reservation in this phase).

## 8. Next steps (unchanged from 1.2)

Wire `shared/ai/providerInfo.js` UI selector; incremental Anthropic streaming; Durable Object usage/billing reservation; fee-quote + billing state machine behind `AUTONOMA_AI_BILLING_ENABLED`.
