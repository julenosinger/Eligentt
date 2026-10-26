# Gateway Fase 2.8 — Unified Balance como centro de operações

**Data:** 26/10/2026  
**Status:** Concluída — `GATEWAY_SPEND_BLOCKED = true` (bloqueios de infra CF pendentes)  
**Testes:** 717/717 Gateway + UB + Bridge + Swap + LI.FI + RWA

---

## Causa raiz identificada

`UBScreen._refreshSwap` lia saldo de `UB.state.assets[i].balance` — campo de float populado apenas após um ciclo completo de `UBLive.refreshBalances()`. Se o painel for aberto antes desse ciclo, `bal = 0`. Se o token não estiver na lista, `bal = 0`. Exibição permanente de `—`/`0.00`.

---

## Arquivos alterados

| Arquivo | Mudança |
|---|---|
| `index.html` | `_refreshSwap`: substituído `UB.state.assets` por IIFE `_ubScrSwapBal` que usa `BalanceService.getTokenBalance` (EVM) ou `ubGetGatewayBalance` (GW) |
| `index.html` | `showOperation('send')`: adicionada linha "Available" (`ub-scr-send-bal`) com `BalanceService.getTokenBalance`, stale-while-revalidate, atualização ao trocar token |
| `tests/ub-actions-phase28.test.js` | Novo — 27 testes comportamentais |

---

## Arquitetura antes/depois

### Antes

```
UBScreen._refreshSwap
  → UB.state.assets[i].balance  ← stale float, só existe após UBLive cycle
  → "Balance: 0" ou "Balance: —"
```

```
UBScreen showOperation('send')
  → Sem campo de saldo disponível
```

### Depois

```
UBScreen._refreshSwap
  ├── _ubSourceWallet === 'gateway'
  │     → ubGetGatewayBalance(sym)  ← _ubGwCache (Fase 2.7)
  └── EVM source
        → BalanceService.getTokenBalance(addr, tokenObj, chainId)
          ├── Shows '…' immediately (stale-while-revalidate)
          ├── Updates when async read completes
          └── .catch → 'Balance: — (RPC error)'
```

```
UBScreen showOperation('send')
  → ub-scr-send-bal (nova linha "Available")
       → BalanceService.getTokenBalance
       → Updates on token change
       → sym2 in total (não hardcoded 'USDC')
```

---

## Single fetch path confirmado

Apenas `ubGatewayFetch` atribui `'/api/gateway/balances'`. `saLoadGatewayBalance`, `swpLoadGatewayBalance` e `UBScreen._refreshSwap` leem do cache via `ubGetGatewayBalance`.

---

## Bloqueios remanescentes para liberar GATEWAY_SPEND_BLOCKED

1. `GATEWAY_OP_LOCK` — DO Worker não deployado
2. `GATEWAY_OPS_KV` — KV binding não configurado no CF Dashboard
3. `DO_INTERNAL_SECRET` — não configurado no CF Dashboard
4. `GATEWAY_RPC_URLS` — env vars por chain não configuradas

Todos os critérios de segurança do código foram aprovados nas Fases 2.2–2.6.
