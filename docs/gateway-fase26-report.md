# Gateway Fase 2.6 — Relatório Final

**Data:** 25 outubro 2026
**Baseline:** 821 testes passando (Fase 2.5)
**Resultado:** 833/833 passando (+12 novos GSS22) — zero regressões

---

## Causa raiz dos gaps auditados

### P0 — `receipt.transactionHash` ausente tratado como tolerável (Fase 2.4–2.5)

Linha 988 (antes desta Fase): `const receiptTxHash = (receipt.transactionHash || receipt.hash || '').toLowerCase()`. Se ambos os campos estivessem ausentes, `receiptTxHash = ''` era falsy → o `if (receiptTxHash && ...)` era pulado silenciosamente. Um RPC que omite `transactionHash` passava sem verificação de vínculo.

**Correção:** Se `receipt.transactionHash` e `receipt.hash` ambos ausentes → `receipt_tx_hash_absent` (502, recuperável). A ausência é indistinguível de um RPC que retornou o receipt errado.

### P1 — `parseInt` em vez de `BigInt` para offsets e comprimentos ABI

Fase 2.4 usava `parseInt(hex, 16)` com guards explícitos. Funcionalmente correto dentro dos bounds, mas divergia do requisito da Fase 2.6 ("use BigInt for offsets and lengths").

**Correção:** Todos os offsets (`param0Offset`) e comprimentos (`payloadLen`, `numAttestations`) agora parseados via `BigInt('0x' + ...)`, bounded como BigInt antes de qualquer multiplicação, depois convertidos a `Number` apenas após confirmação de que o valor é seguro (≤ bound bem abaixo de `Number.MAX_SAFE_INTEGER`).

### Config — `wrangler.jsonc` sem stubs de GATEWAY_OPS_KV e GATEWAY_OP_LOCK

O arquivo existente não tinha comentários ou stubs para os bindings Gateway, tornando o onboarding de infra ambíguo.

**Correção:** `wrangler.jsonc` reescrito com LF (era CRLF, impossibilitando edições via `edit_file`), adicionando:
- Stub comentado de `GATEWAY_OPS_KV` (descomente + preencha ID)
- Instruções completas para `GATEWAY_OP_LOCK` Worker separado, `DO_INTERNAL_SECRET`, `GATEWAY_RPC_URLS`, `GATEWAY_ENV`

---

## Arquivos alterados

| Arquivo | Mudança |
|---|---|
| `functions/api/gateway/transfer.js` | P0: `receipt_tx_hash_absent` para campo ausente; P1: BigInt para offsets/comprimentos ABI |
| `wrangler.jsonc` | Reescrito (LF), stubs GATEWAY_OPS_KV e GATEWAY_OP_LOCK |
| `tests/gateway-spend-service.test.js` | GSS22 (+12 testes); GSS18/19/20 mocks atualizados com `transactionHash` |

---

## Bloqueios remanescentes para liberar `GATEWAY_SPEND_BLOCKED`

Todos são de infraestrutura CF, não de segurança do código:

| # | Item | Ação necessária |
|---|---|---|
| B1 | `GATEWAY_OPS_KV` KV namespace | Criar em CF Dashboard → KV, preencher ID no wrangler.jsonc stub, re-deploy |
| B2 | `GATEWAY_OP_LOCK` DO Worker | Criar Worker separado exportando `GatewayOpLock`, vincular via CF Dashboard → Pages → Settings → Functions → DO bindings |
| B3 | `DO_INTERNAL_SECRET` | Gerar com `openssl rand -hex 32`, configurar em CF Dashboard → Pages → Settings → Environment variables (Production) |
| B4 | `GATEWAY_RPC_URLS` | Configurar JSON map `{"chainId":"rpcUrl",...}` em CF Dashboard → Pages → Settings → Environment variables (Production) |
| B5 | `GATEWAY_ENV=production` | Configurar em CF Dashboard → Pages → Settings → Environment variables (Production) |

Após B1–B5 configurados e verificados em produção: remover `GATEWAY_SPEND_BLOCKED = true` de `index.html`.

---

## Riscos remanescentes (P2 — não bloqueadores de segurança)

1. **Salt decoded at fixed offset** — verifica que o salt está no `TransferSpec.salt` da primeira attestation. Não valida os outros campos do `TransferSpec` (value, tokens, domínios). Um attestation legítimo com salt correto mas valor diferente passaria. Mitigação: o Circle API valida o conteúdo antes de emitir a attestation; o salt é único por operação (32 bytes aleatórios); o minterAddr + chainId estão vinculados. Risco residual: baixo.

2. **`tryRead` DO 401 → null** — falha de auth no DO em leituras é silenciada como "não encontrado". Poderia esconder configuração incorreta de `DO_INTERNAL_SECRET` em reads. Não exploitável (404 é seguro); porém dificulta diagnóstico. Mitigação futura: logar erro interno sem expor ao cliente.

3. **Sem TTL de operações em `submitting`** — uma operação reservada mas nunca atualizada fica como `submitting` indefinidamente no DO. Mitigação futura: CF DO alarm para TTL de 24h.

---

## Confirmação

`GATEWAY_SPEND_BLOCKED = true` permanece ativo. O código está seguro para produção; apenas os 5 itens de infraestrutura CF bloqueiam a liberação.
