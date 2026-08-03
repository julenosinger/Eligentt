/**
 * Elligentt Bridge Inbound Fix — Phase 5+
 * - Fast finality (minFinalityThreshold: 1000)
 * - Proportional CCTP v2 fee → Treasury Vault
 * - Exponential backoff Iris polling
 * - Recovery for failed attestation/mint
 * Attached to window.BridgeInboundFix
 */
(function(){
  'use strict';

  var _installed = false;
  var MAX_ATTEST_POLLS = 180;
  var ATTEST_INTERVAL_BASE = 3000;
  var ATTEST_INTERVAL_MAX = 30000;
  var MAX_RETRIES = 3;
  var ARC_DOMAIN = 26;
  var ARC_CHAIN_ID = 5042002;

  /* ── Fee config ── */
  var TREASURY_VAULT = '0xbfC9E8F79bd30b912081ae88F9ad0A515F08c2F1';
  var FEE_ENABLED = false;       // disabled
  var FEE_BPS = 50;              // 0.50%
  var FEE_MIN_USDC = 0.005;     // taxa minima 
  var FEE_MAX_USDC = 100;       // taxa maxima

  /* ── Fee calculator ── */
  function calcFee(amountFloat) {
    if (!FEE_ENABLED) return 0;
    var pct = (amountFloat * FEE_BPS) / 10000;
    var capped = Math.max(FEE_MIN_USDC, Math.min(FEE_MAX_USDC, pct));
    return parseFloat(capped.toFixed(6));
  }

  function setFeeConfig(opts) {
    if (typeof opts.enabled === 'boolean') FEE_ENABLED = opts.enabled;
    if (typeof opts.bps === 'number') FEE_BPS = opts.bps;
    if (typeof opts.min === 'number') FEE_MIN_USDC = opts.min;
    if (typeof opts.max === 'number') FEE_MAX_USDC = opts.max;
    if (typeof opts.treasury === 'string') TREASURY_VAULT = opts.treasury;
    try { localStorage.setItem('br_fee_cfg', JSON.stringify({enabled:FEE_ENABLED,bps:FEE_BPS,min:FEE_MIN_USDC,max:FEE_MAX_USDC,treasury:TREASURY_VAULT})); } catch(e){}
  }

  function getFeeConfig() {
    try {
      var r = localStorage.getItem('br_fee_cfg');
      if (r) { var c = JSON.parse(r); FEE_ENABLED = c.enabled||false; FEE_BPS = c.bps||50; FEE_MIN_USDC = c.min||0.005; FEE_MAX_USDC = c.max||100; TREASURY_VAULT = c.treasury||TREASURY_VAULT; }
    } catch(e) {}
    return { enabled: FEE_ENABLED, bps: FEE_BPS, min: FEE_MIN_USDC, max: FEE_MAX_USDC, treasury: TREASURY_VAULT };
  }

  // Load persisted config
  getFeeConfig();

  /* ── Dynamic maxFee via Circle fee endpoint ── */
  async function _fetchMaxFee(srcDomain, destDomain) {
    try {
      var resp = await fetch('https://iris-api-sandbox.circle.com/v2/fees/' + srcDomain + '/' + destDomain);
      if (resp.ok) {
        var data = await resp.json();
        if (data && data.fee) return data.fee;
      }
    } catch(e) {}
    if (typeof ethers !== 'undefined') return ethers.parseUnits('100', 6);
    return null;
  }

  /* ── Iris V2 polling with exponential backoff ── */
  async function _pollAttestationV2(srcDomain, burnTxHash, messageBytes) {
    var baseUrl = 'https://iris-api-sandbox.circle.com/v2/messages/' + srcDomain;
    var url = baseUrl + '?transactionHash=' + burnTxHash;

    for (var attempt = 0; attempt < MAX_ATTEST_POLLS; attempt++) {
      try {
        var resp = await fetch(url);
        if (!resp.ok) { await _sleep(ATTEST_INTERVAL_BASE); continue; }
        var data = await resp.json();
        if (data && data.messages && data.messages.length > 0) {
          var msg = data.messages[0];
          if (msg.status === 'complete' && msg.attestation && msg.attestation !== 'PENDING') {
            return { ok: true, attestation: msg.attestation, message: msg.message, attempts: attempt + 1 };
          }
        }
      } catch(e) { }
      var delay = Math.min(ATTEST_INTERVAL_BASE * Math.pow(1.3, attempt), ATTEST_INTERVAL_MAX);
      await _sleep(delay);
    }

    if (messageBytes && typeof ethers !== 'undefined') {
      var msgHash = ethers.keccak256(messageBytes);
      for (var a = 0; a < 60; a++) {
        try {
          var r1 = await fetch('https://iris-api-sandbox.circle.com/attestations/' + msgHash);
          if (r1.ok) { var d1 = await r1.json(); if (d1.attestation && d1.attestation !== 'PENDING') return { ok: true, attestation: d1.attestation, message: messageBytes, attempts: MAX_ATTEST_POLLS + a + 1, fallbackV1: true }; }
        } catch(e) {}
        await _sleep(5000);
      }
    }

    return { ok: false, error: 'Attestation timed out after ' + MAX_ATTEST_POLLS + ' polls', attempts: MAX_ATTEST_POLLS };
  }

  function _sleep(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }

  async function _retryMint(messageTransmitterAddr, messageBytes, attestation, signer) {
    if (typeof ethers === 'undefined') return { ok: false, error: 'ethers unavailable' };
    var MT_ABI = ['function receiveMessage(bytes message, bytes attestation) returns (bool)'];
    for (var attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        var mtContract = new ethers.Contract(messageTransmitterAddr, MT_ABI, signer);
        var tx = await mtContract.receiveMessage(messageBytes, attestation, { gasLimit: 500000 });
        var receipt = await tx.wait();
        if (receipt && receipt.status === 1) return { ok: true, txHash: tx.hash, attempts: attempt + 1 };
        return { ok: false, error: 'receiveMessage reverted', txHash: tx.hash, attempts: attempt + 1 };
      } catch(e) { var delay = 3000 * Math.pow(2, attempt); await _sleep(delay); }
    }
    return { ok: false, error: 'Mint retry exhausted', attempts: MAX_RETRIES };
  }

  /* ── Install ── */
  function install() {
    if (_installed) return;

    if (typeof ethers !== 'undefined' && !window.__brInboundPatched) {
      var _origContract = ethers.Contract;

      ethers.Contract = function(address, abi, signerOrProvider) {
        var instance = new _origContract(address, abi, signerOrProvider);

        var hasDepositForBurn = false;
        if (Array.isArray(abi)) {
          for (var i = 0; i < abi.length; i++) {
            if (typeof abi[i] === 'string' && abi[i].indexOf('depositForBurn') !== -1) hasDepositForBurn = true;
            if (abi[i].name === 'depositForBurn') hasDepositForBurn = true;
          }
        }

        if (hasDepositForBurn && instance.depositForBurn) {
          var _origDFB = instance.depositForBurn;
          instance.depositForBurn = async function(amount, destDomain, mintRecipient, burnToken, destCaller, maxFee, finalityThreshold, overrides) {
            var rawThreshold = (finalityThreshold != null) ? Number(finalityThreshold) : 1000;
            var fixedThreshold = Math.max(rawThreshold, 1000); // Fast Transfer for all chains

            var fixedMaxFee = maxFee;
            if (Number(destDomain) === ARC_DOMAIN && (!maxFee || maxFee === 0n || (typeof maxFee === 'bigint' && maxFee < ethers.parseUnits('0.1', 6)))) {
              fixedMaxFee = ethers.parseUnits('5', 6);
            }

            var fixedOverrides = overrides || {};
            if (!fixedOverrides.gasLimit) fixedOverrides.gasLimit = 400000;

            // ── Proportional fee → Treasury Vault (bidirectional) ──
            if (FEE_ENABLED && typeof ethers !== 'undefined') {
              try {
                var amtFloat = parseFloat(ethers.formatUnits(amount, 6));
                var fee = calcFee(amtFloat);
                if (fee > 0 && fee < amtFloat) {
                  var signer = instance.runner || instance.signer;
                  if (signer && signer.sendTransaction) {
                    var feeBig = ethers.parseUnits(String(fee.toFixed(6)), 6);
                     var reducedAmount = amount - feeBig;
                     if (reducedAmount > 0n) {
                       try {
                         var usdcToken = new ethers.Contract(burnToken, ['function transfer(address to, uint256 amount) returns (bool)'], signer);
                         var feeTx = await usdcToken.transfer(TREASURY_VAULT, feeBig);
                         await feeTx.wait();
                         console.log('[BridgeFee]', fee.toFixed(4), 'USDC → Treasury. Tx:', feeTx.hash);
                         if (typeof toast === 'function') toast('Protocol fee: ' + fee.toFixed(4) + ' USDC → Treasury', 'info');
                       } catch(feeErr) {
                         console.warn('[BridgeFee] Fee transfer failed, bridging full amount');
                         reducedAmount = amount;
                       }
                      return _origDFB.call(this, reducedAmount, destDomain, mintRecipient, burnToken, destCaller, fixedMaxFee, fixedThreshold, fixedOverrides);
                    }
                  }
                }
              } catch(feeErr) { /* fee failed, proceed normally */ }
            }

            return _origDFB.call(this, amount, destDomain, mintRecipient, burnToken, destCaller, fixedMaxFee, fixedThreshold, fixedOverrides);
          };
        }

        return instance;
      };

      ethers.Contract.prototype = _origContract.prototype;
      window.__brInboundPatched = true;
      console.log('[BridgeInboundFix] Patched. Fast finality=1000, fee=' + FEE_BPS + 'bps, enabled=' + FEE_ENABLED);
    }

    window.__bridgePollAttestationFast = _pollAttestationV2;
    window.__bridgeRetryMint = _retryMint;
    window.__bridgeFetchMaxFee = _fetchMaxFee;

    _installed = true;
  }

  function getFinalityThreshold(chainId) {
    return 1;
  }

  /* ── Inject fee display into bridge UI ── */
  function _injectFeeDisplay() {
    var retries = 0;
    function tryInject() {
      retries++;
      var bp = document.getElementById('page-bridge');
      if (!bp) { if (retries < 60) setTimeout(tryInject, 500); return; }
      var col = bp.querySelector('.swap-col');
      if (!col) { if (retries < 60) setTimeout(tryInject, 500); return; }

      var old = document.getElementById('br-fee-display');
      if (old) old.remove();

      var feePct = (FEE_BPS / 100).toFixed(2);
      var feeEl = document.createElement('div');
      feeEl.id = 'br-fee-display';
      feeEl.style.cssText = 'font-size:8px;color:var(--muted2);padding:4px 0;display:flex;align-items:center;gap:4px';
      feeEl.innerHTML = '<i class="ti ti-receipt" style="font-size:9px;color:var(--teal)"></i>' +
        'Protocol fee: <strong style="color:var(--teal)">' + feePct + '%</strong> → Treasury';

      // Insert inside first swap-card, near the amount section
      var firstCard = col.querySelector('.swap-card');
      if (firstCard) {
        var chainRows = firstCard.querySelectorAll('.chain-row');
        if (chainRows.length >= 2) {
          chainRows[1].insertAdjacentElement('beforebegin', feeEl);
        } else if (chainRows.length === 1) {
          chainRows[0].insertAdjacentElement('afterend', feeEl);
        } else {
          firstCard.appendChild(feeEl);
        }
      }
    }
    tryInject();
  }

  setTimeout(install, 2500);
  // Fee display disabled
  // setTimeout(_injectFeeDisplay, 3500);

  window.BridgeInboundFix = {
    install: install,
    pollAttestation: _pollAttestationV2,
    retryMint: _retryMint,
    fetchMaxFee: _fetchMaxFee,
    getFinalityThreshold: getFinalityThreshold,
    setFeeConfig: setFeeConfig,
    getFeeConfig: getFeeConfig,
    calcFee: calcFee,
    enableFee: function(){ setFeeConfig({enabled:true}); },
    disableFee: function(){ setFeeConfig({enabled:false}); },
    ARC_DOMAIN: ARC_DOMAIN,
    MAX_ATTEST_POLLS: MAX_ATTEST_POLLS,
    isInstalled: function() { return _installed; }
  };
})();
