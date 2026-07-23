/**
 * CrossChainTransferRouter — Routing layer for Autonoma cross-chain transfers.
 * ADDITIVE module. Decides: CCTP V2 inbound vs existing outbound bridge.
 *
 * Rules:
 *   src != Arc && dest == Arc → CCTP V2 inbound (NEW — this module's purpose)
 *   src == Arc && dest != Arc → existing bridge (unchanged, routed to legacy path)
 *   src == Arc && dest == Arc → ignore (same chain)
 *
 * Attached to window.CrossChainTransferRouter
 */
(function () {
  'use strict';

  var ARC_CHAIN_ID = 5042002;

  /** CCTP V2 supported source chains (inbound → Arc) */
  var CCTP_V2_SOURCE_CHAINS = [11155111, 84532, 421614, 11155420, 80002]; // Sepolia testnets

  function _getCCTPCfg(chainId) {
    try {
      if (typeof ElligenteCCTP !== 'undefined' && ElligenteCCTP.CCTP_CONFIG) {
        return ElligenteCCTP.CCTP_CONFIG[String(chainId)] || null;
      }
    } catch (_e) {}
    return null;
  }

  function _getChainInfo(chainId) {
    try {
      if (typeof ElligenteChains !== 'undefined' && ElligenteChains.CHAIN_REGISTRY) {
        return ElligenteChains.CHAIN_REGISTRY[chainId] || null;
      }
    } catch (_e) {}
    return null;
  }

  /**
   * Route a transfer based on source and destination chain IDs.
   * Returns a strategy object with:
   *   { strategy: 'CCTP_V2_INBOUND' | 'EXISTING_BRIDGE' | 'INVALID',
   *     sourceCfg, destCfg, details }
   */
  function routeTransfer(srcChainId, destChainId) {
    var src = Number(srcChainId);
    var dest = Number(destChainId);

    if (!src || !dest || src === dest) {
      return { strategy: 'INVALID', reason: 'Same chain or invalid chain IDs' };
    }

    // CCTP V2 Inbound: other chain → Arc
    if (src !== ARC_CHAIN_ID && dest === ARC_CHAIN_ID) {
      var srcCfg = _getCCTPCfg(src);
      var destCfg = _getCCTPCfg(dest);
      var srcInfo = _getChainInfo(src);

      if (!srcCfg || !destCfg) {
        return { strategy: 'INVALID', reason: 'CCTP config not found for source or destination chain' };
      }

      if (CCTP_V2_SOURCE_CHAINS.indexOf(src) === -1) {
        return { strategy: 'INVALID', reason: 'Source chain not in CCTP V2 supported list' };
      }

      return {
        strategy: 'CCTP_V2_INBOUND',
        sourceChainId: src,
        destChainId: dest,
        sourceDomain: srcCfg.domain,
        destDomain: destCfg.domain,
        sourceUSDC: srcCfg.usdc,
        destUSDC: destCfg.usdc,
        tokenMessenger: srcCfg.tokenMessenger,
        messageTransmitter: destCfg.messageTransmitter,
        sourceRPC: (srcInfo && srcInfo.rpc) || srcCfg.rpc,
        destRPC: (destCfg && destCfg.rpc) || '',
        sourceExplorer: (srcInfo && srcInfo.explorer) || '',
        destExplorer: (destCfg && destCfg.explorer) || '',
        sourceChainName: srcInfo ? srcInfo.name : 'Unknown',
        destChainName: 'Arc Testnet',
        transferType: 'BURN_AND_MINT',
        estimatedTimeSecs: 120 // ~2 min CCTP V2 standard
      };
    }

    // Existing bridge: Arc → other chain
    if (src === ARC_CHAIN_ID && dest !== ARC_CHAIN_ID) {
      var outCfg = _getCCTPCfg(dest);
      return {
        strategy: 'EXISTING_BRIDGE',
        sourceChainId: src,
        destChainId: dest,
        destDomain: outCfg ? outCfg.domain : null,
        reason: 'Outbound from Arc — use existing bridge implementation'
      };
    }

    // Cross-chain where neither side is Arc
    return {
      strategy: 'EXISTING_BRIDGE',
      sourceChainId: src,
      destChainId: dest,
      reason: 'Cross-chain between non-Arc chains — route through existing bridge'
    };
  }

  /** Check if CCTP V2 is available for a specific source chain */
  function isCCTPV2Supported(srcChainId) {
    return CCTP_V2_SOURCE_CHAINS.indexOf(Number(srcChainId)) !== -1;
  }

  /** Check if a route matches CCTP V2 inbound pattern */
  function isInboundToArc(srcChainId, destChainId) {
    return Number(srcChainId) !== ARC_CHAIN_ID && Number(destChainId) === ARC_CHAIN_ID;
  }

  /** Get all supported CCTP V2 source chains with their configs */
  function getSupportedSourceChains() {
    return CCTP_V2_SOURCE_CHAINS.map(function (id) {
      var info = _getChainInfo(id);
      var cfg = _getCCTPCfg(id);
      return {
        chainId: id,
        name: info ? info.name : 'Unknown',
        shortName: info ? info.shortName : 'Unknown',
        domain: cfg ? cfg.domain : null,
        rpc: info ? info.rpc : (cfg ? cfg.rpc : ''),
        explorer: info ? info.explorer : ''
      };
    }).filter(function (c) { return c.domain !== null; });
  }

  window.CrossChainTransferRouter = {
    routeTransfer: routeTransfer,
    isCCTPV2Supported: isCCTPV2Supported,
    isInboundToArc: isInboundToArc,
    getSupportedSourceChains: getSupportedSourceChains,
    ARC_CHAIN_ID: ARC_CHAIN_ID,
    CCTP_V2_SOURCE_CHAINS: CCTP_V2_SOURCE_CHAINS.slice()
  };
})();
