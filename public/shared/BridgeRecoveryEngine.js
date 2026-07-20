/**
 * BridgeRecoveryEngine — Retry, resume and recover failed/delayed CCTP transfers.
 * ADDITIVE module. Follows Arc Bridge Error Recovery documentation.
 *
 * Capabilities:
 *   - Retry attestation fetch (Circle Iris V2/V1)
 *   - Retry mint (server-side relayer or direct contract call)
 *   - Resume interrupted transfers mid-pipeline
 *   - Recover transfers from localStorage state
 *
 * Attached to window.BridgeRecoveryEngine
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'elligentt_bre_v1';
  var recoveryState = { pending: [], history: [] };

  function load() { try { var r = localStorage.getItem(STORAGE_KEY); if (r) recoveryState = JSON.parse(r); } catch (_e) {} }
  function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(recoveryState)); } catch (_e) {} }

  var MAX_RETRIES = 5;
  var ATTEST_POLL_INTERVAL = 5000;
  var ATTEST_POLL_MAX = 120;

  /** Check if a transfer is in a recoverable state */
  function isRecoverable(transferState) {
    return ['FAILED', 'RECOVERY', 'WAITING_ATTESTATION', 'ATTESTED', 'WAITING_FINALITY', 'BURNED'].indexOf(transferState) !== -1;
  }

  /** Resume a transfer from its current state */
  async function resumeTransfer(transfer) {
    if (!isRecoverable(transfer.state)) {
      return { ok: false, error: 'Transfer state "' + transfer.state + '" is not recoverable' };
    }

    var result = { ok: false, state: transfer.state, actions: [] };

    try {
      // If burn wasn't completed, retry burn
      if (transfer.state === 'BURNED' || transfer.state === 'WAITING_FINALITY' || transfer.state === 'WAITING_ATTESTATION') {
        if (typeof window.CCTPV2InboundEngine !== 'undefined') {
          // Mark as recovery
          if (typeof window.CircleAttestationMonitor !== 'undefined') {
            window.CircleAttestationMonitor.transition(transfer.id, 'RECOVERY', 'Resuming from ' + transfer.state);
          }

          // Poll attestation
          var attestResult = await window.CCTPV2InboundEngine.pollAttestation(transfer.id);
          if (attestResult.ok) {
            result.actions.push('attestation_retrieved');
            // Proceed to mint
            var mintResult = await window.CCTPV2InboundEngine.executeMint(transfer.id);
            if (mintResult.ok) {
              result.actions.push('mint_completed');
              result.ok = true;
            } else {
              result.error = mintResult.error;
            }
          } else {
            result.error = attestResult.error;
          }
        } else {
          result.error = 'CCTPV2InboundEngine not available';
        }
      } else if (transfer.state === 'ATTESTED') {
        // Already have attestation, just need mint
        if (typeof window.CCTPV2InboundEngine !== 'undefined') {
          var mResult = await window.CCTPV2InboundEngine.executeMint(transfer.id);
          if (mResult.ok) {
            result.actions.push('mint_completed');
            result.ok = true;
          } else {
            result.error = mResult.error;
          }
        } else {
          result.error = 'CCTPV2InboundEngine not available';
        }
      } else if (transfer.state === 'INITIATED' || transfer.state === 'APPROVED') {
        // Need full pipeline
        if (typeof window.CCTPV2InboundEngine !== 'undefined') {
          var fullResult = await window.CCTPV2InboundEngine.executeFullPipeline(transfer.id);
          result.ok = fullResult.ok;
          result.actions.push('full_pipeline_retried');
          if (!fullResult.ok) result.error = fullResult.error;
        } else {
          result.error = 'CCTPV2InboundEngine not available';
        }
      }
    } catch (e) {
      result.error = e.message || String(e);
    }

    // Track recovery history
    recoveryState.history.unshift({
      transferId: transfer.id,
      result: result.ok ? 'recovered' : 'failed',
      error: result.error || null,
      at: Date.now()
    });
    if (recoveryState.history.length > 50) recoveryState.history.length = 50;
    save();

    return result;
  }

  /** Retry attestation fetch with exponential backoff */
  async function retryAttestation(sourceDomain, burnTxHash, messageBytes) {
    var irisUrl = 'https://iris-api-sandbox.circle.com/v2/messages/' + sourceDomain + '?transactionHash=' + burnTxHash;

    for (var attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        var resp = await fetch(irisUrl);
        var data = await resp.json();
        if (data && data.messages && data.messages.length > 0) {
          var msg = data.messages[0];
          if (msg.status === 'complete' && msg.attestation) {
            return { ok: true, attestation: msg.attestation, attempts: attempt + 1 };
          }
        }
      } catch (_e) {}

      var delay = ATTEST_POLL_INTERVAL * Math.pow(2, attempt);
      await new Promise(function (r) { setTimeout(r, delay); });
    }

    return { ok: false, error: 'Attestation retry exhausted after ' + MAX_RETRIES + ' attempts', attempts: MAX_RETRIES };
  }

  /** Retry mint via server-side relayer */
  async function retryMint(messageBytes, attestationSignature) {
    for (var attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        var relayResp = await fetch('/api/relayer/mint', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messageBytes: messageBytes,
            attestationSignature: attestationSignature
          })
        });
        if (relayResp.ok) {
          var result = await relayResp.json();
          return { ok: true, txHash: result.txHash, attempts: attempt + 1 };
        }
      } catch (_e) {}

      var delay = 3000 * Math.pow(2, attempt);
      await new Promise(function (r) { setTimeout(r, delay); });
    }

    return { ok: false, error: 'Mint retry exhausted after ' + MAX_RETRIES + ' attempts', attempts: MAX_RETRIES };
  }

  /** Get all transfers that need recovery */
  function getRecoverableTransfers() {
    try {
      if (typeof window.CCTPV2InboundEngine !== 'undefined') {
        var all = window.CCTPV2InboundEngine.getAllTransfers();
        return all.filter(function (t) { return isRecoverable(t.state); });
      }
    } catch (_e) {}
    return [];
  }

  /** Resume all recoverable transfers */
  async function resumeAll() {
    var transfers = getRecoverableTransfers();
    var results = [];
    for (var i = 0; i < transfers.length; i++) {
      results.push({ transferId: transfers[i].id, result: await resumeTransfer(transfers[i]) });
    }
    return results;
  }

  function getRecoveryHistory() { return recoveryState.history.slice(0, 20); }

  load();

  window.BridgeRecoveryEngine = {
    resumeTransfer: resumeTransfer,
    retryAttestation: retryAttestation,
    retryMint: retryMint,
    isRecoverable: isRecoverable,
    getRecoverableTransfers: getRecoverableTransfers,
    resumeAll: resumeAll,
    getRecoveryHistory: getRecoveryHistory,
    MAX_RETRIES: MAX_RETRIES
  };
})();
