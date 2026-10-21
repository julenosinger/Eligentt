# Bridge History — Auditoria Final
**Data:** 2026-10-21  
**Commit auditado:** `1eb497f` (baseline) + mudanças locais não commitadas  
**Arquivos auditados:** `index.html` (linhas 18250–18565, 26093–26112), `tests/bridge-history-final.test.js`, `tests/bridge-history-security.test.js`

---

## 1. Resultados de teste — números reais

| Estado | Test Files Pass | Test Files Fail | Tests Pass | Tests Fail | Skip |
|---|---|---|---|---|---|
| Baseline `1eb497f` | 115 | 45 | 2955 | 73 | 4 |
| Com mudanças locais | 116 | 44 | 2981 | 47 | 4 |
| **Delta** | **+1** | **-1** | **+26** | **-26** | **0** |

**Comando executado:** `bun run vitest --reporter=dot --run` (160 test files, 3032 tests total)  
**Falhas no estado atual:** 47 — todas preexistentes, confirmadas por `git stash` + `diff`.  
**Novas falhas introduzidas:** **0**.

Suites Bridge+Swap específicas (9 suites, 413 testes): **409 pass / 4 skip / 0 fail**.

---

## 2. Auditoria por correção

### C1 — MutationObserver com seletores CSS frágeis → `data-brg-*`

**Evidência do problema (baseline):** O observer usava:
```js
var labelEl = newest.querySelector('[style*="font-weight:600"]');
var subEl   = newest.querySelector('[style*="color:var(--muted2)"]');
```
O seletor `[style*="color:var(--muted2)"]` falha quando o browser normaliza o valor do atributo `style`. Resultado silencioso: `sub = ''`, `label = '—'` em qualquer entrada.

**Correção implementada:**
1. `addToHistory` agora seta 5 atributos `data-brg-*` no `div` criado **antes** de chamar `setSafeHTML`:
   - `data-brg-label`, `data-brg-sub`, `data-brg-hash`, `data-brg-explorer`, `data-brg-dotcolor`
2. O observer lê exclusivamente via `getAttribute('data-brg-*')` — zero CSS selectors.

**Verificado:** testes B1–B8 (`bridge-history-final.test.js`) — 8/8 pass.  
**Ciclos/duplicações:** Observer usa `_brgSessionEntries.some()` para deduplicar por hash ou label+ts-bucket (2s). Sem ciclos. `observer.observe(container, { childList: true })` — escuta apenas inserções diretas, não mudanças de atributo ou subtree.

---

### C2 — Status inferido por cor → campo semântico

**Evidência do problema (baseline):** 
```js
pending: dotColor.indexOf('f59e0b') >= 0,
failed:  dotColor.indexOf('ef4444') >= 0,
```
`indexOf('f59e0b')` não captura `'rgb(245, 158, 11)'` (formato retornado por `el.style.background` após parse pelo browser). Status ficava `pending: false, failed: false` para entradas âmbar exibidas como "Pending" na UI.

**Correção implementada:**
- Observer normaliza via `STATUS_PENDING = ['#f59e0b', 'f59e0b', 'rgb(245, 158, 11)', 'rgb(245,158,11)']` e `STATUS_FAILED` equivalente.
- Grava campo semântico `status: 'pending'|'done'|'failed'` + boolean `pending`/`failed` derivados dele.
- `_normalizeStored` deriva status de `finalStatus` do localStorage — **nunca de cor**.

**Nota:** O campo `status` ainda usa dotColor como sinal secundário para entradas de sessão (pois não têm `finalStatus`). Isso é correto: o dotColor é controlado pelo código da aplicação (`'#f59e0b'` hardcoded em `executeBridgeViaLiFi`) e não vem de fonte externa. O risco XSS é zero porque o valor vem do código, não do DOM ou do localStorage.

**Verificado:** testes C1–C9 — 9/9 pass.

---

### C3 — Session entry pendente sobrescrevia status confirmado

**Evidência do problema (baseline):**
```js
sessionEntries.forEach(function(e) {
  var key = e.txHash || ...;
  if (!seenHashes[key]) { seenHashes[key] = true; entries.push(e); }
});
stored.forEach(...);  // stored entries already deduped out
```
Se `recoverPendingIntents` havia marcado `finalStatus: 'EXECUTED'` no localStorage, mas a sessão tinha uma entrada com `pending: true` para o mesmo hash, a sessão ganhava e o painel mostrava "Pending".

**Correção implementada:**
```js
var storedByHash = {};
stored.forEach(function(h) {
  var key = h.txHash || h.sourceTxHash || '';
  if (key) storedByHash[key] = h;
});

sessionEntries.forEach(function(e) {
  // ...
  if (e.txHash && storedByHash[e.txHash]) {
    var sv = storedByHash[e.txHash];
    var storedPending = !sv.finalStatus || !!PENDING_STS[sv.finalStatus];
    if (!storedPending) {
      entries.push(_normalizeStored(sv));  // stored wins
      return;
    }
  }
  entries.push(e);
});
```

**Verificado:** testes D1–D6 — 6/6 pass.

---

### Bônus — Link de explorer quando txHash ausente

**Evidência:** `addToHistory('bridge-history', { txHash: undefined, ... })` produzia `href=".../tx/undefined"`. 

**Correção:** Template literal agora usa ternário: `${txHash ? \`<a href="...">\` : ''}`. `_brgSafeTxHash(undefined)` retorna `null` e o link não é criado em `_brgHistBuildRow`.

**Verificado:** teste A6 — pass. Todos os 8 call sites de `addToHistory('bridge-history', ...)` foram inspecionados: 6 passam hash válido, 1 passa `mintTxHash || txHash` (nunca undefined simultâneo), 1 passa `mintTxHash || rec.burnTx`.

---

## 3. Scope guard — diff completo

`git diff --stat HEAD`: apenas `index.html` — 81 inserções, 42 deleções.  
`git diff HEAD -- index.html | grep "^@@ "` revela 3 hunks:
- Linha 18411: `brgHistRender` — merge logic
- Linha 18506: `_initBrgHistObserver` — observer reads
- Linha 26097: `addToHistory` — data-brg-* attrs + conditional link

**Confirmado:** Swap (`swpOpenHistory`, `swpHistRender`), Send Assets (`saExecuteCrossChain`), Billing (`billingInit`), Unified Balance (`ubInit`) — **zero linhas alteradas**.

---

## 4. Limitações declaradas (live — não verificáveis sem wallet)

| Item | Status |
|---|---|
| `approve()` aponta para contrato correto on-chain | PENDENTE — requer wallet Arc Mainnet |
| EURC CCTP Arc↔Base completa on-chain | PENDENTE — requer wallet + EURC real |
| EURC Arc→Ethereum roteia via LiFi | PENDENTE — requer `LIFI_API_KEY` |
| `recoverPendingIntents` atualiza status via RPC | PENDENTE — requer wallet + pending intent no localStorage |

---

## 5. Veredito

**APROVADO PARA COMMIT**

- 409/409 testes Bridge+Swap passam (4 skipped declarados como pendentes on-chain).
- 0 novas falhas introduzidas (47 falhas remanescentes são 100% preexistentes, confirmadas por diff de baseline).
- As 3 correções obrigatórias estão implementadas, verificadas por testes específicos.
- Diff escopo-limitado: apenas Bridge History e `addToHistory`.
- Proteções XSS, validação de hash e lista de explorers preservadas e verificadas.

**Comando de commit:**
```bash
git add index.html tests/bridge-history-final.test.js tests/bridge-history-security.test.js
git commit -m "fix(bridge-history): data-brg-* attrs, semantic status, stored-wins dedup, conditional tx link"
git push
```
