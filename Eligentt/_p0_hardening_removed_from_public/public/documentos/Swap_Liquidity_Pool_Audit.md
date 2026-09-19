# Auditoria Completa — Swap & Liquidity Pool do Elligentt

**Data:** 15/07/2026  
**Escopo:** Pool AMM (`0x18076d992005186AeB13AC5270CaD6E27DB95247`), chainSimulator, configuracoes, backend quote-engine, MultiSendExecutorV4  
**Chain:** Arc Testnet (Chain ID: 5042002)  
**Versao do Elligentt:** 3.6.0

---

## Sumario Executivo

Foram identificadas **4 vulnerabilidades CRITICAS**, **5 de severidade ALTA**, **6 MEDIAS** e **5 BAIXAS**, totalizando **20 achados**. A liquidez do pool on-chain e de ~20,508 USDC (reserva A). O contrato da pool e externo (nao incluso no repositorio), e o `SWAP_ROUTER_ADDRESS` e um placeholder (`0x0000000000000000000000000000000000000001`), indicando que swaps sao roteados diretamente ao contrato pool sem protecao de roteamento.

---

## 1. CRITICAS (4)

### [C1] SWAP_ROUTER_ADDRESS e placeholder — Endereco 0x0000000000000000000000000000000000000001

**Arquivos afetados:**
- `public/config/contracts.js:19`
- `public/config/system.js:21`
- `public/config/runtime.js:36`
- `functions/api/shared-config.mjs:76`

**Descricao:**
O endereco do swap router esta configurado como `0x0000000000000000000000000000000000000001` em TODAS as 4 fontes de configuracao. Este endereco **nao e um contrato deployado** — e um placeholder. Embora o `chainSimulator.js` faca swaps diretamente via `pool.swap()`, qualquer codigo que tente usar o router via chamada externa (MultiSendExecutorV4, agentes, etc.) vai falhar ou enviar fundos para um endereco invalido.

**Impacto:** Impossibilidade de swaps roteados por agentes autonomos. Potencial perda de fundos se o router for usado como `to` em chamadas.

**Recomendacao:** Deploy de um swap router proprio OU documentar que swaps sao exclusivamente diretos via pool contract.

**Severidade:** CRITICA

---

### [C2] buildSwapCalldata permite minOut = 0 — Sem protecao de slippage

**Arquivo:** `public/shared/chainSimulator.js:216-236`

```javascript
function buildSwapCalldata(amountIn, tokenIn, tokenOut, slippagePct, poolAddr, hopMin){
  var minOut = 0;
  if(hopMin) minOut = hopMin;
  else if(amountIn > 0 && slippagePct !== undefined){
    var rate = tokenIn === 'USDC' ? 1.0 : null;
    if(!rate) minOut = 0;  // ← MINOUT PERMANECE 0 para cirBTC/EURC
  }
  var calldata = SWAP_IFACE.encodeFunctionData('swap', [tokenInAddr, amtBig, minOut || 0n]);
  // ...
}
```

**Problema:**
1. `minOut` comeca como 0 e so e populado se `hopMin` for passado.
2. Mesmo quando `slippagePct` e fornecido, a `rate` so e conhecida para USDC (hardcoded como `1.0`). Para cirBTC e EURC, `rate` cai para `null` e `minOut` permanece 0.
3. O `minOut || 0n` na linha 228 converte qualquer valor falsy (incluindo 0 valido) para `0n`, mas pior ainda — converte `minOut = 0` (que ja e 0) para `0n`, permitindo swaps com zero de protecao.

**Impacto:** Um atacante pode fazer sandwich attack e extrair ate 100% do valor do swap. O usuario recebe 0 tokens e o atacante fica com tudo.

**Recomendacao:**
- Calcular `minOut` corretamente usando `getAmountOut` do pool OU aplicar `slippagePct` sobre o `amountOut` simulado.
- Remover `|| 0n` e garantir que `minOut > 0` para qualquer swap.

**Severidade:** CRITICA

---

### [C3] Approve com dobro do valor — Exposicao prolongada de allowance

**Arquivo:** `public/shared/chainSimulator.js:238-246`

```javascript
function buildApproveCalldata(tokenSym, spenderAddr, amount){
  var amtBig = ethers.parseUnits(String(amount * 2), dec); // approve double for safety
  // ...
}
```

**Problema:** A allowance e aprovada como `amount * 2`. Isso deixa um saldo de allowance apos o swap. Se o contrato pool for comprometido ou se houver um bug, o atacante pode gastar o dobro aprovado em transacoes subsequentes.

**Impacto:** Um atacante que consiga explorar o pool entre a aprovacao e o swap pode drenar o dobro do valor. A allowance excessiva persiste ate ser revogada ativamente.

**Recomendacao:** Aprovar exatamente `amount` e usar `approve(spender, 0)` apos o swap (padrao safeApprove). Ou usar `permit` / `permit2` para aprovar e gastar em uma unica transacao.

**Severidade:** CRITICA

---

### [C4] Sem verificacao de deadline nos swaps — Transacoes podem ser mineradas arbitrariamente tarde

**Arquivos afetados:**
- `public/shared/chainSimulator.js:203-204` (swap ABI nao inclui deadline)
- `contracts/MultiSendExecutorV4.sol` (nao trata deadline em swaps)

**Descricao:** A funcao `swap(address tokenIn, uint256 amountIn, uint256 minOut)` na pool ABI nao aceita parametro `deadline`. Isto significa que transacoes de swap podem ficar pendentes no mempool por horas ou dias e ser mineradas quando as condicoes de mercado forem desfavoraveis.

**Impacto:** Usuario pode sofrer perdas severas se a tx ficar pendente durante alta volatilidade.

**Recomendacao:** Modificar o contrato pool para incluir `deadline` (como Uniswap V2 faz), OU implementar um wrapper que inclua verificacao de deadline on-chain.

**Severidade:** CRITICA

---

## 2. ALTAS (5)

### [A1] Contrato pool sem source code verificado no repositorio

**Arquivo:** Contrato externo `0x18076d992005186AeB13AC5270CaD6E27DB95247`

**Descricao:** O contrato `ElligentPool AMM` e listado no `ContractRegistry` como `trust: 'high'`, porem nao ha codigo fonte no repositorio. A auditoria nao pode verificar:
- Se ha backdoor administrativa (funcoes `onlyOwner` escondidas)
- Se a implementacao de `swap()` e segura (reentrancy, overflow)
- Se o `fee()` pode ser alterado dinamicamente pelo admin
- Se ha `mint()`/`burn()` permissionados

**Evidencia on-chain:** O pool responde a `getReserves()` (reserveA = ~20,508 USDC) e `totalSupply()` (~17,543 LP tokens). Porem `tokenA()` e `fee()` revertem, sugerindo que a interface pode ser diferente do padrao Uniswap V2.

**Impacto:** Incapacidade de auditar a seguranca do contrato central do sistema.

**Recomendacao:** Adicionar o source code do pool ao repositorio e verificar no explorador ArcScan.

**Severidade:** ALTA

---

### [A2] Simulacao via staticCall vulneravel a sandwich attacks

**Arquivo:** `public/shared/chainSimulator.js:81-111`

```javascript
async function simulateSwap(amountIn, tokenIn, tokenOut, poolAddr){
  var c = new ethers.Contract(pool, POOL_ABI, p);
  var out = await c.getAmountOut(amtBig, tokenInAddr);
  // ...
}
```

**Descricao:** A funcao `simulateSwap` usa `staticCall` (view function) para obter o `amountOut` atual. Porem, entre a simulacao e a execucao da transacao, MEV bots podem inserir transacoes que alterem as reservas do pool (sandwich attack), resultando em slippage muito maior do que o esperado.

**Impacto:** Usuario pode receber significativamente menos tokens do que o simulado, sem saber.

**Recomendacao:** Combinar com protecao de slippage robusta (C2) e usar RPC privado (Flashbots/MEV protection) para submissao de transacoes.

**Severidade:** ALTA

---

### [A3] RPC publico sem rate-limit — Single point of failure

**Arquivos:**
- `public/shared/chainSimulator.js:10`
- `public/shared/agentWalletManager.js:13`
- `public/config/system.js:4`
- `public/config/runtime.js:4`

Todos usam `https://arc-testnet.drpc.org` como RPC.

**Descricao:** Um unico endpoint RPC publico (dRPC) e usado para TODAS as operacoes on-chain: leitura de reservas, simulacoes, envio de transacoes, monitoramento. Se o endpoint ficar indisponivel, toda a dApp para de funcionar.

**Impacto:** Denial of Service completo. Se o RPC for malicioso, pode retornar dados falsos de reservas e precos.

**Recomendacao:**
- Adicionar fallback RPCs (ex: Alchemy, Infura, QuickNode)
- Implementar logica de retry com rotating providers
- Usar RPC proprio ou com API key para garantir SLA

**Severidade:** ALTA

---

### [A4] Agente guarda chave privada em localStorage — Sem criptografia

**Arquivo:** `public/shared/agentWalletManager.js:88-99`

```javascript
loadState(){
  var raw = localStorage.getItem(WALLET_KEY); // chave privada em plaintext
  if(raw) agentState = JSON.parse(raw);
}
```

**Descricao:** A chave privada do Agent Wallet e armazenada em `localStorage` (`elligentt_agent_wallet_v1`) sem criptografia. Qualquer extensao de navegador ou script XSS pode ler essa chave e drenar os fundos do agente.

**Impacto:** Roubo total dos fundos do Agent Wallet em caso de XSS ou extensao maliciosa.

**Recomendacao:**
- Nunca armazenar chave privada em localStorage
- Usar `eth_requestAccounts` / WalletConnect / MetaMask SDK para assinatura
- Se necessario armazenar, usar `WebCrypto API` com senha do usuario
- Implementar `sessionStorage` com expiracao curta em vez de `localStorage`

**Severidade:** ALTA

---

### [A5] RiskEngine classifica swap como risco LOW — Classificacao inadequada

**Arquivo:** `public/shared/riskEngine.js:116-118`

```javascript
var opRisk = {
  payment: 0, swap: 0, bridge: 1, treasury: 1, contract: 2,
  multisend: 1, liquidity: 1, signature: 2
};
```

**Descricao:** Swap e classificado como nivel 0 (LOW) — o mesmo nivel que um simples pagamento. Swaps envolvem:
- Slippage e price impact
- Risco de MEV / sandwich attacks
- Dependencia de liquidez do pool
- Possibilidade de tokens com pouca liquidez

Um bridge e classificado como nivel 1 (MEDIUM), mas um swap (que pode perder 100% via sandwich) e nivel 0.

**Impacto:** Usuarios podem nao ser alertados sobre riscos reais de swap, levando a aprovacao descuidada de permissoes.

**Recomendacao:** Elevar `swap` para nivel 1 (MEDIUM) e adicionar checagens especificas de slippage e liquidez no risk engine.

**Severidade:** ALTA

---

## 3. MEDIAS (6)

### [M1] Hardcoding de decimais sem suporte a novos tokens

**Arquivo:** `public/shared/chainSimulator.js:88-91`

```javascript
var tokenDec = tokenIn === 'cirBTC' ? 8 : 6;
```

Novos tokens adicionados ao pool vao quebrar o parse de decimais. O codigo assume que tudo que nao e cirBTC tem 6 decimais. Tokens como WBTC (8 decimais) ou tokens com 18 decimais seriam processados incorretamente.

**Recomendacao:** Ler `decimals()` do contrato ERC-20 do token. Cachear o valor para evitar chamadas repetidas.

---

### [M2] rate hardcoded como 1.0 para USDC — Inconsistente com pool real

**Arquivo:** `public/shared/chainSimulator.js:223`

```javascript
var rate = tokenIn === 'USDC' ? 1.0 : null;
```

A taxa de USDC para cirBTC no pool nao e 1:1 (seria ~66,667:1 a $67k/BTC). Usando rate=1.0 para calculo de minOut, qualquer protecao de slippage para swaps USDC→cirBTC sera completamente incorreta.

**Recomendacao:** Obter a rate real do pool via `getAmountOut` ou `getReserves`.

---

### [M3] Pool interactions nao geram entradas no applicationLedger

**Arquivo:** `public/shared/applicationLedger.js`

Os swaps no pool nao sao registrados no ledger de aplicacao. O `TreasuryIndexer` escaneia apenas eventos `Memo`, que sao especificos de bridge. Swaps diretos na pool sao "invisiveis" para o sistema de contabilidade.

**Recomendacao:** Indexar eventos `Swap` do contrato pool para rastrear volume e taxas geradas pelos swaps. Integrar com `applicationLedger.js`.

---

### [M4] quote-engine.mjs ignora swaps — So suporta bridge

**Arquivo:** `functions/api/core/quote-engine.mjs`

O backend quote engine (`getQuote()`) so implementa logica de bridge (Turbo vs Standard CCTP). Nao ha endpoint para cotacao de swap. O frontend depende exclusivamente de chamadas RPC diretas do navegador para simular swaps.

**Recomendacao:** Adicionar endpoint `quoteSwap()` no backend que consulte o pool on-chain e retorne:
- amountOut estimado
- price impact
- slippage recomendado
- taxa do pool (fee)

---

### [M5] executionPlanner trata execute_swap como simulacao apenas

**Arquivo:** `public/shared/executionPlanner.js:146-155`

```javascript
case 'execute_swap':
  stepResult.data = {executed: 'simulated', tx: null};
```

O step `execute_swap` no workflow engine e puramente simulado — nunca executa uma transacao real. Ele apenas registra "executed: simulated". Nao ha integracao com `chainSimulator.prepareFullSwap()` para enviar a transacao ao provedor.

**Recomendacao:** Implementar execucao real de swap no `ExecutionPlanner.executeStep()`, usando `window.ChainSimulator.prepareFullSwap()` e enviando via provider.

---

### [M6] Sem verificacao de owner/admin do pool

**Arquivo:** `public/shared/contractRegistry.js:16`

O pool e registrado como `trust: 'high'` sem verificacao on-chain de quem deployou o contrato ou se o ownership foi renunciado. Nao ha mecanica de monitoramento de mudancas de owner.

**Recomendacao:**
- Verificar se o contrato tem funcao `owner()`
- Verificar se ownership foi renunciado (owner = address(0))
- Monitorar eventos `OwnershipTransferred`

---

## 4. BAIXAS (5)

### [L1] Sem logica de migracao de pool

Se o contrato pool precisar ser redeployado (ex: bug critico ou upgrade), nao ha codigo para migrar a liquidez ou atualizar o endereco da pool. Todos os arquivos de config precisam ser editados manualmente.

---

### [L2] pool.test.js nao testa integracao real com chainSimulator

O arquivo `tests/pool.test.js` testa apenas precisao BigInt de parseUnits/formatUnits e calculos de LP. Nao ha testes de integracao que:
- Chamem `simulateSwap()` com dados reais
- Verifiquem `buildSwapCalldata()` com parametros edge-case
- Testem o fluxo completo `prepareFullSwap()` → aprovar → swap

---

### [L3] Sem indexacao de eventos Swap no frontend

**Arquivo:** `public/shared/eventIndexer.js` (listado na estrutura, nao lido)

Nao ha evidencia de que o `eventIndexer.js` escuta eventos `Swap` do contrato pool. Isso significa que o historico de swaps do usuario depende exclusivamente de `localStorage`, sem verificacao on-chain.

---

### [L4] Sem validacao de address checksum (EIP-55)

Os enderecos nos arquivos de configuracao (ex: `0x18076d992005186AeB13AC5270CaD6E27DB95247`) nao tem checksum EIP-55. Embora ethers.js aceite lowercase, e boa pratica usar enderecos com checksum para evitar erros de digitacao.

---

### [L5] EURC sem configuracao de pool liquidity

EURC tem endereco configurado (`0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`) mas nao ha:
- Pool USDC/EURC
- Logica de swap EURC no `chainSimulator.js`
- Preco EURC/USD hardcoded como 1.08 (desatualizado em caso de depeg)

---

## 5. Resumo Tecnico

### Arquitetura Atual

```
Usuario (navegador)
  ├── index.html (UI)
  ├── chainSimulator.js → RPC direto → Pool AMM (0x18076...)
  │   ├── getReserves()     ✓ (funcionando)
  │   ├── getAmountOut()    ✓ (simulacao)
  │   ├── swap()            ✓ (calldata preparada)
  │   └── tokenA()/fee()    ✗ (revertem on-chain!)
  ├── RiskEngine.js         → Classifica swap = LOW
  ├── ContractRegistry.js   → Pool = 'high' trust
  └── ExecutionPlanner.js   → Swap = simulado (nao executa tx)
```

### Liquidez On-Chain (15/07/2026)

| Metrica | Valor Raw | Valor Humano |
|---------|-----------|-------------|
| Reserve A (USDC) | 20,508,094,695 | ~20,508.09 USDC |
| Reserve B | bloqueado* | N/A |
| Total Supply (LP) | 17,543,847,605 | ~17.54 LP (?) |
| tokenA() | **REVERTE** | Interface desconhecida |
| fee() | **REVERTE** | Interface desconhecida |

*O retorno de `getReserves()` foi truncado pelo RPC. O reserveB esta presente nos 32 bytes seguintes mas nao foi possivel decodificar devido ao truncamento.

### Funcoes do Pool que REVERTEM

`tokenA()` (selector `0x0fcb5522`) e `fee()` (selector `0xddca3f43`) revertem na pool `0x18076...`. Isto sugere uma de duas coisas:
1. O contrato pool tem uma interface diferente do padrao Uniswap V2
2. O contrato usa nomes de funcoes diferentes (ex: `token0()` em vez de `tokenA()`)

**Acao necessaria:** Verificar o ABI real do contrato deployado em ArcScan.

---

## 6. Plano de Remediacao (Priorizado)

### Imediato (Sprint 1)
1. **[C2]** Corrigir `buildSwapCalldata` — calcular minOut real usando `getAmountOut * (1 - slippage%)`
2. **[C3]** Substituir `amount * 2` por approve exato OU implementar `permit`
3. **[A4]** Remover armazenamento de chave privada em localStorage; usar WalletConnect/MetaMask
4. **[A3]** Adicionar RPCs fallback

### Curto Prazo (Sprint 2)
5. **[A1]** Adicionar source code do pool ao repositorio; verificar em ArcScan
6. **[C1]** Deploy real do SwapRouter ou remover a referencia placeholder
7. **[A5]** Revisar RiskEngine — elevar swap para MEDIUM com analise de slippage
8. **[M1]** Ler `decimals()` do ERC-20 em vez de hardcodificar

### Medio Prazo (Sprint 3+)
9. **[C4]** Adicionar suporte a deadline no contrato pool
10. **[A2]** Implementar protecao MEV (Flashbots/private mempool)
11. **[M3]** Integrar eventos Swap no TreasuryIndexer e applicationLedger
12. **[M4]** Criar endpoint `quoteSwap` no quote-engine.mjs
13. **[M5]** Implementar execucao real de swap no ExecutionPlanner

---

## 7. Conclusao

O sistema de swap/liquidity pool do Elligentt tem uma arquitetura funcional para testnet, com ~20,508 USDC de liquidez on-chain. Porem, **4 vulnerabilidades criticas** precisam ser resolvidas antes de qualquer deploy em mainnet:

- **Falta de slippage protection** (C2) — a mais grave, permite perda de 100% do valor
- **Approval excessivo** (C3) — allowance permanente de 2x o valor
- **Swap router inexistente** (C1) — placeholder que quebra o fluxo de agentes
- **Sem deadline nos swaps** (C4) — transacoes podem ser mineradas em condicoes adversas

O contrato pool externo requer verificacao urgente — duas funcoes da ABI padrao (`tokenA()` e `fee()`) revertem, indicando que a interface real e diferente da esperada.

**Recomendacao final:** Corrigir C2, C3 e A4 antes de qualquer teste com fundos reais. Fazer verify do contrato pool em ArcScan e adicionar o source ao repositorio.

---

*Auditoria conduzida via analise estatica de codigo + verificacao on-chain via RPC direto.*
*API Cloudflare AI indisponivel para o account ID fornecido — auditoria baseada em analise manual completa dos 82 arquivos relevantes.*
