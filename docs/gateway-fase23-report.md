# Gateway Fase 2.3 — Relatório Final

**Data:** 25 de outubro de 2026
**Arquivo alterado:** `functions/api/gateway/transfer.js`
**Testes alterados:** `tests/gateway-spend-service.test.js`, `tests/gateway-fase18.test.js`

---

## Causa raiz dos problemas corrigidos

### P0 — `eth_getTransactionReceipt` não garante o campo `input`

O endpoint `/confirm` da Fase 2.2 obtinha a calldata via `receipt.input` (campo de `eth_getTransactionReceipt`). O JSON-RPC padrão define esse campo como opcional no receipt — vários nodes (Arbitrum, Optimism, etc.) omitem `input` do receipt por design. Resultado: o servidor retornava `receipt_input_absent` (recuperável) mesmo para transações mineradas com sucesso, impedindo a confirmação permanentemente.

**Correção:** `eth_getTransactionByHash` foi adicionado como chamada RPC separada. A calldata (`tx.input`) vem exclusivamente dessa chamada. `eth_getTransactionReceipt` continua sendo chamado separadamente para obter `receipt.status` e `receipt.blockNumber`.

### P0 — Verificação de salt por substring, não por offset fixo

A verificação de Fase 2.2 usava `.includes(saltHex)` na calldata completa. Isso é necessariamente verdadeiro para qualquer mint do GatewayMinter que contenha esse salt em qualquer posição. Um atacante que executasse um mint legítimo diferente com calldata que, por coincidência, contivesse os bytes do salt poderia usá-la para confirmar uma operação diferente — embora isso seja computacionalmente inviável para salts aleatórios de 32 bytes.

**Correção:** O salt é extraído no **offset fixo documentado** pelo código-fonte oficial da Circle (`TransferSpec.sol`). O `salt` está no offset 304 dentro de um `TransferSpec`, que está no offset 40 dentro de um `Attestation` (ou offset 8+40=48 para o primeiro elemento de um `AttestationSet`). O seletor `gatewayMint(bytes,bytes)` = `0x9fb01cc5` é verificado primeiro. O offset ABI do primeiro parâmetro é lido do calldata (não hardcoded), e o payload é extraído pelo comprimento declarado. O salt é comparado byte a byte no offset exato.

### Endereços GatewayMinter mainnet confirmados

Os endereços mainnet (`0x2222222d7164433c4C09B0b0D809a9b52C04C205`) estavam comentados/bloqueados pendentes verificação. Os docs oficiais da Circle (`developers.circle.com/gateway/references/contract-addresses.md`, consultados nesta sessão) confirmam o endereço em todas as chains mainnet suportadas. As entradas foram habilitadas. `GATEWAY_SPEND_BLOCKED = true` em `index.html` continua bloqueando execução real.

---

## Arquivos alterados

| Arquivo | Alteração |
|---|---|
| `functions/api/gateway/transfer.js` | Reescrita completa de `onRequestPostConfirm` (ver abaixo) |
| `tests/gateway-spend-service.test.js` | GSS17.5/15, GSS18.4–9/12–15 atualizados; GSS19 adicionado (14 novos testes) |
| `tests/gateway-fase18.test.js` | 1 teste atualizado (GSS18.4 behavior) |

### Mudanças em `onRequestPostConfirm`

| # | Item | Fase anterior | Fase 2.3 |
|---|---|---|---|
| 1 | Fonte do calldata | `receipt.input` (não garantido) | `tx.input` de `eth_getTransactionByHash` |
| 2 | Hash cross-check | ausente | `tx.hash === txHash` obrigatório |
| 3 | `tx.to` vs `receipt.to` | `receipt.to` | `tx.to` (fonte autoritativa) |
| 4 | Verificação de salt | substring search | offset fixo no `TransferSpec.salt` (offset 304) |
| 5 | Verificação de selector | ausente | `keccak256("gatewayMint(bytes,bytes)")[0..3]` = `0x9fb01cc5` |
| 6 | Magic bytes do payload | ausente | `0xff6fb334` (Attestation) ou `0x1e12db71` (AttestationSet) |
| 7 | `transaction.from` | não validado | não validado (correto: destinationCaller=0 permite qualquer caller, incluindo Forwarding Service) |
| 8 | `receipt` null (tx known) | `tx_not_found` | `tx_pending` (INDETERMINATE) |
| 9 | `tx` null (hash unknown) | n/a | `tx_not_found` (INDETERMINATE) |
| 10 | `GATEWAY_MINTER_ADDRESSES` mainnet | comentado/bloqueado | habilitado (confirmado em Circle docs) |

### Novos códigos de erro

| Código | HTTP | Recuperável | Descrição |
|---|---|---|---|
| `tx_hash_mismatch` | 502 | sim | RPC retornou tx com hash diferente do solicitado |
| `tx_pending` | 404 | sim | tx conhecida mas receipt ainda não disponível |
| `calldata_absent` | 502 | sim | `tx.input` ausente ou null |
| `calldata_too_short` | 502 | sim | calldata menor que mínimo para `gatewayMint` |
| `calldata_selector_mismatch` | 422 | não | transação não é uma chamada `gatewayMint` |
| `attestation_payload_too_short` | 502 | sim | payload menor que mínimo para um Attestation válido |
| `attestation_magic_unknown` | 502 | sim | primeiros 4 bytes não são `0xff6fb334` nem `0x1e12db71` |
| `rpc_chain_id_malformed` | 502 | sim | `eth_chainId` retornou valor não-hex |

---

## Testes executados e resultados

### Gateway + Portfolio batch (Fase 2.3)

```
tests/gateway-spend-service.test.js   221 testes  ✓ PASSOU
tests/gateway-fase18.test.js           19 testes  ✓ PASSOU
tests/gateway-fase2.test.js            44 testes  ✓ PASSOU
tests/gateway-balance.test.js          55 testes  ✓ PASSOU
tests/gateway-deposit.test.js          73 testes  ✓ PASSOU
tests/unified-portfolio.test.js        50 testes  ✓ PASSOU
TOTAL                                 462 testes  ✓ 462/462
```

### Regressão Swap/Bridge/LI.FI/RWA

```
tests/bridge-kit-router.test.js        22 testes  ✓
tests/bridge-multi-route.test.js       31 testes  ✓
tests/swap-chain-sync.test.js          55 testes  ✓
tests/swap-balance-fmt.test.js         16 testes  ✓
tests/lifi-enterprise.test.js          27 testes  ✓
tests/rwa-trading.test.js             166 testes  ✓
tests/balance-service.test.js          12 testes  ✓
TOTAL                                 329 testes  ✓ 329/329
```

### Falha pré-existente não alterada

`tests/arc-chain-availability.test.js` — lê `public/shared/policyEngine.js` (build artifact ausente). Falha presente antes da Fase 2.3. Não causada por esta fase.

---

## Riscos remanescentes

| Risco | Severidade | Status |
|---|---|---|
| `GATEWAY_SPEND_BLOCKED = true` em `index.html` | — | Bloqueio de execução real ainda ativo. Deve ser removido somente após validação completa end-to-end em testnet. |
| Salt verificado apenas na primeira attestation de um AttestationSet | Baixo | Para sets com múltiplas attestations, apenas a primeira é verificada. Se Circle suportar sets multi-operação no futuro, a lógica precisará iterar sobre todas as attestations. Por ora, Circle retorna sets apenas para o caso de múltiplas source chains para um único destino — um salt por operação. |
| `MAX_FEE_ATOMIC` como constante (não dinâmica) | Baixo | Documentado como teto pré-autorizado, não cotação em tempo real. Se Circle alterar fees significativamente, o teto precisará de atualização manual. |
| GatewayMinter mainnet habilitado mas execução bloqueada | Info | `GATEWAY_MINTER_ADDRESSES` agora inclui mainnet conforme docs Circle. Execução real permanece bloqueada via `GATEWAY_SPEND_BLOCKED`. |
| `GATEWAY_OPS_KV`, `GATEWAY_OP_LOCK`, `DO_INTERNAL_SECRET`, `GATEWAY_RPC_URLS` | Alto | Infraestrutura CF ainda não configurada. Gateway não funcional em produção até estas configurações serem aplicadas no CF Dashboard. |

---

## Critérios de aceite — verificação

| Critério | Status |
|---|---|
| 1. Calldata da transação correta (não do receipt) | ✓ `eth_getTransactionByHash` |
| 2. Nenhuma operação confirmada sem associação confiável ao intent | ✓ Offset fixo + selector + magic |
| 3. Inconclusivos nunca viram `failed` automaticamente | ✓ `tx_pending`, `attestation_magic_unknown`, etc. são recuperáveis |
| 4. Testes sem regressões | ✓ 462+329 = 791/791 |
| 5. Relatório com causa raiz, arquivos, testes, resultados, riscos | ✓ Este documento |
