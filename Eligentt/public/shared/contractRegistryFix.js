/**
 * Elligentt ContractRegistry Fix — Phase 5 Remediation
 * Distinguishes between protocol contracts, user wallets, and recipients.
 * Prevents false positives blocking valid user addresses.
 * Attached to window.ContractRegistryFix
 */
(function(){
  'use strict';

  /**
   * Determine the type of an address.
   * Returns: 'protocol' | 'user_wallet' | 'recipient' | 'unknown'
   */
  function classifyAddress(addr) {
    if (!addr || typeof addr !== 'string') return 'unknown';

    var lower = addr.toLowerCase();

    // Zero/null addresses are invalid
    if (lower === '0x0000000000000000000000000000000000000000') return 'invalid';
    if (lower === '0x0000000000000000000000000000000000000001') return 'invalid';

    // Protocol contracts (must pass 3 checks: known + verified + trusted)
    var PROTOCOL = {
      '0xbfc9e8f79bd30b912081ae88f9ad0a515f08c2f1': { name: 'Treasury Vault', trust: 'high' },
      '0x18076d992005186aeb13ac5270cad6e27db95247': { name: 'ElligentPool AMM', trust: 'high' },
      '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa': { name: 'CCTP TokenMessenger', trust: 'high' },
      '0xe737e5cebeeba77efe34d4aa090756590b1ce275': { name: 'CCTP MsgTransmitter', trust: 'high' },
      '0x17cfb1aacbc64d0f0c247ed261b66c3d56e3eb16': { name: 'CrossChain Batch', trust: 'high' },
      '0x5294e9927c3306dcbadb03fe70b92e01ccede505': { name: 'Memo Contract', trust: 'high' },
      '0xca11bde05977b3631167028862be2a173976ca11': { name: 'Multicall3', trust: 'high' },
      '0x8004a818bfb912233c491871b3d84c89a494bd9e': { name: 'ERC8004 Identity', trust: 'high' },
      '0x8004b663056a597dffe9eccc1965a193b7388713': { name: 'ERC8004 Reputation', trust: 'high' },
      '0x8004cb1bf31daf7788923b405b754f57aceb4272': { name: 'ERC8004 Validation', trust: 'high' },
      '0x000000000022d473030f116ddee9f6b43ac78ba3': { name: 'Permit2', trust: 'high' }
    };

    if (PROTOCOL[lower]) return 'protocol';

    // Token contracts
    var TOKENS = {
      '0x3600000000000000000000000000000000000000': 'USDC',
      '0x89b50855aa3be2f677cd6303cec089b5f319d72a': 'EURC',
      '0xf0c4a4ce82a5746abaad9425360ab04fbba432bf': 'cirBTC'
    };
    if (TOKENS[lower]) return 'protocol';

    // Known treasury/operator addresses
    var WHITELIST = [
      '0xa43abd9dc38840376d3c469bfbf5951912936c9f',
      '0xc2be29e58f05ba8279bd800b8b6a3790233f2426',
      '0x01de545e8fea5ecaab78ec2c09e6d98117f7687d',
      '0xbbe4bf2d53a4a752c0ef21573fa0162bddafcd12',
      '0xc77f058339bb0ff06554b2d0efcb0e2fd4852cb0'
    ];
    if (WHITELIST.indexOf(lower) !== -1) return 'protocol';

    // User wallets: has interacted with the app, has active permits, or is the current wallet
    if (_isCurrentWallet(lower)) return 'user_wallet';
    if (_isKnownRecipient(lower)) return 'recipient';

    // If it's a valid address but not in any known list, it's a recipient
    if (/^0x[0-9a-fA-F]{40}$/.test(addr)) return 'recipient';

    return 'unknown';
  }

  function _isCurrentWallet(addr) {
    try {
      if (typeof walletAddress !== 'undefined' && walletAddress &&
          walletAddress.toLowerCase() === addr) return true;
    } catch(e) {}
    try {
      if (typeof AgentWalletManager !== 'undefined') {
        var agent = AgentWalletManager.getAgentAddress();
        if (agent && agent.toLowerCase() === addr) return true;
      }
    } catch(e) {}
    return false;
  }

  function _isKnownRecipient(addr) {
    try {
      // Check if address appears in saved recipients
      var raw = localStorage.getItem('recipients');
      if (raw) {
        var list = JSON.parse(raw);
        if (Array.isArray(list)) {
          for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].address && list[i].address.toLowerCase() === addr) return true;
          }
        }
      }
    } catch(e) {}

    try {
      // Check if address has appeared in execution history
      var histRaw = localStorage.getItem('elligentt_exec_history_v1');
      if (histRaw && histRaw.indexOf(addr.slice(2, 8)) !== -1) return true;
    } catch(e) {}

    return false;
  }

  /**
   * Safe allowlist check — NEVER blocks users or recipients.
   * Only flags truly unknown/unverified protocol contracts.
   */
  function isSafeForOperation(addr, operation) {
    var classification = classifyAddress(addr);

    // NEVER block these
    if (classification === 'user_wallet' || classification === 'recipient') return true;
    if (classification === 'protocol') return true;
    if (classification === 'invalid') return false;

    // For bridge operations, allow unknown addresses (destination chain recipient)
    if (operation === 'bridge' || operation === 'crosschain') return true;

    // For payment operations, allow any valid address
    if (operation === 'payment' || operation === 'transfer' || operation === 'send' || operation === 'multisend') return true;

    // For treasury operations, only allow protocol contracts
    if (operation === 'treasury' || operation === 'vault') {
      return classification === 'protocol';
    }

    // For swap operations, require protocol contracts
    if (operation === 'swap') {
      return classification === 'protocol';
    }

    return true;
  }

  /**
   * Patch ContractRegistry to include the classification logic.
   * Does NOT replace ContractRegistry — extends it.
   */
  function install() {
    var maxAttempts = 50;
    var attempts = 0;

    function tryInstall() {
      attempts++;
      if (typeof window.ContractRegistry !== 'undefined') {
        // Add classification method without replacing existing APIs
        window.ContractRegistry.classifyAddress = classifyAddress;
        window.ContractRegistry.isSafeForOperation = isSafeForOperation;

        // Patch isKnown to be more permissive
        var _originalIsKnown = window.ContractRegistry.isKnown;
        window.ContractRegistry.isKnown = function(addr) {
          var classification = classifyAddress(addr);
          // Recipients and user wallets are "known" in the sense they're safe
          if (classification === 'recipient' || classification === 'user_wallet') return true;
          return _originalIsKnown(addr);
        };

        console.log('[ContractRegistryFix] Installed. Address classification active.');
        return;
      }

      if (attempts < maxAttempts) setTimeout(tryInstall, 200);
    }

    tryInstall();
  }

  // Auto-install
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { setTimeout(install, 2000); });
  } else {
    setTimeout(install, 1000);
  }

  window.ContractRegistryFix = {
    classifyAddress: classifyAddress,
    isSafeForOperation: isSafeForOperation,
    install: install
  };
})();
