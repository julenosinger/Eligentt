# Autonoma 2 — Audit Report
**Date:** 2026-10-08  
**Commit:** 458a21e (main)

---

## ESTADO ATUAL — O QUE JÁ ESTÁ FUNCIONANDO

| Componente | Status | Observação |
|---|---|---|
| Rota `/autonoma2` | ✅ | Abre corretamente, isolada do Autonoma original |
| Chat UI — layout | ✅ | Sidebar de conversas + área de mensagens + composer |
| Conversation Engine | ✅ | Cria/lista/deleta conversas, persiste em localStorage |
| Context Engine | ✅ | Lê wallet, chainId, Circle status, contacts |
| Planner | ✅ | 13 intents PT+EN, extração de amount/token/chain |
| Tool Registry | ✅ | 5 read tools + 6 write tools registradas |
| Backend `/api/autonoma2/chat` | ✅ | Auth por sessão + SSE passthrough para DeepSeek |
| `a2Send` outer try/finally | ✅ | `_a2Streaming` sempre resetado |
| `window.a2Send` exposto | ✅ | Acessível via onclick/keydown |
| Módulos carregados na ordem correta | ✅ | core → app.js (IIFE) → inline-1.js |

---

## PROBLEMAS IDENTIFICADOS — O QUE FALTA

### P1 — CRÍTICO: Sessão não está chegando ao backend em produção

**Impacto:** Chat retorna 401, cai no `_keywordFallback` (resposta local sem LLM real)  
**Causa:** `_sessionToken` só é populado em memória quando o usuário faz login nesta sessão. Após page reload, o token em memória é perdido. O cookie `elligente_sid` tem `SameSite=Lax` — pode ser bloqueado em algumas situações no Cloudflare Pages.  
**Evidência:** `ContextEngine` faz `fetch('/api/agent/status', { credentials: 'same-origin' })` sem `Authorization` header — retorna dados da plataforma (não do usuário).  
**Fix necessário:** Armazenar o token de sessão em `sessionStorage` (não `localStorage` por segurança) no login, e lê-lo no `_callLLM` e `ContextEngine.get()`. O `auth.js` já tem `getSessionToken()` — só precisa persistir além da sessão de memória.

---

### P2 — ALTO: Write tools não executam — apenas retornam metadados

**Impacto:** Quando o usuário aprova um `send`, `swap` ou `bridge`, o `tool.execute()` retorna `{ ok: true, action: 'send', ... }` — um objeto de metadados, não a execução real.  
**Causa:** As write tools no `ToolRegistry.js` retornam dados mas não delegam aos engines reais (`saExecuteSend`, `SwapAggregator`, `bridgeKitRouter`).  
**Fix necessário:** Implementar adaptadores reais:

```
send tool.execute() → chama saExecuteSend() via DOM/API
swap tool.execute() → chama SwapAggregator.getBestQuote() + execute
bridge tool.execute() → chama bridgeKitRouter ou LiFiAdapter
create_invoice tool.execute() → chama POST /api/invoice
create_schedule tool.execute() → persiste em Store
create_payment_link tool.execute() → chama POST /api/payment-links
```

---

### P3 — ALTO: `ContextEngine` não lê balances reais

**Impacto:** O sistema prompt enviado ao DeepSeek diz "Balance: unavailable" para todos os tokens.  
**Causa:** `ContextEngine.get()` constrói o contexto mas não lê os saldos. O campo `balances` sempre chega vazio `{}` ao sistema prompt.  
**Fix necessário:** O `ContextEngine.get()` deve chamar o `balance` tool internamente (ou `BalanceService` diretamente) e popular `ctx.balances` com valores reais antes de retornar o contexto ao LLM.

---

### P4 — MÉDIO: `chat.js` — `DEEPSEEK_API_KEY` precisa estar configurado no Cloudflare

**Impacto:** Se `DEEPSEEK_API_KEY` não estiver nos Environment Variables do Pages project, o backend retorna `errSSE(503, 'LLM not configured')`.  
**Causa:** A variável não é a mesma que o Autonoma original usa (`DEEPSEEK_API_KEY` vs possivelmente outro nome).  
**Fix necessário:** Verificar o nome exato da variável no Cloudflare Pages e alinhar com o que `chat.js` lê em `env.DEEPSEEK_API_KEY`.

---

### P5 — MÉDIO: `_registerWriteTools()` sobrescreve o `send` tool

**Impacto:** O `send` é registrado duas vezes — primeiro na linha 177 com implementação, depois na linha 379 por `_registerWriteTools`. A segunda sobrescreve a primeira com uma versão stub.  
**Causa:** Lógica duplicada de registro no `ToolRegistry.js`.  
**Fix necessário:** Remover o registro inline do `send` na linha 177-204 (o `_registerWriteTools` já cuida dele) ou remover a duplicação em `_registerWriteTools`.

---

### P6 — MÉDIO: Markdown não é renderizado nas mensagens

**Impacto:** Respostas do agente com `**bold**`, `• bullets`, `\`code\`` aparecem como texto literal no chat.  
**Causa:** `a2BuildMsgEl` usa `textContent` (plain text) para o conteúdo da mensagem.  
**Fix necessário:** Adicionar um parser de markdown mínimo (bold, bullet, code) em `a2BuildMsgEl`. O app já usa Marked.js ou similar em outras áreas — reutilizar.

---

### P7 — BAIXO: Conversas não têm título automático real

**Impacto:** O título é setado como os primeiros 40 chars da primeira mensagem do usuário, mas não é atualizado se a conversa tiver nome melhor.  
**Causa:** `addMessage` seta o título só uma vez quando `conv.title === 'New Chat'`.  
**Observação:** Aceitável para Fase 1.

---

### P8 — BAIXO: Aprovação de write tool não abre o card visualmente

**Impacto:** Quando o LLM pede aprovação para um `send`, o `onChunk({ type: 'approval' })` é chamado mas o card de aprovação na UI não é renderizado — o `a2Send` só adiciona o texto do `approvalMsg` ao DOM via `a2RenderMessages`.  
**Causa:** O handler de `chunk.type === 'approval'` em `a2Send` não cria um card HTML diferenciado — apenas deixa o texto do preview no chat.  
**Fix necessário:** Em `a2BuildMsgEl`, detectar `msg.meta.type === 'approval_required'` e renderizar botões Confirm/Cancel no card.

---

## TABELA DE PRIORIDADE

| # | Problema | Prioridade | Esforço |
|---|---|---|---|
| P1 | Sessão não chega ao backend (401 → fallback) | CRÍTICO | 30 min |
| P2 | Write tools não executam realmente | ALTO | 2-3h |
| P3 | Balances não chegam ao contexto do LLM | ALTO | 30 min |
| P4 | `DEEPSEEK_API_KEY` não configurado | ALTO | 5 min (config) |
| P5 | `send` registrado duas vezes | MÉDIO | 5 min |
| P6 | Markdown não renderizado | MÉDIO | 30 min |
| P7 | Título de conversa | BAIXO | — |
| P8 | Card de aprovação sem botões | MÉDIO | 1h |

---

## PRÓXIMO PASSO RECOMENDADO

**Para ter um chat 100% funcional (LLM real respondendo):**

1. Configurar `DEEPSEEK_API_KEY` no Cloudflare Pages → Environment Variables (P4)
2. Corrigir persistência do token de sessão (P1)
3. Popular `ctx.balances` no ContextEngine (P3)

**Para ter write tools funcionando:**

4. Implementar adaptadores reais em P2
5. Corrigir card de aprovação P8

**O app está sólido em arquitetura. Os problemas são de integração (sessão, variável de env, execução) — não de design.**
