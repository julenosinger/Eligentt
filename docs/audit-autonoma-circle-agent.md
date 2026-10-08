# Relatório de Auditoria — Autonoma & Circle Agent Wallet
**Data:** 07/10/2026  
**Escopo:** Read-only. Nenhum código foi alterado.  
**Arquivos analisados:**
- `functions/api/agent/[[path]].js`
- `functions/api/agent-signer/authorize.js`
- `functions/api/agent-signer/broadcast.js`
- `functions/api/agent-signer/_circle.js`
- `shared/autonomaCore.js`
- `shared/aiSmartWallet.js`

---

## 1. ARQUITETURA GERAL

### Camadas (backend)

```
Browser
  ↓
GET  /api/agent/status|balance|transactions   → agent/[[path]].js   (read-only)
POST /api/agent-signer/authorize              → authorize.js         (emite proof)
POST /api/agent-signer/broadcast              → broadcast.js         (executa via Circle)
                                              → _circle.js           (primitivas Circle API)
```

### Camadas (frontend)

```
Autonoma (chat NLU)   → AutonomaCore.process() → intent
                      ↓
AIWallet.submitIntent() → validateIntent() → executeIntent()
                      ↓
ScheduleEngine.create() → _agentCheckSchedules() tick
                      ↓
SecureSignerProvider.broadcast() → POST /api/agent-signer/authorize → broadcast
```

---

## 2. ESTADO ATUAL: O QUE ESTÁ CORRETO

### Backend — segurança de execução

| Item | Estado |
|---|---|
| Proof HMAC com expiração curta (authorize → broadcast) | ✅ Implementado |
| Binding completo: executionId + chainId + operation + walletId + contractAddress + ABI + params | ✅ Implementado |
| Single-use (replay do proof bloqueado via KV) | ✅ Implementado |
| Circuit breaker antes de qualquer operação Circle | ✅ Implementado |
| Emergency pause server-side | ✅ Implementado |
| Allowlist de contratos (SIGN_ALLOWLIST — 14 endereços) | ✅ Implementado |
| Validação ABI function signature (regex + allowlist) | ✅ Implementado |
| Idempotência de executionId | ✅ Implementado |
| Nonce lock server-side (evita double-submission) | ✅ Implementado |
| Rate limiting por IP + executionId | ✅ Implementado |
| Audit trail completo (cada execução registrada) | ✅ Implementado |
| Secrets nunca expostos ao browser | ✅ Correto |
| CORS restrito a ALLOWED_ORIGINS | ✅ Implementado |

### Per-user wallet (implementado nesta sessão)

| Item | Estado |
|---|---|
| createUserWallet() — provisiona wallet Circle por usuário no registro | ✅ Implementado |
| resolveUserWallet() — lê session → user → circleWalletId do KV | ✅ Implementado |
| Fallback gracioso para CIRCLE_WALLET_ID global (usuários sem wallet ainda) | ✅ Correto |
| getUserCredentials() — creds por usuário ou global | ✅ Implementado |
| provision.js — endpoint idempotente para provisionar wallet retroativamente | ✅ Implementado |

### AIWallet (frontend)

| Item | Estado |
|---|---|
| Emergency Stop scope: só automações AIWallet, não o app inteiro | ✅ Correto |
| validateIntent() com 13 estágios antes de qualquer execução | ✅ Correto |
| Re-validação completa imediatamente antes de executeIntent() | ✅ Correto |
| Nonce com componente de timestamp (anti-replay por localStorage) | ✅ Correto |
| Deadline com expiração (15min default) | ✅ Correto |
| Balance check via RPC antes de aprovar intent | ✅ Correto |
| Gas reserve check (minReserve = 1 USDC) | ✅ Correto |
| Mode: personal / ai / hybrid (default: hybrid) | ✅ Correto |
| Vault allocation: internal ledger; nunca excede saldo real | ✅ Correto |
| Auto Top-Up: política manual — nunca automático sem aprovação | ✅ Correto |
| Funding (deposit/withdraw/transfer): usa on-chain real, sem mocks | ✅ Correto |

---

## 3. PROBLEMAS IDENTIFICADOS

### P1 — CRÍTICO: `createUserWallet` provisiona blockchains de TESTNET

**Arquivo:** `functions/api/agent-signer/_circle.js`, linha 402  
**Código atual:**
```js
blockchains: ['ARB-SEPOLIA', 'ETH-SEPOLIA', 'MATIC-AMOY', 'SOL-DEVNET'],
```
**Problema:** O app roda em **Arc Mainnet** (chainId 5042). As wallets por usuário estão sendo criadas em testnets. Quando `resolveUserWallet()` retorna `user.circleWalletAddress` de uma wallet testnet para uso em mainnet, todas as operações falham silenciosamente (endereço não tem fundos, transações rejeitadas).  
**Impacto:** Todos os novos usuários registrados recebem uma wallet Circle inutilizável no contexto de produção.  
**Fix necessário:** Substituir pela chain de produção. Circle usa `ARC` como chave de blockchain para Arc Mainnet. Verificar a chave exata na [documentação Circle](https://developers.circle.com/api-reference/wallets/create-wallets).

---

### P2 — CRÍTICO: `CANONICAL_CIRCLE_WALLET` hardcoded em dois lugares

**Arquivos:**  
- `functions/api/agent-signer/_circle.js`, linha 29: `const CANONICAL_CIRCLE_WALLET = '0x794eb2f43a333e9eab9731d8f5e5423d5ec628eb'`  
- `shared/aiSmartWallet.js`, linha 201: `const CANONICAL_CIRCLE_WALLET = '0x794eb2f43a333e9eab9731d8f5e5423d5ec628eb'`

**Problema:** O endereço global da plataforma está hardcoded como fallback em ambos os arquivos. Após a implementação de wallets per-user, este endereço ainda aparece para:
- Usuários sem wallet Circle provisionada ainda
- Caso o `AUTH_KV` não esteja configurado
- Caso `resolveUserWallet()` retorne `isPerUser: false`

A UI do Circle Agent mostra este endereço compartilhado para esses usuários, criando a impressão de que é a wallet deles — mas qualquer depósito vai para a wallet da plataforma.

**Impacto:** Usuários podem depositar fundos na wallet errada pensando ser a deles.  
**Fix necessário:** Quando `isPerUser: false`, a UI deve exibir claramente "Wallet da plataforma (aguardando provisionamento da sua wallet)" em vez de mostrar o endereço como se fosse pessoal. Alternativamente, bloquear operações de funding até a wallet per-user existir.

---

### P3 — ALTO: `circleWalletAddr()` no frontend ignora o endereço per-user

**Arquivo:** `shared/aiSmartWallet.js`, linha 202-210  
**Código atual:**
```js
function circleWalletAddr() {
  try {
    if (typeof CircleAgent !== 'undefined' && CircleAgent.getCachedAddress) {
      const a = CircleAgent.getCachedAddress();
      if (a) return a;
    }
  } catch (_e) {}
  return CANONICAL_CIRCLE_WALLET; // ← endereço global hardcoded
}
```
**Problema:** `CircleAgent.getCachedAddress()` retorna o endereço do último `/api/agent/status` chamado. Se `isPerUser: true` no status, o endereço correto aparece. Mas se a sessão expirar ou o cache for invalidado, cai no hardcoded global.  
**Impacto:** Inconsistência entre o endereço exibido na UI e a wallet real usada nas transações.

---

### P4 — ALTO: `nativeBalance` usa 18 decimals para Arc (deveria usar 6 para USDC-nativo)

**Arquivo:** `shared/aiSmartWallet.js`, linha 490  
**Código atual:**
```js
nativeCache = { at: Date.now(), bal: Number(ethers.formatUnits(raw, 18)) };
```
**Problema:** No Arc, USDC é o token nativo com **6 decimals** (não 18). O `provider.getBalance()` retorna o saldo em unidades nativas de 18 casas no nível do protocolo, mas o valor econômico está em 6. O resultado é um saldo de gas mostrado como `0.000000421 USDC` quando deveria ser `421 USDC` (erro de fator 10^12).  
**Impacto:** Gas reserve check, renderVaultPanel, gasStatus ficam com valores incorretos no Arc.  
**Fix necessário:** Usar `ethers.formatUnits(raw, 6)` para Arc (chainId 5042), ou importar/reutilizar `usdcToGasToken`/`gasTokenToUsdc` do registry existente.

---

### P5 — MÉDIO: `walletSet` criado por usuário sem CIRCLE_WALLET_SET_ID gera um walletSet por usuário

**Arquivo:** `functions/api/agent-signer/_circle.js`, linha 378-390  
**Código atual:** quando `CIRCLE_WALLET_SET_ID` não está configurado como Cloudflare Secret, o código cria um walletSet novo por usuário com idempotencyKey `walletset_{userId}_{Date.now()}`.  
**Problema:** `Date.now()` na idempotency key significa que dois requests simultâneos (ex: duplo-clique no register, retry) criam dois walletSets diferentes. A idempotência quebra.  
**Fix necessário:** idempotency key = `walletset_{userId}_v1` (sem timestamp).

---

### P6 — MÉDIO: `requireSession()` em `/api/agent/[[path]].js` não existe — é read-only mas sem auth

**Arquivo:** `functions/api/agent/[[path]].js`  
**Código atual:** `resolveUserWallet()` tenta resolver per-user mas silently cai no fallback global quando sem sessão. Não retorna 401.  
**Problema:** Qualquer request não autenticado a `/api/agent/status` recebe os dados do wallet global da plataforma (endereço, balances do Circle wallet da plataforma).  
**Mitigação existente:** Os dados retornados são apenas balance/endereço da wallet — sem secrets. O risco é exposição de dados operacionais da plataforma (saldo do wallet global, txs).  
**Fix necessário:** Adicionar auth check em `/api/agent/status` se `AUTH_KV` configurado: retornar 401 quando sem sessão válida, em vez de mostrar dados do wallet global.

---

### P7 — BAIXO: `autonomaCore.js` armazena histórico em `localStorage` sem TTL

**Arquivo:** `shared/autonomaCore.js`, linha 76  
**Problema:** `memory.history` limita a 50 entradas, mas `userPreferences` cresce indefinidamente. Com wallets per-user, preferências de um usuário ficam no localStorage de outro dispositivo se compartilhado.  
**Impacto:** Baixo — cosmético, não afeta segurança financeira.

---

### P8 — BAIXO: `CHAIN_RPC` em `_circle.js` usa RPCs públicos sem fallback

**Arquivo:** `functions/api/agent-signer/_circle.js`, linha 31-38  
**Problema:** Os RPCs hardcoded (`cloudflare-eth.com`, `polygon-rpc.com`, etc.) são públicos e podem estar sujeitos a rate limit. O `fetchNonce` já tem retry (3x com backoff), mas sem fallback para RPC alternativo.  
**Mitigação:** A lógica já tenta o Circle API primeiro (nonce via `/wallets/{id}`), usando RPC só como fallback. O risco real é baixo.

---

## 4. RESUMO DE RISCO

| # | Severidade | Problema | Impacto se não corrigido |
|---|---|---|---|
| P1 | 🔴 CRÍTICO | Wallets criadas em testnets | Novos usuários sem wallet funcional em mainnet |
| P2 | 🔴 CRÍTICO | Endereço global exibido como wallet pessoal | Usuário deposita na wallet errada |
| P3 | 🟠 ALTO | circleWalletAddr() cai no hardcoded | Inconsistência UI vs execução |
| P4 | 🟠 ALTO | nativeBalance usa 18 decimals no Arc | Gas check, vault e status mostram valores errados |
| P5 | 🟡 MÉDIO | walletSet idempotency key com timestamp | Wallets duplicadas em retry |
| P6 | 🟡 MÉDIO | /api/agent/status sem auth retorna dados globais | Exposição de dados operacionais da plataforma |
| P7 | 🟢 BAIXO | localStorage sem TTL para preferences | Cosmético |
| P8 | 🟢 BAIXO | RPCs públicos sem fallback | Possível latência em pico |

---

## 5. O QUE NÃO FOI ENCONTRADO

Os seguintes riscos foram investigados e **não estão presentes:**

- Execução sem proof válido: não é possível — broadcast exige proof HMAC server-side
- Replay de proof: bloqueado pelo `consumeProof()` com KV
- Operação em contrato não allowlistado: bloqueado por `SIGN_ALLOWLIST` + `isKnownContract()`
- Execução sem sessão autenticada no authorize: `verifySession()` é fail-closed com 401
- Escalada de privilégio via body manipulation: binding do proof previne isso
- Nonce collision: `reserveNonce()` com lock server-side
- Funds locked: emergency stop só pausa automações, withdraw pessoal sempre permitido

---

## 6. PRÓXIMOS PASSOS RECOMENDADOS (por prioridade)

1. **P1** — Corrigir `blockchains` em `createUserWallet` para o identificador correto de Arc Mainnet na Circle API
2. **P2** — Na UI: quando `isPerUser: false`, mostrar estado "aguardando provisionamento" em vez do endereço global
3. **P4** — Corrigir `nativeBalance` para usar 6 decimals em Arc (chainId 5042)
4. **P5** — Remover `Date.now()` da idempotency key do walletSet
5. **P6** — Adicionar auth check em `/api/agent/status` quando `AUTH_KV` configurado
6. **P3** — Persistir o endereço per-user resolvido em localStorage com TTL após auth, como fonte primária para `circleWalletAddr()`
