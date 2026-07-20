/**
 * Autonoma CCTP V2 Inbound Hook — Surgical patch for Autonoma's bridge flow.
 * ONLY intercepts: source != Arc && dest == Arc → CCTP V2 inbound.
 * All other routes (Arc → other / Turbo Bridge) pass through unchanged.
 *
 * ADDITIVE: saves original _agentExecuteBridge as __agentExecuteBridgeOriginal.
 * Injects CCTP V2 status cards into Autonoma chat.
 *
 * Attached to window.AutonomaCCTPIntegration
 */
(function () {
  'use strict';

  var ARC_CHAIN_ID = 5042002;
  var ARC_DOMAIN = 26;

  /* ══════════════════════════════════════════════════════════════════
     SURGICAL PATCH — Intercept inbound bridge calls only
     ══════════════════════════════════════════════════════════════════ */
  function _patchExecuteBridge() {
    if (typeof window._agentExecuteBridge === 'undefined') return;
    if (window.__agentExecuteBridgeOriginal) return; // już patched

    // Save original
    window.__agentExecuteBridgeOriginal = window._agentExecuteBridge;

    // Replace with routing wrapper
    window._agentExecuteBridge = async function (amount, destDomain, destChainName, calldataId, sourceChainId, recipientAddr) {
      var src = Number(sourceChainId);

      // ONLY intercept: other chain → Arc inbound
      if (src !== ARC_CHAIN_ID && destDomain === ARC_DOMAIN) {
        return _executeInboundCCTPV2(amount, src, destChainName, recipientAddr);
      }

      // All other routes → pass through to original (unchanged!)
      return window.__agentExecuteBridgeOriginal(amount, destDomain, destChainName, calldataId, sourceChainId, recipientAddr);
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     CCTP V2 Inbound Execution — Reuses existing infra + new engines
     ══════════════════════════════════════════════════════════════════ */
  async function _executeInboundCCTPV2(amount, sourceChainId, sourceChainName, recipientAddr) {
    var execId = 'cctpi_' + Date.now();

    // Show status in Autonoma chat
    _addAutMsg(execId, 'PLANNING', 'CCTP V2 Inbound · ' + amount + ' USDC from ' + (sourceChainName || 'Chain ' + sourceChainId) + ' → Arc');

    // 1. Get route config
    if (!window.CrossChainTransferRouter) {
      _addAutMsg(execId, 'FAILED', 'CrossChainTransferRouter not loaded');
      return;
    }
    var route = window.CrossChainTransferRouter.routeTransfer(sourceChainId, ARC_CHAIN_ID);
    if (route.strategy !== 'CCTP_V2_INBOUND') {
      _addAutMsg(execId, 'FAILED', 'Route not CCTP V2 inbound: ' + route.strategy);
      return;
    }

    // 2. Create transfer via inbound engine
    if (!window.CCTPV2InboundEngine || !window.CircleAttestationMonitor) {
      _addAutMsg(execId, 'FAILED', 'CCTP engines not loaded');
      return;
    }

    var t = window.CCTPV2InboundEngine.createTransfer({
      sourceChainId: sourceChainId,
      amount: amount,
      token: 'USDC',
      sourceRPC: route.sourceRPC,
      mintRecipient: recipientAddr || null
    });

    window.CircleAttestationMonitor.track(t.id, 'INITIATED');

    // 3. Burn on source chain
    _addAutMsg(execId, 'BROADCASTING', 'Step 1/3: Burning ' + amount + ' USDC on ' + route.sourceChainName + '…');
    var burnResult = await window.CCTPV2InboundEngine.executeBurn(t.id);

    if (!burnResult.ok) {
      _addAutMsg(execId, 'FAILED', 'Burn failed: ' + (burnResult.error || 'unknown'));
      window.CircleAttestationMonitor.transition(t.id, 'FAILED', burnResult.error);
      return;
    }

    _addAutMsg(execId, 'CONFIRMING',
      '<div style="font-size:10px">' +
      '<span style="color:#22c55e">✓ Burn confirmed on ' + route.sourceChainName + '</span><br>' +
      '<code style="font-size:8px;word-break:break-all;color:#a78bfa">' + (t.burnTxHash || '') + '</code><br>' +
      '<a href="' + route.sourceExplorer + '/tx/' + t.burnTxHash + '" target="_blank" style="color:#a78bfa;font-size:8px">View on Explorer →</a></div>');

    // 4. Poll attestation
    _addAutMsg(execId, 'ATTESTING', 'Step 2/3: Waiting for Circle attestation (<2 min)…');
    window.CCTPHealthMonitor && window.CCTPHealthMonitor.runFullCheck && window.CCTPHealthMonitor.runFullCheck();

    var attestStart = Date.now();
    var attestResult = await window.CCTPV2InboundEngine.pollAttestation(t.id);

    if (!attestResult.ok) {
      _addAutMsg(execId, 'FAILED', 'Attestation timeout: ' + (attestResult.error || 'check Circle Iris'));
      window.CircleAttestationMonitor.transition(t.id, 'FAILED', attestResult.error);
      return;
    }

    window.CCTPHealthMonitor && window.CCTPHealthMonitor.recordAttestationLatency(Date.now() - attestStart);

    _addAutMsg(execId, 'ATTESTING',
      '<div style="font-size:10px"><span style="color:#22c55e">✓ Circle attestation received</span><br>' +
      '<span style="font-size:8px;color:var(--muted2)">' + ((Date.now() - attestStart) / 1000).toFixed(1) + 's · Iris V2 sandbox</span></div>');

    // 5. Mint on Arc
    _addAutMsg(execId, 'MINTING', 'Step 3/3: Minting ' + amount + ' USDC on Arc Testnet…');

    var mintStart = Date.now();
    var mintResult = await window.CCTPV2InboundEngine.executeMint(t.id);

    if (!mintResult.ok) {
      _addAutMsg(execId, 'FAILED', 'Mint failed: ' + (mintResult.error || 'try recovery'));
      window.CircleAttestationMonitor.transition(t.id, 'FAILED', mintResult.error);
      return;
    }

    window.CCTPHealthMonitor && window.CCTPHealthMonitor.recordMintLatency(Date.now() - mintStart);

    // 6. Completed
    _addAutMsg(execId, 'COMPLETED',
      '<div style="font-size:10px">' +
      '<span style="color:#22c55e;font-size:12px">✓ CCTP V2 Transfer Completed</span><br><br>' +
      '<strong>' + amount + ' USDC</strong> · ' + route.sourceChainName + ' → Arc Testnet<br>' +
      (t.burnTxHash ? 'Burn: <code style="font-size:8px;color:#a78bfa">' + t.burnTxHash.substring(0, 16) + '…</code><br>' : '') +
      (t.mintTxHash ? 'Mint: <code style="font-size:8px;color:#a78bfa">' + t.mintTxHash.substring(0, 16) + '…</code><br>' : '') +
      '<span style="color:var(--muted);font-size:9px">' + ((Date.now() - t.createdAt) / 1000).toFixed(1) + 's total · CCTP v2</span>' +
      '</div>');

    window.CircleAttestationMonitor.transition(t.id, 'COMPLETED', 'Mint: ' + (t.mintTxHash || 'server-side'));
  }

  /* ══════════════════════════════════════════════════════════════════
     Autonoma Chat UI — Inject status messages (additive)
     ══════════════════════════════════════════════════════════════════ */
  var STATES_UI = {
    PLANNING:    ['#6b7280', 'Planning CCTP V2 transfer…'],
    BROADCASTING: ['#06F7E9', 'Broadcasting burn…'],
    CONFIRMING:  ['#f59e0b', 'Confirming burn…'],
    ATTESTING:   ['#a78bfa', 'Polling Circle attestation…'],
    MINTING:     ['#06F7E9', 'Minting on Arc…'],
    COMPLETED:   ['#22c55e', 'Completed on-chain'],
    FAILED:      ['#ef4444', 'CCTP V2 transfer failed']
  };

  function _addAutMsg(execId, state, detail) {
    var c = document.getElementById('aut-messages');
    if (!c) return;

    var st = STATES_UI[state] || ['#6b7280', state];
    var html =
      '<div class="aut-msg ai">' +
      '<div class="aut-msg-header"><i class="ti ti-arrows-exchange" style="color:#a78bfa"></i><span class="aut-msg-role">CCTP V2 · Autonoma</span></div>' +
      '<div class="aut-msg-body">' +
      '<div style="font-size:10px">' +
      '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + st[0] + ';margin-right:6px;vertical-align:middle"></span>' +
      '<strong style="color:' + st[0] + '">' + st[1] + '</strong>' +
      (typeof detail === 'string' && detail.indexOf('<') === 0 ? '<br>' + detail :
       (detail ? '<br><span style="color:var(--muted);font-size:9px">' + String(detail).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</span>' : '')) +
      '</div></div></div>';
    c.insertAdjacentHTML('beforeend', html);
    c.scrollTop = c.scrollHeight;
  }

  /* ══════════════════════════════════════════════════════════════════
     INIT — Auto-patch when Autonoma page activates
     ══════════════════════════════════════════════════════════════════ */
  function init() {
    var attempts = 0;

    function tryPatch() {
      attempts++;
      if (typeof window._agentExecuteBridge !== 'undefined') {
        _patchExecuteBridge();
        // Start health monitor in background
        if (window.CCTPHealthMonitor && window.CCTPHealthMonitor.start) {
          setTimeout(function () { window.CCTPHealthMonitor.start(180000); }, 10000);
        }
        return;
      }
      if (attempts < 40) setTimeout(tryPatch, 500);
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { setTimeout(tryPatch, 800); });
    } else {
      setTimeout(tryPatch, 500);
    }
  }

  init();

  /* ══════════════════════════════════════════════════════════════════
     PUBLIC API
     ══════════════════════════════════════════════════════════════════ */
  window.AutonomaCCTPIntegration = {
    analyzeTransfer: function (sourceChainId, destChainId, amount) {
      var src = Number(sourceChainId);
      var dest = Number(destChainId || ARC_CHAIN_ID);
      if (src !== ARC_CHAIN_ID && dest === ARC_CHAIN_ID && window.CrossChainTransferRouter) {
        var route = window.CrossChainTransferRouter.routeTransfer(src, dest);
        if (route.strategy === 'CCTP_V2_INBOUND') {
          return {
            strategy: 'CCTP_V2_INBOUND',
            protocol: 'Circle CCTP V2',
            steps: ['Burn on ' + route.sourceChainName, 'Circle Attestation', 'Mint on Arc Testnet'],
            estimatedTime: route.estimatedTimeSecs + ' seconds',
            sourceDomain: route.sourceDomain,
            destDomain: route.destDomain,
            supported: true
          };
        }
      }
      return { strategy: 'EXISTING_BRIDGE', supported: false, reason: 'Not an inbound CCTP V2 route' };
    },

    // Expose for manual recovery
    recoverTransfer: function (transferId) {
      if (window.BridgeRecoveryEngine) {
        var t = window.CCTPV2InboundEngine ? window.CCTPV2InboundEngine.getTransfer(transferId) : null;
        if (t) return window.BridgeRecoveryEngine.resumeTransfer(t);
      }
      return { ok: false, error: 'Transfer not found or recovery engine unavailable' };
    },

    isPatched: function () { return !!window.__agentExecuteBridgeOriginal; },
    ARC_CHAIN_ID: ARC_CHAIN_ID
  };
})();
