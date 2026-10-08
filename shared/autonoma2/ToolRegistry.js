/**
 * Autonoma 2 — Tool Registry
 * Declarative registry of every tool the agent can use.
 * Each tool has: name, description, type (read|write), requiresApproval,
 * inputSchema, and an execute() that delegates to existing engines.
 * No business logic here — only routing and schema.
 */
(function () {
  'use strict';

  var _tools = {};

  function register(tool) {
    if (!tool || !tool.name) return;
    _tools[tool.name] = tool;
  }

  function get(name) { return _tools[name] || null; }
  function list() { return Object.values(_tools); }
  function listNames() { return Object.keys(_tools); }

  // ─── READ TOOLS ─────────────────────────────────────────────────────────────

  register({
    name: 'balance',
    description: 'Get current wallet balances (USDC, EURC, cirBTC) on all chains',
    type: 'read',
    requiresApproval: false,
    llmDescription: 'Retrieve the user\'s token balances. No parameters needed.',
    parameters: {},
    execute: async function (params, ctx) {
      var addr = ctx.walletAddress;
      if (!addr) return { ok: false, error: 'NO_WALLET', message: 'No wallet connected.' };
      var balances = {};
      try {
        if (typeof BalanceService !== 'undefined') {
          var tokens = ['USDC', 'EURC', 'cirBTC'];
          var chainId = ctx.chainId || 5042;
          for (var i = 0; i < tokens.length; i++) {
            try {
              var b = await BalanceService.getTokenBalance(addr, tokens[i], chainId);
              balances[tokens[i]] = b;
            } catch (e) { balances[tokens[i]] = null; }
          }
        }
      } catch (e) { /* continue */ }
      return { ok: true, walletAddress: addr, chainId: ctx.chainId || 5042, balances: balances };
    }
  });

  register({
    name: 'history',
    description: 'Get recent transaction history',
    type: 'read',
    requiresApproval: false,
    llmDescription: 'Retrieve recent transactions. Optional: limit (number, default 10).',
    parameters: { limit: { type: 'number', default: 10 } },
    execute: async function (params, ctx) {
      var limit = Math.min(params.limit || 10, 50);
      var txs = [];
      try {
        if (typeof Store !== 'undefined') {
          var stored = Store.load('txHistory') || [];
          txs = stored.slice(0, limit);
        }
      } catch (e) { /* continue */ }
      return { ok: true, transactions: txs, count: txs.length };
    }
  });

  register({
    name: 'wallet_info',
    description: 'Get wallet address, Circle wallet, and chain information',
    type: 'read',
    requiresApproval: false,
    llmDescription: 'Get the user\'s wallet address, chain, and Circle wallet details.',
    parameters: {},
    execute: async function (params, ctx) {
      var result = {
        ok: true,
        evmWallet: ctx.walletAddress || null,
        chainId: ctx.chainId || 5042,
        chainName: ctx.chainName || 'Arc Mainnet',
        circleWallet: ctx.circleWalletAddress || null
      };
      // Try to get Circle wallet from CircleAgent
      if (!result.circleWallet && typeof CircleAgent !== 'undefined') {
        try {
          var status = await fetch('/api/agent/status', { credentials: 'same-origin' });
          if (status.ok) {
            var s = await status.json();
            result.circleWallet = s.walletAddress || s.address || null;
            result.needsProvision = s.needsProvision || false;
          }
        } catch (e) { /* continue */ }
      }
      return result;
    }
  });

  register({
    name: 'routes',
    description: 'Get available swap/bridge routes for a token pair',
    type: 'read',
    requiresApproval: false,
    llmDescription: 'Find routes for swapping or bridging tokens. Parameters: fromToken, toToken, amount, fromChain (optional), toChain (optional).',
    parameters: {
      fromToken: { type: 'string', required: true },
      toToken: { type: 'string', required: true },
      amount: { type: 'number', required: true },
      fromChain: { type: 'string', default: 'Arc' },
      toChain: { type: 'string', default: 'Arc' }
    },
    execute: async function (params, ctx) {
      if (!params.fromToken || !params.toToken || !params.amount) {
        return { ok: false, error: 'MISSING_PARAMS' };
      }
      var routes = [];
      var addr = ctx.walletAddress;
      if (!addr) return { ok: false, error: 'NO_WALLET' };
      try {
        var fromChainId = _resolveChainId(params.fromChain || 'Arc');
        var toChainId   = _resolveChainId(params.toChain || 'Arc');
        var decimals = params.fromToken.toLowerCase() === 'cirbtc' ? 8 : 6;
        var amountRaw = String(Math.round(params.amount * Math.pow(10, decimals)));
        var qp = new URLSearchParams({
          fromChain: fromChainId,
          toChain: toChainId,
          fromToken: _resolveTokenAddr(fromChainId, params.fromToken),
          toToken: _resolveTokenAddr(toChainId, params.toToken),
          fromAmount: amountRaw,
          fromAddress: addr.toLowerCase(),
          toAddress: addr.toLowerCase()
        });
        var res = await fetch('/api/lifi/routes?' + qp.toString());
        if (res.ok) {
          var data = await res.json();
          routes = (data.routes || []).slice(0, 5).map(function (r) {
            return {
              id: r.id,
              steps: r.steps ? r.steps.length : 1,
              provider: r.steps && r.steps[0] ? (r.steps[0].toolDetails && r.steps[0].toolDetails.name) || r.steps[0].tool : 'LI.FI',
              toAmount: r.toAmount,
              toAmountMin: r.toAmountMin,
              toToken: r.toAmountMin ? params.toToken : params.toToken,
              estimatedSeconds: r.steps ? r.steps.reduce(function (a, s) { return a + (s.estimate && s.estimate.executionDuration || 30); }, 0) : 30,
              gasCostUSD: r.gasCostUSD,
              feeCostUSD: r.feeCostUSD
            };
          });
        }
      } catch (e) { /* continue */ }
      return { ok: true, routes: routes, fromToken: params.fromToken, toToken: params.toToken, amount: params.amount };
    }
  });

  register({
    name: 'schedules',
    description: 'List scheduled/recurring payments',
    type: 'read',
    requiresApproval: false,
    llmDescription: 'List the user\'s scheduled and recurring payments.',
    parameters: {},
    execute: async function (params, ctx) {
      var list = [];
      try {
        if (typeof Store !== 'undefined') {
          list = (Store.load('schedules') || []).filter(function (s) { return s && s.active !== false; });
        }
      } catch (e) { /* continue */ }
      return { ok: true, schedules: list, count: list.length };
    }
  });

  // ─── WRITE TOOLS (all require approval) ────────────────────────────────────

  register({
    name: 'send',
    description: 'Send tokens to a recipient address',
    type: 'write',
    requiresApproval: true,
    llmDescription: 'Send USDC, EURC, or cirBTC to a recipient. Parameters: to (address), amount (number), token (USDC|EURC|cirBTC, default USDC), memo (optional string).',
    parameters: {
      to: { type: 'string', required: true, description: 'Recipient address (0x...)' },
      amount: { type: 'number', required: true },
      token: { type: 'string', default: 'USDC', enum: ['USDC', 'EURC', 'cirBTC'] },
      memo: { type: 'string' }
    },
    execute: async function (params, ctx) {
      // Delegate to existing send engine
      if (!params.to || !params.amount) return { ok: false, error: 'MISSING_PARAMS' };
      if (!ctx.walletAddress) return { ok: false, error: 'NO_WALLET' };
      // This tool signals the execution orchestrator — actual signing happens via existing flow
      return {
        ok: true,
        action: 'send',
        to: params.to,
        amount: params.amount,
        token: params.token || 'USDC',
        memo: params.memo || '',
        walletAddress: ctx.walletAddress
      };
    }
  });

  register({
    name: 'swap',
    description: 'Swap one token for another using the existing swap engine',
    type: 'write',
    requiresApproval: true,
    llmDescription: 'Swap tokens. Parameters: fromToken (USDC|EURC|cirBTC), toToken (USDC|EURC|cirBTC), amount (number).',
    parameters: {
      fromToken: { type: 'string', required: true, enum: ['USDC', 'EURC', 'cirBTC'] },
      toToken: { type: 'string', required: true, enum: ['USDC', 'EURC', 'cirBTC'] },
      amount: { type: 'number', required: true }
    },
    execute: async function (params, ctx) {
      if (!params.fromToken || !params.toToken || !params.amount) return { ok: false, error: 'MISSING_PARAMS' };
      // Get quote first
      var quoteResult = null;
      try {
        if (typeof SwapAggregator !== 'undefined' && typeof SwapAggregator.getBestQuote === 'function') {
          var decimals = params.fromToken.toLowerCase() === 'cirbtc' ? 8 : 6;
          var amountRaw = BigInt(Math.round(params.amount * Math.pow(10, decimals)));
          quoteResult = await Promise.race([
            SwapAggregator.getBestQuote({
              tokenIn: params.fromToken,
              tokenOut: params.toToken,
              amountInRaw: amountRaw,
              chainId: ctx.chainId || 5042,
              fromChainId: ctx.chainId || 5042,
              toChainId: ctx.chainId || 5042,
              userAddress: ctx.walletAddress,
              timeoutMs: 7000
            }),
            new Promise(function (res) { setTimeout(function () { res(null); }, 8000); })
          ]);
        }
      } catch (e) { /* continue */ }
      return {
        ok: true,
        action: 'swap',
        fromToken: params.fromToken,
        toToken: params.toToken,
        amount: params.amount,
        quote: quoteResult,
        walletAddress: ctx.walletAddress
      };
    }
  });

  register({
    name: 'bridge',
    description: 'Bridge USDC cross-chain via LI.FI or CCTP',
    type: 'write',
    requiresApproval: true,
    llmDescription: 'Bridge tokens between chains. Parameters: fromChain, toChain, amount, token (default USDC).',
    parameters: {
      fromChain: { type: 'string', required: true },
      toChain: { type: 'string', required: true },
      amount: { type: 'number', required: true },
      token: { type: 'string', default: 'USDC' }
    },
    execute: async function (params, ctx) {
      if (!params.fromChain || !params.toChain || !params.amount) return { ok: false, error: 'MISSING_PARAMS' };
      return {
        ok: true,
        action: 'bridge',
        fromChain: params.fromChain,
        toChain: params.toChain,
        amount: params.amount,
        token: params.token || 'USDC',
        walletAddress: ctx.walletAddress
      };
    }
  });

  register({
    name: 'create_invoice',
    description: 'Create an invoice for a client',
    type: 'write',
    requiresApproval: true,
    llmDescription: 'Create an invoice. Parameters: client (name or address), amount (number), currency (USDC|EURC|cirBTC), description (optional), due_days (optional, default 7).',
    parameters: {
      client: { type: 'string', required: true },
      amount: { type: 'number', required: true },
      currency: { type: 'string', default: 'USDC', enum: ['USDC', 'EURC', 'cirBTC'] },
      description: { type: 'string' },
      due_days: { type: 'number', default: 7 }
    },
    execute: async function (params, ctx) {
      if (!params.amount) return { ok: false, error: 'MISSING_PARAMS' };
      return {
        ok: true,
        action: 'create_invoice',
        client: params.client || 'Client',
        amount: params.amount,
        currency: params.currency || 'USDC',
        description: params.description || '',
        due_days: params.due_days || 7
      };
    }
  });

  register({
    name: 'create_schedule',
    description: 'Create a scheduled or recurring payment',
    type: 'write',
    requiresApproval: true,
    llmDescription: 'Schedule a recurring payment. Parameters: name, amount, recipient (address), frequency (once|daily|weekly|biweekly|monthly), token (default USDC).',
    parameters: {
      name: { type: 'string', required: true },
      amount: { type: 'number', required: true },
      recipient: { type: 'string', required: true },
      frequency: { type: 'string', required: true, enum: ['once', 'daily', 'weekly', 'biweekly', 'monthly'] },
      token: { type: 'string', default: 'USDC' }
    },
    execute: async function (params, ctx) {
      if (!params.amount || !params.frequency) return { ok: false, error: 'MISSING_PARAMS' };
      return {
        ok: true,
        action: 'create_schedule',
        name: params.name || 'Scheduled Payment',
        amount: params.amount,
        recipient: params.recipient,
        frequency: params.frequency,
        token: params.token || 'USDC'
      };
    }
  });

  register({
    name: 'create_payment_link',
    description: 'Create a shareable payment link',
    type: 'write',
    requiresApproval: true,
    llmDescription: 'Create a payment link. Parameters: label, amount (0 for open), token (default USDC), type (fixed|open|donation).',
    parameters: {
      label: { type: 'string', required: true },
      amount: { type: 'number', default: 0 },
      token: { type: 'string', default: 'USDC' },
      type: { type: 'string', default: 'fixed', enum: ['fixed', 'open', 'donation'] }
    },
    execute: async function (params, ctx) {
      return {
        ok: true,
        action: 'create_payment_link',
        label: params.label || 'Payment Link',
        amount: params.amount || 0,
        token: params.token || 'USDC',
        type: params.type || 'fixed'
      };
    }
  });

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function _resolveChainId(name) {
    var map = { arc: 5042, ethereum: 1, eth: 1, base: 8453, arbitrum: 42161, arb: 42161, optimism: 10, op: 10, polygon: 137, matic: 137 };
    if (!isNaN(Number(name))) return Number(name);
    return map[(name || '').toLowerCase()] || 5042;
  }

  function _resolveTokenAddr(chainId, sym) {
    var TOKENS = {
      5042: { USDC: '0x3600000000000000000000000000000000000000', EURC: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1', CIRBTC: '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0' },
      8453: { USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', EURC: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42' },
      1: { USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', EURC: '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c' },
      42161: { USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
      10: { USDC: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' },
      137: { USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' }
    };
    var chain = TOKENS[chainId] || TOKENS[5042];
    var s = (sym || '').toUpperCase();
    return chain[s] || chain['USDC'];
  }

  // ─── WRITE TOOLS — registered after page load so A2SendTool is available ───

  function _registerWriteTools() {
    // Send — delegates entirely to saExecuteSend via A2SendTool
    if (typeof window.A2SendTool !== 'undefined') {
      register(window.A2SendTool);
    } else {
      // Stub: will be replaced when A2SendTool loads
      register({
        name: 'send',
        description: 'Send tokens to a recipient.',
        llmDescription: 'Send USDC, EURC, or cirBTC to an address, ENS name, or contact. Specify amount, token, recipient, and optionally network.',
        type: 'write',
        requiresApproval: true,
        parameters: {
          recipient: { type: 'string', description: 'Recipient address (0x...), ENS, or contact name', required: true },
          amount: { type: 'number', description: 'Amount to send', required: true },
          token: { type: 'string', description: 'Token: USDC, EURC, cirBTC. Default USDC', required: false },
          network: { type: 'string', description: 'Network: arc, base, ethereum, arbitrum, optimism, polygon', required: false }
        },
        validate: async function (args, ctx) {
          if (typeof window.A2SendTool !== 'undefined') return window.A2SendTool.validate(args, ctx);
          return { ok: false, errors: ['Send tool not loaded'] };
        },
        execute: async function (args, ctx, onProgress) {
          if (typeof window.A2SendTool !== 'undefined') return window.A2SendTool.execute(args, ctx, onProgress);
          return { ok: false, error: 'Send tool not loaded', stage: 'ENGINE_UNAVAILABLE' };
        }
      });
    }
  }

  // Run after DOM ready so A2SendTool is available
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _registerWriteTools);
  } else {
    setTimeout(_registerWriteTools, 0);
  }

  window.A2ToolRegistry = {
    register: register,
    get: get,
    list: list,
    listNames: listNames
  };

})();
