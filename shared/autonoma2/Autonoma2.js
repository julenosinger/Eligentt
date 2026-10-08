/**
 * Autonoma 2 — Main Orchestrator
 * Chat-first AI financial agent. Delegates to existing engines.
 * Never executes blockchain operations directly.
 * Attached to window.Autonoma2
 */
(function () {
  'use strict';

  // ─── Conversation store ──────────────────────────────────────────────────
  var CONV_KEY = 'a2_conversations_v1';
  var _convs = null;       // { [id]: { id, title, messages: [], createdAt } }
  var _activeId = null;

  function _loadConvs() {
    if (_convs) return _convs;
    try { _convs = JSON.parse(localStorage.getItem(CONV_KEY) || '{}'); } catch (e) { _convs = {}; }
    return _convs;
  }

  function _saveConvs() {
    try { localStorage.setItem(CONV_KEY, JSON.stringify(_convs)); } catch (e) {}
  }

  function newConversation() {
    _loadConvs();
    var id = 'c' + Date.now();
    _convs[id] = { id: id, title: 'New Chat', messages: [], createdAt: Date.now() };
    _activeId = id;
    _saveConvs();
    return _convs[id];
  }

  function getConversation(id) {
    _loadConvs();
    return _convs[id] || null;
  }

  function listConversations() {
    _loadConvs();
    return Object.values(_convs).sort(function (a, b) { return b.createdAt - a.createdAt; });
  }

  function setActive(id) { _activeId = id; }
  function activeId() { return _activeId; }

  function addMessage(convId, role, content, meta) {
    _loadConvs();
    var conv = _convs[convId];
    if (!conv) return null;
    var msg = {
      id: 'm' + Date.now() + Math.random().toString(36).slice(2, 6),
      role: role, // user | assistant | tool | system
      content: content,
      meta: meta || {},
      ts: Date.now()
    };
    conv.messages.push(msg);
    // Auto-title from first user message
    if (role === 'user' && conv.title === 'New Chat') {
      conv.title = content.slice(0, 40) + (content.length > 40 ? '…' : '');
    }
    _saveConvs();
    return msg;
  }

  function getMessages(convId) {
    _loadConvs();
    return (_convs[convId] && _convs[convId].messages) || [];
  }

  function deleteConversation(id) {
    _loadConvs();
    delete _convs[id];
    if (_activeId === id) _activeId = null;
    _saveConvs();
  }

  // ─── Chat processing ─────────────────────────────────────────────────────
  var _pendingApproval = null; // { convId, executionId, action }

  async function sendMessage(convId, userText, onChunk) {
    if (!convId || !userText || !userText.trim()) return;
    _loadConvs();
    if (!_convs[convId]) return;

    // Add user message
    addMessage(convId, 'user', userText.trim());

    // Build context
    var ctx = await A2Context.get();

    // Build message history for LLM (last 20 messages)
    var history = getMessages(convId).slice(-20);
    var llmMessages = history.map(function (m) {
      if (m.role === 'tool') return null; // skip tool results in LLM context
      return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content };
    }).filter(Boolean);

    // Build system prompt with real context
    var systemPrompt = _buildSystemPrompt(ctx);

    var assistantMsgId = null;

    try {
      // Try LLM (DeepSeek via /api/autonoma2/chat)
      var llmResult = await _callLLM(systemPrompt, llmMessages, ctx, onChunk);

      if (llmResult.toolCall) {
        // Handle tool call
        var tcResult = await _handleToolCall(convId, llmResult.toolCall, ctx, onChunk);
        return tcResult;
      }

      if (llmResult.text) {
        var msg = addMessage(convId, 'assistant', llmResult.text);
        if (onChunk) onChunk({ type: 'done', text: llmResult.text, msgId: msg.id });
        return msg;
      }

    } catch (e) {
      // Fallback: keyword-based response
      var fallback = _keywordFallback(userText, ctx);
      var msg2 = addMessage(convId, 'assistant', fallback);
      if (onChunk) onChunk({ type: 'done', text: fallback, msgId: msg2.id });
      return msg2;
    }
  }

  async function _callLLM(systemPrompt, messages, ctx, onChunk) {
    // Build tools list from registry
    var tools = (typeof A2ToolRegistry !== 'undefined' ? A2ToolRegistry.list() : []).map(function (t) {
      return {
        type: 'function',
        function: {
          name: t.name,
          description: t.llmDescription || t.description,
          parameters: {
            type: 'object',
            properties: t.parameters || {},
            required: Object.keys(t.parameters || {}).filter(function (k) { return t.parameters[k] && t.parameters[k].required; })
          }
        }
      };
    });

    var body = {
      model: 'deepseek-chat',
      messages: [{ role: 'system', content: systemPrompt }].concat(messages),
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length ? 'auto' : undefined,
      stream: true,
      max_tokens: 800,
      temperature: 0.3
    };

    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 30000);

    // Build auth headers — cookie alone may be blocked (SameSite/domain); add Bearer as backup
    var fetchHeaders = { 'Content-Type': 'application/json' };
    var _tok = (typeof Auth !== 'undefined' && typeof Auth.getSessionToken === 'function') ? Auth.getSessionToken() : null;
    if (!_tok) { try { _tok = JSON.parse(localStorage.getItem('elligentt_session') || '{}').token || null; } catch(_) {} }
    if (_tok) fetchHeaders['Authorization'] = 'Bearer ' + _tok;

    var resp = await fetch('/api/autonoma2/chat', {
      method: 'POST',
      headers: fetchHeaders,
      credentials: 'include',
      body: JSON.stringify(body),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!resp.ok) {
      if (resp.status === 401) throw new Error('LLM_UNAUTHORIZED');
      if (resp.status === 503) throw new Error('LLM_UNAVAILABLE');
      throw new Error('LLM_ERROR_' + resp.status);
    }

    // Parse streaming response
    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    var fullText = '';
    var toolCall = null;
    var toolArgs = '';
    var toolName = '';

    while (true) {
      var _ref = await reader.read();
      var done = _ref.done, value = _ref.value;
      if (done) break;
      var chunk = decoder.decode(value);
      var lines = chunk.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line.startsWith('data: ')) continue;
        var data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          var parsed = JSON.parse(data);
          var delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
          if (!delta) continue;
          if (delta.content) {
            fullText += delta.content;
            if (onChunk) onChunk({ type: 'chunk', text: delta.content });
          }
          if (delta.tool_calls && delta.tool_calls[0]) {
            var tc = delta.tool_calls[0];
            if (tc.function && tc.function.name) toolName = tc.function.name;
            if (tc.function && tc.function.arguments) toolArgs += tc.function.arguments;
          }
        } catch (e) { /* skip malformed */ }
      }
    }

    if (toolName) {
      var parsedArgs = {};
      try { parsedArgs = JSON.parse(toolArgs); } catch (e) {}
      return { toolCall: { name: toolName, arguments: parsedArgs } };
    }

    return { text: fullText || null };
  }

  async function _handleToolCall(convId, tc, ctx, onChunk) {
    var tool = typeof A2ToolRegistry !== 'undefined' ? A2ToolRegistry.get(tc.name) : null;
    if (!tool) {
      var errMsg = 'I tried to use the "' + tc.name + '" capability, but it\'s not available.';
      var m = addMessage(convId, 'assistant', errMsg);
      if (onChunk) onChunk({ type: 'done', text: errMsg, msgId: m.id });
      return m;
    }

    if (tool.requiresApproval) {
      // Show approval card
      var executionId = 'ex' + Date.now();
      _pendingApproval = { convId: convId, executionId: executionId, toolName: tc.name, args: tc.arguments, ctx: ctx };

      var preview = _buildApprovalPreview(tool, tc.arguments, ctx);
      var approvalMsg = addMessage(convId, 'assistant', preview, {
        type: 'approval_required',
        executionId: executionId,
        toolName: tc.name,
        args: tc.arguments
      });
      if (onChunk) onChunk({ type: 'approval', executionId: executionId, preview: preview, msgId: approvalMsg.id });
      return approvalMsg;
    }

    // Read-only: execute directly
    if (onChunk) onChunk({ type: 'tool_start', toolName: tc.name });
    var result = await tool.execute(tc.arguments, ctx);
    var responseText = _formatToolResult(tool, result, ctx);
    var msg = addMessage(convId, 'assistant', responseText, { type: 'tool_result', toolName: tc.name, result: result });
    if (onChunk) onChunk({ type: 'done', text: responseText, msgId: msg.id });
    return msg;
  }

  async function approveAction(executionId, onChunk) {
    if (!_pendingApproval || _pendingApproval.executionId !== executionId) {
      return { ok: false, error: 'NO_PENDING_APPROVAL' };
    }
    var pending = _pendingApproval;
    _pendingApproval = null;

    var tool = typeof A2ToolRegistry !== 'undefined' ? A2ToolRegistry.get(pending.toolName) : null;
    if (!tool) return { ok: false, error: 'TOOL_NOT_FOUND' };

    // Execution monitor progress handler
    function _onProgress(progress) {
      var stageText = {
        PREPARING: 'Preparing…',
        APPROVED: 'Approved. Starting execution…',
        SUBMITTED: 'Transaction submitted…',
        PENDING: 'Pending confirmation…',
        CONFIRMING: 'Confirming on-chain…',
        COMPLETED: 'Completed.',
        FAILED: 'Failed.',
        CANCELLED: 'Cancelled.'
      }[progress.stage] || progress.message || progress.stage;

      var progressMsg = '**' + (progress.stage || '…') + '** ' + stageText;
      if (progress.txHash) progressMsg += '\nTx: `' + progress.txHash + '`';

      addMessage(pending.convId, 'assistant', progressMsg, {
        type: 'execution_progress',
        executionId: executionId,
        stage: progress.stage,
        txHash: progress.txHash || null
      });

      if (onChunk) onChunk({
        type: 'execution_progress',
        stage: progress.stage,
        message: progress.message,
        txHash: progress.txHash || null,
        text: progressMsg
      });
    }

    var result = await tool.execute(pending.args, pending.ctx, _onProgress);

    var resultText = _formatToolResult(tool, result, pending.ctx);
    addMessage(pending.convId, 'assistant', resultText, {
      type: 'execution_result',
      executionId: executionId,
      result: result
    });
    if (onChunk) onChunk({ type: 'done', text: resultText });
    return { ok: true, result: result };
  }

  function cancelApproval(executionId) {
    if (_pendingApproval && _pendingApproval.executionId === executionId) {
      var convId = _pendingApproval.convId;
      _pendingApproval = null;
      addMessage(convId, 'assistant', 'Action cancelled.');
      return { ok: true };
    }
    return { ok: false };
  }

  // ─── Formatting helpers ───────────────────────────────────────────────────

  function _buildSystemPrompt(ctx) {
    var wallet = ctx.walletAddress ? ctx.walletAddress.slice(0, 6) + '...' + ctx.walletAddress.slice(-4) : 'not connected';
    var chain = ctx.chainName || 'Arc Mainnet';
    var circleWallet = ctx.circleWalletAddress ? ctx.circleWalletAddress.slice(0, 6) + '...' + ctx.circleWalletAddress.slice(-4) : 'not provisioned';
    var tools = typeof A2ToolRegistry !== 'undefined' ? A2ToolRegistry.listNames().join(', ') : '';
    return [
      'You are Autonoma 2, a conversational AI financial agent for the Elligentt dApp on Arc Mainnet (Chain ID 5042).',
      'The native gas token on Arc is USDC. Supported tokens: USDC, EURC, cirBTC.',
      '',
      'Current user context:',
      '- EVM wallet: ' + wallet,
      '- Chain: ' + chain + ' (ID ' + (ctx.chainId || 5042) + ')',
      '- Circle wallet: ' + circleWallet,
      '- Contacts: ' + (ctx.contacts ? ctx.contacts.length : 0) + ' saved',
      '',
      'Available tools: ' + tools,
      '',
      'RULES:',
      '1. Be concise and conversational. Format amounts clearly (e.g. "500 USDC").',
      '2. For any read operation (balance, history, routes), call the appropriate tool.',
      '3. For any write operation (send, swap, bridge, create), call the tool — it will ask for approval.',
      '4. Never invent balances, addresses, or transaction hashes.',
      '5. If the wallet is not connected, say so clearly.',
      '6. For multi-step workflows, describe each step before executing.',
      '7. Cross-chain routes use LI.FI. CCTP v2 is available for USDC bridging.',
      '8. Supported chains: Arc (5042), Ethereum (1), Base (8453), Arbitrum (42161), Optimism (10), Polygon (137).',
      '9. If a tool returns an error, explain it clearly without technical jargon.',
      '10. For "send to João / to Base", resolve the name from contacts if available, or ask for the address.'
    ].join('\n');
  }

  function _buildApprovalPreview(tool, args, ctx) {
    if (tool.name === 'send') {
      var feeBps = 20;
      var amount = parseFloat(args.amount) || 0;
      var feeAmt = amount * feeBps / 10000;
      var totalAmt = amount + feeAmt;
      var token = (args.token || 'USDC').toUpperCase();
      var network = (args.network || 'arc').toLowerCase();
      var networkLabel = { arc: 'Arc Mainnet', base: 'Base', ethereum: 'Ethereum', arbitrum: 'Arbitrum', optimism: 'Optimism', polygon: 'Polygon' }[network] || network;
      var fromWallet = (ctx && ctx.walletAddress) ? ctx.walletAddress.slice(0, 6) + '…' + ctx.walletAddress.slice(-4) : 'connected wallet';
      var bal = (ctx && ctx.balances && ctx.balances[token]) ? Number(ctx.balances[token]).toFixed(4) : '?';
      var remaining = (ctx && ctx.balances && ctx.balances[token]) ? (Number(ctx.balances[token]) - totalAmt).toFixed(4) : '?';

      return [
        '**Send ' + amount.toFixed(4) + ' ' + token + '**',
        '',
        '• From: ' + fromWallet,
        '• To: ' + (args.recipient || '?'),
        '• Network: ' + networkLabel,
        '• Fee (0.2%): ' + feeAmt.toFixed(4) + ' ' + token,
        '• Total: ' + totalAmt.toFixed(4) + ' ' + token,
        '• Balance after: ≈' + remaining + ' ' + token,
        '',
        'type **confirm** to approve or **cancel** to abort.'
      ].join('\n');
    }

    // Generic
    var lines = ['**Approval required: ' + tool.description + '**', ''];
    Object.keys(args || {}).forEach(function (k) {
      if (args[k] !== null && args[k] !== undefined) {
        lines.push('• ' + k + ': ' + JSON.stringify(args[k]));
      }
    });
    lines.push('', 'type **confirm** to proceed or **cancel** to abort.');
    return lines.join('\n');
  }

  function _formatToolResult(tool, result, ctx) {
    if (!result.ok) {
      if (result.error === 'NO_WALLET') return 'No wallet is connected. Please connect your wallet first.';
      if (result.stage === 'CANCELLED') return 'Transaction cancelled by user.';
      if (result.stage === 'VALIDATION_FAILED') return 'Could not send: ' + (result.error || 'validation failed');
      return 'Could not complete: ' + (result.error || 'unknown error');
    }

    switch (tool.name) {
      case 'send':
        var sLines = [
          '✅ **Send completed.**',
          '• Sent: ' + (result.amount || '?') + ' ' + (result.token || 'USDC'),
          '• To: ' + (result.recipient ? result.recipient.slice(0, 6) + '…' + result.recipient.slice(-4) : '?'),
          '• Network: ' + (result.network || 'arc')
        ];
        if (result.txHash) {
          sLines.push('• Tx: `' + result.txHash.slice(0, 10) + '…' + result.txHash.slice(-6) + '`');
          var explorer = 'https://explorer.arc.io/tx/' + result.txHash;
          if (result.network === 'base') explorer = 'https://basescan.org/tx/' + result.txHash;
          else if (result.network === 'ethereum') explorer = 'https://etherscan.io/tx/' + result.txHash;
          else if (result.network === 'arbitrum') explorer = 'https://arbiscan.io/tx/' + result.txHash;
          sLines.push('• [View on explorer](' + explorer + ')');
        }
        return sLines.join('\n');
      case 'balance':
        var bLines = ['**Your balances on ' + (ctx.chainName || 'Arc Mainnet') + ':**'];
        Object.keys(result.balances || {}).forEach(function (t) {
          var v = result.balances[t];
          bLines.push('• ' + t + ': ' + (v !== null && v !== undefined ? Number(v).toFixed(4) : 'unavailable'));
        });
        return bLines.join('\n');

      case 'wallet_info':
        var wLines = ['**Wallet Information:**',
          '• EVM Wallet: ' + (result.evmWallet || 'not connected'),
          '• Chain: ' + (result.chainName || 'Arc Mainnet') + ' (ID ' + result.chainId + ')',
          '• Circle Wallet: ' + (result.circleWallet || (result.needsProvision ? 'not provisioned — go to Circle Agent to create' : 'unavailable'))
        ];
        return wLines.join('\n');

      case 'history':
        if (!result.transactions || !result.transactions.length) return 'No recent transactions found.';
        var hLines = ['**Recent transactions (' + result.count + '):**'];
        result.transactions.slice(0, 5).forEach(function (tx) {
          hLines.push('• ' + (tx.type || 'TX') + ' ' + (tx.amount || '') + ' ' + (tx.token || '') + (tx.to ? ' → ' + tx.to.slice(0, 8) + '…' : ''));
        });
        return hLines.join('\n');

      case 'routes':
        if (!result.routes || !result.routes.length) return 'No routes found for ' + result.fromToken + ' → ' + result.toToken + '. The pair may not be supported on this chain.';
        var rLines = ['**Available routes for ' + result.fromToken + ' → ' + result.toToken + ' (' + result.amount + '):**'];
        result.routes.forEach(function (r, i) {
          var out = r.toAmount ? (Number(r.toAmount) / 1e6).toFixed(4) : '~';
          rLines.push((i + 1) + '. ' + r.provider + ' — receive ≈' + out + ' ' + result.toToken + ' (~' + r.estimatedSeconds + 's)');
        });
        return rLines.join('\n');

      case 'schedules':
        if (!result.schedules || !result.schedules.length) return 'No active schedules found.';
        var sLines = ['**Active schedules (' + result.count + '):**'];
        result.schedules.slice(0, 5).forEach(function (s) {
          sLines.push('• ' + (s.name || 'Schedule') + ': ' + (s.amount || '') + ' ' + (s.token || 'USDC') + ' ' + (s.frequency || '') + ' → ' + (s.recipient ? s.recipient.slice(0, 8) + '…' : 'unknown'));
        });
        return sLines.join('\n');

      case 'send':
        return 'Ready to send **' + result.amount + ' ' + result.token + '** to `' + result.to + '`' + (result.memo ? ' (memo: ' + result.memo + ')' : '') + '.\nApproved — executing via your connected wallet.';

      case 'swap':
        return 'Ready to swap **' + result.amount + ' ' + result.fromToken + '** → **' + result.toToken + '**.\nApproved — opening swap execution.';

      case 'bridge':
        return 'Ready to bridge **' + result.amount + ' ' + result.token + '** from ' + result.fromChain + ' → ' + result.toChain + '.\nApproved — opening bridge execution.';

      case 'create_invoice':
        return 'Invoice created for **' + result.amount + ' ' + result.currency + '** — client: ' + result.client + '.';

      case 'create_schedule':
        return 'Schedule "' + result.name + '" created: ' + result.amount + ' ' + result.token + ' ' + result.frequency + '.';

      case 'create_payment_link':
        return 'Payment link "' + result.label + '" created for ' + (result.amount || 'open') + ' ' + result.token + '.';

      default:
        return 'Done: ' + JSON.stringify(result);
    }
  }

  function _keywordFallback(text, ctx) {
    var t = text.toLowerCase();
    if (/saldo|balance|quanto|how much/.test(t)) return 'To check your balance, I\'ll need to read your wallet. Say "show my balance" and I\'ll fetch it.';
    if (/enviar|send|pagar|pay/.test(t)) return 'To send funds, tell me: how much, which token, and the recipient address.';
    if (/swap|trocar|exchange/.test(t)) return 'To swap tokens, tell me: how much, from which token, to which token.';
    if (/bridge|ponte|cross/.test(t)) return 'To bridge, tell me: how much USDC, from which chain, to which chain.';
    if (/invoice|fatura/.test(t)) return 'To create an invoice, tell me the client name and amount.';
    if (/agendar|schedule|recurring/.test(t)) return 'To schedule a payment, tell me: amount, token, recipient, and frequency (daily/weekly/monthly).';
    if (/ajuda|help|o que você faz|what can you do/.test(t)) {
      return [
        '**I can help you with:**',
        '• Check balances and wallet info',
        '• Send USDC / EURC / cirBTC',
        '• Swap tokens on Arc Mainnet',
        '• Bridge cross-chain (Arc ↔ Ethereum, Base, Arbitrum, Optimism, Polygon)',
        '• Find best routes for swaps and bridges',
        '• Create invoices and payment links',
        '• Schedule recurring payments',
        '• View transaction history and schedules',
        '',
        'Just tell me what you want to do in plain language.'
      ].join('\n');
    }
    return 'I\'m Autonoma 2, your AI financial assistant. How can I help you? You can ask about your balance, send funds, swap tokens, bridge cross-chain, or manage invoices and schedules.';
  }

  // Handle "confirm" / "cancel" text as approval responses
  async function handleConfirmCancel(convId, text, onChunk) {
    if (!_pendingApproval || _pendingApproval.convId !== convId) return false;
    var t = text.trim().toLowerCase();
    if (/^(confirm|yes|sim|ok|approve|executar|execute|go|proceed|fazer|yes do it|fazer isso)/.test(t)) {
      await approveAction(_pendingApproval.executionId, onChunk);
      return true;
    }
    if (/^(cancel|no|não|nao|abort|cancelar|stop|pare|nope|not now|agora nao)/.test(t)) {
      cancelApproval(_pendingApproval.executionId);
      if (onChunk) onChunk({ type: 'done', text: 'Action cancelled.' });
      return true;
    }
    return false;
  }

  window.Autonoma2 = {
    newConversation: newConversation,
    getConversation: getConversation,
    listConversations: listConversations,
    setActive: setActive,
    activeId: activeId,
    addMessage: addMessage,
    getMessages: getMessages,
    deleteConversation: deleteConversation,
    sendMessage: sendMessage,
    approveAction: approveAction,
    cancelApproval: cancelApproval,
    handleConfirmCancel: handleConfirmCancel
  };

})();
