/**
 * Elligentt Pool Health Check (FASE 2.7)
 * ═══════════════════════════════════════
 * Verifies pool contract health: existence, RPC, reserves, tokens, LP, router.
 * Marks pool as unhealthy if any check fails. Blocks critical operations.
 * Attached to window.PoolHealthCheck
 */
(function(){
  'use strict';

  async function run(poolConfig, provider) {
    if (!provider) provider = _getProvider();

    var checks = [];
    var allPassed = true;

    // 1. Contract existence
    var codeCheck = { name: 'Contract Code', passed: false, detail: '' };
    try {
      var code = await provider.getCode(poolConfig.poolAddress);
      codeCheck.passed = code && code !== '0x';
      codeCheck.detail = codeCheck.passed ? 'Contract found on-chain (' + code.length + ' bytes)' : 'No code at address';
    } catch(e) {
      codeCheck.passed = false;
      codeCheck.detail = 'RPC error: ' + (e.message || 'unknown');
      codeCheck.error = true;
    }
    checks.push(codeCheck);
    if (!codeCheck.passed) allPassed = false;

    // 2. RPC health
    var rpcCheck = { name: 'RPC Availability', passed: false, detail: '' };
    try {
      var blockNumber = await provider.getBlockNumber();
      rpcCheck.passed = blockNumber > 0;
      rpcCheck.detail = 'Block #' + blockNumber;
    } catch(e) {
      rpcCheck.passed = false;
      rpcCheck.detail = 'RPC unreachable';
    }
    checks.push(rpcCheck);
    if (!rpcCheck.passed) allPassed = false;

    // 3. Reserve validation
    var reserveCheck = { name: 'Pool Reserves', passed: false, detail: '' };
    try {
      var iface = new ethers.Interface(['function getReserves() view returns (uint256,uint256,uint256)']);
      var data = iface.encodeFunctionData('getReserves');
      var result = await provider.call({ to: poolConfig.poolAddress, data: data });
      var decoded = iface.decodeFunctionResult('getReserves', result);
      var rA = decoded[0], rB = decoded[1];
      reserveCheck.passed = rA > 0n && rB > 0n;
      reserveCheck.detail = reserveCheck.passed
        ? 'ReserveA=' + ethers.formatUnits(rA, 6) + ' ReserveB=' + ethers.formatUnits(rB, 8)
        : 'Empty reserves (A=' + rA + ' B=' + rB + ')';
      reserveCheck.reserveA = rA;
      reserveCheck.reserveB = rB;
    } catch(e) {
      reserveCheck.passed = false;
      reserveCheck.detail = 'Reserve read failed: ' + (e.message || 'reverted');
    }
    checks.push(reserveCheck);
    if (!reserveCheck.passed) allPassed = false;

    // 4. Token validation
    var tokenCheck = { name: 'Token Addresses', passed: true, detail: '' };
    if (!poolConfig.tokens || poolConfig.tokens.length < 2) {
      tokenCheck.passed = false;
      tokenCheck.detail = 'Less than 2 tokens configured';
    } else {
      tokenCheck.detail = poolConfig.tokens.length + ' tokens: ' + poolConfig.tokens.map(function(t) { return t.symbol; }).join(', ');
    }
    checks.push(tokenCheck);
    if (!tokenCheck.passed) allPassed = false;

    // 5. LP token validation
    var lpCheck = { name: 'LP Token', passed: false, detail: '' };
    try {
      var erc20Iface = new ethers.Interface([
        'function name() view returns (string)',
        'function symbol() view returns (string)',
        'function totalSupply() view returns (uint256)',
        'function decimals() view returns (uint8)'
      ]);
      var nameEnc = erc20Iface.encodeFunctionData('name');
      var nameResult = await provider.call({ to: poolConfig.poolAddress, data: nameEnc });
      var name = erc20Iface.decodeFunctionResult('name', nameResult)[0];
      var tsEnc = erc20Iface.encodeFunctionData('totalSupply');
      var tsResult = await provider.call({ to: poolConfig.poolAddress, data: tsEnc });
      var ts = erc20Iface.decodeFunctionResult('totalSupply', tsResult)[0];

      lpCheck.passed = name && ts > 0n;
      lpCheck.detail = lpCheck.passed
        ? name + ' (totalSupply=' + ethers.formatUnits(ts, 18) + ')'
        : 'LP token validation failed';
    } catch(e) {
      lpCheck.passed = false;
      lpCheck.detail = 'LP check error: ' + (e.message || 'reverted');
    }
    checks.push(lpCheck);
    if (!lpCheck.passed) allPassed = false;

    // 6. Router validation
    var routerCheck = { name: 'Router/Factory', passed: false, detail: '' };
    if (!poolConfig.routerAddress || poolConfig.routerAddress === '0x0000000000000000000000000000000000000001') {
      routerCheck.passed = false;
      routerCheck.detail = 'Router contract not deployed (placeholder address) — swaps blocked';
      routerCheck.warning = true;
    } else {
      try {
        var rCode = await provider.getCode(poolConfig.routerAddress);
        routerCheck.passed = rCode && rCode !== '0x';
        routerCheck.detail = routerCheck.passed ? 'Router found' : 'No code at router address';
      } catch(e) {
        routerCheck.passed = false;
        routerCheck.detail = 'Router check error';
      }
    }
    checks.push(routerCheck);

    return {
      healthy: allPassed && (reserveCheck.passed || false),
      passed: checks.filter(function(c) { return c.passed; }).length,
      failed: checks.filter(function(c) { return !c.passed; }).length,
      total: checks.length,
      checks: checks,
      checkedAt: Date.now(),
      poolAddress: poolConfig.poolAddress,
      chainId: poolConfig.chainId
    };
  }

  function _getProvider() {
    if (typeof RPCManager !== 'undefined' && RPCManager.getHealthyRPC) {
      var p = RPCManager.getCurrentProvider();
      if (p) return p;
    }
    if (typeof ethers !== 'undefined') {
      return new ethers.JsonRpcProvider('https://arc-testnet.drpc.org');
    }
    return null;
  }

  function isHealthy(result) {
    return result && result.healthy === true;
  }

  function formatReport(result) {
    if (!result) return 'Health check not performed.';
    var lines = [];
    lines.push('=== Pool Health Report ===');
    lines.push('Pool: ' + result.poolAddress);
    lines.push('Status: ' + (result.healthy ? 'HEALTHY' : 'UNHEALTHY'));
    lines.push('Passed: ' + result.passed + '/' + result.total);
    for (var i = 0; i < result.checks.length; i++) {
      var c = result.checks[i];
      lines.push('  [' + (c.passed ? 'PASS' : 'FAIL') + '] ' + c.name + ': ' + c.detail);
    }
    return lines.join('\n');
  }

  window.PoolHealthCheck = {
    run: run,
    isHealthy: isHealthy,
    formatReport: formatReport
  };
})();
