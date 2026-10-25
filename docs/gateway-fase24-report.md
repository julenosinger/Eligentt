# Gateway Fase 2.4 — Relatório Final

**Data:** 2026-10-25  
**Arquivo alterado:** `functions/api/gateway/transfer.js`  
**Arquivo de testes alterado:** `tests/gateway-spend-service.test.js`  
**`GATEWAY_SPEND_BLOCKED`:** permanece `true` em `index.html`

---

## Causa raiz dos gaps identificados no commit 9b49794

### P0.1 — Receipt não vinculado ao txHash solicitado
`eth_getTransactionReceipt` pode retornar um recibo para um hash diferente do solicitado se o RPC estiver
mal configurado ou for malicioso. O campo `receipt.transactionHash` nunca era verificado. Um atacante com
controle do endpoint RPC poderia retornar o recibo de outra transação bem-sucedida (mesmo contrato, intent
diferente) e — com a validação anterior limitada ao `receipt.status` — confirmar uma operação que não
correspondesse à transação real.

### P0.1b — Inconsistência de `blockNumber` ignorada
`tx.blockNumber` (de `eth_getTransactionByHash`) e `receipt.blockNumber` (de `eth_getTransactionReceipt`)
devem ser idênticos quando ambos estão presentes. Ausência de verificação permitia que respostas
inconsistentes passassem silenciosamente.

### P0.2a — `payloadLen` lido com `parseInt` sem limite superior
`parseInt('ffffffff...', 16)` retorna um Number impreciso para valores próximos de `Number.MAX_SAFE_INTEGER`.
O check `calldata.length < payloadStart + payloadLen * 2` poderia passar incorretamente para lengths
absurdas (ex: `0xffffffff` → ~4 GB), pois `payloadLen * 2` transborda a representação de inteiro do JS
antes de ser comparado com o tamanho real da string.

### P0.2b — `param0Offset` sem limite superior
Um `param0Offset` de `0x7fffffff` produz `payloadLenOffset = (4 + 2147483647) * 2 = 4294967302`. Essa
operação ultrapassa `Number.MAX_SAFE_INTEGER / 2` em multiplicidade, introduzindo imprecisão na aritmética
de ponteiro antes da extração do payload.

### P0.2c — `AttestationSet` sem validação de `numAttestations`
Para o formato `AttestationSet`, o campo `numAttestations` (bytes 4–7 do payload) era ignorado. Um payload
com `numAttestations = 0` mas dados suficientes passaria pela verificação de tamanho mínimo (388 bytes), e
o salt seria extraído do offset 352 — que pertenceria a dados indefinidos, não a um `TransferSpec` real.

### P0.2d — `MIN_PAYLOAD_BYTES` definido dentro da função
A constante `380` era definida dentro de `onRequestPostConfirm` em vez de no nível do módulo, e o mesmo
valor era usado para Attestation e AttestationSet (mínimos diferentes: 380 vs 388 bytes).

### P1 — Salt lido além dos limites declarados do payload
Após o `payloadLen` ser validado como presente no calldata, o salt era extraído no offset fixo sem verificar
se `saltOffsetInPayload + 32 ≤ payloadLen`. O salt poderia ser extraído de bytes de padding ABI ou da
assinatura adjacente — dados que não fazem parte da attestation — passando como prova de linkage.

---

## Correções aplicadas

### `functions/api/gateway/transfer.js`

#### Novas constantes de módulo
```
MIN_PAYLOAD_BYTES_SINGLE = 380   // Attestation mínima
MIN_PAYLOAD_BYTES_SET    = 388   // AttestationSet mínimo
ABI_MAX_PARAM_OFFSET     = 4096  // limite de segurança para param0Offset
ABI_MAX_PAYLOAD_LEN      = 262144 // 256 KB, limite de segurança para payloadLen
```

#### Steps 5b e 5c: cross-check de receipt
- **Step 5b**: `receipt.transactionHash` normalizado para lowercase e comparado com `txHash` solicitado.
  Ausência (`null`, `''`) é tolerada (alguns RPCs omitem o campo em receipts antigos). Divergência →
  `receipt_tx_hash_mismatch` (502, recuperável).
- **Step 5c**: `tx.blockNumber` vs `receipt.blockNumber` são comparados como strings (evita coerção).
  Qualquer um ausente → skip (sem ambos, não há inconsistência verificável). Divergência →
  `block_number_mismatch` (502, recuperável).

#### Decodificação ABI segura (P1)
1. `param0Offset` verificado contra `ABI_MAX_PARAM_OFFSET` antes de qualquer multiplicação.
   Erro → `abi_offset_out_of_bounds` (502, recuperável).
2. `payloadLen` verificado contra `ABI_MAX_PAYLOAD_LEN` antes de qualquer uso.
   Erro → `abi_payload_len_out_of_bounds` (502, recuperável).
3. Verificação separada de truncamento: `calldata.length < payloadStart + payloadLen * 2` →
   `attestation_payload_truncated` (502, recuperável). Distingue "payload ausente" de "payload curto".

#### Validação estrutural por formato (P0.2)
- **Attestation**: `payloadLen < MIN_PAYLOAD_BYTES_SINGLE` → `attestation_payload_too_short`.
- **AttestationSet**:
  - `payloadLen < MIN_PAYLOAD_BYTES_SET` → `attestation_payload_too_short`.
  - `numAttestations` lido dos bytes 4–7 do payload; `numAttestations < 1` → `attestation_set_empty` (502, recuperável).
  - Magic da primeira attestation verificado contra `ATTESTATION_MAGIC` → `attestation_set_first_magic_unknown`.

#### Salt dentro dos limites declarados (P0.2)
Após determinar `saltOffsetInPayload`:
```
if (saltOffsetInPayload + 32 > payloadLen) → salt_outside_payload_bounds (502, recuperável)
```
Garante que os 32 bytes do salt estão integralmente dentro dos bytes declarados da attestation,
não no padding ABI ou nos dados de assinatura adjacentes.

---

## Testes executados e resultados

### Gateway + Portfolio (incluindo GSS20)
```
tests/gateway-spend-service.test.js   236 tests  ✓ (GSS1–GSS20, 15 novos em GSS20)
tests/gateway-fase18.test.js           19 tests  ✓
tests/gateway-fase2.test.js            44 tests  ✓
tests/gateway-balance.test.js          55 tests  ✓
tests/gateway-deposit.test.js          73 tests  ✓
tests/unified-portfolio.test.js        50 tests  ✓
─────────────────────────────────────────────────
Total                                 477/477    ✓
```

### Regressão Swap/Bridge/LI.FI/CCTP
```
tests/bridge-kit-router.test.js        22 tests  ✓
tests/bridge-multi-route.test.js       31 tests  ✓
tests/swap-chain-sync.test.js          55 tests  ✓
tests/swap-balance-fmt.test.js         16 tests  ✓
tests/lifi-enterprise.test.js          27 tests  ✓
tests/rwa-trading.test.js             166 tests  ✓
tests/balance-service.test.js          12 tests  ✓
─────────────────────────────────────────────────
Total                                 329/329    ✓
```

**Zero novas falhas. Baseline de 64 falhas pré-existentes inalterado.**

### Falhas pré-existentes (não causadas por esta fase)
As mesmas 64 falhas registradas desde a Fase 1: `arc-chain-availability.test.js` (lê artefato de build
`public/shared/policyEngine.js` ausente no sandbox), `fase3-ui`, `unified-balance`, `network-selector`,
`billing-*` (dependências de Workers/DO não disponíveis no ambiente de testes locais). Nenhuma alterada.

---

## Comparação com baseline anterior (Fase 2.3)

| Métrica | Fase 2.3 | Fase 2.4 |
|---|---|---|
| Gateway total | 462 | 477 (+15 GSS20) |
| Regressão Swap/Bridge | 329 | 329 |
| Novas falhas | 0 | 0 |
| Falhas pré-existentes | 64 | 64 |

---

## Riscos remanescentes

1. **Prova criptográfica da attestation é estrutural, não de assinatura**: a verificação confirma que o
   `salt` está no offset correto dentro de uma estrutura bem formada. A assinatura ECDSA da attestation não
   é verificada no servidor (requereria a chave pública do Circle). Mitigação: o `minterAddr` verificado é
   o contrato oficial do Circle; o contrato verifica a assinatura on-chain antes de executar o mint.
   A verificação do servidor é uma camada adicional de rastreabilidade, não a única linha de defesa.

2. **`numAttestations > 1` em AttestationSet**: apenas a primeira attestation é verificada. Um payload com
   múltiplas attestations é aceito desde que a primeira contenha o salt correto. Isso está correto para o
   fluxo atual (cada operação tem um único TransferSpec com um salt único), mas deve ser revisado se o
   Circle introduzir batching de múltiplas operações em um único `gatewayMint`.

3. **`GATEWAY_SPEND_BLOCKED = true`**: execução real do Gateway permanece bloqueada. Esta fase não altera
   essa restrição. A decisão de habilitar requer autorização explícita fora deste escopo.

4. **GatewayMinter mainnet endereço `0x2222222d7164433c4C09B0b0D809a9b52C04C205`**: confirmado via fonte
   oficial Circle GitHub. Mantido ativo para os chains suportados. World Chain (480) incluído.

---

## Arquivos alterados nesta fase

- `functions/api/gateway/transfer.js` — onRequestPostConfirm: Steps 5b, 5c, P1 ABI safety, P0.2 attestation bounds
- `tests/gateway-spend-service.test.js` — GSS17.6 window, GSS20 (15 novos testes)
