# AUTONOMA-AUDIT-1 — Complete Chat & Autonoma Agent Audit

| Field | Value |
|---|---|
| **Phase** | AUDIT-ONLY — no code, no refactor, no commit, no push |
| **Repo** | `julenosinger/Eligentt` @ `9fe8bf0` (`main`, 2026-08-18) |
| **Authoring source of truth** | [`index.html`](../index.html) + [`shared/*.js`](../shared) |
| **Deployed artifact** | [`public/index.html`](../public/index.html) via `scripts/build.js` → Wrangler Pages (`package.json` `deploy`) |
| **Date** | 2026-08-21 |
| **Method** | Runtime-flow tracing (callers/callees), not filenames or comments |

---

## 1. Executive Summary

Autonoma is **not** a single pipeline of Chat → Intent → Policy → Authorization → Approval → Claim → Execution.

It is a **layered stack of independent routers** that race until one returns HTML, plus **two independent on-chain authorities**:

1. **Chat Agent broadcast APIs** (`window._agentExecuteOp` / Swap / Bridge / Turbo / Liquidity / MultiSend) — sign with the Agent Wallet, **no MS-2/MS-3/MS-4 claim/ledger**.
2. **AgentScheduleExecutor** 30s tick — **does** use `ScheduleEngine.claimExecution` + persistent ledger + nonce fingerprint. Autonoma inherits those protections **only** when it creates a schedule and lets the executor run.

There is **no single financial execution authority**.

**Headline verdicts**

| Area | Verdict |
|---|---|
| Chat (read / cards / navigation) | CONDITIONALLY READY |
| Read-only Agent | CONDITIONALLY READY |
| Agent with approval | NOT READY |
| Agent Wallet | NOT READY (crypto isolation exists; operational isolation does not) |
| Autonomous financial execution | **CRITICAL / NOT SAFE** |

**Highest-severity facts (proven in code)**

- Chat can **create Active `agentExecution:true` schedules** without a second confirmation (`autProcess` time-delay send; Phase-1 `tryHandle` schedule; document intel; schedule route).
- Chat can **broadcast on-chain** via globally exported `_agentExecute*` (one click; some paths auto-fire).
- Authorization is **unsigned localStorage**, defaults `allowPayments/allowSwap/allowBridge/allowCrosschain = true`.
- `_isFinancialIntent` **omits** payment links, schedules, mass payment, batch swap, turbo, payroll, execute-schedules.
- Agent Wallet and Agent Session **share the same localStorage key**.
- Autonoma memory is **not keyed by user wallet**. Wallet B inherits Wallet A chat, grants, agent key, contacts, schedules.
- MS-2/MS-3/MS-4 **do not wrap** `_agentExecute*`. Schedule swap/bridge **delegate back** into those unprotected functions.
- Intended V2 / Contacts / ScheduleRoute monkey-patches **do not attach** to the live chat functions.

---

## 2. Real Autonoma Architecture

The idealized funnel in the audit brief is **not** what runs.

### 2.1 Runtime sources

| Layer | Loaded? | Role |
|---|---|---|
| Inline IIFE in `index.html` ~42879–49261 | YES | Real send → `autProcess` → classify → execute → `_agentExecute*` |
| Phase-1 `AutonomaAgent` IIFE `index.html` 49271–50274 | YES | Overwrites `window.AutonomaAgent`; `tryHandle` intercepts chat |
| `shared/autonomaCore.js`, `autonomaNlu.js`, `autonomaLLM.js` | YES | Called from `autProcess` |
| `shared/autonomaAgent.js` | YES then **overwritten** | Workflows / `getAgentReply` — dropped after 50274 |
| `autonomaAgentBrain.js` | YES | Flag `AUTONOMA_AGENT_BRAIN_ENABLED` **default OFF** |
| `autonomaV2Integration.js`, `autonomaContactIntegration.js`, `autonomaScheduleRoute.js` | YES | Patch **`window.*` names that the chat IIFE never publishes** |
| `shared/autonoma/{Intent,Context,Memory}Engine.js` | Loaded via `autonoma/index.js` only if imported | **Not on chat send path** |
| `AutonomaPlugin.js`, `AutonomaAdapter.js` | Not in `index.html` script list | Not on chat send path |

`public/index.html` is a **build extract**. Audit of behavior uses **root `index.html`**. Tests that string-search `public/index.html` for `_agentExecuteBridge` are stale vs the extracted bundle.

### 2.2 Real runtime flow

```
USER
  │  Enter / Send / quick-card / file / LLM button
  ▼
CHAT UI  (index.html #aut-input → autonomaSend 42963)
  ▼
autonomaSendQuick 42968
  • persist autChats → AES-GCM localStorage elligentt_autonoma_chats
  • autUI user (escaped)
  • 500–1100ms delay
  • NO in-flight lock
  ▼
autProcess (IIFE local; wrapped at 47733 for [CONTACTS])
  │
  ├─ [0] [CONTACTS] prefix → batch card (default amount 100)     47733
  ├─ [1] AutonomaAgentBrain.run if FLAG true (default false)     43845
  ├─ [2] AutonomaLLM.ask if proxy up → HTML (may stop)           43862
  ├─ [3] AutonomaAgent.tryHandle (Phase-1, after overwrite)      43872
  ├─ [4] AutonomaNLU.decompose clarifications → HTML stop        43879
  ├─ [5] DocIntel command → autDocExecute                        43898
  ├─ [6] [csv] → autProcessCSV                                   43927
  ├─ [7] "send in N min" → ScheduleEngine.create (AUTO)          43941  ★
  ├─ [8] ≥2 addresses → MultiSend card → _agentExecuteOp click   43985
  ├─ [9] send w/o method → method picker                         44039
  ├─[10] AutonomaCore.process WORD_MAP → maybe _executeIntent    44074
  ├─[11] AutonomaIntelligence.preprocess rewrite/clarify         44097
  ├─[12] if _ctxActive → merge params → _executeIntent           44109
  ├─[13] _classifyIntent regex first-match                       44117
  └─[14] _executeIntent switch → HTML / side effects             44158
           │
           ├─ CREATE_PAYMENT_LINK → createPayLink() immediately  44291  ★
           ├─ SEND/SWAP/BRIDGE → cards + optional Agent button
           ├─ BATCH_SWAP fallback → await _agentExecuteOp        47137  ★
           └─ AGENT_ALLOW → unsigned localStorage grant          46318  ★
                    │
                    ▼  onclick / auto
           window._agentExecute*  (49249–49255)
                    │  NO claim, NO PolicyEngine, NO MS ledger
                    ▼
           AgentWalletManager.getSessionSigner
                    │
                    ▼
           signer.signTransaction + eth_sendRawTransaction
                    │
                    ▼
           waitForTransaction 60s → DROPPED (user can click again)

PARALLEL AUTONOMOUS PATH
  Chat / DocIntel / tryHandle / autonomaScheduleRoute
    → ScheduleEngine.create({ agentExecution:true, status:'Active' })
    → AgentScheduleExecutor tick 30s (auto-start 5s)
         • hasScheduledAuth (payment auth counts as scheduled)   ★
         • PolicyEngine catch → {ok:true}                        ★
         • claimExecution + ledger + MS-2/3/4 for ERC-20 payment
         • swap/bridge → _delegateExecution → _agentExecute* (MS gap)
```

`★` = financial side-effect without the idealized Policy→Approval→Claim chain.

### 2.3 Per-step table (canonical chat path)

| Step | File | Function | Caller | Callee | Input | Output | Mutation | Persist | Auth | Errors | Retry | Bypassable? |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| UI send | `index.html` 11030, 42963 | `autonomaSend` | DOM | `autonomaSendQuick` | textarea | — | clear input | no | none | return | no | yes (any `autonomaSendQuick`) |
| Queue | 42968 | `autonomaSendQuick` | send/cards/LLM | `autProcess` | string | HTML | `autChats[]` | AES-GCM LS | none | catch, no retry | no | double-click = two runs |
| Process | 43833 / 47733 | `autProcess` | sendQuick | many | string | HTML | `_ctx`, schedules, DOM | mixed | per-handler | fall-through | no | later stages skipped if earlier returns |
| LLM | `autonomaLLM.js` 298 | `ask` | autProcess | DeepSeek `/api/deepseek/chat` | msg | HTML/null | none | none | none | null → fallback | no | skipped if `_fastTrack` |
| Agent try | `index.html` 49499+ | `tryHandle` | autProcess | `ScheduleEngine.create` | msg | HTML/null | mem.tasks | LS + schedules | none | swallow | no | intercepts before regex |
| NLU | `autonomaNlu.js` 680 | `decompose` | autProcess | — | msg | entities | none | none | none | fall-through | no | skipped `_fastTrack` |
| Core | `autonomaCore.js` | `process` | autProcess | `_executeIntent` | msg | HTML / intent | core memory | `elligentt_core_memory_v1` | none | fall-through | no | can steal before regex |
| Classify | 43632 | `_classifyIntent` | autProcess | `_extractParams` | msg | `{intent,params}` | none | no | none | DEFAULT | no | first regex wins |
| Execute | 44158 | `_executeIntent` | autProcess/Core/_ctx | handlers | intent+params | HTML | `_ctx` cleared | handler-dep | **partial** `_isFinancialIntent` | handler | no | intents missing from financial list |
| Agent tx | 47924+ | `_agentExecuteOp` | onclick / batch / schedule delegate | ethers | op, amount | void | on-chain | AgentAudit after success | revalidate payment/swap only; fail-open | DROPPED on timeout | no auto | **global window** |
| Schedule | `agentScheduleExecutor.js` | tick / `_executeDue` | 30s timer | `_signAndSend` | due sched | status | ledger | LS ledger + claims | validateIntent + policy | timeout keeps submitted | reconcile, never rebroadcast (payment) | swap/bridge delegate out |

---

## 3. Chat Flow

### 3.1 Send path

- **DOM:** `#aut-input` Enter and `#aut-send-btn` call `autonomaSend()` (`index.html` 11030–11033, 42963–42966).
- **Quick cards / clarify buttons / LLM tool buttons** call `autonomaSendQuick(msg)` directly.
- Voice fills the textarea; it does **not** auto-send (41842–41952).
- File upload → `autonomaHandleFile` (43002) → DocIntel parse **or** `[CSV]` message.

### 3.2 Parsing

There is **no single parser**. Independent extractors:

| Parser | Location | Mechanism |
|---|---|---|
| AutonomaIntelligence.preprocess | 42543 / hooked 44101 | typo/synonym rewrite; may **rewrite the message** |
| AutonomaNLU.decompose | `autonomaNlu.js` 680 | entities + `intent_scores` |
| `_extractParams` | 43769 | regex amount/token/`0x{40}`/chains + NLU additive |
| `_parseMultiSendLines` | ~43620 | ≥2 addresses |
| AutonomaLLM | `autonomaLLM.js` 298 | remote model + tools |
| `_classifyIntent` | 43632 | ordered PT/EN/`alt` regex, first match, confidence 0.9/0.7 |

`AutonomaTemporal.preprocess` (42823) is **never called** from `autProcess`.

### 3.3 Intent

- **Primary:** first matching regex in `_classifyIntent`. Single intent only.
- **LLM** short-circuits the whole pipeline when available.
- **Core WORD_MAP** can convert a message to `{type:'intent'}` and call `_executeIntent` **before** `_classifyIntent`.
- **NLU** `intent_scores[]` exist but chat only uses `intent_type` for clarification halt.
- `MULTI_STEP_WORKFLOW` is one intent, not a fan-out.
- Agent Brain combines classify+NLU+policy **only if** `window.AUTONOMA_AGENT_BRAIN_ENABLED === true` (`autonomaAgentBrain.js` 36–38). Default **false**. Confirmed by `tests/autonoma-agent-brain.test.js`.

### 3.4 Ambiguity

- Missing amount/address → `_needsContext` + `_ctx` (5 min, **RAM only**) then next message **skips reclassify** and executes (44109–44113).
- Send without method → method picker (44039).
- Core low confidence → “Did you mean {goal}?” (autonomaCore.js 434).
- Intelligence ≥2 candidates → clarify HTML; 1 candidate → **rewrites text**.
- No ranking of competing financial intents (“swap and bridge”): **first matcher wins**.

### 3.5 Response generation

`autProcess` returns an **HTML string**. `autonomaSendQuick` injects it via `autUI('ai', r)` (`42925–42931`) using **`innerHTML` with no sanitizer**. User text is `esc()`’d; AI HTML is not. LLM text path uses `escHtml` (`autonomaLLM.js` 322). Regex/R-cards embed **inline `onclick`**.

### 3.6 Multiple handlers / duplicate processing

Yes, sequential until first return. Also:

- `autonomaSendQuick` has **no in-flight lock** → double Enter = two `autProcess`.
- LLM button → `autonomaSendQuick` again (`autonomaLLM.js` 394–395).
- NLU invoked twice on a full path (early halt + `_extractParams`).
- Brain (if enabled) can call `_executeIntent`; if `handled:false`, Core/regex can call it again.

### 3.7 Conceptual scenario results

| Scenario | Result |
|---|---|
| 1. Simple request | Regex or Core or LLM card. May execute (payment link / schedule) or offer Agent button. |
| 2. Ambiguous | Clarify / picker / `_ctx`. Next utterance executes **same intent** without reclassify. |
| 3. Multi-intent | **Not supported.** First pattern wins. |
| 4. Follow-up | Only if `_ctx` (5 min) or Core goal (5 min, persisted). Chat transcript **not** passed to classifier. |
| 5. Referring to previous message | Pronoun rewrite is Intelligence-only, not transcript-based. Classifier sees **current string only**. |
| 6. Wallet switch mid-chat | Chat history, grants, agent wallet **unchanged**. Core polls wallet every **15s** and only `resetGoal()` (`autonomaCore.js` 470–481). |
| 7. Network switch | Chat memory unchanged. Agent txs hardcode `chainId: 5042002`. |
| 8. Reload | `_ctx` lost. AES chats, core memory, agent auth, schedules restore. In-flight `_agentExecute*` has no resume/claim. |
| 9. Chat + manual | Independent. Manual `scheduleRun` uses **user wallet** + shared claim. Chat Agent path uses **agent key** with **no claim**. Same logical payment can be sent twice from two UIs. |
| 10. Chat + Schedule | Chat can **create** a schedule that the executor fires, **and** user can click Execute via Agent for the same instruction. |

---

## 4. Agent Flow

### 4.1 Two AutonomaAgent objects

| Object | File | API | Fate |
|---|---|---|---|
| Shared | `shared/autonomaAgent.js` 403 | `createWorkflow`, `getAgentReply`, `monitorTx` | Assigned `window.AutonomaAgent` at load |
| Phase-1 | `index.html` 49271 | `tryHandle`, `plan`, memory, `AUTO_EXECUTE_ENABLED=false` | **Overwrites** `window.AutonomaAgent` at 50274 |

Chat `autProcess` looks up **global** `AutonomaAgent` at **call time**, so after 50274 it uses Phase-1 `tryHandle`. Shared `getAgentReply` is **gone**. V2’s `__v2AgentEnhanced` wrap of `getAgentReply` is discarded with the object.

### 4.2 Lifecycle

| Stage | Implementation | Notes |
|---|---|---|
| Init | `AgentIdentity.loadIdentity`, `AgentWalletManager`, `AgentSession.load`, executor auto-start 5s | Identity capabilities are a **string list**, not a gate |
| Identity | `shared/agentIdentity.js` | ERC-8004 metadata; not consulted by `_agentExecute*` |
| Session | `agentSession.js` | 24h idle; **no user-wallet field** |
| Context | Brain `buildContext` | Brain **off** |
| Memory | many LS keys (see §7) | not wallet-scoped |
| Permissions | `AgentAuthorization` LS | unsigned; see §8 |
| Policy | `PolicyEngine` | schedule path only; throw → allow |
| Planning | cards / Phase-1 `plan()` / Brain `plan()` | Brain off; ExecutionPlanner money steps **simulated** (`executionPlanner.js` 146–150) |
| Tools | `_executeIntent` switch + Phase-1 tools | Phase-1 write tools `showPage` because `AUTO_EXECUTE_ENABLED=false` |
| Execution | `_agentExecute*` **or** `AgentScheduleExecutor` | two authorities |
| Verify | `waitForTransaction` / `AgentAudit` after success | timeout → DROPPED (chat) vs submitted (schedule payment) |
| Recovery | MS-3/MS-4 | **schedule payment only** |

### 4.3 Who has authority to execute?

**Cryptographic signer:** whoever holds the unlocked Agent Wallet session key (`AgentWalletManager.getSessionSigner` / RAM `_sessionPrivateKey`).

**Product policy:** intended to be `AgentAuthorization` + `PolicyEngine` + schedule hard gates.

**Actual authorities (independent):**

1. `window._agentExecuteOp` and siblings (chat / onclick / doc intel / batch fallback / schedule delegate).
2. `AgentScheduleExecutor._signAndSend` (scheduled ERC-20).
3. User wallet via Send/Swap/Bridge UI and `scheduleRun`.
4. `BatchExecutionEngine` for `createdBy === 'aiwallet'` multisend.

There is **no** unique execution authority.

---

## 5. Intent Architecture

- **Regex engine** (`_classifyIntent`) is the durable fallback and the Core/LLM/tryHandle short-circuits sit **above** it.
- Pattern order is financially meaningful: `CREATE_PAYMENT_LINK` is #1. `SWAP_GUIDE` matches bare “swap” unless guard. `QUERY_BALANCE` matches “wallet”. `CONTACT_OPERATION` can steal send-to-name if `RecipientResolver.resolve` hits.
- Core `WORD_MAP` (`autonomaCore.js`) is a **second classifier** with alias scoring.
- V2 intents (`FINANCIAL_PLAN`, `TREASURY_CHECK`, …) exist in `autonomaV2Integration.js` 73–109 but **never attach** (see §19).
- Brain canonicalization exists but is flag-gated off.

**Multiple intents in one message:** not executed as a list. First winner only.

---

## 6. Context Architecture

### Authoritative sources (intended vs used)

| Fact | Intended source | What Autonoma actually uses |
|---|---|---|
| Connected wallet | `walletAddress` / WalletStore | `walletAddress` global; FinancialContext `window.walletAddress`; **not** written into chat keys |
| Agent wallet | `AgentWalletManager.getAgentAddress()` | same + `AgentSession.agentWalletAddress` (can desync) |
| Active chain | `activeChainId` | Chat does not pin per conversation. Agent txs **hardcode 5042002**. Disconnect **forces 5042002** (`index.html` 15641) |
| Balances | on-chain | `#sb-bal` DOM (`autonomaCore.js` 93–96; `autonomaAgent.js` 190–206); `__FinancialBridge._portfolioSnapshot` RAM (no TTL, not cleared on switch) |
| Token addresses | `ElligenteContracts` | Fallback hardcoded Arc USDC `0x3600…0000` (`index.html` 47949; `autonomaAgent.js` 183; `agentScheduleExecutor.js` 44–47) |
| Permissions | AgentAuthorization | origin-global LS |
| Current schedule | ScheduleEngine | load **not filtered** by current wallet |
| Current task | `_ctx` / Core goal / AgentSession | three copies, different TTLs |
| Preferences | `elligentt_autonoma_agent` | origin-global |

### DOM as financial truth

```93:96:index.html
# via shared/autonomaCore.js getWorldState
var balEl = document.getElementById('sb-bal');
if(balEl) state.balances.USDC = balEl.textContent || '—';
```

`autonomaAgent.js` 190–206 uses `parseFloat(#sb-bal)` for low-balance and idle-funds **alerts**. On-chain `balanceOf` is fire-and-forget `.then` (185); the same tick still uses DOM.

Payment-link create **writes DOM form fields** then `createPayLink()` (44279–44293).

---

## 7. Memory Architecture

### Stores

| Key | Module | Scoped by |
|---|---|---|
| `elligentt_autonoma_chats` | chat IIFE | **none** (AES-GCM; key also unscoped) |
| `elligentt_autonoma_enc_key` | chat IIFE | **device/origin** (raw key bytes in LS) |
| `elligentt_core_memory_v1` | AutonomaCore | none (goal reset on wallet poll 15s) |
| `elligentt_autonoma_agent` | Phase-1 agent | none |
| `elligentt_finmem_v1` / `elligentt_finplans_v1` | FinancialMemory/Planner | none |
| `elligentt_workflows_v1` / `elligentt_alerts_v1` | shared AutonomaAgent | none |
| `elligentt_agent_session_v2` | **AgentSession AND AgentWalletManager** | **COLLISION** |
| `elligentt_agent_wallet_v2` | AgentWalletManager | none (not bound to user wallet) |
| `elligentt_agent_auth_v1` | AgentAuthorization | none (`grantedBy` stamped but not enforced on read) |
| `elligentt_policies_v1` | PolicyEngine | none |
| `elligentt_agent_sched_exec_v1` | schedule ledger | occurrence id, not user wallet |
| `elligentt_agent_sched_enabled_v1` | auto-exec | default **on** (`!== 'off'`) |
| `elligentt_agent_brain_pending_v1` | Brain | unused unless flag on |
| `arcpay_ub_memory` | Unified Balance | **wallet** (Autonoma does not use this) |
| IndexedDB `elligente_wallet` | internal wallet | not Autonoma chat |
| sessionStorage | — | unused by Autonoma |
| KV | wrangler AUTH/RATE_LIMIT | not Autonoma memory |

`AutonomaStore` (`shared/store/autonomaStore.js`) is in-memory only (lost on reload).

### Wallet A → Wallet B

**Yes. B inherits A.**

- Chat is a single global list (`AUT_KEY`, 42880). No `wallet` field.
- `WALLET_SWITCHED` (15702) only refreshes Unified Balance (37986–37993). **No Autonoma listener.**
- `disconnectWallet` (15638–15662) does **not** `removeItem` any Autonoma key. Chain forced to Arc.
- Agent Wallet key remains; B can spend **A’s agent funds** under **A’s grants**.

### Scenario matrix

| Event | Autonoma memory |
|---|---|
| Logout/disconnect | Kept |
| Reconnect same wallet | Full restore |
| Switch A→B | B sees A chats/goals/grants/contacts/agent wallet |
| Chain switch | Memory unchanged; agent still Arc |
| Reload | Persisted keys restore; `_ctx` lost |
| Private tab | Isolated (new origin storage) |
| Multiple tabs | Shared LS; last writer wins; **no** Autonoma BroadcastChannel (schedules **do** claim) |
| Multiple browsers | Isolated unless storage copied |

---

## 8. Authorization Architecture

File: [`shared/agentAuthorization.js`](../shared/agentAuthorization.js)

- Persistence: `elligentt_agent_auth_v1` (localStorage). Comment L3 “on-chain authorization” is **aspirational**. `signatureProof` optional (L89). Any same-origin JS can `createAuthorization`.
- Defaults on create (L74–82): `allowSwap/allowBridge/allowPayments/allowCrosschain = true`; `allowScheduled = false`.
- Chat grant `_handleAgentAllow` (index.html 46280–46318):
  - Parses ops from the message.
  - Sets mentioned flags **true**.
  - **Does not set the others false.**
  - Default amount 500, maxSpending `amount*10`, duration **7 days**, `allowedTokens/Networks ['*']`.
  - **No wallet signature.**
- `hasOperationAuth` (L341–344): any active auth with the boolean flag. **Does not** check spending/daily/recipient/time-window.
- `validateExecution` **does** check those, but `_agentRevalidateAuth` always passes `destination: ''` (47853–55) → **recipient allow-list never applied** on chat payments.
- `_agentCanExecute` (47874–47882): if `AgentAuthorization` missing → **`return true`** (fail-open). UI uses this to hide buttons; `window._agentExecuteOp` **does not call it**.
- `_executeIntent` permission card only if `_isFinancialIntent` **and** agent address exists. Missing intents (links, schedule, mass, batch swap, turbo, payroll) **skip the card**.

`hasScheduledAuth` (`agentScheduleExecutor.js` 259–268): `scheduled` **OR payment OR swap OR bridge**. Header L7 says `allowScheduled=true` is required. **Code does not require it.**

---

## 9. Policy Architecture

File: [`shared/policyEngine.js`](../shared/policyEngine.js)

- Defaults require simulation, risk, authorization (L19–25).
- Simulation rule **skipped** for `payment` and `swap` when `simulationHash` is null (L117–123).
- Used by `AgentScheduleExecutor._validatePolicy` (397–411).
- **If PolicyEngine throws → `{ ok: true }`** (411). Fail-open.
- **`_agentExecute*` never call PolicyEngine.**
- Brain `confirm()` re-runs `execute` **without** re-running policy (`autonomaAgentBrain.js` 752–759). Flag off, but the contract is wrong if enabled.

---

## 10. Tool Router

There is **no** unified tool router.

| Router | When | Tools |
|---|---|---|
| `_executeIntent` switch | After classify/Core/_ctx | ~40 intents |
| Phase-1 `plan()` / tools | `tryHandle` | `checkBalance`, `executeSwap/Bridge/Payment` → `showPage` (`AUTO_EXECUTE_ENABLED=false`) |
| AutonomaLLM TOOLS | If proxy up | Cards that call `autonomaSendQuick` again |
| DocIntel `executePlan` | File + command | Schedule create **or** loop `_agentExecuteBridge` |
| AIWallet.submitIntent | Batch swap / doc instant | Creates schedule / batch engine |

Phase-1 comment (49266–49268) says money is never auto-fired. **That is true only for Phase-1 `executeIntent`.** It is **false** for `tryHandle` schedule create, `autProcess` time-delay, payment links, doc intel, batch-swap fallback.

---

## 11. Execution Paths

### 11.1 Chat Agent broadcast (`index.html`)

| Function | Lines | Broadcast | Auth recheck | Policy | Claim/MS-2–4 |
|---|---|---|---|---|---|
| `_agentExecuteOp` payment | 47924–48019 | `eth_sendRawTransaction` 47974–75 | `_agentRevalidateAuth` 47972 | No | **No** |
| `_agentExecuteSwap` | 48189+ | yes | payment/swap only | No | No |
| `_agentExecuteBridge` | 48333+ | yes | `_agentPreValidate` only | No | No |
| `_agentExecuteTurboBridge` | 48611+ | yes | No revalidate | No | No |
| `_agentExecuteLiquidity` | 48795+ | yes | No | No | No |
| `_agentExecuteMultiSend` | 48951+ | approve + batch | preValidate | No | No |
| `_agentExecuteSchedule` | 49124–49213 | calls `_agentExecute*` | No claim | No | **Dead tick path** but still callable |

All assigned to `window` at 49249–49255. Callable from DevTools, injected scripts, leftover `onclick`.

Receipt timeout (47992–94): `_agentStateMsg(..., 'DROPPED')` then **return**. No “never rebroadcast”. User/tab can click again.

Hardcoded `chainId: 5042002` and USDC `0x3600…0000` on payment (47949–47960).

### 11.2 Schedule executor

[`shared/agentScheduleExecutor.js`](../shared/agentScheduleExecutor.js)

- MS-5 singleton (L27).
- Auto-enabled unless LS `'off'` (92–94).
- Claim `ScheduleEngine.claimExecution` (664–675).
- Payment path: prepare → persist intent → sign → persist txHash → wait → timeout keeps `submitted` (825–828) → MS-4 nonce reconcile.
- **Swap/bridge/crosschain: `_delegateExecution` → `window._agentExecute*`** (717–718, 1063–1086). Claim exists around the **delegate**, but the inner broadcast has **no intent ledger / fingerprint**. Inner timeout DROPPED can be retried while outer claim still held or later released.

### 11.3 User wallet

Default Autonoma cards “Open Send & Pre-fill”. Manual `scheduleRun` uses user wallet + **same claim key** so Agent and manual should not both run the same occurrence **if claim API is present**.

---

## 12. Schedule Integration

Autonoma creates schedules with `createdBy: 'autonoma'`, `agentExecution: true`, `status: 'Active'`:

| Creator | Location | Confirmation | `nextRun` |
|---|---|---|---|
| Time-delay send | `autProcess` 43957–43967 | **None** (message is the intent) | now + N min |
| Phase-1 `tryHandle` | 49580–49595 | **None** | parsed time |
| DocIntel scheduled | `autonomaDocumentIntelligence.js` 425–440 | command after file | `scheduleDate` or +60s |
| `autonomaScheduleRoute` | 16–26 | if patch attached (it is **not**) | **now** |
| AIWallet.executeIntent | `aiSmartWallet.js` ~754 | after AI Wallet validate | now |

Executor auto-starts 5s after load (`index.html` 49242–49246 + executor DOM start).

`isEligible` skips `createdBy === 'aiwallet'` multisend (246–248) — Batch engine owns those. Good split **if** claim is shared.

**Chat + Schedule race:** Chat “Execute via Agent” does **not** take a schedule claim. A scheduled copy of the same payment can still fire.

---

## 13. Agent Wallet Integration

[`shared/agentWalletManager.js`](../shared/agentWalletManager.js)

- Dedicated key, AES-GCM (`WALLET_KEY = elligentt_agent_wallet_v2`).
- Session ciphertext key **`elligentt_agent_session_v2`** — **same string** as `AgentSession.SESSION_KEY`.
  - `AgentSession.save()` writes **JSON** conversation (51–52).
  - Wallet manager expects `ENC6:` ciphertext (~553).
  - **Last writer corrupts the other.**
- Legacy `_agentGetPrivateKey` still reads **plaintext** `elligentt_agent_session_v1` (index.html 47789–47800).
- Auto-lock 30 min RAM. Restore races documented in comments (7B-9).
- `validatePreExecution` increments `executionCount` even if later broadcast fails.
- **Not bound to connected user wallet.** One Agent Wallet per origin.

Isolation vs user wallet: **cryptographic keys differ**. Operational isolation: **fails** (shared origin, shared auth, leftover v1, key collision, B inherits A).

---

## 14. Financial Execution Paths

Gate matrix: Y = enforced · N = not on path · P = partial · F = fail-open

| Path | Auth | Policy | Approval | Claim | Ledger | Dup/nonce | Wallet | Chain |
|---|---|---|---|---|---|---|---|---|
| Chat payment `_agentExecuteOp` | P revalidate; F if AA missing | N | UI click | N | N | N | Agent signer | Hardcoded 5042002 |
| Chat swap/bridge/LP/MS | P / preValidate | N | UI click | N | N | N | Agent | 5042002 / src id |
| Payment link create | wallet connected only | N | **None** | n/a | Store links | n/a | user | form DOM |
| Time-delay / tryHandle schedule create | N | N | **None** | later on tick | later | later | Agent on tick | Arc |
| DocIntel crosschain loop | inner preValidate | N | **None** (command) | N | N | N | Agent | 5042002 src |
| Batch swap fallback | `_agentCanExecute` UI | N | **None** (auto loop) | N | N | N | Agent | Arc |
| `_handleAgentAllow` | creates auth | N | chat text | n/a | LS | n/a | n/a | n/a |
| Schedule payment tick | Y | Y (throw→allow) | auto if enabled | Y | Y | Y MS-2–4 | Agent + balance | 5042002 |
| Schedule swap/bridge tick | Y then delegate | before delegate | auto | outer claim | outer | **inner No** | Agent | Arc source |
| BatchExecutionEngine | preValidate | N | instant intent | Y | own | claim, no fingerprint | Agent | 5042002 |
| Manual `scheduleRun` | connected wallet | N | user | Y | history | claim vs Agent | **User** | UI |
| Brain execute | if flag on | before confirm only | confirm | weak local | N | weak | router | N |

**Can Chat execute a financial tx?** Yes — Agent path on click; payment link and schedule create without that click; batch-swap and doc-crosschain can auto-broadcast.

**Can Agent execute without explicit authorization?** If AA module missing: yes (fail-open). If present: unsigned chat grant is enough; defaults are wide; scheduled path treats payment auth as scheduled.

---

## 15. Duplicate Execution Analysis

### What MS-2/3/4 actually cover

Proven on `AgentScheduleExecutor` + `ScheduleEngine.claimExecution` + tests:

- `tests/ms2-execution-integrity.test.js` — timeout after known hash never second broadcast
- `tests/ms3-failure-recovery.test.js` — terminal fail, multi-instance claim
- `tests/ms4-lost-transaction-recovery.test.js` — nonce reconcile, no blind retry
- `tests/ms5-executor-singleton.test.js` — second script eval skipped
- `tests/schedule-execution-claim.test.js` — cross-tab claim

Those tests load **`public/shared/agentScheduleExecutor.js`**, **not** `index.html` `_agentExecute*`.

### Autonoma connection — proven, not assumed

Autonoma **uses** MS protections **only** by creating a schedule the executor later ticks.

Autonoma **does not** wrap chat Agent broadcasts with `claimExecution` or `elligentt_agent_sched_exec_v1`.

Schedule swap/bridge **calls back** into `_agentExecute*` (`_delegateExecution`), so MS-4 fingerprint **does not** protect that inner send.

### Scenario results

| Scenario | Duplicate broadcast possible? |
|---|---|
| Chat + Agent (two clicks) | **YES** — no claim on `_agentExecute*` |
| Agent + Manual Send UI | **YES** — different wallets/paths, no shared id |
| Agent + Schedule | **YES** if chat also broadcasts; claim only on schedule occurrence |
| Autonoma + Schedule same create | Occurrence claimed for **schedule**; chat button is separate |
| Two browser tabs, chat execute | **YES** |
| Two Agent instances | MS-5 stops second **executor**; **not** second `_agentExecuteOp` |
| Reload during execution | Chat: no resume; user can retry → **YES**. Schedule payment: submitted persisted → **NO** (MS-2) |
| Receipt timeout | Chat DROPPED → retry **YES**. Schedule payment submitted → **NO** |
| RPC timeout before hash | both may retry; schedule should persist intent first (payment) |
| Wallet switch | Chat retry with same agent key **YES** |
| Network switch | Agent still Arc 5042002 |
| Browser crash after send, before persist | Schedule payment: MS-4. Chat: **YES** rebroadcast |
| Multiple messages same command | **YES** — no semantic idempotency on chat |
| V2 wrap stacking | V2 **not attached** to live `autProcess`; not a live dup source |
| ModuleLoader double-load | Executor singleton OK; other IIFEs may re-wrap (Financial Memory on `ScheduleEngine.create`) |

---

## 16. Persistence Analysis

See §7. Additional risks:

- Chat encryption key stored as **comma-separated raw key bytes** in LS (`43454–43461`). AES-GCM hides chats from casual glance, **not** from same-origin XSS or Wallet B on same browser profile.
- Encrypt failure → **plaintext fallback** (43472–43474).
- Auth history truncated to 50k chars (agentAuthorization.js 27).
- Schedule ledger capped 300 keys (executor 69–73).
- No server-side Autonoma memory; KV not used.

---

## 17. Wallet Isolation Analysis

**FAIL.**

Autonoma is origin-scoped, not wallet-scoped. Switching accounts does not:

- clear chats
- clear `_ctx` immediately (only Core goal on 15s poll)
- rotate Agent Wallet
- revoke authorizations
- filter schedules/contacts

`grantedBy` is stored but `getActive()` / `hasOperationAuth` do **not** require `grantedBy === walletAddress`.

---

## 18. Chain Isolation Analysis

**FAIL for Agent execution.**

- Agent payment/swap/LP/MS hardcode `chainId: 5042002`.
- `ARC_RPC` / `https://rpc.testnet.arc.network` fallbacks (`agentWalletManager.js` 20–21; `_agentGetProvider` 47836–47846).
- Brain receipts force `chainId: 5042002` (`autonomaAgentBrain.js` ~501–504).
- Disconnect resets `activeChainId = 5042002`.
- Bridge path uses `sourceChainId` argument (better), but CCTP patch race can miss inbound wrap (see §19).
- Token USDC address is Arc placeholder, not selected per chain.

Chat **context** can mention Base/Arbitrum; **broadcast** still tends to Arc unless the specific bridge function is used.

---

## 19. V2 / Monkey-Patching Analysis

### Script order (`index.html` 47–153 then inline)

1. `autonomaConsolidation.js` — wraps `AutonomaCore.process` (retries)
2. `autonomaScheduleRoute.js` — waits for `window._handleMassPayment` (**never exported**; handler is IIFE-local 47192)
3. `moduleLoader.js` + `remediation/bootstrap.js` → `ModuleLoader.init()` **re-injects** DEFERRED scripts (`autonomaCore`, `autonomaAgent`, `agentSession`, `agentScheduleExecutor`, …) because `loaded{}` starts empty and **does not inspect existing `<script>` tags** (moduleLoader.js 110–137, 230–239)
4. Shared modules including V2, Contacts, CCTP
5. Inline `autProcess` / `_classifyIntent` / `_executeIntent` — **locals, never `window.*`**
6. `[CONTACTS]` wraps **local** `autProcess` (47732) — this wrap **is live**
7. `window._agentExecuteBridge = …` at 49251 (after CCTP’s poll may have already run)
8. `window.AutonomaAgent =` Phase-1 at 50274

### V2 (`autonomaV2Integration.js`)

`waitForDeps` requires `window._classifyIntent` (25–26). **Nothing assigns it** except V2 itself. After 60×200ms, V2 **gives up**.

If it ever attached:

- `enhanceClassifyIntent` treats any truthy object `!== 'UNKNOWN'` as success (66–67). Real classifier returns `{intent, confidence, params}` — V2 intents would **never** apply.
- `autProcess` wrap has **no once-flag** (unlike `getAgentReply` `__v2AgentEnhanced`).

**Live chat is not intercepted by V2.** Duplicate execution from V2 stacking is **not currently live**. Dead code remains a footgun if someone assigns `window._classifyIntent`.

### Contacts patch

Waits for `window.autProcess`. Real function is closed-over. **Dead.** Local `[CONTACTS]` wrap is the real contacts path.

### CCTP inbound (`AutonomaCCTPV2Integration.js` 20–37)

Once-flag `__agentExecuteBridgeOriginal` is correct. Race: patch polls before 49251 assign; inline then **overwrites unpatched** function → inbound route **bypassed**. If patch runs after assign, wrap works.

### Consolidation / Financial Memory

`ScheduleEngine.create` hook in Financial Memory has **no once-flag**; ModuleLoader can wrap twice (double memory records, not double chain send by itself).

---

## 20. Error & Recovery Analysis

| Failure | Chat `_agentExecute*` | Schedule payment | Schedule swap/bridge delegate |
|---|---|---|---|
| RPC fail before broadcast | FAILED, return; user can retry | retry_pending / no send | same as chat inner |
| RPC fail after broadcast, hash known | DROPPED; retry can **second send** | `submitted`, never resend | inner DROPPED; outer may mark executed if return not `ok:false` |
| `sendRawTransaction` throws | FAILED/REJECTED | catch → retry_pending | delegate catch → failed |
| Hash known, receipt timeout | DROPPED | submitted + reconcile | inner DROPPED |
| Hash unknown | user retry | MS-4 nonce fingerprint | no inner fingerprint |
| Revert | REVERTED | terminal failed, pause | depends on return shape |
| Reload mid-flight | lost; retry | ledger survives | mixed |
| Close browser | same | same | same |
| Wallet change | agent key unchanged | same | same |
| Network change | still 5042002 | still Arc | still Arc |
| Agent crash | no lock | claim/ledger | claim outer |
| Chat crash | no lock | n/a | n/a |
| Schedule crash | n/a | MS-3/4 | inner unprotected |

`autonomaStop` (43067) sets `_agentStopRequested` and clears `autPendingOps`. It does **not** abort a signed tx already broadcast. `_agentStopCheck` is sampled at a few points, not as a mutex across tabs.

`_delegateExecution` records usage as `'delegated'` **before** the inner call (1080). If inner returns `undefined` (many `_agentExecute*` paths `return;` on failure **without** `{ok:false}`), outer may treat it as success (1097 checks explicit false).

---

## 21. Test Coverage

### What exists

| File | Covers | Does not cover |
|---|---|---|
| `tests/autonoma-agent-brain.test.js` | Brain lifecycle vs stubs; flag default OFF | `autProcess`, wallet isolation, real `_executeIntent` |
| `tests/agent-schedule-executor.test.js` | Agent schedule exec, auth limits, chain, sequential MS | Chat send path |
| `tests/ms2/ms3/ms4/ms5-*.test.js` | Schedule integrity | `_agentExecute*` |
| `tests/schedule-execution-claim.test.js` | Cross-tab claim | Chat |
| `tests/agent-swap-crosschain.test.js` | **String search of `public/index.html`** | Functions extracted to bundles — **stale** |
| `tests/FinancialSmokeTests.js` `testAutonoma` | `typeof AutonomaCore` | behavior |
| UB tests | wallet-keyed UB cache | Autonoma keys |

### Missing (all required by this audit)

- Chat → execution (`autonomaSend` → `autProcess` → `_executeIntent` → `_agentExecuteOp`)
- Multi-intent messages
- Wallet isolation of chats/auth/agent key
- Memory isolation A→B
- Chat duplicate execution / no in-flight lock
- Cross-tab `_agentExecute*`
- Reload/resume of chat Agent txs
- Receipt timeout on `_agentExecute*`
- Lost tx on chat path
- Policy bypass on chat path
- Authorization bypass (`_handleAgentAllow` unsigned; fail-open)
- Chat + Schedule race
- Agent + manual race
- Agent + Autonoma race
- Wallet/network switch during chat
- Monkey-patch duplication / ModuleLoader double-load
- `elligentt_agent_session_v2` collision
- `_isFinancialIntent` omissions
- Payment link auto-create
- DocIntel auto `_agentExecuteBridge`
- Batch-swap fallback auto-exec
- V2 dead-patch / CCTP race
- XSS `autUI` innerHTML
- `hasScheduledAuth` payment≡scheduled

---

## 22. Critical Risks

### A-1 — Dual execution authorities; chat bypasses MS-2/3/4

- **Severity:** Critical
- **File/Function:** `index.html` `_agentExecuteOp` 47924; `window` export 49249; contrast `agentScheduleExecutor.js` 664–828
- **Current:** Chat Agent broadcasts with no claim/ledger/fingerprint.
- **Expected:** One execution authority; every financial broadcast through claim + intent persist.
- **Risk:** Double spend on timeout, reload, two tabs, Chat+Schedule.
- **Evidence:** 47992–94 DROPPED return; no `claimExecution` in `_agentExecute*`; MS tests do not load these functions.
- **Existing test:** none for chat path. MS-2 covers executor only.
- **Missing test:** timeout + second `_agentExecuteOp` call must not send twice.
- **Fix:** Route all Agent broadcasts through `AgentScheduleExecutor` (or shared claim+ledger). **Architecture change: yes.**

### A-2 — Unsigned localStorage authorization; fail-open

- **Severity:** Critical
- **File/Function:** `agentAuthorization.js` `createAuthorization` 49–93; `_handleAgentAllow` 46280; `_agentCanExecute` 47874
- **Current:** Chat text creates 7-day auth; defaults allow payments/swap/bridge/crosschain; missing AA module → execute allowed.
- **Expected:** Wallet-signed grant; deny-by-default; fail-closed.
- **Risk:** XSS or Wallet B spends Agent funds.
- **Evidence:** no `signatureProof` required; 47882 `return true`.
- **Existing test:** schedule auth tests; **not** chat grant.
- **Missing test:** grant without signature must not enable broadcast; AA undefined must deny.
- **Fix:** EIP-712 grant; bind to `walletAddress`; fail-closed. **Architecture change: yes.**

### A-3 — Autonoma memory not isolated by wallet; Agent Wallet shared

- **Severity:** Critical
- **File/Function:** `index.html` 42880, 43464; `disconnectWallet` 15638; `WALLET_SWITCHED` 37986 (UB only)
- **Current:** Wallet B inherits chats, grants, agent key, contacts, schedules.
- **Expected:** All Autonoma state keyed by user wallet (and chain where relevant).
- **Risk:** Cross-account data leak and **cross-account spend**.
- **Evidence:** no Autonoma listener on `WALLET_SWITCHED`; disconnect does not scrub keys.
- **Existing test:** none.
- **Missing test:** A chat → switch B → B must not see A chats/auth/agent key.
- **Fix:** namespace keys; on switch, lock agent + clear session. **Architecture change: yes.**

### A-4 — `elligentt_agent_session_v2` key collision + leftover plaintext v1

- **Severity:** Critical
- **File/Function:** `agentSession.js` 10, 51–52; `agentWalletManager.js` 18; `_agentGetPrivateKey` 47789
- **Current:** Conversation JSON vs encrypted session key share one LS key; v1 privateKey still readable.
- **Expected:** Distinct keys; no plaintext private keys in LS.
- **Risk:** Lost session **or** leaked key.
- **Evidence:** identical string `elligentt_agent_session_v2`; v1 parse at 47793.
- **Existing test:** none.
- **Missing test:** AgentSession.save must not clobber wallet ciphertext; v1 key must not be readable after migration.
- **Fix:** rename session key; delete v1; single key reader. **Architecture change: yes (key migration).**

### A-5 — Chat can auto-create Active agent schedules and auto-broadcast

- **Severity:** Critical
- **File/Function:** `autProcess` 43941–43967; `tryHandle` 49580–49595; `autonomaDocumentIntelligence.js` `executePlan` 444–451; `_handleBatchSwap` 47137–139; `_handleCreatePaymentLink` 44291
- **Current:** Natural-language “send in 10 minutes” persists `agentExecution:true`. DocIntel crosschain **loops** `_agentExecuteBridge`. Batch swap **awaits** `_agentExecuteOp` if AIWallet submit fails. Payment link `createPayLink()` immediately.
- **Expected:** No financial mutation without explicit approval + policy + claim.
- **Risk:** Unintended payroll/bridge/link creation; autonomous spend once executor ticks (default **on**).
- **Evidence:** cited lines; `isAutoEnabled` default true (executor 92–94).
- **Existing test:** none for these chat side-effects.
- **Missing test:** those phrases must not persist Active agent schedules without confirm; doc loop must not call `_agentExecuteBridge` without approval.
- **Fix:** confirm cards; default auto-exec off; remove auto-broadcast fallbacks. **Architecture change: partial.**

### A-6 — `hasScheduledAuth` treats payment/swap/bridge as scheduled permission

- **Severity:** Critical
- **File/Function:** `agentScheduleExecutor.js` 259–268 vs header L7
- **Current:** `allowPayments` (default true on any grant) enables the 30s autonomous tick.
- **Expected:** `allowScheduled===true` only.
- **Risk:** User who allowed “send payments” gets unattended scheduled execution.
- **Evidence:** 263–266.
- **Existing test:** executor tests may not assert scheduled flag exclusivity.
- **Missing test:** auth with only `allowPayments` must **not** pass `hasScheduledAuth`.
- **Fix:** require `allowScheduled`. **Architecture change: no** (behavioral tightening).

---

## 23. High Risks

### A-7 — `_isFinancialIntent` incomplete

- **Severity:** High
- **File/Function:** `index.html` 45244–45246
- **Current:** Only SWAP/BRIDGE/SEND/MULTISEND/LIQUIDITY. Omits `CREATE_PAYMENT_LINK`, `CREATE_SCHEDULE`, `MASS_PAYMENT`, `BATCH_SWAP`, `BRIDGE_TURBO`, `CROSSCHAIN_PAYROLL`, `EXECUTE_SCHEDULES`, `EXECUTE_ALL_SCHEDULES`.
- **Expected:** All money-moving intents gated.
- **Risk:** Permission card skipped.
- **Evidence:** switch 44176–44235 vs list 45245.
- **Missing test:** each omitted intent with no auth must not execute.
- **Fix:** expand list / use allow-list of non-financial. **Arch change: no.**

### A-8 — PolicyEngine not on chat path; schedule catch-all allow

- **Severity:** High
- **File/Function:** `_agentExecute*`; `_validatePolicy` 411
- **Current:** Chat never calls policy; schedule `catch → ok:true`.
- **Expected:** Deny on policy error; every broadcast.
- **Fix:** fail-closed; call from one authority. **Arch change: yes.**

### A-9 — Recipient allow-list bypassed (`destination: ''`)

- **Severity:** High
- **File/Function:** `_agentRevalidateAuth` 47853–55; `validateExecution` 185–188
- **Current:** Empty destination skips allow-list.
- **Expected:** Payment dest always checked.
- **Fix:** pass real address. **Arch change: no.**

### A-10 — ModuleLoader double-loads already-tagged scripts

- **Severity:** High
- **File/Function:** `moduleLoader.js` 110, 230; `bootstrap.js` 33; `index.html` 59–60 + 79–153
- **Current:** Second copies of core Autonoma modules.
- **Risk:** stacked wraps, reset of `_installed` flags, two memory hooks. Executor has singleton; others mostly do not.
- **Fix:** detect existing scripts or remove duplicate tags. **Arch change: load-order.**

### A-11 — Two AutonomaAgent implementations; overwrite drops workflows/getAgentReply

- **Severity:** High
- **File/Function:** `shared/autonomaAgent.js` 403; `index.html` 50274
- **Current:** Global replaced; V2 agent enhance discarded.
- **Risk:** Dead security UX; confusing tests.
- **Fix:** compose, don’t overwrite. **Arch change: yes.**

### A-12 — CCTP inbound patch vs `_agentExecuteBridge` assign race

- **Severity:** High
- **File/Function:** `AutonomaCCTPV2Integration.js` 20–37; `index.html` 49251
- **Current:** Possible unpatched inbound.
- **Fix:** patch after assign or wrap inside IIFE. **Arch change: no.**

### A-13 — DOM / stale cache as balance truth

- **Severity:** High
- **File/Function:** `autonomaCore.js` 93–96; `autonomaAgent.js` 190–206; `financialContext.js` snapshot
- **Current:** `#sb-bal` and RAM snapshot used as USDC.
- **Expected:** on-chain / UB engine only.
- **Fix:** remove DOM financial reads. **Arch change: no.**

### A-14 — Hardcoded chain 5042002 / USDC on Agent path

- **Severity:** High
- **File/Function:** `_agentExecuteOp` 47949–47960; wallet manager 20–21
- **Risk:** wrong-chain send; mainnet confusion if RPC swapped without chainId change.
- **Fix:** resolve from `ElligenteContracts` + active chain; refuse mismatch. **Arch change: no.**

### A-15 — AI HTML `innerHTML` (XSS → A-2)

- **Severity:** High
- **File/Function:** `autUI` 42925–42931
- **Current:** AI HTML unsanitized. LLM path escaped; regex cards trusted. If any handler interpolates user/LLM unsafely, XSS can call `createAuthorization` / `_agentExecuteOp`.
- **Fix:** sanitize; no inline onclick; event delegation. **Arch change: partial.**

### A-16 — `_delegateExecution` success if inner returns undefined

- **Severity:** High
- **File/Function:** `agentScheduleExecutor.js` 1080–1097; `_agentExecute*` bare `return`
- **Risk:** schedule marked executed / usage recorded without a tx.
- **Fix:** require `{ok:true, txHash}`; don’t record usage before success. **Arch change: no.**

### A-17 — No in-flight lock on `autonomaSendQuick`

- **Severity:** High
- **File/Function:** 42968–43000
- **Risk:** double process, double schedule create, double cards.
- **Fix:** mutex per chat. **Arch change: no.**

---

## 24. Medium Risks

| ID | Issue | Where | Risk |
|---|---|---|---|
| A-18 | V2/Contacts/ScheduleRoute dead patches | v2 25; contacts wait `window.autProcess`; scheduleRoute 41 | Future attach = wrong return types / stacked wraps |
| A-19 | Classifier first-match; no multi-intent | `_classifyIntent` 43746 | Wrong financial action |
| A-20 | `_ctx` skip reclassify 5 min | 44109 | Follow-up executed as old intent after wallet/chain change |
| A-21 | Core wallet poll 15s only | autonomaCore 473 | Stale goal across switch |
| A-22 | Contacts `[CONTACTS]` amount fallback `\|\| 100` | 47748 | Unexpected 100 USDC card |
| A-23 | Payment link default amount 10 | 44254 | Silent default |
| A-24 | `ExecutionCoordinator` unused | shared | Dead 60s dedup |
| A-25 | `AUTO_EXECUTE_ENABLED=false` false sense of safety | 49274 | Other paths still execute |
| A-26 | Chat encrypt key in LS | 43461 | Same-origin decrypt |
| A-27 | NLU/LLM/Core/regex disagreement | autProcess order | Flaky UX; hard to test |
| A-28 | `public/index.html` tests stale vs bundles | `agent-swap-crosschain.test.js` | False CI green/red |
| A-29 | Brain `confirm` skips policy | brain 752 | If flag enabled |
| A-30 | `validatePreExecution` counts failed ops | wallet manager ~1553 | Quota DoS / false reputation |
| A-31 | Agent stop doesn’t cancel in-flight broadcast | 43067 | User thinks they stopped a tx |
| A-32 | Schedules not filtered by wallet on load | ScheduleEngine | B sees A automations |
| A-33 | IntentEngine/ContextEngine/MemoryEngine unused | `shared/autonoma/` | Dual architecture confusion |

---

## 25. Low Risks

| ID | Issue |
|---|---|
| A-34 | `AutonomaTemporal` never called |
| A-35 | FinancialContext.record/augment APIs missing vs FinancialMemory hooks (dead learning) |
| A-36 | SharedCache 30s TTL not wallet-namespaced (UB separate) |
| A-37 | Help/greeting regex can collide with later financial patterns (order currently protects most) |
| A-38 | Voice does not auto-send (safe; UX only) |
| A-39 | Duplicate `shared/` vs `public/shared/` copies — build sync risk |
| A-40 | `_agentExecuteSchedule` leftover callable |

---

## 26. Mainnet Readiness

| Surface | Classification | Why |
|---|---|---|
| **A. Chat only** (no Agent Wallet, no schedule auto) | **CONDITIONALLY READY** | XSS innerHTML, no wallet isolation, payment-link auto-create, unsigned grants if agent exists. Usable on testnet as copilot if Agent Wallet locked and auto-exec off. |
| **B. Read-only Agent** | **CONDITIONALLY READY** | DOM balances, stale snapshot, Brain off, dual AutonomaAgent. Do not treat alerts as financial truth. |
| **C. Agent with approval** | **NOT READY** | Approval is a UI button, not a signed intent. `window._agentExecute*` callable without that UI. Financial-intent list incomplete. |
| **D. Agent Wallet** | **NOT READY** | Keys exist and can be encrypted, but: session key collision, v1 plaintext, not bound to user wallet, fail-open auth, hardcoded Arc. |
| **E. Autonomous financial execution** | **CRITICAL / NOT SAFE** | Default auto-tick ON; payment auth ⇒ scheduled auth; chat creates Active agent schedules; chat broadcasts bypass MS-2/3/4; two authorities. |

Do not treat passing MS-2–5 tests as Autonoma safety. Those tests **do not execute the chat Agent path**.

---

## 27. Recommended Fix Phases

**Do not implement in this phase.** Suggested sequence:

### Phase AUTONOMA-0 — Containment (no product features)

1. Fail-closed `_agentCanExecute` / `_agentRevalidateAuth`.
2. `hasScheduledAuth` requires `allowScheduled===true`.
3. Default `elligentt_agent_sched_enabled_v1 = off` until explicit opt-in.
4. Remove/disable DocIntel auto `_agentExecuteBridge` and batch-swap `_agentExecuteOp` fallback.
5. Stop exporting `_agentExecute*` or wrap them with claim+auth+policy.
6. Rename `AgentSession` LS key; purge v1 privateKey.
7. Expand `_isFinancialIntent`.
8. Pass real `destination` into `validateExecution`.

### Phase AUTONOMA-1 — Single execution authority

1. All Agent broadcasts through `AgentScheduleExecutor` (instant = schedule `nextRun: now` + claim).
2. Delete or deprecate `_agentExecuteSchedule` leftover.
3. Delegate swap/bridge must not call unprotected inner send (or inner must use same ledger).
4. Require `{ok, txHash}` from every broadcast.

### Phase AUTONOMA-2 — Isolation

1. Namespace all Autonoma LS keys by `walletAddress` (+ agent id).
2. On `WALLET_SWITCHED` / disconnect: clear `_ctx`, lock agent, do not leak chats.
3. Bind authorizations to `grantedBy` + signature.
4. Filter schedules by wallet.

### Phase AUTONOMA-3 — Chat correctness

1. One classifier; remove dead V2 patches or actually wire them with once-guards and compatible return types.
2. In-flight send lock.
3. Sanitize `autUI`.
4. Stop DOM balance reads.
5. Confirm cards for schedule create and payment links.
6. Fix ModuleLoader double-load.
7. Compose AutonomaAgent instead of overwrite.

### Phase AUTONOMA-4 — Tests that match production

1. Boot `autProcess` from `index.html` source (not missing public inline).
2. Matrix: chat+schedule, two tabs, timeout, A→B wallet, unsigned grant, fail-open, MS connection proof for **chat**.
3. Fix stale `public/index.html` string tests.

---

## Findings index (required fields compact)

Every finding above includes ID, severity, file, function, location, current vs expected, risk, evidence, tests, fix, architecture-change flag.

---

## 15. Most important final questions

| # | Question | Answer |
|---|---|---|
| 1 | Can Chat directly execute a financial transaction? | **YES.** Payment link `createPayLink()` (44291). Time-delay and `tryHandle` persist Active agent schedules. Click “Execute via Agent” → `eth_sendRawTransaction`. DocIntel crosschain and batch-swap fallback can broadcast without a second card. |
| 2 | Can Autonoma Agent execute without explicit authorization? | **YES if** `AgentAuthorization` is undefined (fail-open 47882). **YES in practice** with unsigned chat grant (`_handleAgentAllow`). Cryptographic key in RAM is sufficient for `_agentExecute*` (payment/swap revalidate; bridge/LP/MS weaker). |
| 3 | Can Agent bypass Policy? | **YES.** `_agentExecute*` never call `PolicyEngine`. Schedule path catch → `{ok:true}` (411). |
| 4 | Can Agent bypass Approval? | **YES.** Schedule tick has no per-tx click (auto default ON). DocIntel/batch-swap/schedule-create have no signed approval. `window._agentExecuteOp` ignores the UI button. |
| 5 | Can Agent bypass MS-2/MS-3/MS-4? | **YES on the live chat path.** Those protections live in `AgentScheduleExecutor` payment flow. Chat `_agentExecute*` does not call them. Schedule swap/bridge **delegates into** the unprotected functions. |
| 6 | Can two Autonoma instances execute the same operation? | **YES for chat Agent txs** (two tabs, no claim). **NO for a given schedule occurrence** if `claimExecution` works (MS-2/5). Two instances can still each create **new** schedules from the same chat text. |
| 7 | Can Chat + Agent execute the same operation twice? | **YES.** No shared idempotency key between `autProcess` and `_agentExecute*`. Double send / double click / LLM resend. |
| 8 | Can Agent + Schedule execute the same operation twice? | **YES** if chat broadcasts **and** a schedule was created for the same intent. Claim protects the **schedule occurrence**, not the chat broadcast. Manual `scheduleRun` shares claim with executor for that occurrence only. |
| 9 | Can memory from Wallet A leak into Wallet B? | **YES.** Origin-global chats, grants, contacts, core memory, agent wallet, schedules. |
| 10 | Can context from Chain A leak into Chain B? | **YES.** Chat `_ctx` and Core goal are not chain-keyed. Agent execution **forces Arc 5042002** regardless of UI chain. |
| 11 | Can the Agent use stale/DOM financial data? | **YES.** `#sb-bal`, `__FinancialBridge._portfolioSnapshot` (no TTL / no switch invalidation). |
| 12 | Can V2 cause duplicate execution? | **Not on the live path** — V2 never attaches to IIFE `autProcess`. **If wired naively**, classify wrap + no once-flag + wrong return-type check would be dangerous. ModuleLoader can still stack **other** wraps. |
| 13 | Can reload cause duplicate execution? | **YES on chat Agent path** (DROPPED / lost in-flight). **NO on schedule payment** if hash was persisted (MS-2). |
| 14 | Can receipt timeout cause duplicate execution? | **YES chat** (DROPPED). **NO schedule payment** (submitted + reconcile). **YES inner** swap/bridge delegate. |
| 15 | Can lost transaction state cause duplicate execution? | **YES chat** (no fingerprint). **NO schedule payment** (MS-4). **YES inner delegate.** |
| 16 | Is the Agent Wallet truly isolated from the user's wallet? | **Cryptographically different keys: YES. Operationally isolated: NO.** Not bound to user wallet; B uses A’s agent; v1 plaintext leftover; session key collision; same origin. |
| 17 | Is every financial operation protected by Policy + Authorization? | **NO.** |
| 18 | Is autonomous financial execution MAINNET READY? | **NO. CRITICAL / NOT SAFE.** |

---

## OVERALL AUTONOMA STATUS

**CRITICAL / NOT SAFE** for autonomous or Agent-signed financial execution.

| Mode | Status |
|---|---|
| Chat only (copilot, Agent Wallet locked, schedule auto-exec off) | CONDITIONALLY READY |
| Read-only Agent | CONDITIONALLY READY |
| Agent with approval | NOT READY |
| Agent Wallet | NOT READY |
| Autonomous financial execution | **CRITICAL / NOT SAFE** |

---

*End of AUTONOMA-AUDIT-1. No application files were modified. No commit. No push.*
