# Auditoria — Autonoma Agent Wallet

**Data:** 15/07/2026  
**Escopo:** agentWalletManager.js, agentIdentity.js, agentAuthorization.js, agentSession.js, agentReputation.js, agentTreasury.js, agentAudit.js, autonomaAgent.js, autonomaCore.js + código de execução no index.html  
**Chain:** Arc Testnet (5042002)

---

## Sumário Executivo

Foram identificadas **2 vulnerabilidades CRÍTICAS**, **3 ALTAS**, **4 MÉDIAS** e **3 BAIXAS**, totalizando **12 achados**.

---

## 1. CRÍTICAS (2)

### [C1] Private Key em plaintext no localStorage — `elligentt_agent_session_v1`

**Arquivos:**
- `public/shared/agentWalletManager.js:175-209` (getOrCreateWallet)
- `public/index.html:39636-39642` (_agentExecuteOp)
- `public/index.html:39836-39846` (_agentExecuteSwap)
- `public/index.html:39998-40006` (_agentExecuteBridge)

**Descrição:**
A chave privada do Agent Wallet é armazenada em `localStorage` sob a chave `elligentt_agent_session_v1` como `{ privateKey: "0x..." }` em texto puro. As funções de execução (`_agentExecuteOp`, `_agentExecuteSwap`, `_agentExecuteBridge`) leem diretamente:

```javascript
var sessRaw = localStorage.getItem('elligentt_agent_session_v1');
var sess = JSON.parse(sessRaw);
var wallet = new ethers.Wallet(sess.privateKey, provider);
```

O `agentWalletManager.js` v2 tenta mitigar removendo `walletPrivateKey` do state mas NÃO remove a chave de sessão v1, pois isso quebraria o Treasury auto-operations (correção aplicada no deploy anterior).

**Impacto:** Qualquer extensão de navegador, script XSS ou malware com acesso ao localStorage pode extrair a chave privada e drenar todos os fundos do Agent Wallet + Treasury.

**Evidência de exploração:** A chave persiste entre sessões. Basta `localStorage.getItem('elligentt_agent_session_v1')` no console do navegador.

**Recomendação:** 
- Curto prazo: Criptografar com WebCrypto API usando senha do usuário
- Médio prazo: Migrar para WalletConnect/MetaMask SDK onde a chave nunca sai da extensão
- Imediato: Adicionar banner de aviso sobre o risco

**Severidade:** CRITICA

---

### [C2] Bypass de autorização entre check e execução (TOCTOU)

**Arquivos:**
- `public/index.html:39599` (_agentCanExecute)
- `public/index.html:39633` (_agentExecuteOp)

**Descrição:**
`_agentCanExecute()` valida autorização no momento do check. Mas `_agentExecuteOp()` assina e envia a transação sem revalidar. Entre o check e a assinatura, a autorização pode ser revogada (race condition TOCTOU — Time of Check, Time of Use).

```javascript
// Check (t0)
if (!_agentCanExecute(opts)) return;

// ... delay ...

// Execution (t1) — sem revalidação
var wallet = new ethers.Wallet(sess.privateKey, provider);
var tx = await wallet.sendTransaction(txData);
```

O `AgentAuthorization.validateExecution()` não é chamado novamente antes do `sendTransaction`.

**Impacto:** Um ataque de timing pode permitir execução não autorizada se a autorização for revogada entre o check e a assinatura. O agente pode executar operações após ter sua autorização removida.

**Recomendação:** Chamar `AgentAuthorization.validateExecution()` imediatamente antes de `sendTransaction()`, dentro do mesmo bloco assíncrono.

**Severidade:** CRITICA

---

## 2. ALTAS (3)

### [A1] Wallet criada com `ethers.Wallet.createRandom()` — sem backup

**Arquivo:** `public/shared/agentWalletManager.js:126-144`

```javascript
function createAgentWallet(){
    agentWallet = ethers.Wallet.createRandom();
    // A chave NUNCA é exibida ao usuário para backup
}
```

**Descrição:** A wallet do agente é gerada aleatoriamente. Se o localStorage for limpo, o navegador resetado, ou o usuário trocar de dispositivo, a chave privada é **perdida permanentemente**. Não há frase de recuperação, nem seed phrase, nem mecanismo de exportação segura.

**Impacto:** Perda irreversível de todos os fundos do Agent Wallet + capacidades de assinatura do Treasury. Todas as operações autônomas param de funcionar.

**Recomendação:** Exibir frase mnemônica (BIP-39) no momento da criação e exigir confirmação de backup pelo usuário. Ou usar wallet externa (MetaMask).

**Severidade:** ALTA

---

### [A2] Sem validação de gas limits — agente pode gastar ilimitado em gas

**Arquivos:**
- `public/index.html:39633-39780` (_agentExecuteOp)
- `public/shared/agentAuthorization.js:89` (maxSpending)

**Descrição:** O `AgentAuthorization` define `maxSpending` como limite de valor transferido, mas **não há limite de gas**. Um ataque poderia submeter transações com gas price extremamente alto, drenando o native token (USDC nativo no Arc) via custos de gas.

O `AGENT_MAX_GAS_USD: 5` está definido em `system.js:109` mas não é aplicado no código de execução.

**Impacto:** Drenagem de fundos via gas fees excessivos. O agente pode gastar todo seu saldo em gas sem nunca transferir valor.

**Recomendação:** Aplicar `AGENT_MAX_GAS_USD` antes de assinar. Estimar gas e rejeitar se exceder o limite.

**Severidade:** ALTA

---

### [A3] Agente sem limite de frequência por operação

**Arquivos:**
- `public/shared/agentAuthorization.js:170` (validateExecution)
- `public/shared/agentWalletManager.js:31` (capabilities)

**Descrição:** O agente tem `AGENT_MAX_DAILY_OPS: 50` mas `_agentExecuteOp` e funções relacionadas não incrementam contador de operações diárias nem verificam o limite ANTES da execução. O `recordExecution()` é chamado apenas APÓS a transação.

**Impacto:** O agente pode exceder o limite diário configurado, executando mais operações do que o usuário autorizou.

**Recomendação:** Incrementar contador de operações ANTES da execução. Bloquear se `AGENT_MAX_DAILY_OPS` for excedido.

**Severidade:** ALTA

---

## 3. MÉDIAS (4)

### [M1] Recovery engine guard com janela de 100ms — insuficiente

**Arquivo:** `public/index.html:30897`

```javascript
window.__SETTLEMENT_RECOVERY_READONLY = true;
setTimeout(function(){ window.__SETTLEMENT_RECOVERY_READONLY = false; }, 100);
```

**Descrição:** O flag `__SETTLEMENT_RECOVERY_READONLY` é setado por apenas 100ms. Operações assíncronas (RPC calls) podem levar mais que isso, criando uma janela onde o recovery engine e o executor de liquidação podem colidir.

**Impacto:** Condição de corrida entre recovery engine (leitura) e executor de liquidação (escrita). Potencial para nonce collision ou double-spend.

**Recomendação:** Usar mutex assíncrono (Promise-based lock) em vez de flag temporizado. O guard deve ser liberado apenas quando a operação assíncrona concluir.

**Severidade:** MEDIA

---

### [M2] Duas fontes de verdade para a chave privada

**Arquivos:**
- `public/shared/agentWalletManager.js:146-159` (sessionWallet em RAM)
- `public/index.html:39636` (session v1 em localStorage)

**Descrição:** A chave privada existe em dois lugares diferentes dependendo do code path:
1. `agentWalletManager.js` v2: RAM (`_agentSessionWallet`)
2. `index.html` _agentExecute*: `localStorage` (`elligentt_agent_session_v1`)

Se um path atualizar a chave e o outro não, há inconsistência. A função `getOrCreateWallet()` tenta unificar via fallback, mas não há sincronização bidirecional.

**Impacto:** Wallet dessincronizada entre módulos. Possível uso de chave errada/antiga para assinatura.

**Recomendação:** Unificar em uma única fonte de verdade. Se a chave precisa existir em localStorage, que seja criptografada. Se não, que TODOS os paths usem a versão em RAM.

**Severidade:** MEDIA

---

### [M3] `auditPlaintextKeys()` não é chamado proativamente

**Arquivo:** `public/shared/agentWalletManager.js:385-416`

**Descrição:** A função `auditPlaintextKeys()` escaneia localStorage/sessionStorage por chaves privadas, mas nunca é chamada automaticamente. Só existe como API exposta.

**Impacto:** Vazamentos de chave privada não são detectados até que alguém chame manualmente a função de auditoria.

**Recomendação:** Chamar `auditPlaintextKeys()` no `load()` e logar warnings no console. Executar auditoria a cada inicialização.

**Severidade:** MEDIA

---

### [M4] Agente sem circuito de kill switch

**Arquivo:** `public/shared/agentWalletManager.js:272-286` (pause/resume)

**Descrição:** O agente pode ser pausado via `pause()` mas não há um kill switch global que:
- Revogue todas as autorizações ativas
- Transfira fundos para uma cold wallet
- Desabilite permanentemente a chave

O `pause()` apenas seta `status: 'paused'` e o `AgentSession.pause()`, mas a chave privada continua acessível.

**Impacto:** Em caso de comprometimento da chave, não há mecanismo de emergência para proteger os fundos.

**Recomendação:** Implementar `emergencyShutdown()` que: revoga todas as autorizações, zera o nonce, tenta transferir fundos restantes para a treasury vault.

**Severidade:** MEDIA

---

## 4. BAIXAS (3)

### [L1] Capacidades hardcoded sem verificação on-chain

**Arquivo:** `public/shared/agentWalletManager.js:31`

```javascript
capabilities: ['swap','bridge','treasury','payments','contracts','vault','crosschain','permit','recurring','scheduled','reimbursement','treasury_deposit']
```

**Descrição:** As capacidades do agente são hardcoded. Não há verificação on-chain de que o agente realmente possui essas permissões no contrato ERC-8004 Identity Registry.

**Recomendação:** Sincronizar capabilities com o registro on-chain ERC-8004.

---

### [L2] `agentReputation.js` pontuação base 50 sem justificativa

**Arquivo:** `public/shared/agentReputation.js:15`

```javascript
reputationScore: 50
```

**Descrição:** Score inicial de 50/100 sem justificativa. Não há diferenciação entre agente novo (sem histórico) e agente com histórico ruim.

**Recomendação:** Iniciar com score 0 ou "N/A" até que haja histórico suficiente.

---

### [L3] Metadados IPFS hardcoded sem verificação

**Arquivo:** `public/shared/agentIdentity.js:55`

```javascript
metadataURI: 'ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei'
```

**Descrição:** URI de metadados IPFS hardcoded. Se o arquivo for removido do IPFS ou o gateway falhar, o agente perde identidade.

**Recomendação:** Permitir atualização do metadataURI. Adicionar fallback gateway.

---

## 5. Fluxo de Chave Privada

```
Criação:
  ethers.Wallet.createRandom()
    ↓
  _setSessionWallet(w)    → RAM (_agentSessionWallet)
    ↓
  localStorage.setItem('elligentt_agent_session_v1', '{ privateKey: "0x..." }')
  
Leitura (v2):
  getOrCreateWallet()
    → _sessionWallet()    → RAM
    → fallback: localStorage 'elligentt_agent_session_v1'
    → fallback: localStorage 'elligentt_agent_wallet_v1'
    
Leitura (execução — index.html):
  _agentExecuteOp()
    → localStorage.getItem('elligentt_agent_session_v1')
    → JSON.parse → sess.privateKey
    → new ethers.Wallet(key, provider)
```

**Problema:** 3 code paths diferentes leem a mesma chave de 2 fontes diferentes (RAM vs localStorage). Inconsistência garantida.

---

## 6. Recomendações Priorizadas

### Imediato
1. **[C1]** Criptografar `elligentt_agent_session_v1` com WebCrypto API + senha
2. **[C2]** Adicionar `AgentAuthorization.validateExecution()` antes de `sendTransaction()`
3. **[A2]** Aplicar `AGENT_MAX_GAS_USD` em todas as funções de execução
4. **[A3]** Incrementar contador de operações ANTES da execução

### Curto Prazo
5. **[A1]** Implementar backup BIP-39 com frase mnemônica
6. **[M1]** Substituir timeout de 100ms por mutex assíncrono
7. **[M2]** Unificar fonte da chave privada
8. **[M3]** Chamar `auditPlaintextKeys()` no `load()`

### Médio Prazo
9. **[M4]** Implementar `emergencyShutdown()` com transferência para vault
10. **[L1]** Sincronizar capabilities com ERC-8004 on-chain
11. **[L2]** Iniciar reputation com "N/A" para agentes novos

---

## 7. Conclusão

O Agent Wallet da Autonoma tem arquitetura funcional mas com **falhas críticas de segurança**:

- A chave privada em plaintext no localStorage é o risco **mais grave** — qualquer XSS compromete todos os fundos
- A inconsistência entre v2 (RAM) e v1 (localStorage) como fontes da chave cria superfície de ataque adicional
- O bypass de autorização (TOCTOU) permite execução não autorizada em condições de corrida
- A falta de backup da chave privada significa perda permanente em caso de limpeza do navegador

O Treasury auto-operations depende da chave em localStorage para funcionar. Migrar para um modelo seguro (WalletConnect, WebCrypto, ou HSM) sem quebrar o Treasury é o principal desafio arquitetural.
