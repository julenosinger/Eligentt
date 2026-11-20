# Autonoma 1.2.2 — Provider Isolation, SSE Final Integrity & Security Hardening

> Corrective phase on PR #4 (branch `feat/autonoma-1.2-multi-ai`). No deploy, no billing, no financial execution.

## 1. Repository state

| Item | Value |
|---|---|
| Baseline | `feat/autonoma-1.2-multi-ai` @ `9af67bc` |
| Final | *(this commit)* |
| Production `main` | `ad5f527` (unchanged) |

## 2. Root cause & correction (per finding)

### P0 — Strict provider isolation (FIXED)
**Root cause:** `resolveProvider()` reached `defaultProviderId()` even when multi-provider was disabled, so `AUTONOMA_DEFAULT_PROVIDER=openai` (or a missing DeepSeek key with an available OpenAI key) could select a non-DeepSeek provider. Invalid explicit provider IDs were silently replaced with the default; unsupported models were silently substituted.

**Correction:**
- When `AUTONOMA_MULTI_PROVIDER_ENABLED=false`, DeepSeek is the ONLY provider: explicit non-deepseek → `multi_provider_disabled`; missing DeepSeek key → `no_provider` (never falls back to another provider); `AUTONOMA_DEFAULT_PROVIDER` cannot bypass.
- Invalid explicit provider id → `invalid_provider` (never silently defaulted).
- `resolveModel()` rejects unsupported models with `invalid_model` (never silently substituted) in both `generate()` and `stream()`.

### P0 — SSE parser integrity (FIXED)
**Root cause:** `_usageTrackingStream()` assumed `\n\n` event boundaries and did not robustly handle CRLF/CR, multi-line `data:`, comments, or incomplete final events.

**Correction:** a standards-compliant incremental SSE parser (LF/CRLF/CR via ordered regex split, multi-line `data:` joined with `\n`, comment lines, arbitrary UTF-8 chunk boundaries via streaming `TextDecoder`, multiple events per chunk, `[DONE]` recognition, incomplete-final-event processing in `flush`, and a 256 KB parse-state cap). Original bytes are passed through unchanged; malformed metadata is never treated as confirmed usage.

### P1 — Non-blocking usage persistence (FIXED)
**Root cause:** `flush()` awaited `recordUsage()`, potentially delaying response completion.

**Correction:** `flush()` now calls `onUsage(usage)` synchronously (no await). The callback builds the record promise and schedules it via `context.waitUntil()` (passed through `chat.js` → `stream()`), else fire-and-forget best-effort (documented limitation). Persistence can never block or corrupt the client stream.

### P1 — Server-authoritative prompts & tools (FIXED)
**Root cause:** `chat.js` accepted client `role: system` messages and client tool definitions.

**Correction:**
- New `functions/api/_ai/trustedTools.js` owns `TRUSTED_SYSTEM_PROMPT` and `TRUSTED_TOOLS` (authoritative definitions) + `resolveTools()`.
- `chat.js` ignores client `role: system` (substitutes the trusted prompt), and builds tools via `resolveTools()` — tool names validated against the allowlist, definitions always from the registry (client descriptions/parameters never trusted). Unknown tool → `400 unauthorized_tool`.
- Client context is marked as untrusted display data (never instructions/authority).

### P1 — Usage ledger input validation (FIXED)
**Root cause:** `recordUsage()` used unsafe `Number()` coercion and trusted a client-supplied `estimatedProviderCost`.

**Correction:** `_normalizeTokens()` accepts only non-negative safe integers or `null`; rejects negatives, fractions, NaN, Infinity, malformed strings (`invalid_token_count`). Provider cost is ALWAYS computed server-side via `estimateProviderCost()` — client estimates are ignored. Cross-user requestId reuse is still detected; KV remains telemetry-only (no atomic idempotency claim).

## 3. Anthropic compatibility (PRESERVED)

Text + tool calls (id/name/arguments) + finish reason flow through the normalized SSE delta (tested). Non-incremental compatibility mode remains documented. No tool call executes automatically.

## 4. SSE compatibility contract (unchanged)

Client expects OpenAI-style SSE `data: {"choices":[{"delta":{"content":…,"tool_calls":[…]}}]}` + `data: [DONE]`. DeepSeek/OpenAI native; Anthropic materialised. Server reads the trailing `usage` chunk and never forwards credentials/sensitive metadata.

## 5. Tests

- New `tests/autonoma-1.2.2-hardening.test.js` — **23 pass** (provider isolation, SSE CRLF/multi-event/pass-through/truncation/comments, waitUntil persistence, trusted tools allowlist + definition-substitution rejection, ledger negative/fraction/NaN/Infinity/malformed/client-cost-ignored).
- `tests/autonoma-1.2.1-hardening.test.js` (12), `tests/autonoma-1.2-multi-ai.test.js` (29) — pass.
- Regression sweep (circle-identity, wallet-identity-1.1, login-no-wallet, no-internal-wallet, per-user-circle-wallet) — pass (**125 total**).
- `npm run build` — passes.

Pre-existing failure (unchanged): `tests/autonoma2.test.js` (Windows path bug `C:\C:\...`).

## 6. Classification

| Finding | Status |
|---|---|
| Strict provider isolation | **PASS** |
| SSE parser integrity | **PASS** |
| Non-blocking usage persistence | **PASS** |
| Server-authoritative prompts/tools | **PASS** |
| Usage ledger input validation | **PASS** |
| Anthropic compatibility | **PASS** (preserved) |
| Financial billing / execution / deploy | **NOT IMPLEMENTED** (by design) |

## 7. Remaining risks

- KV usage counters remain approximate (telemetry only); hard budget requires a Durable Object.
- Anthropic streaming is still materialised (single chunk), not incremental.
- Without `waitUntil` (non-Cloudflare runtimes), usage persistence is fire-and-forget best-effort.

## 8. Next steps (unchanged)

Wire `shared/ai/providerInfo.js` UI selector; incremental Anthropic streaming; Durable Object usage/billing reservation; fee-quote + billing state machine behind `AUTONOMA_AI_BILLING_ENABLED`.
