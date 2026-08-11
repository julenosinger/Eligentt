/**
 * CCTPV2InboundEngine — Handles burn → attestation → mint for USDC inbound to Arc.
 * ADDITIVE module. Uses existing cctp.js + chainSimulator.js infrastructure.
 * NEVER modifies outbound bridge or Turbo Bridge.
 *
 * Pipeline: burn on source → poll attestation → mint on Arc (server or client)
 *
 * Attached to window.CCTPV2InboundEngine
 */
(function () {
  'use strict';

  var ARC_CHAIN_ID = 5042002;
  var ARC_DOMAIN = 26;

  var STORAGE_KEY = 'elligentt_cctp_inbound_v1';
  var transfers = {}; // { id: { state, srcChain, amount, ... } }

  function load() { try { var r = localStorage.getItem(STORAGE_KEY); if (r) transfers = JSON.parse(r); } catch (_e) { transfers = {}; } }
  function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(transfers)); } catch (_e) {} }

  var STATES = [
    'INITIATED', 'APPROVED', 'BURNING', 'BURNED', 'WAITING_FINALITY',
    'WAITING_ATTESTATION', 'ATTESTED', 'MINTING', 'COMPLETED', 'FAILED', 'RECOVERY'
  ];

  function _nextId() { return 'CCTPI-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6); }

  function _getCfg(chainId) {
    try {
      if (typeof ElligenteCCTP !== 'undefined' && ElligenteCCTP.CCTP_CONFIG) {
        return ElligenteCCTP.CCTP_CONFIG[String(chainId)] || null;
      }
    } catch (_e) { return null; }
  }

  function _getProvider(rpcUrl) {
    if (typeof ethers === 'undefined') return null;
    try {
      if (typeof RPCManager !== 'undefined' && RPCManager.getHealthyRPC) {
        var r = RPCManager.getCurrentProvider();
        if (r) return r;
      }
    } catch (_e) {}
    try { return new ethers.JsonRpcProvider(rpcUrl); } catch (_e) { return null; }
  }

  var _fallbackRPCs = {
    11155111: 'https://ethereum-sepolia-rpc.publicnode.com',
    84532: 'https://sepolia.base.org',
    421614: 'https://sepolia-rollup.arbitrum.io/rpc',
    11155420: 'https://sepolia.optimism.io',
    80002: 'https://rpc-amoy.polygon.technology',
  };

  async function _getDynamicMaxFee(srcDomain, destDomain) {
    try {
      var resp = await fetch('https://iris-api-sandbox.circle.com/v2/fees/' + srcDomain + '/' + destDomain);
      if (!resp.ok) return null;
      var data = await resp.json();
      return data.maxFee ? String(data.maxFee) : null;
    } catch(e) { return null; }
  }

  /** Initiate a new CCTP V2 inbound transfer */
  function createTransfer(opts) {
    var id = _nextId();
    var srcCfg = _getCfg(opts.sourceChainId);
    var t = {
      id: id,
      state: 'INITIATED',
      sourceChainId: Number(opts.sourceChainId),
      destChainId: ARC_CHAIN_ID,
      sourceDomain: srcCfg ? srcCfg.domain : null,
      destDomain: ARC_DOMAIN,
      amount: Number(opts.amount) || 0,
      token: opts.token || 'USDC',
      sourceUSDC: srcCfg ? srcCfg.usdc : '',
      tokenMessenger: srcCfg ? srcCfg.tokenMessenger : '',
      messageTransmitter: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
      sourceRPC: opts.sourceRPC || (srcCfg ? srcCfg.rpc : ''),
      mintRecipient: opts.mintRecipient || '',
      burnTxHash: null,
      messageBytes: null,
      messageHash: null,
      attestationSignature: null,
      mintTxHash: null,
      createdAt: Date.now(),
      completedAt: null,
      error: null,
      retryCount: 0,
      maxRetries: 5
    };
    transfers[id] = t;
    save();
    return t;
  }

  /** Execute burn on source chain via depositForBurn */
  async function executeBurn(transferId) {
    var t = transfers[transferId];
    if (!t) return { ok: false, error: 'Transfer not found' };
    if (t.state !== 'INITIATED' && t.state !== 'APPROVED') return { ok: false, error: 'Invalid state: ' + t.state };

    t.state = 'BURNING';
    save();

    try {
      if (typeof ethers === 'undefined') throw new Error('ethers not available');

      var provider = _getProvider(t.sourceRPC);
      if (!provider) throw new Error('RPC unavailable for chain ' + t.sourceChainId);

      // Get signer for the SOURCE chain (not Arc!)
      // Must create a dedicated signer connected to the source chain's provider
      // with the correct chain ID to avoid "invalid chain ID" errors.
      var signer = null;

      if (typeof AgentWalletManager !== 'undefined') {
        signer = AgentWalletManager._createSignerForChain && AgentWalletManager._createSignerForChain(provider);
      }
      if (!signer && typeof window.signer !== 'undefined') {
        signer = window.signer;
      }

      if (!signer) throw new Error('No agent wallet signer available');

      // Verify chain ID matches the source chain
      try {
        var network = await provider.getNetwork();
        if (Number(network.chainId) !== t.sourceChainId) {
          throw new Error('Provider chain mismatch: got ' + network.chainId + ', expected ' + t.sourceChainId + '. RPC may be for wrong chain.');
        }
      } catch (netErr) {
        if (netErr.message && netErr.message.indexOf('chain mismatch') !== -1) throw netErr;
        // Non-fatal — continue with the provider as-is
      }

      var signerAddr = signer.address;

      // Build depositForBurn calldata
      var mintRecipientBytes = ethers.zeroPadValue(signerAddr, 32);
      var amountWei = ethers.parseUnits(String(t.amount), 6); // USDC has 6 decimals

      var CCTP_ABI = [
        'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
        'function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, bytes hookData, uint256 maxFee, uint32 minFinalityThreshold)',
        'event MessageSent(bytes message)',
        'function approve(address spender, uint256 amount) returns (bool)'
      ];

      // 1. Approve USDC spending
      var usdcContract = new ethers.Contract(t.sourceUSDC, ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'], signer);

      var balance = await usdcContract.balanceOf(signerAddr);
      var balFloat = parseFloat(ethers.formatUnits(balance, 6));
      if (balFloat < t.amount) throw new Error('Insufficient balance: ' + balFloat.toFixed(2) + ' USDC (need ' + t.amount + ')');

      var approveTx = await usdcContract.approve(t.tokenMessenger, ethers.parseUnits(String(t.amount), 6));
      await approveTx.wait();

      // Dynamic maxFee from Circle API — include forwarding fee estimate
      var dynamicFee = await _getDynamicMaxFee(t.sourceDomain, ARC_DOMAIN);
      var forwardingEnabled = (typeof ElligenteCCTP !== 'undefined' && ElligenteCCTP.FORWARDING_ENABLED);
      var forwardHookData = (typeof ElligenteCCTP !== 'undefined') ? ElligenteCCTP.FORWARDING_HOOK_DATA : null;
      var forwardingFee = forwardingEnabled ? (typeof ElligenteCCTP !== 'undefined' ? ElligenteCCTP.FORWARDING_FEE_USDC : '0.55') : '0.5';
      var maxFee = dynamicFee ? ethers.parseUnits(String(Number(dynamicFee) + (forwardingEnabled ? 0.05 : 0)), 6) : ethers.parseUnits(forwardingFee, 6);
      var minFinality = 1000; // Fast Transfer threshold

      // 2. Execute depositForBurnWithHook (Forwarding Service) or fallback to depositForBurn
      var messengerContract = new ethers.Contract(t.tokenMessenger, CCTP_ABI, signer);
      var burnTx;
      try {
        if (forwardingEnabled && forwardHookData) {
          burnTx = await messengerContract.depositForBurnWithHook(
            amountWei, ARC_DOMAIN, mintRecipientBytes, t.sourceUSDC,
            ethers.ZeroHash, forwardHookData, maxFee, minFinality
          );
        } else {
          burnTx = await messengerContract.depositForBurn(
            amountWei, ARC_DOMAIN, mintRecipientBytes, t.sourceUSDC,
            ethers.ZeroHash, maxFee, minFinality
          );
        }
      } catch (burnErr) {
        // If primary RPC fails, try fallback for this chain
        var fallbackUrl = _fallbackRPCs[t.sourceChainId];
        if (fallbackUrl && burnErr.message && (burnErr.message.indexOf('fetch') >= 0 || burnErr.message.indexOf('network') >= 0 || burnErr.message.indexOf('timeout') >= 0)) {
          var fbProvider = new ethers.JsonRpcProvider(fallbackUrl);
          var fbSigner = new ethers.Wallet(AgentWalletManager.getSessionKey(), fbProvider);
          var fbMessenger = new ethers.Contract(t.tokenMessenger, CCTP_ABI, fbSigner);
          var fbUsdc = new ethers.Contract(t.sourceUSDC, ['function approve(address,uint256) returns (bool)'], fbSigner);
          await fbUsdc.approve(t.tokenMessenger, ethers.parseUnits(String(t.amount), 6)).then(function(tx){ return tx.wait(); });
          burnTx = await fbMessenger.depositForBurn(amountWei, ARC_DOMAIN, mintRecipientBytes, t.sourceUSDC, ethers.ZeroHash, maxFee, minFinality);
        } else {
          throw burnErr;
        }
      }

      t.burnTxHash = burnTx.hash;
      t.state = 'BURNED';
      t.mintRecipient = signerAddr;
      save();

      // 3. Extract message bytes from receipt
      var receipt = await burnTx.wait();
      try {
        if (typeof window.extractMessageFromLogs === 'function') {
          t.messageBytes = window.extractMessageFromLogs(receipt);
        } else if (typeof extractMessageFromLogs === 'function') {
          t.messageBytes = extractMessageFromLogs(receipt);
        } else {
          // Manual extraction from MessageSent event
          for (var k = 0; k < receipt.logs.length; k++) {
            try {
              var parsed = new ethers.Interface(['event MessageSent(bytes message)']).parseLog({ topics: receipt.logs[k].topics, data: receipt.logs[k].data });
              if (parsed && parsed.name === 'MessageSent') {
                t.messageBytes = parsed.args.message;
                break;
              }
            } catch (_e) {}
          }
        }
        if (t.messageBytes) {
          t.messageHash = ethers.keccak256(t.messageBytes);
        }
      } catch (_e) {}

      t.state = 'WAITING_FINALITY';
      save();

      return { ok: true, burnTxHash: t.burnTxHash, messageBytes: t.messageBytes, messageHash: t.messageHash };
    } catch (e) {
      t.state = 'FAILED';
      t.error = e.message || String(e);
      save();
      return { ok: false, error: t.error };
    }
  }

  /** Poll for CCTP attestation (uses existing cctp.js infrastructure) */
  async function pollAttestation(transferId) {
    var t = transfers[transferId];
    if (!t) return { ok: false, error: 'Transfer not found' };
    if (!t.messageBytes) return { ok: false, error: 'No message bytes — burn may not have completed' };

    t.state = 'WAITING_ATTESTATION';
    save();

    try {
      var attestation = null;

      // Use existing pollForAttestation if available
      if (typeof window.pollForAttestation === 'function') {
        attestation = await window.pollForAttestation({
          domain: t.sourceDomain,
          txHash: t.burnTxHash,
          messageBytes: t.messageBytes
        });
      } else if (typeof pollForAttestation === 'function') {
        attestation = await pollForAttestation({
          domain: t.sourceDomain,
          txHash: t.burnTxHash,
          messageBytes: t.messageBytes
        });
      } else {
        // Manual Iris V2 polling with exponential backoff
        var irisUrl = 'https://iris-api-sandbox.circle.com/v2/messages/' + t.sourceDomain + '?transactionHash=' + t.burnTxHash;
        var delay = 3000;
        for (var i = 0; i < 180; i++) {
          try {
            var resp = await fetch(irisUrl);
            var data = await resp.json();
            if (data && data.messages && data.messages.length > 0) {
              var msg = data.messages[0];
              if (msg.status === 'complete' && msg.attestation) {
                attestation = msg.attestation;
                break;
              }
            }
          } catch (_e) {}
          if (i < 179) {
            await new Promise(function(r){ setTimeout(r, delay); });
            delay = Math.min(delay * 1.2, 30000);
          }
          await new Promise(function (r) { setTimeout(r, 5000); });
        }
      }

      if (!attestation) {
        t.state = 'FAILED';
        t.error = 'Attestation not received within timeout';
        save();
        return { ok: false, error: t.error };
      }

      t.attestationSignature = attestation;
      t.state = 'ATTESTED';
      save();

      return { ok: true, attestation: attestation };
    } catch (e) {
      t.state = 'FAILED';
      t.error = 'Attestation polling failed: ' + (e.message || String(e));
      save();
      return { ok: false, error: t.error };
    }
  }

  /** Execute mint on Arc (via server-side relayer when available, or direct contract call) */
  async function executeMint(transferId) {
    var t = transfers[transferId];
    if (!t) return { ok: false, error: 'Transfer not found' };
    if (t.state !== 'ATTESTED') return { ok: false, error: 'Not ready to mint — attestation required first' };
    if (!t.attestationSignature || !t.messageBytes) return { ok: false, error: 'Missing attestation or message bytes' };

    t.state = 'MINTING';
    save();

    try {
      // Try server-side relayer first (handles gas, nonce, memo wrapping)
      var mintResult = null;
      try {
        var relayResp = await fetch('/api/relayer/mint', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messageBytes: t.messageBytes,
            attestationSignature: t.attestationSignature,
            agentRecipient: t.mintRecipient
          })
        });
        if (relayResp.ok) {
          mintResult = await relayResp.json();
          if (mintResult && mintResult.txHash) {
            t.mintTxHash = mintResult.txHash;
          }
        }
      } catch (_e) { /* fall through to direct mint */ }

      // Direct mint fallback — only if relayer not available and signer exists
      if (!t.mintTxHash) {
        if (typeof ethers === 'undefined') throw new Error('ethers not available for direct mint');

        var arcRpc = 'https://arc-testnet.drpc.org';
        try { if (typeof ElligenteChains !== 'undefined' && ElligenteChains.CHAIN_REGISTRY[ARC_CHAIN_ID]) arcRpc = ElligenteChains.CHAIN_REGISTRY[ARC_CHAIN_ID].rpc; } catch (_e) {}

        var provider = _getProvider(arcRpc);
        if (!provider) throw new Error('Arc RPC unavailable');

        var signer = null;
        try {
          if (typeof AgentWalletManager !== 'undefined' && AgentWalletManager.getSessionSigner) {
            signer = await AgentWalletManager.getSessionSigner(provider);
          }
        } catch (_e) {}

        if (signer) {
          var MT_ABI = ['function receiveMessage(bytes message, bytes attestation) returns (bool)', 'function usedNonces(bytes32) view returns (bool)'];
          var mtContract = new ethers.Contract(t.messageTransmitter, MT_ABI, signer);

          var mintTx = await mtContract.receiveMessage(t.messageBytes, t.attestationSignature);
          var mintReceipt = await mintTx.wait();
          if (mintReceipt && mintReceipt.status === 1) {
            t.mintTxHash = mintTx.hash;
          } else {
            throw new Error('Mint transaction failed on-chain');
          }
        }
      }

      t.state = 'COMPLETED';
      t.completedAt = Date.now();
      save();
      return { ok: true, mintTxHash: t.mintTxHash };
    } catch (e) {
      t.state = 'FAILED';
      t.error = 'Mint failed: ' + (e.message || String(e));
      save();
      return { ok: false, error: t.error };
    }
  }

  /** Full pipeline: burn → attest → mint */
  async function executeFullPipeline(transferId) {
    var burnRes = await executeBurn(transferId);
    if (!burnRes.ok) return burnRes;

    var attestRes = await pollAttestation(transferId);
    if (!attestRes.ok) return attestRes;

    var mintRes = await executeMint(transferId);
    return mintRes;
  }

  function getTransfer(id) { return transfers[id] || null; }
  function getAllTransfers() { return Object.values(transfers); }
  function getPendingTransfers() { return Object.values(transfers).filter(function (t) { return t.state !== 'COMPLETED' && t.state !== 'FAILED'; }); }

  function retryTransfer(id) {
    var t = transfers[id];
    if (!t) return null;
    t.retryCount = (t.retryCount || 0) + 1;
    if (t.retryCount > t.maxRetries) { t.state = 'FAILED'; t.error = 'Max retries exceeded'; save(); return t; }

    if (t.state === 'FAILED') {
      if (t.burnTxHash && t.messageBytes) t.state = 'WAITING_FINALITY';
      else if (t.burnTxHash) t.state = 'BURNED';
      else t.state = 'INITIATED';
      t.error = null;
    }
    save();
    return t;
  }

  load();

  window.CCTPV2InboundEngine = {
    createTransfer: createTransfer,
    executeBurn: executeBurn,
    pollAttestation: pollAttestation,
    executeMint: executeMint,
    executeFullPipeline: executeFullPipeline,
    getTransfer: getTransfer,
    getAllTransfers: getAllTransfers,
    getPendingTransfers: getPendingTransfers,
    retryTransfer: retryTransfer,
    STATES: STATES.slice()
  };
})();
