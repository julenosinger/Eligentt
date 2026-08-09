/**
 * AutonomaLLM — DeepSeek LLM backend for Autonoma AI Agent
 * ADDITIVE module. Falls back to existing regex pipeline when unavailable.
 * 
 * SECURITY: API key lives server-side (Cloudflare Functions env var DEEPSEEK_API_KEY).
 * The frontend calls /api/deepseek/chat proxy — never sees the key.
 * Auto-detects server availability on first use. No manual toggle needed.
 * 
 * Attached to: window.AutonomaLLM
 */
(function () {
  'use strict';

  var PROXY_URL = '/api/deepseek/chat';
  var TIMEOUT_MS = 30000;

  var _checked = false;
  var _available = false;

  function isAvailable() {
    return _available;
  }

  async function _checkAvailability() {
    if (_checked) return _available;
    _checked = true;
    try {
      var controller = new AbortController();
      var timeout = setTimeout(function () { controller.abort(); }, 5000);
      var resp = await fetch(PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (resp.ok) {
        _available = true;
      } else if (resp.status === 503) {
        _available = false; // key not configured on server
      } else {
        _available = false;
      }
    } catch (_e) {
      _available = false;
    }
    return _available;
  }

  var SYSTEM_PROMPT = [
    'You are Autonoma, an AI agent for the Elligentt financial dApp on Arc Testnet (Chain ID 5042002).',
    'You help users with: sending USDC/EURC/cirBTC payments, creating payment links, creating invoices, scheduling recurring payments, swapping tokens, bridging assets cross-chain via CCTP v2, batch/multi-send payments, checking balances, viewing transaction history, managing agent permissions, and executing multi-step financial workflows.',
    '',
    'Cross-chain is via CCTP v2 (Circle) on these testnets: Ethereum Sepolia (11155111), Base Sepolia (84532), Arbitrum Sepolia (421614), Optimism Sepolia (11155420), Polygon Amoy (80002). Arc domain is 26.',
    '',
    'RESPONSE RULES:',
    '1. Be concise and helpful. Never hallucinate transaction hashes or balances.',
    '2. When the user asks to perform an action, use the appropriate function.',
    '3. When asked a question, answer directly without calling functions unless needed.',
    '4. Always format amounts as numbers (not strings).',
    '5. If the user mentions a wallet address (0x...), use it. If they mention a name, note that you need the address.',
    '6. For "what can you do", list your capabilities briefly.',
    '',
    'USER CONTEXT:',
    'The app has these tabs: Send Assets, Batch Payments, Payment Links, Invoices, Schedule, Swap, Bridge, Liquidity Pool, Autonoma AI, AI Smart Wallet, Treasury Vault, CrossChain, Recipients, Templates, Reports, Settings, Payment Queue.'
  ].join('\n');

  var TOOLS = [
    {
      type: 'function',
      function: {
        name: 'send_payment',
        description: 'Send a single USDC payment to a recipient',
        parameters: {
          type: 'object',
          properties: {
            recipient: { type: 'string', description: 'Recipient wallet address (0x...) or ENS name' },
            amount: { type: 'number', description: 'Amount in USDC' },
            token: { type: 'string', enum: ['USDC', 'EURC', 'cirBTC'], description: 'Token to send', default: 'USDC' },
            memo: { type: 'string', description: 'Optional note/memo' }
          },
          required: ['recipient', 'amount']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'create_payment_link',
        description: 'Create a shareable payment link',
        parameters: {
          type: 'object',
          properties: {
            amount: { type: 'number', description: 'Amount in USDC (0 for open amount)' },
            label: { type: 'string', description: 'Label for the payment link' },
            token: { type: 'string', enum: ['USDC', 'EURC', 'cirBTC'], description: 'Token', default: 'USDC' },
            type: { type: 'string', enum: ['fixed', 'open', 'donation', 'subscription'], description: 'Link type' }
          },
          required: ['amount', 'label']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'create_invoice',
        description: 'Create an invoice with line items',
        parameters: {
          type: 'object',
          properties: {
            client: { type: 'string', description: 'Client name or wallet address' },
            amount: { type: 'number', description: 'Amount in USDC' },
            description: { type: 'string', description: 'What the invoice is for' },
            due_days: { type: 'number', description: 'Days until due', default: 7 },
            currency: { type: 'string', enum: ['USDC', 'EURC', 'cirBTC'], description: 'Currency', default: 'USDC' }
          },
          required: ['amount']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'create_schedule',
        description: 'Create a scheduled/recurring payment',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Schedule name (e.g. Monthly Payroll)' },
            amount: { type: 'number', description: 'Amount per execution' },
            recipient: { type: 'string', description: 'Recipient address' },
            frequency: { type: 'string', enum: ['once', 'daily', 'weekly', 'biweekly', 'monthly'], description: 'How often' },
            token: { type: 'string', enum: ['USDC', 'EURC', 'cirBTC'], description: 'Token', default: 'USDC' }
          },
          required: ['amount', 'frequency']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'swap_tokens',
        description: 'Swap one token for another',
        parameters: {
          type: 'object',
          properties: {
            from_token: { type: 'string', description: 'Token to swap from', default: 'USDC' },
            to_token: { type: 'string', description: 'Token to swap to', default: 'EURC' },
            amount: { type: 'number', description: 'Amount to swap' }
          },
          required: ['amount', 'to_token']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'bridge_assets',
        description: 'Bridge USDC cross-chain via CCTP v2',
        parameters: {
          type: 'object',
          properties: {
            from_chain: { type: 'string', enum: ['Ethereum', 'Base', 'Arbitrum', 'Optimism', 'Polygon'], description: 'Source chain' },
            to_chain: { type: 'string', description: 'Destination chain', default: 'Arc' },
            amount: { type: 'number', description: 'Amount in USDC to bridge' }
          },
          required: ['from_chain', 'amount']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'batch_send',
        description: 'Send USDC to multiple recipients at once',
        parameters: {
          type: 'object',
          properties: {
            recipients: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  address: { type: 'string', description: 'Recipient wallet address' },
                  amount: { type: 'number', description: 'Amount in USDC' },
                  note: { type: 'string', description: 'Optional note' }
                },
                required: ['address', 'amount']
              },
              description: 'List of recipients with amounts'
            }
          },
          required: ['recipients']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'check_balance',
        description: 'Check wallet balance or get wallet info',
        parameters: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'Token to check (default: all)', default: 'all' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'query_history',
        description: 'Show transaction history or reports',
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['recent', 'reports', 'queue', 'schedules'], description: 'What to show' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'manage_permissions',
        description: 'Manage agent wallet permissions',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['show', 'revoke', 'grant', 'audit'], description: 'Permission action' }
          },
          required: ['action']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_help',
        description: 'Show what Autonoma can do',
        parameters: {
          type: 'object',
          properties: {}
        }
      }
    }
  ];

  function _buildMessages(userMsg) {
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMsg }
    ];
  }

  async function _callDeepSeek(messages, tools) {
    if (!_available) return null;

    var body = {
      model: 'deepseek-chat',
      messages: messages,
      temperature: 0.3,
      max_tokens: 1024
    };
    if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);

    try {
      var resp = await fetch(PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!resp.ok) return null;
      return await resp.json();
    } catch (e) {
      clearTimeout(timeout);
      return null;
    }
  }

  /**
   * Main entry point. Calls DeepSeek LLM, routes tool calls to existing handlers.
   * Returns HTML string on success, null on failure (triggers fallback to regex).
   */
  async function ask(userMsg) {
    await _checkAvailability();
    if (!_available) return null;

    var messages = _buildMessages(userMsg);
    var result = await _callDeepSeek(messages, TOOLS);
    if (!result || !result.choices || !result.choices[0]) return null;

    var choice = result.choices[0];
    var msg = choice.message;

    // Tool call response — route to existing handlers
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      return _handleToolCall(msg.tool_calls[0]);
    }

    // Direct text response
    if (msg.content && msg.content.trim()) {
      return _formatTextResponse(msg.content);
    }

    return null;
  }

  function _formatTextResponse(text) {
    var formatted = escHtml(text)
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code style="background:rgba(79,142,247,.1);padding:1px 4px;border-radius:2px;font-size:10px">$1</code>')
      .replace(/\n/g, '<br>');
    return '<div style="font-size:10px;line-height:1.6;color:var(--text)">' + formatted + '</div><div style="font-size:7px;color:var(--muted2);margin-top:6px;text-align:right">Powered by DeepSeek</div>';
  }

  function _handleToolCall(toolCall) {
    var fn = toolCall.function;
    var name = fn.name;
    var args = {};
    try { args = JSON.parse(fn.arguments); } catch (_e) { args = {}; }

    switch (name) {
      case 'send_payment':
        return _handleSendPayment(args);
      case 'create_payment_link':
        return _handleCreatePaymentLink(args);
      case 'create_invoice':
        return _handleCreateInvoice(args);
      case 'create_schedule':
        return _handleCreateSchedule(args);
      case 'swap_tokens':
        return _handleSwapTokens(args);
      case 'bridge_assets':
        return _handleBridgeAssets(args);
      case 'batch_send':
        return _handleBatchSend(args);
      case 'check_balance':
        return _handleCheckBalance(args);
      case 'query_history':
        return _handleQueryHistory(args);
      case 'manage_permissions':
        return _handleManagePermissions(args);
      case 'get_help':
        return _handleGetHelp();
      default:
        return null;
    }
  }

  function _cardHtml(title, body, icon, color) {
    icon = icon || 'robot';
    color = color || 'var(--blue)';
    return '<div class="card" style="margin:4px 0"><div class="ch"><i class="ti ti-' + icon + '" style="font-size:13px;color:' + color + '"></i><span class="ct">' + escHtml(title) + '</span></div><div class="cb">' + body + '</div></div>';
  }

  function _actionButtons(buttons) {
    return '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:8px">' + buttons.map(function (b) {
      return '<button class="btn" style="font-size:8px;padding:4px 8px;' + (b.primary ? 'background:var(--blue);color:#fff' : '') + '" onclick="' + b.action + '">' + b.label + '</button>';
    }).join('') + '</div>';
  }

  // ── Tool Handlers ───────────────────────────────────────

  function _handleSendPayment(args) {
    var recipient = args.recipient || '';
    var amount = args.amount || 0;
    var token = args.token || 'USDC';
    var memo = args.memo || '';

    if (!recipient || !isAddr(recipient)) {
      return _cardHtml('Send Payment', '<p style="font-size:10px">To send ' + amount + ' ' + token + ', I need a valid recipient address.</p><p style="font-size:9px;color:var(--muted2)">Please provide a wallet address (0x...) or ENS name.</p>', 'send', 'var(--blue)');
    }

    var body = '<div style="font-size:10px;display:flex;flex-direction:column;gap:4px">';
    body += '<div><span style="color:var(--muted2)">Recipient:</span> <span style="font-family:monospace;color:var(--blue)">' + shortAddr(recipient) + '</span></div>';
    body += '<div><span style="color:var(--muted2)">Amount:</span> <strong>' + amount + ' ' + token + '</strong></div>';
    if (memo) body += '<div><span style="color:var(--muted2)">Memo:</span> ' + escHtml(memo) + '</div>';
    body += '</div>';
    body += _actionButtons([
      { label: ' Send ' + amount + ' ' + token, primary: true, action: 'autonomaSendQuick(\'send ' + amount + ' ' + token + ' to ' + recipient + '\')' },
      { label: ' Open Send Page', action: 'showPage(\'send\')' }
    ]);
    return _cardHtml('Send ' + amount + ' ' + token, body, 'send', 'var(--blue)');
  }

  function _handleCreatePaymentLink(args) {
    var amount = args.amount || 0;
    var label = args.label || 'Payment';
    var token = args.token || 'USDC';
    var type = args.type || 'fixed';

    var body = '<div style="font-size:10px;display:flex;flex-direction:column;gap:4px">';
    body += '<div><span style="color:var(--muted2)">Amount:</span> <strong>' + (amount > 0 ? amount : 'Open') + ' ' + token + '</strong></div>';
    body += '<div><span style="color:var(--muted2)">Type:</span> ' + type + '</div>';
    body += '</div>';
    body += _actionButtons([
      { label: ' Create Payment Link', primary: true, action: 'autonomaSendQuick(\'create payment link ' + amount + ' ' + token + ' named ' + label + '\')' },
      { label: ' Open Links Page', action: 'showPage(\'links\')' }
    ]);
    return _cardHtml('Create Payment Link: ' + label, body, 'link', 'var(--teal)');
  }

  function _handleCreateInvoice(args) {
    var client = args.client || 'Client';
    var amount = args.amount || 0;
    var desc = args.description || '';
    var currency = args.currency || 'USDC';
    var dueDays = args.due_days || 7;

    var body = '<div style="font-size:10px;display:flex;flex-direction:column;gap:4px">';
    body += '<div><span style="color:var(--muted2)">Client:</span> ' + escHtml(client) + '</div>';
    body += '<div><span style="color:var(--muted2)">Amount:</span> <strong>' + amount + ' ' + currency + '</strong></div>';
    body += '<div><span style="color:var(--muted2)">Due:</span> ' + dueDays + ' days</div>';
    if (desc) body += '<div><span style="color:var(--muted2)">For:</span> ' + escHtml(desc) + '</div>';
    body += '</div>';
    body += _actionButtons([
      { label: ' Create Invoice', primary: true, action: 'autonomaSendQuick(\'create invoice for ' + amount + ' ' + currency + ' from ' + client + ' for ' + (desc || 'services') + '\')' },
      { label: ' Open Invoices', action: 'showPage(\'invoices\')' }
    ]);
    return _cardHtml('Create Invoice', body, 'file-invoice', 'var(--yellow)');
  }

  function _handleCreateSchedule(args) {
    var name = args.name || 'Scheduled Payment';
    var amount = args.amount || 0;
    var recipient = args.recipient || '';
    var freq = args.frequency || 'monthly';
    var token = args.token || 'USDC';

    var body = '<div style="font-size:10px;display:flex;flex-direction:column;gap:4px">';
    body += '<div><span style="color:var(--muted2)">Amount:</span> <strong>' + amount + ' ' + token + '</strong></div>';
    body += '<div><span style="color:var(--muted2)">Frequency:</span> ' + freq + '</div>';
    if (recipient) body += '<div><span style="color:var(--muted2)">Recipient:</span> <span style="font-family:monospace;color:var(--blue)">' + shortAddr(recipient) + '</span></div>';
    body += '</div>';
    body += _actionButtons([
      { label: ' Create Schedule', primary: true, action: 'autonomaSendQuick(\'schedule ' + name + ' ' + amount + ' ' + token + ' ' + freq + '\')' },
      { label: ' Open Schedule', action: 'showPage(\'schedule\')' }
    ]);
    return _cardHtml('Schedule: ' + name, body, 'calendar-event', 'var(--orange)');
  }

  function _handleSwapTokens(args) {
    var fromToken = args.from_token || 'USDC';
    var toToken = args.to_token || 'EURC';
    var amount = args.amount || 0;

    var body = '<div style="font-size:10px;display:flex;flex-direction:column;gap:4px">';
    body += '<div><span style="color:var(--muted2)">From:</span> <strong>' + amount + ' ' + fromToken + '</strong></div>';
    body += '<div><span style="color:var(--muted2)">To:</span> <strong>' + toToken + '</strong></div>';
    body += '</div>';
    body += _actionButtons([
      { label: ' Swap Now', primary: true, action: 'autonomaSendQuick(\'swap ' + amount + ' ' + fromToken + ' for ' + toToken + '\')' },
      { label: ' Open Swap Page', action: 'showPage(\'swap\')' }
    ]);
    return _cardHtml('Swap ' + fromToken + ' → ' + toToken, body, 'arrows-exchange', 'var(--purple)');
  }

  function _handleBridgeAssets(args) {
    var fromChain = args.from_chain || 'Ethereum';
    var toChain = args.to_chain || 'Arc';
    var amount = args.amount || 0;

    var body = '<div style="font-size:10px;display:flex;flex-direction:column;gap:4px">';
    body += '<div><span style="color:var(--muted2)">From:</span> <strong>' + fromChain + '</strong> → <strong>' + toChain + '</strong></div>';
    body += '<div><span style="color:var(--muted2)">Amount:</span> <strong>' + amount + ' USDC</strong></div>';
    body += '<div style="font-size:8px;color:var(--muted2)">Via Circle CCTP v2 — attestation takes ~2-10 min</div>';
    body += '</div>';
    body += _actionButtons([
      { label: ' Bridge ' + amount + ' USDC', primary: true, action: 'autonomaSendQuick(\'bridge ' + amount + ' USDC from ' + fromChain + ' to ' + toChain + '\')' },
      { label: ' Open Bridge Page', action: 'showPage(\'bridge\')' }
    ]);
    return _cardHtml('Bridge via CCTP v2', body, 'topology-star-3', 'var(--teal)');
  }

  function _handleBatchSend(args) {
    var recipients = args.recipients || [];
    var total = recipients.reduce(function (s, r) { return s + (r.amount || 0); }, 0);

    var body = '<div style="font-size:10px;display:flex;flex-direction:column;gap:4px">';
    body += '<div><span style="color:var(--muted2)">Recipients:</span> <strong>' + recipients.length + '</strong></div>';
    body += '<div><span style="color:var(--muted2)">Total:</span> <strong>' + total + ' USDC</strong></div>';
    recipients.slice(0, 5).forEach(function (r) {
      body += '<div style="font-size:9px"><span style="font-family:monospace;color:var(--muted2)">' + shortAddr(r.address) + '</span> — ' + (r.amount || 0) + ' USDC</div>';
    });
    if (recipients.length > 5) body += '<div style="font-size:8px;color:var(--muted2)">...and ' + (recipients.length - 5) + ' more</div>';
    body += '</div>';
    body += _actionButtons([
      { label: ' Open Batch Page', primary: true, action: 'showPage(\'batch\')' }
    ]);
    return _cardHtml('Batch Send — ' + recipients.length + ' recipients', body, 'stack', 'var(--blue)');
  }

  function _handleCheckBalance(args) {
    var token = args.token || 'all';
    var body = '<p style="font-size:10px">Let me check your balances...</p>';
    body += _actionButtons([
      { label: ' Show Balance', primary: true, action: 'autonomaSendQuick(\'show my wallet summary\')' }
    ]);
    return _cardHtml('Balance Check', body, 'wallet', 'var(--green)');
  }

  function _handleQueryHistory(args) {
    var type = args.type || 'recent';
    var types = { recent: 'recent transactions', reports: 'reports', queue: 'execution queue', schedules: 'scheduled payments' };
    var label = types[type] || 'transaction history';
    var body = _actionButtons([
      { label: ' Show ' + label, primary: true, action: 'autonomaSendQuick(\'' + label + '\')' }
    ]);
    return _cardHtml('Query: ' + label, body, 'history', 'var(--purple)');
  }

  function _handleManagePermissions(args) {
    var action = args.action || 'show';
    var actions = { show: 'show permissions', revoke: 'revoke permissions', grant: 'grant permissions', audit: 'audit log' };
    var label = actions[action] || 'show permissions';
    var body = _actionButtons([
      { label: ' ' + label, primary: true, action: 'autonomaSendQuick(\'' + label + '\')' }
    ]);
    return _cardHtml('Permissions: ' + label, body, 'shield-check', 'var(--yellow)');
  }

  function _handleGetHelp() {
    var body = '<div style="font-size:10px">' +
      '<p>Here\'s what I can help with:</p>' +
      '<ul style="margin:4px 0;padding-left:16px;line-height:1.6">' +
      '<li> Send USDC/EURC/cirBTC payments</li>' +
      '<li> Create payment links and invoices</li>' +
      '<li> Schedule recurring payments</li>' +
      '<li> Swap tokens & bridge cross-chain (CCTP v2)</li>' +
      '<li> Batch send to multiple recipients</li>' +
      '<li> Check balances & transaction history</li>' +
      '<li> Manage agent wallet permissions</li>' +
      '</ul>' +
      '<p style="font-size:9px;color:var(--muted2)">Try: "send 100 USDC to 0x...", "create invoice for 500 USDC", "bridge 300 USDC from Base to Arc", "show my balance"</p>' +
      '</div>';
    return _cardHtml('Autonoma Capabilities', body, 'brain', '#06F7E9');
  }

  // ── Public API ──────────────────────────────────────────
  window.AutonomaLLM = {
    VERSION: '1.2.0',
    ask: ask,
    isAvailable: isAvailable
  };
})();
