/**
 * Autonoma 2 — Send Tool
 * Orchestrates the existing saExecuteSend() engine via DOM bridge.
 * Never implements its own wallet/signer/nonce/broadcast logic.
 * Never calls eth_sendTransaction directly.
 */
(function () {
  'use strict';

  // ── Validation helpers ────────────────────────────────────────────────────

  function _isAddr(v) { return /^0x[0-9a-fA-F]{40}$/.test(v); }

  function _resolveRecipient(recipientInput, ctx) {
    // Direct address
    if (_isAddr(recipientInput)) return recipientInput;
    // ENS name — surface to engine (it resolves ENS natively)
    if (/\.eth$/i.test(recipientInput)) return recipientInput;
    // Named contact from context
    var contacts = (ctx && ctx.contacts) ? ctx.contacts : [];
    for (var i = 0; i < contacts.length; i++) {
      var c = contacts[i];
      if (c.name && c.name.toLowerCase() === recipientInput.toLowerCase()) {
        return c.address || null;
      }
    }
    return null;
  }

  function _normalizeToken(token) {
    if (!token) return 'USDC';
    var t = token.toString().toUpperCase().trim();
    var allowed = ['USDC', 'EURC', 'CIRBTC'];
    return allowed.indexOf(t) !== -1 ? t : 'USDC';
  }

  function _normalizeNetwork(network) {
    if (!network) return 'arc';
    var n = network.toString().toLowerCase().trim();
    if (n.includes('arc')) return 'arc';
    if (n.includes('base')) return 'base';
    if (n.includes('ethereum') || n === 'eth' || n === 'mainnet') return 'ethereum';
    if (n.includes('arbitrum') || n === 'arb') return 'arbitrum';
    if (n.includes('optimism') || n === 'op' || n === 'optimistic') return 'optimism';
    if (n.includes('polygon') || n === 'matic') return 'polygon';
    return 'arc';
  }

  // ── Validation ────────────────────────────────────────────────────────────

  async function validate(args, ctx) {
    var errors = [];

    var amount = parseFloat(args.amount);
    if (!args.amount || isNaN(amount) || amount <= 0) {
      errors.push('Amount must be greater than 0.');
    }

    var resolved = _resolveRecipient(args.recipient || '', ctx);
    if (!resolved) {
      errors.push('Recipient "' + (args.recipient || '') + '" is not a valid address, ENS name, or known contact.');
    }

    var token = _normalizeToken(args.token);

    // Wallet check
    if (!ctx || !ctx.walletAddress) {
      errors.push('No wallet connected. Please connect your wallet first.');
    }

    // Balance check
    if (ctx && ctx.balances && !isNaN(amount)) {
      var bal = parseFloat(ctx.balances[token] || 0);
      var feeBps = 20; // 0.2% — mirrors saExecuteSend
      var feeAmt = amount * feeBps / 10000;
      var totalNeed = amount + feeAmt;
      if (bal < totalNeed) {
        errors.push(
          'Insufficient ' + token + '. You have ' + bal.toFixed(4) +
          ' but need ' + totalNeed.toFixed(4) + ' (including ' + feeAmt.toFixed(4) + ' fee).'
        );
      }
    }

    // Self-send warning (not a hard error, engine handles this)
    if (ctx && ctx.walletAddress && resolved && resolved.toLowerCase() === ctx.walletAddress.toLowerCase()) {
      errors.push('Recipient is your own wallet address.');
    }

    return {
      ok: errors.length === 0,
      errors: errors,
      resolved: {
        recipient: resolved,
        amount: amount,
        token: token,
        network: _normalizeNetwork(args.network)
      }
    };
  }

  // ── Execute via existing saExecuteSend DOM bridge ─────────────────────────

  async function execute(args, ctx, onProgress) {
    var validation = await validate(args, ctx);
    if (!validation.ok) {
      return { ok: false, error: validation.errors.join(' '), stage: 'VALIDATION_FAILED' };
    }

    var resolved = validation.resolved;
    if (typeof onProgress === 'function') onProgress({ stage: 'PREPARING', message: 'Preparing send...' });

    // Cross-chain: Autonoma 2 routes to the existing cross-chain engine
    var isCrossChain = (resolved.network !== 'arc');

    // ── DOM bridge: populate fields the existing engine reads ──────────────
    // This is the only supported way to invoke saExecuteSend without forking its logic.
    function _setHiddenField(id, value) {
      var el = document.getElementById(id);
      if (!el) {
        el = document.createElement('input');
        el.type = 'hidden';
        el.id = id;
        document.body.appendChild(el);
      }
      el.value = value != null ? String(value) : '';
    }

    _setHiddenField('sa-recipient', resolved.recipient);
    _setHiddenField('sa-amount', resolved.amount.toString());
    _setHiddenField('sa-memo', 'AUTONOMA2|SEND|' + resolved.recipient.slice(0, 8));

    // Set the current asset in the Send Assets engine
    if (typeof window.saCurrentAsset !== 'undefined') {
      window.saCurrentAsset = resolved.token;
    }

    // For cross-chain, set destination chain selector
    if (isCrossChain) {
      var destMap = { base: 8453, ethereum: 1, arbitrum: 42161, optimism: 10, polygon: 137 };
      var destId = destMap[resolved.network] || 8453;
      var saDestEl = document.getElementById('sa-dest-chain');
      if (saDestEl) saDestEl.value = String(destId);
    }

    if (typeof onProgress === 'function') onProgress({ stage: 'APPROVED', message: 'Execution approved.' });

    // ── Invoke existing engine ──────────────────────────────────────────────
    // saExecuteSend shows its own confirmation modal — we BYPASS it for Autonoma 2
    // by calling the post-confirmation logic directly.
    // We do this by calling saExecuteSend() which will show its own modal;
    // when user confirms there, the send proceeds through all existing security checks.
    // This preserves: SendGuard, BalanceService TOCTOU check, allowance check, nonce, broadcast.

    if (typeof window.saExecuteSend !== 'function') {
      return { ok: false, error: 'Send engine not available.', stage: 'ENGINE_UNAVAILABLE' };
    }

    if (typeof onProgress === 'function') onProgress({ stage: 'SUBMITTED', message: 'Sending via existing engine...' });

    try {
      // saExecuteSend reads DOM fields we just set, shows its confirmation modal,
      // then executes through all existing security layers.
      await window.saExecuteSend();

      // Get tx hash from saRecentTxs (saLogTx pushes to it)
      var txHash = null;
      if (typeof window.saRecentTxs !== 'undefined' && window.saRecentTxs.length > 0) {
        txHash = window.saRecentTxs[0].txHash || window.saRecentTxs[0].hash || null;
      }

      if (typeof onProgress === 'function') onProgress({ stage: 'COMPLETED', message: 'Send complete.', txHash: txHash });

      return {
        ok: true,
        stage: 'COMPLETED',
        txHash: txHash,
        amount: resolved.amount,
        token: resolved.token,
        recipient: resolved.recipient,
        network: resolved.network
      };

    } catch (e) {
      var errMsg = e.shortMessage || e.message || 'Send failed';
      var stage = 'FAILED';
      if (e.code === 4001 || errMsg.includes('rejected')) stage = 'CANCELLED';
      if (typeof onProgress === 'function') onProgress({ stage: stage, message: errMsg });
      return { ok: false, error: errMsg, stage: stage };
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  window.A2SendTool = {
    name: 'send',
    description: 'Send tokens to a recipient on any supported network.',
    llmDescription: 'Send USDC, EURC, or cirBTC to an address or contact. For cross-chain sends, bridges automatically.',
    readOnly: false,
    requiresApproval: true,
    parameters: {
      recipient: { type: 'string', description: 'Recipient address (0x...), ENS name, or contact name', required: true },
      amount: { type: 'number', description: 'Amount to send (positive number)', required: true },
      token: { type: 'string', description: 'Token: USDC, EURC, or cirBTC. Default: USDC', required: false },
      network: { type: 'string', description: 'Network: arc, base, ethereum, arbitrum, optimism, polygon. Default: arc', required: false }
    },
    validate: validate,
    execute: execute
  };

})();
