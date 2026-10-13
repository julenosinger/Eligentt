# x402 Payments — Integração Inicial (Autonoma)

> **Fase 1 — Infraestrutura, descoberta, validação e autorização.**
> Pagamentos reais **não** estão habilitados. Não há liquidação simulada.

## 1. Objetivo

Adicionar suporte real ao protocolo **x402** (HTTP 402 Payment Required, versão 2)
à Autonoma, permitindo reconhecer solicitações de pagamento de serviços/APIs e
preparar o fluxo de autorização usando USDC e a infraestrutura da Circle — sem
regressões e sem criar uma segunda carteira ou um sistema paralelo de autorização.

## 2. Versão do protocolo e compatibilidade (achados da auditoria)

- **Protocolo:** x402 **v2** (`x402Version: 2`).
  - Fonte autoritativa: https://docs.x402.org e
    https://raw.githubusercontent.com/x402-foundation/x402/main/specs/x402-specification-v2.md
- **Headers:** `PAYMENT-REQUIRED` (Base64-encoded JSON), `PAYMENT-SIGNATURE`
  (`PaymentPayload`), `PAYMENT-RESPONSE` (Base64-encoded `SettlementResponse`).
- **Scheme:** `exact` — assinatura EIP-3009 `transferWithAuthorization` sobre o
  contrato USDC (domínio EIP-712 `name="USDC"`, `version="2"`).
- **Rede:** formato CAIP-2 (`eip155:<chainId>`).

| Rede | CAIP-2 | chainId | EIP-3009 (USDC) | Situação nesta integração |
|------|--------|---------|-----------------|---------------------------|
| Base Sepolia | `eip155:84532` | 84532 | confirmado | suportado (teste) |
| Base | `eip155:8453` | 8453 | confirmado | suportado |
| Polygon PoS | `eip155:137` | 137 | confirmado | suportado |
| Arc Mainnet | `eip155:5042` | 5042 | **não confirmado** | **bloqueado** |

### Por que Arc Mainnet está bloqueado

A Circle AI Smart Wallet do usuário vive em **Arc Mainnet** (chainId 5042), onde
o USDC é um *precompile nativo* (`0x3600…0000`; o gás nativo **é** USDC), e não
um ERC-20 padrão com suporte a EIP-3009. Como o scheme `exact` exige
`transferWithAuthorization` (uma extensão ERC-20), **a compatibilidade de
liquidação em Arc não pode ser assumida** sem verificação on-chain. Por isso,
qualquer rede marcada `eip3009Compatible: false` (atualmente só Arc) é
**bloqueada no backend**, e o pagamento real permanece desligado por padrão.

> A confirmação definitiva (probe on-chain do contrato USDC em Arc para
> `DOMAIN_SEPARATOR` / `transferWithAuthorization`) é um passo da Fase 2.

## 3. Arquitetura (arquivos adicionados)

```
functions/api/x402/_x402.mjs   → parsing/normalização/validação puros (testável)
functions/api/x402/index.js    → rotas HTTP (status, discover, prepare, pay)
functions/api/x402/[[path]].js → catch-all de rota (/api/x402/* → mesmo handler)
config/x402.js                 → constantes de exibição (frontend, sem segredos)
shared/x402Client.js           → cliente + UI da seção "x402 Payments"
tests/x402.test.js             → 21 testes de unidade/integração
docs/x402-integration.md       → este documento
```

Edições em `index.html` (aditivas): um `<script>` para `config/x402.js`, um para
`shared/x402Client.js` e um chip de capacidade "x402 Payments" na tela inicial
da Autonoma.

### Reuso (nenhum sistema paralelo)

- **Autenticação/sessão:** reusa `verifySession` de
  `functions/api/agent-signer/_session.mjs` e o padrão de resolução de carteira
  per-user de `functions/api/agent/index.js` (`session:` + `user:` em `AUTH_KV`).
- **Carteira:** usa **exclusivamente** a Circle AI Smart Wallet per-user
  (`user.circleWalletId` / `user.circleWalletAddress`). O wallet de plataforma
  (`CIRCLE_WALLET_ID`/`ADDRESS`) **nunca** é devolvido como identidade do usuário.
- **Credenciais Circle:** permanecem em `context.env` (Cloudflare Secrets).

## 4. Endpoints

| Rota | Método | Auth | Comportamento |
|------|--------|------|---------------|
| `/api/x402/status` | GET | não | Estado da integração (`disabled` / `settlement_unavailable` / `available`) + capacidades `discovery`/`settlement` + `user.id` |
| `/api/x402/discover` | POST | sessão | Probe de URL → detecta 402 → parseia `PAYMENT-REQUIRED` → requisitos normalizados |
| `/api/x402/prepare` | POST | sessão | Revalida requisitos no servidor + carteira + autorização → `intent` (ready/blocked) |
| `/api/x402/pay` | POST | sessão | **fail-closed 503** — liquidação não implementada nesta fase |

### Fluxo

1. Autonoma descobre os requisitos de pagamento (402) de um serviço.
2. O backend revalida **tudo** no servidor (nunca confia no cliente/IA):
   scheme, rede, ativo (USDC), `payTo`, valor, teto (`X402_MAX_USD`) e timeout.
3. A UI mostra serviço, valor, token, rede, destinatário e o resultado de cada
   checagem.
4. O pagamento só ocorreria após confirmação explícita do usuário — e, nesta
   fase, é bloqueado de forma honesta (`payments_enabled` / rede incompatível).

## 5. Segurança

- **Nenhuma chave privada / API key / segredo no frontend.** `config/x402.js` e
  `shared/x402Client.js` contêm apenas constantes de exibição.
- **Preço, destinatário, rede e status nunca são confiados do cliente ou do
  modelo** — revalidados no servidor.
- **Ativos confiáveis (allowlist explícita).** O endereço do contrato, a rede e
  os decimais são validados contra `TRUSTED_ASSETS` (USDC por rede). `extra.name
  = "USDC"` sozinho **não** é aceito: um token falso rotulado "USDC" é bloqueado
  por `asset_known` (endereço) + `asset_domain_name`/`asset_domain_version`
  (domínio EIP-712). A versão do protocolo (`x402Version`) é validada (=2).
- **Anti-SSRF + redirecionamentos.** Bloqueio de IPs privados/loopback/
  link-local/reservados, literais IPv6, `localhost`/`.local`/`.internal`,
  protocolos != http(s), e allowlist opcional `X402_ALLOWED_HOSTS`. Redirecionamentos
  (301/302/303/307/308) são seguidos **manualmente** e o destino é **revalidado a
  cada hop** — nunca se confia apenas na URL inicial.
- **Anti-replay / duplicidade:** `requirementId` determinístico + mapa de
  operações **realmente liquidadas** no cliente. Operações bloqueadas/falhas são
  registradas apenas no histórico — **nunca** como "submetidas" — e não impedem
  novas tentativas legítimas.
- **Histórico isolado por usuário.** As chaves de `localStorage` são namespacedas
  por `user.id` (do `/api/x402/status`), impedindo mistura entre usuários do mesmo
  navegador. Nenhum segredo é persistido.
- **Fail-closed:** falha de RPC/Circle/provedor não produz falso sucesso nem
  falso fracasso; incompatibilidade de rede/ativo bloqueia o pagamento com motivo claro.

## 6. Configuração (Cloudflare Secrets / env vars)

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `X402_ENABLED` | `false` | Chave-mestra. `true` só após confirmação de rede + liquidação (Fase 2). |
| `X402_MAX_USD` | `25` | Teto (USD) por pagamento único. |
| `X402_ALLOWED_HOSTS` | _(vazio)_ | Allowlist de hosts para o proxy de descoberta (SSRF). |

## 7. Testes

```bash
npx vitest run tests/x402.test.js tests/x402-client.test.js   # 34 testes, todos verdes
```

Cobertura backend (`tests/x402.test.js`, 29 testes): parsing de
`PAYMENT-REQUIRED` (base64/raw/body), normalização v1/v2, versão obrigatória (=2),
validação (scheme/rede/EIP-3009/**ativo allowlist**/domínio EIP-712/payTo/valor/
teto/timeout), token falso "USDC", mismatch endereço/rede, bloqueio de Arc, SSRF
(incluindo **redirecionamento para IP privado**), `status` (disabled +
settlement_unavailable), `discover` (402/200/redirect/parse-error/SSRF),
`prepare` (bloqueado por flag/settlement/rede/recipiente), `pay` fail-closed.

Cobertura do cliente (`tests/x402-client.test.js`, 5 testes): descoberta sem
lançar (regressão do `_lastPrepare` não declarado), 503 não marca como submetida,
nova tentativa legítima após falha, histórico isolado por usuário, nenhum segredo
persistido.

> A suíte completa do repositório já contém **33 arquivos de teste falhando de
> forma pré-existente** (Arc Mainnet registry / Unified Balance / Autonoma
> execution / CSS extraído do HTML) — **independentes** desta integração. Nenhum
> teste novo regrediu (contagem de falhas idêntica antes/depois).

## 8. Correções aplicadas nesta revisão (causa → correção)

| Bug | Causa | Correção |
|-----|-------|----------|
| `ReferenceError` no fluxo de descoberta | `_lastPrepare` não declarado (strict mode) | declarado e inicializado em `shared/x402Client.js` |
| Operações bloqueadas marcadas como submetidas | `markSubmitted(id,'blocked')` no caminho de erro | só `markSubmitted(...,'settled')` com `txHash` real |
| Pagamento "concluído" sem evidência | `txHash: null` no caminho de sucesso | exige `txHash`/`transaction` verificável |
| Token falso rotulado "USDC" aceito | validação só por `extra.name` | allowlist `TRUSTED_ASSETS` (endereço+rede+decimais+domínio) |
| SSRF via redirecionamento | `redirect:'manual'` sem re-validação | loop manual de redirect revalidando cada hop |
| Status prometia "available" com flag ligada | estado derivado do flag | `SETTLEMENT_IMPLEMENTED=false` (nível de código) |
| Histórico misturado entre usuários | chave única de `localStorage` | namespacing por `user.id` |

## 9. Limitações desta fase e próximos passos

- **Liquidação real não implementada.** `pay` retorna 503. Sem pagamento simulado.
- **Arc Mainnet bloqueado** até confirmação on-chain de EIP-3009 no USDC nativo.
- **Fase 2 (não incluída):** assinatura EIP-3009 via Circle `signTypedData`,
  submissão ao Facilitator Service, verificação de resposta de liquidação
  (`PAYMENT-RESPONSE`), e registro do hash real da transação.
- **Não integra** NVIDIA, não altera o cérebro da Autonoma e não habilita
  pagamentos autônomos sem aprovação.
