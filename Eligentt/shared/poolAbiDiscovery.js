/**
 * Elligentt Pool ABI Discovery (FASE 2.1)
 * ═══════════════════════════════════════
 * Discovers the actual ABI of the liquidity pool on-chain.
 * Tested against deploy 0x18076d992005186AeB13AC5270CaD6E27DB95247 on Arc Testnet.
 * Attached to window.PoolAbiDiscovery
 *
 * DISCOVERED ABI (15/07/2026):
 *   ERC-20: name, symbol, decimals(18), totalSupply, balanceOf, allowance
 *   Pool:   getReserves() → (uint256 reserveA, uint256 reserveB, uint256 blockTimestamp)
 *   NOT available: token0, token1, tokenA, tokenB, fee, factory, getAmountOut, swap
 */
(function(){
  'use strict';

  var SELECTORS = {
    /* ERC-20 metadata */
    name:         { sig: '0x06fdde03',   type: 'view',   ret: 'string',    category: 'erc20' },
    symbol:       { sig: '0x95d89b41',   type: 'view',   ret: 'string',    category: 'erc20' },
    decimals:     { sig: '0x313ce567',   type: 'view',   ret: 'uint8',     category: 'erc20' },
    totalSupply:  { sig: '0x18160ddd',   type: 'view',   ret: 'uint256',   category: 'erc20' },
    balanceOf:    { sig: '0x70a08231',   type: 'view',   ret: 'uint256',   category: 'erc20',  input: ['address'] },
    allowance:    { sig: '0xdd62ed3e',   type: 'view',   ret: 'uint256',   category: 'erc20',  input: ['address','address'] },
    transfer:     { sig: '0xa9059cbb',   type: 'write',  ret: 'bool',      category: 'erc20',  input: ['address','uint256'] },
    approve:      { sig: '0x095ea7b3',   type: 'write',  ret: 'bool',      category: 'erc20',  input: ['address','uint256'] },
    transferFrom: { sig: '0x23b872dd',   type: 'write',  ret: 'bool',      category: 'erc20',  input: ['address','address','uint256'] },

    /* Pool-specific */
    getReserves:  { sig: '0x0902f1ac',   type: 'view',   ret: '(uint256,uint256,uint256)', category: 'pool' },

    /* Standard AMM — NOT SUPPORTED by this pool */
    token0:       { sig: '0x0dfe1681',   type: 'view',   ret: 'address',   category: 'amm',   supported: false },
    token1:       { sig: '0xd21220a7',   type: 'view',   ret: 'address',   category: 'amm',   supported: false },
    tokenA:       { sig: '0x0fcb5522',   type: 'view',   ret: 'address',   category: 'amm',   supported: false },
    tokenB:       { sig: '0x5f0e0dd1',   type: 'view',   ret: 'address',   category: 'amm',   supported: false },
    fee:          { sig: '0xddca3f43',   type: 'view',   ret: 'uint256',   category: 'amm',   supported: false },
    factory:      { sig: '0xc45a0155',   type: 'view',   ret: 'address',   category: 'amm',   supported: false },
    getAmountOut: { sig: '0xf2ac2d16',   type: 'view',   ret: 'uint256',   category: 'amm',   supported: false, input: ['uint256','address'] }
  };

  var DISCOVERY_RESULT = null;

  async function _callSelector(provider, contractAddr, name, meta) {
    try {
      var data = meta.sig;
      if (meta.input && meta.input.length > 0 && name === 'balanceOf') {
        data += '0000000000000000000000000000000000000000000000000000000000000001';
      }
      var result = await provider.call({ to: contractAddr, data: data });
      return { name: name, sig: meta.sig, supported: true, result: result, category: meta.category, type: meta.type };
    } catch(e) {
      return { name: name, sig: meta.sig, supported: false, error: e.message || 'reverted', category: meta.category, type: meta.type };
    }
  }

  async function discoverABI(provider, contractAddr) {
    if (!provider || typeof ethers === 'undefined') return null;
    var results = [];
    var names = Object.keys(SELECTORS);
    var promises = [];

    for (var i = 0; i < names.length; i++) {
      promises.push(_callSelector(provider, contractAddr, names[i], SELECTORS[names[i]]));
    }

    try {
      results = await Promise.allSettled ? (await Promise.allSettled(promises)).map(function(r) { return r.value || r.reason; }) : [];
    } catch(e) {
      for (var j = 0; j < promises.length; j++) {
        try { results.push(await promises[j]); } catch(e2) { results.push(null); }
      }
    }

    var supported = results.filter(function(r) { return r && r.supported; });
    var unsupported = results.filter(function(r) { return r && !r.supported; });

    var erc20Count = supported.filter(function(r) { return r.category === 'erc20'; }).length;
    var poolCount = supported.filter(function(r) { return r.category === 'pool'; }).length;
    var ammCount = supported.filter(function(r) { return r.category === 'amm'; }).length;

    // Build the ABI based on what's actually supported
    var abi = [];
    for (var k = 0; k < supported.length; k++) {
      var sel = supported[k];
      var meta = SELECTORS[sel.name];
      if (meta) {
        abi.push({ name: sel.name, type: 'function', selector: sel.sig, category: sel.category, stateMutability: meta.type });
      }
    }

    DISCOVERY_RESULT = {
      contract: contractAddr,
      chainId: 5042002,
      totalFunctions: results.length,
      supportedCount: supported.length,
      unsupportedCount: unsupported.length,
      erc20Functions: erc20Count,
      poolFunctions: poolCount,
      ammFunctions: ammCount,
      isErc20: erc20Count >= 7,
      hasReserves: supported.some(function(r) { return r.name === 'getReserves'; }),
      hasStandardAMM: ammCount > 3,
      poolType: ammCount > 3 ? 'UniswapV2-like' : 'Custom LP Token with Reserves',
      supportedFunctions: supported,
      unsupportedFunctions: unsupported,
      abi: abi,
      discoveredAt: Date.now()
    };

    return DISCOVERY_RESULT;
  }

  function getDiscoveryResult() {
    return DISCOVERY_RESULT;
  }

  function getSupportedFunctions() {
    if (!DISCOVERY_RESULT) return [];
    return DISCOVERY_RESULT.supportedFunctions;
  }

  function isFunctionSupported(name) {
    if (!DISCOVERY_RESULT) return null;
    var f = DISCOVERY_RESULT.supportedFunctions;
    return f.some(function(r) { return r.name === name; });
  }

  function getPoolType() {
    return DISCOVERY_RESULT ? DISCOVERY_RESULT.poolType : 'Unknown';
  }

  function formatDiscoveryReport() {
    if (!DISCOVERY_RESULT) return 'ABI discovery not yet performed.';
    var d = DISCOVERY_RESULT;
    var lines = [];
    lines.push('=== Pool ABI Discovery Report ===');
    lines.push('Contract: ' + d.contract);
    lines.push('Chain ID: ' + d.chainId);
    lines.push('Pool Type: ' + d.poolType);
    lines.push('ERC-20 Compatible: ' + (d.isErc20 ? 'Yes' : 'No'));
    lines.push('Has Reserves: ' + (d.hasReserves ? 'Yes' : 'No'));
    lines.push('');
    lines.push('--- Supported Functions (' + d.supportedCount + '/' + d.totalFunctions + ') ---');
    for (var i = 0; i < d.supportedFunctions.length; i++) {
      var f = d.supportedFunctions[i];
      lines.push('  [' + f.category.toUpperCase() + '] ' + f.name + ' (' + f.sig + ')');
    }
    lines.push('');
    lines.push('--- Unsupported Functions (' + d.unsupportedCount + ') ---');
    for (var j = 0; j < d.unsupportedFunctions.length; j++) {
      var u = d.unsupportedFunctions[j];
      lines.push('  [' + u.category.toUpperCase() + '] ' + u.name + ' (' + u.sig + ')');
    }
    return lines.join('\n');
  }

  window.PoolAbiDiscovery = {
    discoverABI: discoverABI,
    getDiscoveryResult: getDiscoveryResult,
    getSupportedFunctions: getSupportedFunctions,
    isFunctionSupported: isFunctionSupported,
    getPoolType: getPoolType,
    formatDiscoveryReport: formatDiscoveryReport,
    SELECTORS: SELECTORS
  };
})();
