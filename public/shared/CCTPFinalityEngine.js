/**
 * CCTPFinalityEngine — Block confirmation & finality tracking for CCTP V2.
 * ADDITIVE module. Manages fast vs standard finality thresholds.
 *
 * Fast transfer: 1 block confirmation → ready for attestation polling.
 * Standard: waits for configured block depth per chain.
 *
 * Attached to window.CCTPFinalityEngine
 */
(function () {
  'use strict';

  var FINALITY_CONFIG = {
    11155111: { minConfirmations: 1, name: 'Ethereum Sepolia', estSeconds: 12 },
    84532: { minConfirmations: 1, name: 'Base Sepolia', estSeconds: 2 },
    421614: { minConfirmations: 1, name: 'Arbitrum Sepolia', estSeconds: 2 },
    11155420: { minConfirmations: 1, name: 'Optimism Sepolia', estSeconds: 2 },
    80002: { minConfirmations: 1, name: 'Polygon Amoy', estSeconds: 2 },
    5042002: { minConfirmations: 1, name: 'Arc Testnet', estSeconds: 1 }
  };

  var STORAGE_KEY = 'elligentt_cfe_v1';
  var tracked = {}; // { burnTxHash: { chainId, blockNumber, confirmations, ready, ... } }

  function load() { try { var r = localStorage.getItem(STORAGE_KEY); if (r) tracked = JSON.parse(r); } catch (_e) { tracked = {}; } }
  function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tracked)); } catch (_e) {} }

  function _getRPC(chainId) {
    try {
      if (typeof ElligenteChains !== 'undefined' && ElligenteChains.CHAIN_REGISTRY) {
        var cfg = ElligenteChains.CHAIN_REGISTRY[chainId];
        if (cfg && cfg.rpc) return cfg.rpc;
      }
    } catch (_e) {}
    return null;
  }

  function _getProvider(rpcUrl) {
    if (typeof ethers === 'undefined') return null;
    try { return new ethers.JsonRpcProvider(rpcUrl); } catch (_e) { return null; }
  }

  /** Start tracking finality for a burn transaction */
  function trackBurn(burnTxHash, chainId, blockNumber) {
    var fc = FINALITY_CONFIG[chainId] || { minConfirmations: 1, estSeconds: 2 };
    tracked[burnTxHash] = {
      burnTxHash: burnTxHash,
      chainId: chainId,
      blockNumber: blockNumber || 0,
      confirmations: 0,
      requiredConfirmations: fc.minConfirmations,
      estSecondsPerBlock: fc.estSeconds,
      ready: false,
      startedAt: Date.now(),
      readyAt: null
    };
    save();
    return tracked[burnTxHash];
  }

  /** Check if a burn has reached finality */
  async function checkFinality(burnTxHash, chainId) {
    var t = tracked[burnTxHash];
    if (!t) return { ready: false, confirmations: 0, error: 'Not tracked' };

    var rpcUrl = _getRPC(chainId);
    if (!rpcUrl) return { ready: false, confirmations: 0, error: 'No RPC for chain ' + chainId };

    try {
      var provider = _getProvider(rpcUrl);
      if (!provider) return { ready: false, confirmations: 0, error: 'Provider unavailable' };

      var currentBlock = await provider.getBlockNumber();
      var confirmations = t.blockNumber > 0 ? Math.max(0, currentBlock - t.blockNumber + 1) : 0;

      t.confirmations = confirmations;
      t.ready = confirmations >= t.requiredConfirmations;
      if (t.ready && !t.readyAt) t.readyAt = Date.now();
      save();

      return {
        ready: t.ready,
        confirmations: confirmations,
        required: t.requiredConfirmations,
        currentBlock: currentBlock,
        burnBlock: t.blockNumber,
        startedAt: t.startedAt,
        readyAt: t.readyAt
      };
    } catch (e) {
      return { ready: false, confirmations: 0, error: e.message || String(e) };
    }
  }

  /** Wait for finality with polling */
  async function waitForFinality(burnTxHash, chainId, maxWaitMs) {
    var maxWait = maxWaitMs || 300000; // 5 min default
    var pollInterval = 3000;
    var start = Date.now();

    while (Date.now() - start < maxWait) {
      var result = await checkFinality(burnTxHash, chainId);
      if (result.ready) return { ok: true, result: result };
      if (result.error) {
        await new Promise(function (r) { setTimeout(r, pollInterval); });
        continue;
      }
      await new Promise(function (r) { setTimeout(r, pollInterval); });
    }

    return { ok: false, error: 'Finality timeout (' + (maxWait / 1000) + 's)' };
  }

  /** Estimate time to finality */
  function estimateTimeToFinality(chainId) {
    var fc = FINALITY_CONFIG[chainId] || { minConfirmations: 1, estSeconds: 2 };
    return fc.minConfirmations * fc.estSeconds;
  }

  /** Check if fast transfer mode is available (all testnets support it with 1 block) */
  function isFastTransferSupported(chainId) {
    var fc = FINALITY_CONFIG[chainId];
    return fc ? fc.minConfirmations <= 1 : false;
  }

  function getTracked(burnTxHash) { return tracked[burnTxHash] || null; }

  load();

  window.CCTPFinalityEngine = {
    trackBurn: trackBurn,
    checkFinality: checkFinality,
    waitForFinality: waitForFinality,
    estimateTimeToFinality: estimateTimeToFinality,
    isFastTransferSupported: isFastTransferSupported,
    getTracked: getTracked,
    FINALITY_CONFIG: FINALITY_CONFIG
  };
})();
