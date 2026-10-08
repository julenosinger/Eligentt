/**
 * Autonoma 2 — Planner
 * Transforms natural language into structured intents.
 * Used as a pre-LLM fast path for common patterns,
 * and as a post-LLM intent validator.
 * Never executes blockchain operations.
 * Attached to window.A2Planner
 */
(function () {
  'use strict';

  var CHAIN_IDS = { arc: 5042, ethereum: 1, eth: 1, base: 8453, arbitrum: 42161, arb: 42161, optimism: 10, op: 10, polygon: 137, matic: 137 };
  var TOKENS = ['USDC', 'EURC', 'CIRBTC', 'ETH', 'MATIC', 'ARB'];

  /**
   * Parse a plain-text user message into a structured intent.
   * Returns null if no clear intent is detected (LLM handles it).
   *
   * @param {string} text
   * @param {object} ctx — A2Context snapshot
   * @returns {object|null}
   */
  function parse(text, ctx) {
    if (!text) return null;
    var t = text.toLowerCase().trim();

    // Balance query
    if (/\b(saldo|balance|quanto|how much|balances?|my funds?|meu saldo)\b/.test(t)) {
      var token = _extractToken(t);
      var chain = _extractChain(t);
      return { intent: 'balance', token: token, chainId: chain || (ctx && ctx.chainId) || 5042, readOnly: true };
    }

    // Wallet info
    if (/\b(wallet|carteira|endere[cç]o|address|minha wallet|my wallet)\b/.test(t)) {
      return { intent: 'wallet_info', readOnly: true };
    }

    // History / transactions
    if (/\b(history|hist[oó]rico|transa[cç][oõ]es|transactions?|recente|recent|ultimas?|last)\b/.test(t)) {
      var limit = _extractNumber(t) || 10;
      return { intent: 'history', limit: Math.min(limit, 50), readOnly: true };
    }

    // Routes / best route query
    if (/\b(rota|route|melhor rota|best route|how to (bridge|send)|caminho)\b/.test(t)) {
      var fromChain = _extractFromChain(t) || (ctx && ctx.chainId) || 5042;
      var toChain   = _extractToChain(t)   || 5042;
      var amount    = _extractAmount(t)     || 100;
      var fromTok   = _extractToken(t)      || 'USDC';
      return { intent: 'routes', fromChain: fromChain, toChain: toChain, amount: amount, fromToken: fromTok, toToken: fromTok, readOnly: true };
    }

    // Schedules
    if (/\b(schedule|agendamento|recorrente|recurring|pagamento agendado|scheduled)\b/.test(t)) {
      return { intent: 'schedules', readOnly: true };
    }

    // Send
    if (/\b(enviar|send|pagar|pay|transfer)\b/.test(t)) {
      var amount2   = _extractAmount(t);
      var token2    = _extractToken(t)    || 'USDC';
      var recipient = _extractAddress(t)  || null;
      return { intent: 'send', amount: amount2, token: token2, to: recipient, readOnly: false, requiresApproval: true };
    }

    // Swap
    if (/\b(swap|trocar|exchange|converter)\b/.test(t)) {
      var amount3 = _extractAmount(t);
      var tokens  = _extractTwoTokens(t);
      return { intent: 'swap', amount: amount3, fromToken: tokens[0] || 'USDC', toToken: tokens[1] || 'EURC', readOnly: false, requiresApproval: true };
    }

    // Bridge
    if (/\b(bridge|ponte|cross[- ]?chain|mover|move)\b/.test(t)) {
      var amount4   = _extractAmount(t);
      var fromChain2 = _extractFromChain(t) || (ctx && ctx.chainId) || 5042;
      var toChain2   = _extractToChain(t)   || 8453;
      var token4     = _extractToken(t)     || 'USDC';
      return { intent: 'bridge', amount: amount4, fromChain: fromChain2, toChain: toChain2, token: token4, readOnly: false, requiresApproval: true };
    }

    // Invoice
    if (/\b(invoice|fatura|cobrar|cobran[cç]a)\b/.test(t)) {
      var amount5 = _extractAmount(t);
      var token5  = _extractToken(t) || 'USDC';
      return { intent: 'create_invoice', amount: amount5, currency: token5, readOnly: false, requiresApproval: true };
    }

    // Payment link
    if (/\b(payment link|link de pagamento|criar link)\b/.test(t)) {
      var amount6 = _extractAmount(t);
      return { intent: 'create_payment_link', amount: amount6 || 0, readOnly: false, requiresApproval: true };
    }

    // Help
    if (/\b(help|ajuda|o que (voc[eê] faz|vc faz)|what can you do|capabilities|funcionalidades)\b/.test(t)) {
      return { intent: 'help', readOnly: true };
    }

    return null; // Let the LLM handle it
  }

  /**
   * Validate that a tool call from the LLM is safe to route.
   * Returns { ok: true } or { ok: false, reason: string }
   */
  function validateToolCall(toolName, args) {
    var READ_TOOLS = ['balance', 'history', 'wallet_info', 'routes', 'schedules'];
    var WRITE_TOOLS = ['send', 'swap', 'bridge', 'create_invoice', 'create_schedule', 'create_payment_link'];
    var ALL_TOOLS = READ_TOOLS.concat(WRITE_TOOLS);

    if (!ALL_TOOLS.includes(toolName)) {
      return { ok: false, reason: 'Unknown tool: ' + toolName };
    }

    // Write tools need approval — they are never auto-executed
    if (WRITE_TOOLS.includes(toolName)) {
      if (!args || typeof args !== 'object') {
        return { ok: false, reason: 'Missing arguments for write tool' };
      }
      if ((toolName === 'send' || toolName === 'swap' || toolName === 'bridge') && !args.amount) {
        return { ok: false, reason: 'Amount required for ' + toolName };
      }
    }

    return { ok: true };
  }

  // ─── Extraction helpers ───────────────────────────────────────────────────

  function _extractAmount(text) {
    var m = text.match(/(\d+(?:[.,]\d+)?)\s*(?:usdc|eurc|cirbtc|usd|eur|btc)?/i);
    if (m) return parseFloat(m[1].replace(',', '.'));
    return null;
  }

  function _extractToken(text) {
    for (var i = 0; i < TOKENS.length; i++) {
      if (text.toLowerCase().includes(TOKENS[i].toLowerCase())) return TOKENS[i].toUpperCase();
    }
    return null;
  }

  function _extractTwoTokens(text) {
    var found = [];
    for (var i = 0; i < TOKENS.length; i++) {
      var re = new RegExp('\\b' + TOKENS[i] + '\\b', 'i');
      if (re.test(text)) found.push(TOKENS[i].toUpperCase());
      if (found.length === 2) break;
    }
    return found;
  }

  function _extractChain(text) {
    for (var name in CHAIN_IDS) {
      if (text.includes(name)) return CHAIN_IDS[name];
    }
    return null;
  }

  function _extractFromChain(text) {
    var m = text.match(/\b(?:from|de|da?)\s+([a-z]+)\b/i);
    if (m) return CHAIN_IDS[m[1].toLowerCase()] || null;
    return null;
  }

  function _extractToChain(text) {
    var m = text.match(/\b(?:to|para|p[rp]a?)\s+([a-z]+)\b/i);
    if (m) return CHAIN_IDS[m[1].toLowerCase()] || null;
    return null;
  }

  function _extractAddress(text) {
    var m = text.match(/0x[0-9a-fA-F]{40}/);
    return m ? m[0] : null;
  }

  function _extractNumber(text) {
    var m = text.match(/\b(\d+)\b/);
    return m ? parseInt(m[1], 10) : null;
  }

  window.A2Planner = { parse: parse, validateToolCall: validateToolCall };

})();
