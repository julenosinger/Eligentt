# Gateway Fase 2.5 — Auditoria de Liberação Segura

**Data:** 25 outubro 2026  
**Decisão:** `GATEWAY_SPEND_BLOCKED` **permanece `true`**  
**Motivo:** infraestrutura CF não configurada (ver Seção 3)

---

## 1. Resultado de cada critério de segurança

| # | Critério | Status | Fonte |
|---|---|---|---|
| 1 | GatewayWallet `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE` | ✅ APROVADO | Circle docs mainnet, Oct 2026 |
| 2 | GatewayMinter `0x2222222d7164433c4C09B0b0D809a9b52C04C205` | ✅ APROVADO | Circle docs mainnet, Oct 2026 |
| 3 | GatewayWallet testnet `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` | ✅ APROVADO | Circle official how-to |
| 4 | GatewayMinter testnet `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B` | ✅ APROVADO | Circle official how-to |
| 5 | Selector `gatewayMint(bytes,bytes)` = `0x9fb01cc5` | ✅ APROVADO | keccak256 verificado Fase 2.3 |
| 6 | EIP-712 BurnIntent/TransferSpec types | ✅ APROVADO | Circle transfer how-to |
| 7 | Salt em offset fixo 304 no TransferSpec | ✅ APROVADO | evm-gateway-contracts source |
| 8 | Autenticação attestation (hash + receipt + calldata) | ✅ APROVADO | Fase 2.3–2.4 |
| 9 | receipt.transactionHash cross-check | ✅ APROVADO | Fase 2.4 |
| 10 | blockNumber consistency check | ✅ APROVADO | Fase 2.4 |
| 11 | Limites ABI (offset, payloadLen, saltEnd) | ✅ APROVADO | Fase 2.4 |
| 12 | numAttestations validado em AttestationSet | ✅ APROVADO | Fase 2.4 |
| 13 | `strToAtomic`/`atomicToStr` — BigInt, sem float | ✅ APROVADO | GatewaySpendService.js |
| 14 | `execute()` sem parseFloat em caminhos de valor | ✅ APROVADO | GSS21.8 |
| 15 | `verifyBurnIntentSignature` fail-closed | ✅ APROVADO | GSS21.11 |
| 16 | BurnIntent `Object.freeze` antes de assinar | ✅ APROVADO | GatewaySpendService.js L539 |
| 17 | Idempotência — KV/DO reserva antes de encaminhar | ✅ APROVADO | transfer.js tryReserve |
| 18 | `kv_query_unavailable` bloqueia se salt check falhar | ✅ APROVADO | GSS21.12 |
| 19 | `_inflight` browser-lock anti-duplicate | ✅ APROVADO | execute() L680 |
| 20 | `cancel()` recusado após submitted=true | ✅ APROVADO | GSS21.13 |
| 21 | Nenhum PATCH cliente — `CLIENT_ALLOWED_TRANSITIONS = {}` | ✅ APROVADO | Fase 2.2, GSS21.14 |
| 22 | `ambiguous→failed` via `/confirm` server-side | ✅ APROVADO | Fase 2.2 |
| 23 | `ambiguous→confirmed` válido via `/confirm` | ✅ APROVADO | Fase 2.3 |
| 24 | KV desabilitado em produção | ✅ APROVADO | isProduction, GSS21.15 |
| 25 | DO requerido em produção | ✅ APROVADO | do_required_in_production |
| 26 | DO_INTERNAL_SECRET constant-time compare | ✅ APROVADO | timingSafeEqual() |
| 27 | `persistence_failed_after_response` nunca silenciado | ✅ APROVADO | transfer.js L508 |
| 28 | Isolamento por depositor em GET/PATCH/confirm | ✅ APROVADO | normAddr comparison |
| 29 | `parseFloat` removido do display de saldo GW | ✅ APROVADO | Fase 2.5 |

---

## 2. Bloqueios de infraestrutura CF (não são falhas de segurança)

Estes bloqueios impedem a execução real, mas não representam vulnerabilidades no código.  
O código é seguro para executar assim que forem configurados.

| # | Item | Ação necessária |
|---|---|---|
| B1 | `GATEWAY_OP_LOCK` | Fazer deploy de Worker separado exportando `GatewayOpLock`; adicionar binding em CF Pages Settings → Functions |
| B2 | `GATEWAY_OPS_KV` | Criar namespace KV; adicionar `kv_namespaces` em `wrangler.jsonc`; fazer deploy |
| B3 | `DO_INTERNAL_SECRET` | Gerar string aleatória 32+ chars; configurar em CF Pages → Settings → Environment Variables (Production) |
| B4 | `GATEWAY_RPC_URLS` | Configurar JSON `{"5042":"https://rpc.mainnet.arc.io","8453":"https://mainnet.base.org",...}` por chain como env var em CF Pages |

---

## 3. Arquivos alterados nesta fase

| Arquivo | Alteração |
|---|---|
| `shared/GatewaySpendService.js` | Nota "UNVERIFIED" removida de GW_WALLET e GW_MINTER — endereços agora marcados como confirmados com fonte Circle docs |
| `index.html` | `saLoadGatewayBalance` — `parseFloat(bal).toFixed(6)` substituído por truncamento string sem float; comentário `GATEWAY_SPEND_BLOCKED` expandido com checklist CF explícita |
| `tests/gateway-spend-service.test.js` | GSS21 (15 testes) adicionado |

---

## 4. Testes executados

| Suite | Testes | Resultado |
|---|---|---|
| `gateway-spend-service.test.js` | 251 | ✅ 251/251 |
| `gateway-fase18.test.js` | 19 | ✅ 19/19 |
| `gateway-fase2.test.js` | 44 | ✅ 44/44 |
| `gateway-balance.test.js` | 55 | ✅ 55/55 |
| `gateway-deposit.test.js` | 73 | ✅ 73/73 |
| `unified-portfolio.test.js` | 50 | ✅ 50/50 |
| `bridge-kit-router.test.js` | 22 | ✅ 22/22 |
| `bridge-multi-route.test.js` | 31 | ✅ 31/31 |
| `swap-chain-sync.test.js` | 55 | ✅ 55/55 |
| `swap-balance-fmt.test.js` | 16 | ✅ 16/16 |
| `lifi-enterprise.test.js` | 27 | ✅ 27/27 |
| `rwa-trading.test.js` | 166 | ✅ 166/166 |
| `balance-service.test.js` | 12 | ✅ 12/12 |
| **Total** | **821** | **✅ 821/821** |

Falha preexistente não relacionada (baseline desde antes da Fase 2.1):
- `arc-chain-availability.test.js` — lê `public/shared/policyEngine.js` que é artefato de build CF Pages, não gerado no ambiente de desenvolvimento.

---

## 5. Decisão final

`GATEWAY_SPEND_BLOCKED = true` **mantido**.

O código de segurança está aprovado em todos os 29 critérios. A liberação depende exclusivamente da configuração da infraestrutura CF (B1–B4). Assim que B1–B4 estiverem confirmados em produção e um deploy de verificação for executado, `GATEWAY_SPEND_BLOCKED` pode ser alterado para `false` — sem necessidade de nova auditoria de código.

**`GATEWAY_SPEND_BLOCKED` não é uma proteção de segurança do código.** É um gate operacional que protege o usuário de iniciar um fluxo de assinatura que resultaria em 503 no servidor por falta de configuração de infraestrutura.
