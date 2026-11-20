# Autonoma 3.0 Hotfix — Restore AI-Native Conversation

> P0 regression fix: ordinary conversational messages must reach the selected AI
> provider; when the AI cannot answer, the user gets a clear error — never a
> legacy "default / Missing Information" payment-intent card.

## 1. Root cause

**File/function reference:** `index.html` → `autProcess()` → `_autAiProcess()` →
`shared/autonomaAi.js` `chat()` → `/api/autonoma2/chat`.

The reported response — *"I understood you want to **default**, but I need a bit
more info."* + a *"Missing Information"* card — is produced by
`shared/autonomaAgentBrain.js` `buildClarification()` (line 724), reached when the
Agent Brain's `understand()` classifies a message as `canonical: 'default'` and
`needsClarification` is true.

The message life-cycle diverged at `_autAiProcess()`:

1. `autProcess()` calls `_autAiProcess(msg)` (AI-first) — correct.
2. `_autAiProcess()` calls `AutonomaAi.chat()`. When the AI provider does not
   produce a usable answer (provider error, timeout, empty content, or
   misconfiguration), `AutonomaAi.chat()` returns `{ error }` / `null`, and
   `_autAiProcess()` **silently returns `null`**.
3. `autProcess()` then falls through to `AutonomaAgentBrain.run()`, whose legacy
   classifier maps the ordinary message ("vc pode falar em ingles") to `DEFAULT`
   and emits the "default … Missing Information" clarification.

**Net effect:** an ordinary conversation was silently re-interpreted by the legacy
classifier as a payment-intent clarification, exactly the failure reported.

> The AI backend (`functions/api/autonoma2/chat.js` + `runReadLoop()` +
> `generate()`) is correct: controlled tests prove the provider is invoked and
> plain text / tool-call responses are returned as valid SSE. The defect was the
> **silent frontend fallback**, not the backend.

## 2. Fix

`index.html`:

- Added `_autAiUnavailable(msg)` — a clear conversational error with a **Retry**
  button (preserves the message in `window._autAiRetryMsg`).
- In `autProcess()`, after `_autAiProcess()` returns null, classify the message
  with the existing `_classifyIntent()`. If the intent is `DEFAULT` (no recognized
  financial/read intent), return `_autAiUnavailable(msg)` instead of falling into
  the Agent Brain / legacy classifier.

Recognized non-`DEFAULT` intents (send / swap / bridge / balance / contacts …)
still fall through to the legacy execution path — **financial execution and
Autonoma 3.0 read tools are preserved.**

## 3. Before / after routing

**Before (regression):**
```
msg → autProcess → _autAiProcess → (AI fails) → null
    → AutonomaAgentBrain → "I understood you want to default" + Missing Information
```

**After (fixed):**
```
msg → autProcess → _autAiProcess → AI text / tool-call surface   (AI up)
                                   → null → _classifyIntent
                                     ├─ DEFAULT → _autAiUnavailable (clear error + Retry)
                                     └─ recognized → legacy execution path (unchanged)
```

## 4. Authentication & configuration findings

- `/api/autonoma2/chat` authenticates fail-closed (`requireSession` → `AUTH_KV`,
  returns 401 without a session; 503 if `AUTH_KV` is missing). Verified unchanged.
- Provider resolution (`resolveProvider`) honours the selected provider
  (DeepSeek/OpenAI/Claude) and the `AUTONOMA_*` flags; a missing
  `DEEPSEEK_API_KEY` yields `no_provider` → HTTP 503 (now surfaced, not hidden).
- No secrets are hardcoded; no auth bypass was added.
- **Environment note:** if production is missing `DEEPSEEK_API_KEY` (or
  `AUTONOMA_AI_ENABLED`/`AUTONOMA_MULTI_PROVIDER_ENABLED`), the AI will report
  "unavailable" rather than answer. These bindings live in the Cloudflare Pages
  dashboard (not `wrangler.jsonc`) and cannot be read from the repo. 2.x streaming
  was live, so the key is expected to still be present.

## 5. Tests & build

- `tests/autonoma-3.0-hotfix.test.js` (new) — **9 pass**:
  - provider is actually invoked for "vc pode falar em ingles" (`called === true`);
  - plain text returns as SSE content with `[DONE]`;
  - provider 401 → mapped 502 `auth_error`; missing key → 503 `no_provider`;
  - frontend surfaces `_autAiUnavailable` and gates on `intent === 'DEFAULT'`;
  - send/swap/bridge execution fallback + Autonoma 3.0 read tools preserved;
  - read-tool loop still returns a grounded balance answer.
- Regression re-run: **15 files, 212 pass** (incl. `autonoma-3.0-app-awareness`,
  AI hardening 1.2.x, ai-first, timeline 2.2, receipt 2.3, wallet identity).
- `npm run build` — passes.
- Pre-existing failures unchanged (verified at `origin/main`): `agent-capability-router`
  (3 — stale `public/index.html` `.das-*`), `autonoma-0-execution-gate` (1),
  `autonoma-1-execution-authority` (2 — `signer.signTransaction` in source).

## 6. Files changed

- `index.html` — `_autAiUnavailable()` + `DEFAULT` fallback gate in `autProcess()`.
- `tests/autonoma-3.0-hotfix.test.js` — new regression tests.
- `docs/autonoma-3.0-hotfix.md` — this document.

## 7. Remaining risks

- If the production AI provider binding is missing, the user now sees a clear
  "AI unavailable" message instead of a wrong payment-intent card — this is
  intended, but resolving the actual answer still requires the binding.
- `_classifyIntent()` is called once more per failed AI turn (read-only, idempotent);
  negligible cost.
- Client-side read tools remain device-local (unchanged from Autonoma 3.0).
