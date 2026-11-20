# Autonoma 3.0.2 — AI Provider HTTP 502 Root-Cause Fix

> P0 production recovery. The AI endpoint returned HTTP 502 with empty logs and
> no runtime exceptions. This hotfix makes the failure observable (structured
> diagnostics) and corrects the error taxonomy so the true cause is surfaced
> instead of being collapsed into an anonymous 502.

## 1. Root cause

**Where 502 is produced:** `functions/api/autonoma2/chat.js` →
`onRequestPost()` → `errSSE(cors, 502, ...)` when `runReadLoop()` returns
`{ ok:false }`. `runReadLoop()` delegates to `generate()`
(`functions/api/_ai/orchestrator.js`).

**Why the cause was invisible:** the backend had **no logging** for AI failures
("application logs: empty"), and the HTTP status mapping was incomplete. The old
`statusMap` only covered `ai_disabled/multi_provider_disabled/no_provider/budget_exceeded/timeout/auth_error/rate_limited`; every other code — `provider_error`,
`network_error`, `invalid_model`, `invalid_provider`, `provider_not_configured`,
`malformed_response` — fell through to the `|| 502` default.

**Evidence → most likely upstream failure:** the request reached the provider
(wall time ~455 ms = KV session read + provider round-trip) and returned a
non-2xx. Given the registered-but-unverified secret (`DEEPSEEK_API_KEY`) and the
"Cloudflare Worker outcome: ok / no exceptions", the leading cause is an upstream
**401 `auth_error`** (invalid/expired key) or **5xx/400 `provider_error`**. The
exact code/status is only observable after the diagnostics in this hotfix run.

## 2. Correction (minimal)

`functions/api/_ai/orchestrator.js`:
- Added `logAiFailure()` — a single structured line, e.g.
  `autonoma_ai_failure provider=deepseek stage=upstream code=auth_error upstream_status=401 request_id=req_… duration_ms=…`.
- Instrumented every failure stage in `generate()` (`resolve`, `model`,
  `upstream`/timeout/network, `parse`). **Never** logs keys, prompts, contact
  data, wallet secrets, or raw provider bodies.

`functions/api/autonoma2/chat.js`:
- `errSSE()` now accepts a sanitized `code`, surfaced in the SSE body
  (`{error, code}`) — no raw provider content.
- Completed the `statusMap` so every internal code maps to an accurate HTTP
  status: `provider_not_configured`/`no_provider`/`ai_disabled`/`multi_provider_disabled` → 503;
  `invalid_provider`/`invalid_model` → 400; `rate_limited` → 429; `timeout` → 504;
  `auth_error`/`network_error`/`provider_error`/`malformed_response` → 502.

No change to provider selection, tool execution, authentication, or any financial
path.

## 3. Provider compatibility (controlled mocks)

- DeepSeek success → valid SSE text (`[DONE]`, content present).
- OpenAI success → `api.openai.com` invoked, text returned.
- Claude (Anthropic) success → `api.anthropic.com` invoked, text returned.
- 401/403 → `auth_error` (502); 429 → `rate_limited` (429); 5xx → `provider_error` (502);
  missing key → `no_provider`/`provider_not_configured` (503); network → `network_error` (502);
  malformed body → `malformed_response` (502); abort → `timeout` (504).

## 4. Tests & build

- `tests/autonoma-3.0.2-ai-502.test.js` (new) — **15 pass** (taxonomy + diagnostics +
  no-secret-leakage + DeepSeek/OpenAI/Claude success).
- Regression re-run: **16 files, 227 pass** (incl. App Awareness, hotfix, AI hardening
  1.2.x, ai-first, timeline 2.2, receipt 2.3, wallet identity).
- `npm run build` — passes.
- Pre-existing failures unchanged (verified at `origin/main`): `agent-capability-router`
  (3), `autonoma-0-execution-gate` (1), `autonoma-1-execution-authority` (2).

## 5. Runtime verification

Deployed build passes CI; the diagnostics emit a `autonoma_ai_failure …` line on the
next failed request, revealing the exact `code` and `upstream_status`. A live
authenticated call is required to confirm the actual upstream status — this cannot
be read from the repo (secrets live in the Cloudflare dashboard).

## 6. Required manual Cloudflare configuration (if confirmed)

After this hotfix deploys, reproduce the request and read the Cloudflare function
log line `autonoma_ai_failure …`. The corrective action depends on the code:

- `code=auth_error upstream_status=401/403` → **replace `DEEPSEEK_API_KEY`** with a
  valid, active key.
- `code=provider_error upstream_status=400` → review provider/model/tool payload
  (the diagnostics isolate it); `upstream_status=5xx` → provider-side incident.
- `code=provider_not_configured` → `DEEPSEEK_API_KEY` is empty/unset — set it.
- `code=no_provider` → `AUTONOMA_MULTI_PROVIDER_ENABLED`/default provider mismatch.

No secrets are printed; never overwrite secrets or disable auth.

## 7. Remaining risks

- The exact upstream status is unconfirmed until the diagnostics run in production
  (the repo cannot read Cloudflare secrets).
- The 502→accurate-status change means a missing key now surfaces as 503 (not 502),
  which is the intended, more truthful classification.

## 8. Files changed

- `functions/api/_ai/orchestrator.js` — structured diagnostics.
- `functions/api/autonoma2/chat.js` — complete error taxonomy + sanitized `code`.
- `tests/autonoma-3.0.2-ai-502.test.js` — new behavioral tests.
- `docs/autonoma-3.0.2-ai-502.md` — this document.
