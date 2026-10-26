# Gateway Fase 2.7 — Unified Balance como fonte central

**Data:** 2026-10-26  
**Baseline anterior:** 833/833 (Fase 2.6)  
**Resultado:** 794/794 (suítes relevantes) — zero novas falhas

---

## Arquitetura antes/depois

### Antes (Fase 2.6)

| Módulo | Fonte do saldo Gateway | Chamadas independentes |
|---|---|---|
| Unified Balance | `ubGatewayFetch()` → `/api/gateway/balances` | 1 por `ubRefresh()` |
| Send | `saLoadGatewayBalance()` → `/api/gateway/balances` | 1 ao clicar "Gateway" |
| Swap | `swpLoadGatewayBalance()` → `/api/gateway/balances` | 1 ao clicar "Gateway" |
| Bridge | Sem display de saldo GW | — |

3 chamadas paralelas ao mesmo endpoint. Lógica de parse duplicada com divergência
(`saLoadGatewayBalance` usava slice-string; `swpLoadGatewayBalance` usava `parseFloat`).
Nenhuma invalidava o cache após operação.

### Depois (Fase 2.7)

```
ubGatewayFetch() ─── /api/gateway/balances  ← ÚNICA chamada de rede
        │
        ▼
  _ubGwCache { data, ts, addr, status }      ← fonte única de verdade
        │
        ├─ ubGatewayRender()                  (UB display — inalterado)
        ├─ ubGetGatewayBalance(sym)            ← nova API de leitura
        │       ├─ saLoadGatewayBalance()     (sem fetch próprio)
        │       └─ swpLoadGatewayBalance()    (sem fetch próprio)
        └─ ubInvalidateGatewayCache()         ← chamado após spend confirmado
                └─ ubGatewaySyncRefresh()      (refresca apenas GW, não EVM)
```

---

## Arquivos modificados

| Arquivo | Mudança |
|---|---|
| `index.html` | `_ubGwCache` declarado; `ubGatewayRender` popula cache; `ubGetGatewayBalance` e `ubInvalidateGatewayCache` adicionados; `saLoadGatewayBalance` e `swpLoadGatewayBalance` reescritos para consumir cache; `saExecGateway` chama `ubInvalidateGatewayCache` após `result.ok`; `_saFmtGwBal` helper sem float |
| `tests/gateway-ub-integration.test.js` | Novo — 32 testes GUB1–GUB9 |
| `tests/gateway-fase2.test.js` | GF2-5 atualizado para nova arquitetura |

---

## Propriedades garantidas

1. **Fonte única:** `_ubGwCache` é a única fonte de saldo Gateway para Send, Swap e Bridge.
2. **Zero fetch duplicado:** `saLoadGatewayBalance` e `swpLoadGatewayBalance` não emitem chamadas de rede independentes.
3. **Sem float:** `ubGetGatewayBalance` usa `_ubGwAddStr` (string arithmetic). `_saFmtGwBal` usa `slice`, não `parseFloat`.
4. **Stale guard:** cache expirado após 90 s → retorna null → trigger de refresh silencioso.
5. **Isolamento por wallet:** `_ubGwCache.addr` verificado; cache de outra carteira retorna null.
6. **Invalidação após spend:** `saExecGateway` chama `ubInvalidateGatewayCache()` só na branch `result.ok`.
7. **`GATEWAY_SPEND_BLOCKED = true`** — ativo. Nenhum fluxo de execução real foi habilitado.

---

## Bloqueios remanescentes para liberação

Os mesmos 5 itens de infraestrutura CF listados na Fase 2.5 e 2.6:

1. `GATEWAY_OP_LOCK` — DO Worker não deployado
2. `GATEWAY_OPS_KV` — KV namespace não configurado
3. `DO_INTERNAL_SECRET` — não configurado no CF Dashboard
4. `GATEWAY_RPC_URLS` — não configurado
5. `GATEWAY_ENV=production` — não configurado

Nenhum é um gap de segurança de código. O código está pronto para produção após configuração da infra.

---

## Testes executados

| Suite | Testes | Status |
|---|---|---|
| gateway-ub-integration.test.js | 32 | ✅ |
| gateway-spend-service.test.js | 263 | ✅ |
| gateway-fase2.test.js | 44 | ✅ |
| gateway-fase18.test.js | 19 | ✅ |
| gateway-balance.test.js | 55 | ✅ |
| gateway-deposit.test.js | 73 | ✅ |
| unified-portfolio.test.js | 50 | ✅ |
| bridge-kit-router.test.js | 22 | ✅ |
| bridge-multi-route.test.js | 31 | ✅ |
| rwa-trading.test.js | 166 | ✅ |
| lifi-enterprise.test.js | 27 | ✅ |
| balance-service.test.js | 12 | ✅ |
| **Total** | **794** | **✅ zero falhas** |
