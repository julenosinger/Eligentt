# Autonoma 1.2.3.1 — Final Runtime Integrity (Streaming Lifecycle, Usage Accuracy, tool_choice)

> Surgical runtime-integrity corrections on PR #4 (branch `feat/autonoma-1.2-multi-ai`). No behavioral change, no deploy, no billing, no merge.

## 1. Repository state

| Item | Value |
|---|---|
| Baseline | `feat/autonoma-1.2-multi-ai` @ `4ac9ed2` |
| Final | *(this commit)* |
| Production `main` | `ad5f527` (unchanged) |

## 2. Root cause & correction

### P1 — Streaming lifecycle integrity (FIXED)
**Root cause:** `upstreamBody.pipeTo(transform.writable).catch(() => {})` swallowed upstream stream errors, so an interrupted/cancelled stream was never recorded (usage telemetry missing for incomplete responses).

**Correction:** a `recordOnce` guard records the interrupted lifecycle from the `pipeTo().catch()` path (usage + `completed:false`) when `flush()` does not run (upstream error / client cancellation). Clean completion still records via `flush()`; `recordOnce` prevents any duplicate write. The connection timeout is unchanged (no new hard duration limit); long-running responses are not interrupted.

### P2 — Non-streaming usage accuracy (FIXED)
**Root cause:** `normalizeResponse()` collapsed missing provider usage to `0` tokens, and `generate()` recorded it as `confirmed:true`.

**Correction:** normalized `usage` now carries `present:boolean`; missing usage → `{ inputTokens:null, outputTokens:null, present:false }`, a valid zero → `{ 0, 0, present:true }` (via nullish `??`, so `0` is preserved). `generate()`/`_fallbackGenerate()` record `confirmed: usage.present` and `status: present ? 'recorded' : 'unknown_usage'`. Missing usage never blocks the response.

### P3 — Safe tool_choice propagation (FIXED)
**Root cause:** `toolChoice` was accepted but ignored (adapters hardcoded `auto`).

**Correction:** `toolChoice` is now passed through `generate()`/`stream()`/`_fallbackGenerate()` → `buildRequest()`. OpenAI-compatible adapters normalize (`auto`/`none`/`required`/single-function object; unsupported → `auto`). Anthropic maps to its `tool_choice` (`required`→`{type:'any'}`, `none`→`{type:'none'}`, `auto`→omit). Default `auto` preserved; no new tool permissions or restrictions.

## 3. Behavioral preservation (CONFIRMED)

- Autonoma conversational behavior, prompts, tool registry, approval flow, Send/Swap cards, history — unchanged.
- Circle Agent Wallet 1.1, Multisend, Send/Swap/Bridge, Gateway, x402, Treasury, LI.FI, CCTP — untouched.
- Feature flags unchanged; no billing, no financial execution, no new gates/restrictions.
- Existing security controls (auth fail-closed, trusted tool allowlist, execution gate) intact.

## 4. Tests

- New `tests/autonoma-1.2.3.1-integrity.test.js` — **9 pass** (non-streaming unknown vs confirmed-zero usage, streaming interrupted lifecycle + no-duplicate, tool_choice default/required/none/unsupported/Anthropic mapping).
- Full AI suite (1.2 → 1.2.3) + wallet regressions — **165 tests pass (11 files)**.
- `npm run build` — passes.

Pre-existing failure (unchanged, recorded separately): `tests/autonoma2.test.js` — Windows path bug (`C:\C:\...`).

## 5. Classification

| Finding | Status |
|---|---|
| Streaming lifecycle integrity | **PASS** |
| Non-streaming usage accuracy | **PASS** |
| Safe tool_choice propagation | **PASS** |
| Behavioral preservation / zero regressions | **PASS** (165 tests) |
| Billing / execution / deploy / merge | **NOT PERFORMED** (by design) |

## 6. Remaining risks

- KV usage counters remain approximate telemetry (hard budget requires a Durable Object).
- Anthropic streaming is still non-incremental (single-chunk materialisation).
- `waitUntil` absence → best-effort fire-and-forget persistence (documented).

## 7. Release safety

Flags preserved (`AUTONOMA_MULTI_PROVIDER_ENABLED=false`, `AUTONOMA_AI_BILLING_ENABLED=false`, `AUTONOMA_AI_FINANCIAL_EXECUTION_ENABLED=false`). No merge, no deploy.

**PR #4 remains unmerged and undeployed.**
