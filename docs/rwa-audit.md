# RWA Advanced Trading — Auditoria Pós-Implementação

**Data:** 2026-10-21  
**Escopo:** `index.html` (namespace `rwa`), `functions/api/lifi/routes.js`, `tests/rwa-trading.test.js`  
**Referência:** https://docs.li.fi/enterprise/real-world-assets

---

## Arquivos e linhas auditados

| Arquivo | Linhas / Escopo |
|---|---|
| `index.html` | Bloco JS `rwa` (~45 000 chars), funções `rwaFetchQuote`, `rwaConfirmTrade`, `rwaExecuteTrade`, `rwaRenderHistory`, `_rwaRecord`, `_rwaUpdateStatus`, `_rwaSafeTxHash`, `_rwaSafeExplorer` |
| `shared/LiFiAdapter.js` | `getRoutes`, `getStepTransaction`, `validateRoute`, `getStatus` (507 linhas, leitura integral) |
| `functions/api/lifi/routes.js` | `onRequestPost` (127 linhas, leitura integral) |
| `functions/api/lifi/tokens.js` | `onRequestGet` (107 linhas, leitura integral) |
| `functions/api/lifi/quote.js` | referenciada indiretamente via `LiFiAdapter.getQuote` (não chamado diretamente pelo RWA) |
| `tests/rwa-trading.test.js` | 97 testes estruturais + novos testes de auditoria |

---

## Defeitos encontrados e corrigidos

### D1 — CRÍTICO: Perda de precisão em `amtRaw` para tokens com 18 decimais

**Evidência:**  
`var amtRaw = BigInt(Math.round(amt * Math.pow(10, decimals)));`  
`Number.MAX_SAFE_INTEGER ≈ 9.007×10¹⁵`. Para `amt = 1.123456789012345` com 18 decimais, o produto `1.123... × 10¹⁸ = 1 123 456 789 012 345 000` tem 19 dígitos — acima da precisão do `Number`, causando arredondamento silencioso. A transação seria assinada com um valor diferente do digitado pelo usuário.

**Correção:**  
Substituído por conversão string-split que separa parte inteira e fracionária antes de elevar a BigInt, eliminando qualquer arredondamento:
```js
var amtRaw = (function(a, d) {
  var s = String(a);
  var dot = s.indexOf('.');
  if (dot === -1) return BigInt(s) * (10n ** BigInt(d));
  var intPart = s.slice(0, dot) || '0';
  var fracPart = s.slice(dot + 1);
  if (fracPart.length > d) fracPart = fracPart.slice(0, d); // trunca, não arredonda
  while (fracPart.length < d) fracPart += '0';
  return BigInt(intPart) * (10n ** BigInt(d)) + BigInt(fracPart);
})(amt, decimals);
```

---

### D2 — CRÍTICO: Policy block da LI.FI não detectado de `unavailableRoutes.filteredOut`

**Evidência:**  
Per docs LI.FI: `POST /v1/advanced/routes` retorna **HTTP 200** com `routes: []` e `unavailableRoutes.filteredOut[].reason` quando a política está `declined`. O código anterior tratava `routes.length === 0` como "sem liquidez" genérico, nunca mostrando a mensagem correta sobre o Partner Portal.

**Correção:**  
`rwaFetchQuote` inspeciona `routeRes.unavailableRoutes.filteredOut` e detecta policy block via `reason.toLowerCase().includes('rwa') || .includes('policy')`. Conforme docs, o texto da razão é diagnóstico legível por humanos — não é comparado como enum.

---

### D3 — CRÍTICO: `validateRoute` recebia `null` como `fromToken` para USDC

**Evidência:**  
`_rwaFromToken.address = null` para tokens selecionados pelo símbolo (USDC, USDT, ETH) — o endereço só existe no `TOKEN_REGISTRY` ou via `getTokenAddressForChain`. O código anterior passava `_rwaFromToken && _rwaFromToken.address` (null) diretamente para `validateRoute`, que comparava `undefined` com `null` e retornava `from_token_mismatch` — bloqueando todas as execuções com USDC como origem.

**Correção:**  
`rwaExecuteTrade` resolve os endereços reais antes de chamar `validateRoute`, usando `getTokenAddressForChain` como fallback — exatamente como `rwaFetchQuote` já fazia.

---

### D5 — MÉDIO: Trade cross-chain marcado `done` após recibo da origem

**Evidência:**  
`tx.wait()` confirma apenas a transação de origem. Para rotas cross-chain (`fromChainId !== toChainId`), a ponte ou o intent pode falhar no destino. O código anterior definia `status = 'done'` quando `receipt.status === 1`, independente do tipo de rota.

**Correção:**  
Para cross-chain, o status fica `pending` após o recibo de origem. O toast informa "Waiting for cross-chain completion". `rwaRefreshHistoryStatus` (que chama `LiFiAdapter.getStatus`) se encarrega de atualizar para `done` ou `failed` ao reconciliar os pendentes.

---

### D6 — MÉDIO: Cotação expirada aceita em `rwaConfirmTrade`

**Evidência:**  
`_rwaCurrentQuote` era definido em `rwaFetchQuote` sem timestamp. O usuário poderia esperar vários minutos e clicar "Confirm" com uma cotação de > 60s. `LiFiAdapter` define `QUOTE_TTL_MS = 60000` para o mesmo motivo.

**Correção:**  
`_rwaCurrentQuote._quoteFetchedAt = Date.now()` é adicionado em `rwaFetchQuote`. `rwaConfirmTrade` rejeita cotações com `Date.now() - _quoteFetchedAt > 60000`, nulifica o quote e re-executa `rwaFetchQuote` automaticamente.

---

### D7 — BAIXO: Proxy `routes.js` descartava `unavailableRoutes`

**Evidência:**  
`return json({ ok: true, routes: data.routes || [], count: ... })` — `data.unavailableRoutes` era perdido no proxy, impossibilitando a detecção D2 no cliente.

**Correção:**  
```js
const unavailableRoutes = data.unavailableRoutes || null;
return json({ ok: true, routes, count: routes.length, unavailableRoutes }, 200, env, request);
```

---

## Resultados dos testes

| Suite | Antes da auditoria | Após correções | Delta |
|---|---|---|---|
| `rwa-trading.test.js` | 72/72 | **97/97** | +25 novos testes de auditoria |
| 7 suites existentes (bridge + swap + lifi) | 312/312 | **312/312** | 0 |
| **Total alvo** | **384/384** | **409/409** | +25 |
| Novas falhas introduzidas | — | **0** | — |

As 47 falhas preexistentes do projeto permanecem inalteradas (confirmado por comparação com baseline `1eb497f`).

---

## Fluxos validados (evidências estruturais — sem carteira real disponível no sandbox)

| Fluxo | Evidência |
|---|---|
| Cotação usa `LiFiAdapter.getRoutes` | Verificado em `rwaFetchQuote`: chama `LiFiAdapter.getRoutes` com `fromAddress: walletAddress`, `toAddress: walletAddress`, sem `integrator` inline (delegado ao adapter) |
| `getStepTransaction` chamado antes da assinatura | Verificado: `LiFiAdapter.getStepTransaction(firstStep)` executado antes de `signer.sendTransaction` |
| `validateRoute` verifica `to`, `data`, `chainId`, `sender`, `value`, `recipient` | Verificado em `LiFiAdapter.validateRoute` (507 linhas): todos os campos validados com fail-close |
| ERC-20 approval verificada antes de assinar | `erc20.allowance(walletAddress, approvalAddress)` comparada com `amtRaw` antes de `approve` |
| Execução requer `walletProvider` real | Sem `walletProvider`, mostra erro e não chama `signer.sendTransaction` |
| Confirmação explícita do usuário | Modal aberto em `rwaConfirmTrade`, execução só em `rwaExecuteTrade` (botão separado) |
| Nenhuma chave exposta no frontend | `LIFI_API_KEY` permanece server-side; frontend só usa `credentials: 'same-origin'` |

---

## Limitações de acesso RWA (inalteradas)

1. **LI.FI Partner Portal**: política deve ser `accepted` ou `pending` (não `declined`) para rotas RWA serem retornadas.
2. **Elegibilidade por endereço**: ativos permissionados (Ondo, etc.) verificam o endereço do destinatário onchain. O código passa `walletAddress` real como `toAddress` em todas as chamadas.
3. **Cobertura de tokens**: lista dinâmica via `/api/lifi/tokens` com filtro `tags.includes('rwa')` — não hardcodada.
4. **Validação on-chain real**: não foi possível executar transações reais nesta sessão (sem carteira conectada no sandbox). Os fluxos foram validados estruturalmente; testes funcionais completos requerem ambiente com carteira + saldo + API key configurada.

---

## Arquivos alterados nesta auditoria

| Arquivo | Mudanças |
|---|---|
| `index.html` | D1: amtRaw precision fix; D2: unavailableRoutes policy detection; D3: validateRoute address resolution; D5: cross-chain pending status; D6: quote TTL check + stamp |
| `functions/api/lifi/routes.js` | D7: propaga `unavailableRoutes` na resposta |
| `tests/rwa-trading.test.js` | +25 testes de auditoria (A1–A7); janelas de extração uniformizadas para 50000 chars; N6 atualizado para D1-fix |
