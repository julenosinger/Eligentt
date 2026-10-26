# Gateway Fase 2.9 — Circle Gateway como origem no Unified Balance

**Data:** 26 Oct 2026  
**Baseline:** 794 testes passando antes desta fase  
**Resultado:** 683/683 nos suítes relevantes, zero novas falhas  
**`GATEWAY_SPEND_BLOCKED`:** continua `true`

---

## O que foi implementado

### Send via Gateway — funcional (bloqueado por infra)

`UBScreen.execSend` agora detecta `_ubSourceWallet === 'gateway'` e roteia para `saExecGateway()` em vez de `saExecuteSend()`.

Fluxo completo quando a flag for liberada:
1. Popula `#sa-recipient` e `#sa-amount` com os valores do drawer
2. Chama `saExecGateway()` que:
   - Verifica `GATEWAY_SPEND_BLOCKED` (retorna se `true`)
   - Chama `GatewaySpendService.execute(...)` com EIP-712 signing
   - Submete ao endpoint `/api/gateway/transfer`
   - Aguarda confirmação on-chain via `/api/gateway/transfer/confirm`
   - Invalida `_ubGwCache` em sucesso
3. Reflete o resultado no drawer (steps + showResult)

O caminho EVM (`saExecuteSend`) continua inalterado como default.

### Swap via Gateway — bloqueado com mensagem clara

`UBScreen.execSwap` detecta `_ubSourceWallet === 'gateway'` e retorna imediatamente com:
> "Swap requires tokens in your EVM wallet. Circle Gateway funds cannot be used directly as a swap input. Send your Gateway balance to your EVM wallet first, then swap from there."

**Razão técnica:** LI.FI, Tower e o Elligentt Pool precisam de `approve + swap` assinado pela EVM wallet. O mecanismo BurnIntent do Gateway é um P2P transfer, não um input de DEX. Não existe nenhum provedor que aceite um GatewayBurnIntent como origem de swap — inventar essa integração criaria uma rota que nunca executaria fundos reais.

### Bridge via Gateway — bloqueado com mensagem clara

`UBScreen.execBridge` detecta `_ubSourceWallet === 'gateway'` e retorna com:
> "Bridge requires tokens in your EVM wallet. Circle Gateway funds cannot be used directly as a bridge source. Send your Gateway balance to your EVM wallet first, then bridge from there."

**Razão técnica:** CCTP e LI.FI bridge precisam de `approve + burnTokens` ou `approve + lockTokens`, assinados pela EVM wallet. Gateway BurnIntent ≠ CCTP burn.

### Circle Gateway card no seletor de origem

`_ubInjectSourceSelector` agora renderiza três cards:
- Circle AI Smart Wallet (agent)
- EVM Wallet (evm)
- **Circle Gateway (gateway)** — com saldo lido de `_ubGwCache` via `ubGetGatewayBalance('USDC')`, sem fetch adicional

### `_ubSourceWallet` e `_ubSetSource` aceitam `'gateway'`

`_ubSetSource('gateway')` define `_ubSourceWallet = 'gateway'` e roteia para o UBScreen drawer (não para `_ubOpenAgentPanel`). `enterUnifiedBalanceMode` também inclui `'gateway'` na condição do ramo UBScreen.

---

## Arquivos alterados

| Arquivo | Mudança |
|---|---|
| `index.html` | `_ubSourceWallet` type comment; `_ubSetSource` gateway mapping; `_ubInjectSourceSelector` gateway card; `execSend` gateway branch; `execSwap` gateway block; `execBridge` gateway block; `enterUnifiedBalanceMode` gateway condition |
| `tests/gateway-ub-fase29.test.js` | 21 novos testes GF29-1 a GF29-8 |

---

## Bloqueios remanescentes

`GATEWAY_SPEND_BLOCKED = true` permanece. O Send via Gateway só executa fundos reais quando:

| # | Bloqueio | Ação necessária |
|---|---|---|
| B1 | `GATEWAY_OP_LOCK` DO Worker não deployado | Deploy separado + binding em wrangler.jsonc |
| B2 | `GATEWAY_OPS_KV` KV namespace binding ausente | Criar + bind no CF Dashboard |
| B3 | `DO_INTERNAL_SECRET` não configurado | Set no CF Dashboard → Settings → Environment Variables |
| B4 | `GATEWAY_RPC_URLS` não configurado | Set por chain: `{"5042":"<rpc>","1":"<rpc>",...}` |
| B5 | Teste de integração ponta-a-ponta em staging | Executar com fundos reais em ambiente de teste antes de prod |

Nenhum desses bloqueios é de segurança de código — todos são de infraestrutura CF. O código em si está pronto e auditado (Fases 2.1–2.8).
