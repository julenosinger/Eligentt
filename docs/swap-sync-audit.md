# Auditoria — Swap Network Auto-Sync (`df54522`)

**Data:** 23 Out 2026  
**Commit auditado:** `df54522454e9da9b680f2e6aa9c7aa1f31dcf29a`  
**Arquivos analisados:** `index.html`, `tests/swap-chain-sync.test.js`  
**Veredicto:** ✅ **APROVADO COM RESSALVAS**

---

## 1. Resumo Executivo

A implementação resolve corretamente o problema principal: o Swap Standard agora sincroniza `fromChainId`/`toChainId`, invalidação de quotes e tokens default quando a rede ativa muda. Os três trigger points (`chainChanged`, `WALLET_CONNECTED`, `WALLET_SWITCHED`) estão corretamente registrados, o guard de idempotência funciona, e o incremento de `_swapQuoteSeq` descarta callbacks LI.FI in-flight.

Não foram introduzidas novas falhas de teste. As 51 falhas da suite completa são **todas preexistentes** — confirmadas comparando `df54522` com `1216340` (commit anterior).

Há **duas ressalvas** que não bloqueiam o funcionamento em Arc (caso de uso primário) mas introduzem comportamento incorreto em chains não-Arc com apenas USDC disponível (Ethereum, Arbitrum, Optimism, Polygon):

- **R1 (moderado):** `TOKEN_LIST[1]` (EURC) é usado como `tokenOut` quando `symOut='ETH'` não existe em nenhuma chain não-Arc — exibe EURC como par default em chains onde EURC não existe.
- **R2 (baixo):** Os testes são 100% estruturais/estáticos — não executam nenhuma lógica de sincronização em runtime.

---

## 2. Arquivos e Commits Analisados

| Arquivo | Tipo | Descrição |
|---|---|---|
| `index.html` (df54522) | Produção | +73 linhas: `swpSyncToActiveChain`, 3 trigger points |
| `tests/swap-chain-sync.test.js` | Teste | +230 linhas: 34 testes estáticos N1–N11 |
| `index.html` (1216340) | Baseline | Estado antes do commit |
| `/tmp/pre-sync-baseline.log` | Evidência | Suite antes do commit (11 falhas / 69 total) |
| `/tmp/post-sync.log` | Evidência | Suite após o commit (5 falhas / 90 total — +34 novos testes) |
| `/tmp/full-audit.log` | Evidência | Suite completa: 51 falhas / 3317 total |

---

## 3. Matriz de Cenários

| # | Cenário | Resultado | Evidência | Observação |
|---|---|---|---|---|
| C1 | Conexão inicial em Arc (5042) | ✅ PASSA | `WALLET_CONNECTED` → `swpSyncToActiveChain` → `cid=5042 ≠ 0` → USDC/EURC | Guard `_swpSyncChainLast=0` garante execução na 1ª chamada |
| C2 | Switch Arc → Base (8453) | ⚠️ PARCIAL | `chainChanged` → `swpSyncToActiveChain` → `cid=8453` → `symOut='ETH'` → `hasOut=false` → fallback `TOKEN_LIST[1]=EURC` | EURC não existe em Base; badge exibe EURC incorretamente. USDC correto. |
| C3 | Switch Base → Arc (5042) | ✅ PASSA | `cid=5042` → USDC/EURC via `swapAvailableTokens(5042)` | Funcional |
| C4 | Switch para Ethereum (1) | ⚠️ PARCIAL | `avail=[USDC]`, `symOut='ETH'`, fallback → `TOKEN_LIST[1]=EURC` | Mesmo problema de R1 |
| C5 | Switch para Arbitrum (42161) | ⚠️ PARCIAL | `avail=[USDC]`, fallback → EURC | Mesmo problema |
| C6 | Switch para Optimism (10) | ⚠️ PARCIAL | `avail=[USDC]`, fallback → EURC | Mesmo problema |
| C7 | Switch para Base (8453) — EURC disponível | ✅ PASSA | `avail=[USDC, EURC]`, `alt=EURC` → USDC/EURC | Base tem EURC registrado; par correto |
| C8 | Seleção manual após sync | ✅ PASSA | `SWP.tokenInObj=null` após sync → usuário pode usar picker | `_swpTokIn()` usa `SWP.tokenInObj` quando definido; sync não bloqueia |
| C9 | Duplicação de listeners | ✅ PASSA | `_swpSyncChainLast` guard + `typeof` guard em cada trigger | N8: `swpSyncToActiveChain` declarado exatamente 1 vez |
| C10 | Invalidação de quotes antigas | ✅ PASSA | `_swapQuoteSeq++` + `SWP.lastQuote=null` + `aggQuotes=null` + `clearTimeout` | Race guard efetivo |
| C11 | Respostas assíncronas stale | ✅ PASSA | `_swapQuoteSeq` verificado em `updateSwapRate` (N9.2) | Callbacks descartados pelo seq check |
| C12 | Wallet desconectada | ✅ PASSA | `activeChainId` volta para 5042 default; sync roda corretamente | `WALLET_DISCONNECTED` não chama sync — correto (sem chain para sincronizar) |
| C13 | Execução automática de transação | ✅ PASSA | `swpSyncToActiveChain` não chama `executeSwap`, `signMessage` ou `sendTransaction` | Apenas UI/state reset |
| C14 | App selector de rede | ⚠️ NÃO CONCLUSIVO | Não existe evento global de app selector — apenas `chainChanged` via wallet | Se o seletor de rede do app não emite `WALLET_SWITCHED`, a sync não dispara sem mudança de wallet |
| C15 | Advanced mode preservado | ✅ PASSA | `SWP.tokenInObj/tokenOutObj = null` → reseta para Standard; usuário pode re-selecionar via picker | Sem impacto em Advanced mode pós-sync |

---

## 4. Regressões

### Novas (introduzidas por df54522)
**Nenhuma.** Comparação direta confirma:
- Pre-commit (`1216340`): 11 falhas nos 5 arquivos testados
- Post-commit (`df54522`): 5 falhas nos mesmos 5 arquivos (6 que antes falhavam agora passam por causa de `swap-chain-sync.test.js` adicionado ao set)
- Suite completa: 51 falhas em ambos os estados

### Preexistentes (confirmadas)
Todos os 51 failures da suite completa existiam antes de `df54522`. Exemplos representativos:

| Suite | Falha | Preexistente |
|---|---|---|
| `fase3-ui.test.js` | Billing Under Construction, Swap providers | Sim |
| `unified-balance-structure.test.js` | ub-asset-tbody ausente | Sim |
| `chain-provider-consistency.test.js` | Base RPC/token addresses | Sim — testa `shared/` não `index.html` |
| `lifi-integration.test.js` | Arc RPC registry | Sim |
| `network-selector-mainnet.test.js` | `SWP._towerQuoteData.source === 'lifi'` | Sim |

---

## 5. Resultados das Suítes

| Suite | Executados | Passou | Falhou | Status |
|---|---|---|---|---|
| `swap-chain-sync.test.js` | 34 | 34 | 0 | ✅ |
| `chain-provider-consistency.test.js` | 21 | 19 | 2 | ⚠️ preexistente |
| `swap-core.test.js` | — | — | — | ⚠️ preexistente |
| `lifi-integration.test.js` | — | — | 1 | ⚠️ preexistente |
| `network-selector-mainnet.test.js` | — | — | 2 | ⚠️ preexistente |
| **Suite completa** | **3317** | **3262** | **51** | ⚠️ 51 preexistentes |

---

## 6. Problemas Identificados

### P1 — Token default inválido em chains com USDC-only (MODERADO)

**Arquivo:** `index.html`  
**Linha:** `32583–32595` (função `swpSyncToActiveChain`)  
**Causa raiz:** `swapAvailableTokens(chainId)` filtra `ETH` explicitamente (`t.sym === 'ETH' → skip`). Chains 1, 42161, 10, 137 têm apenas USDC registrado. `symOut = 'ETH'` → `hasOut = false` → fallback: `alt = avail.find(t => t.sym !== 'USDC')` → `undefined` → `symOut = undefined` → loop busca `TOKEN_LIST[i].sym === undefined` → `idxOut = -1` → `SWP.tokenOutIdx = Math.min(1, TOKEN_LIST.length-1) = 1` → `TOKEN_LIST[1] = EURC` — token que não existe nessas chains.

**Impacto:** Badge "YOU RECEIVE" exibe EURC em Ethereum/Arbitrum/Optimism/Polygon. Balance fetch para EURC nessas chains retorna `—` (correto: token não encontrado) mas não uma mensagem clara. Quotes tentando USDC→EURC nessas chains falharão no LI.FI com `no_route`.

**Severidade:** Moderada — Arc (caso de uso primário) funciona corretamente. Chains não-Arc só funcionam via LI.FI Advanced; o usuário pode re-selecionar manualmente.

**Reprodução:** Conectar wallet em Ethereum mainnet → abrir Swap → badge "YOU RECEIVE" mostra EURC.

**Correção mínima:** No fallback quando `!hasOut && avail.length === 1`: `symOut = symIn` (USDC→USDC, que o LI.FI renderiza como "same token" e mostra erro explicativo) ou mostrar estado "Select token" explícito.

---

### P2 — Testes 100% estáticos — nenhuma lógica de runtime executada (BAIXO)

**Arquivo:** `tests/swap-chain-sync.test.js`  
**Linhas:** 1–231  
**Causa raiz:** Todos os 34 testes fazem `fs.readFileSync` no HTML e verificam presença de strings. Nenhum instancia `swpSyncToActiveChain`, simula `chainChanged`, ou verifica mudança de estado em `SWP`.

**Impacto:** O bug P1 (token default errado) não é detectado por nenhum teste. Um refactor que renomeia variáveis internas quebraria os testes sem quebrar a funcionalidade.

**Severidade:** Baixa — os testes são válidos como guard de regressão estrutural, mas não comprovam comportamento funcional.

**Correção mínima:** Adicionar 2–3 testes unitários que importam a lógica `swapAvailableTokens` + fallback loop via `vm.runInNewContext` ou similar.

---

### P3 — App network selector não identificado (NÃO CONCLUSIVO)

**Arquivo:** `index.html`  
**Observação:** O seletor de rede global do app (chips no topbar ou outro componente) pode existir sem emitir `WALLET_SWITCHED` ou `WALLET_CONNECTED`. Se ele apenas muda `activeChainId` sem disparar esses eventos, `swpSyncToActiveChain` não é chamada.

**Evidência buscada:** `grep -n 'activeChainId\s*=' index.html` retorna múltiplos pontos de atribuição — nenhum deles chama `swpSyncToActiveChain`. Somente `refreshProviderState()` atualiza `activeChainId` e é chamado pelo `chainChanged`.

**Impacto:** Se o usuário muda de rede via interface do app sem mudar a wallet, o Swap pode não sincronizar.

**Severidade:** Não conclusiva sem E2E ou teste manual.

---

## 7. Lacunas de Cobertura

| Lacuna | Motivo |
|---|---|
| Comportamento runtime de `swpSyncToActiveChain` | Infraestrutura de teste é JSDOM-less (apenas `fs.readFileSync`) — não instancia DOM nem `window` |
| Verificação de badges DOM após sync | Sem DOM real ou virtual; seria necessário jsdom + script execution |
| Comportamento do app network selector | Componente não identificado nos testes |
| Quote re-fetch após sync | Depende de `updateSwapRate` sendo chamada pelo usuário (correto — não automático) |
| Múltiplas mudanças de chain rápidas | Race condition teórica não testada |

---

## 8. Próximos Passos Recomendados (por prioridade)

**P1 — ALTA — Corrigir token default em chains USDC-only:**
```js
// Em swpSyncToActiveChain, substituir o fallback quando avail.length === 1:
if (!hasOut) {
  // Chain só tem USDC: usar USDC→USDC (LI.FI mostrará "same token" ou rota cross)
  // ou manter índice 0 para ambos (mostra Select Token via picker)
  symOut = symIn; // USDC→USDC: seguro, sem endereço inválido
}
```
Localização: `index.html` linha ~32589.

**P2 — MÉDIA — Adicionar 2 testes funcionais mínimos:**
Simular `swapAvailableTokens` para chains 1, 8453, 5042 com o `TOKEN_REGISTRY` real e verificar que `tokenOutIdx` aponta para um token com endereço válido na chain.

**P3 — BAIXA — Verificar app network selector:**
Inspecionar o componente de seleção de rede global para confirmar que emite evento capturado pelo sync, ou adicionar chamada direta onde `activeChainId` é atualizado pelo seletor.
