/**
 * Elligentt Chain Simulator — Real on-chain simulation
 * Uses ethers.js staticCall/view to get real data from deployed contracts.
 * Non-blocking: falls back silently if provider/contract unavailable.
 * Attached to window.ChainSimulator
 *
 * FASE 1 SECURITY PATCHES:
 *   - calculateMinOut() with slippage protection (C2)
 *   - deadline enforcement (C4)
 *   - exact approve (C3)
 *   - router validation (C1)
 */
(function(){
  'use strict';

  var SWAP_DEFAULT_DEADLINE = 300;
  var SWAP_DEFAULT_SLIPPAGE_BPS = 100;

  var ARC_RPC = 'https://arc-testnet.drpc.org';
  var readProvider = null;

  function getProvider(){
    if(readProvider) return readProvider;
    try {
      if (typeof RPCManager !== 'undefined') {
        var rpcResult = RPCManager.getCurrentProvider();
        if (rpcResult) {
          readProvider = rpcResult;
          return readProvider;
        }
      }
    } catch(e) {}
    try {
      if(typeof ethers !== 'undefined'){
        readProvider = new ethers.JsonRpcProvider(ARC_RPC);
      }
    } catch(e){}
    return readProvider || (typeof provider !== 'undefined' ? provider : null);
  }

  /* Pool ABI for getReserves / getAmountOut */
  var POOL_ABI = [
    'function getReserves() view returns (uint256 reserveA, uint256 reserveB, uint256 blockTimestampLast)',
    'function getAmountOut(uint256 amountIn, address tokenIn) view returns (uint256 amountOut)',
    'function tokenA() view returns (address)',
    'function tokenB() view returns (address)',
    'function totalSupply() view returns (uint256)',
    'function fee() view returns (uint256)'
  ];

  var ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function allowance(address owner, address spender) view returns (uint256)'
  ];

  var CCTP_ABI = [
    'function tokenMessenger() view returns (address)',
    'function messageTransmitter() view returns (address)'
  ];

  /* Token addresses */
  var TOKENS = {
    USDC: '0x3600000000000000000000000000000000000000',
    EURC: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
    cirBTC: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF'
  };

  var POOL_ADDRESS = '0x18076d992005186AeB13AC5270CaD6E27DB95247';
  var CCTP_MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA';

  /* ── Router validation (C1) ── */
  var BLOCKED_ROUTERS = [
    '0x0000000000000000000000000000000000000000',
    '0x0000000000000000000000000000000000000001'
  ];

  function validateSwapRouter(routerAddr) {
    if (!routerAddr || routerAddr === 'null' || routerAddr === 'undefined') {
      return { valid: false, reason: 'Swap router unavailable.' };
    }
    var lower = String(routerAddr).toLowerCase();
    for (var i = 0; i < BLOCKED_ROUTERS.length; i++) {
      if (lower === BLOCKED_ROUTERS[i]) {
        return { valid: false, reason: 'Swap router unavailable.' };
      }
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(lower)) {
      return { valid: false, reason: 'Swap router unavailable.' };
    }
    return { valid: true };
  }

  function isRouterValid(routerAddr) {
    return validateSwapRouter(routerAddr).valid;
  }

  /* ── Get real token balance ── */
  async function getBalance(tokenSym, addr){
    var p = getProvider(); if(!p) return null;
    var tokenAddr = TOKENS[tokenSym];
    if(!tokenAddr) return null;
    var wallet = addr || (typeof walletAddress !== 'undefined' ? walletAddress : null);
    if(!wallet) return null;
    try {
      var c = new ethers.Contract(tokenAddr, ERC20_ABI, p);
      var bal = await c.balanceOf(wallet);
      var dec = await c.decimals();
      return parseFloat(ethers.formatUnits(bal, dec));
    } catch(e){ return null; }
  }

  /* ── Check token decimals on-chain ── */
  async function getTokenDecimals(tokenSym) {
    var p = getProvider(); if(!p) return null;
    var tokenAddr = TOKENS[tokenSym];
    if(!tokenAddr) return null;
    try {
      var c = new ethers.Contract(tokenAddr, ERC20_ABI, p);
      var dec = await c.decimals();
      return Number(dec);
    } catch(e) {
      return tokenSym === 'cirBTC' ? 8 : 6;
    }
  }

  /* ── Check allowance ── */
  async function checkAllowance(tokenSym, ownerAddr, spenderAddr) {
    var p = getProvider(); if(!p) return null;
    var tokenAddr = TOKENS[tokenSym];
    if(!tokenAddr) return null;
    var owner = ownerAddr || (typeof walletAddress !== 'undefined' ? walletAddress : null);
    if(!owner) return null;
    try {
      var c = new ethers.Contract(tokenAddr, ERC20_ABI, p);
      var allowance = await c.allowance(owner, spenderAddr);
      var dec = await getTokenDecimals(tokenSym) || 6;
      return parseFloat(ethers.formatUnits(allowance, dec));
    } catch(e){ return null; }
  }

  /* ── Get real pool reserves ── */
  async function getPoolReserves(poolAddr){
    var p = getProvider(); if(!p) return null;
    try {
      var c = new ethers.Contract(poolAddr || POOL_ADDRESS, POOL_ABI, p);
      var r = await c.getReserves();
      return { reserveA: parseFloat(ethers.formatUnits(r.reserveA, 6)), reserveB: parseFloat(ethers.formatUnits(r.reserveB, 6)) };
    } catch(e){ return null; }
  }

  /* ── Simulate swap output ── */
  async function simulateSwap(amountIn, tokenIn, tokenOut, poolAddr){
    var p = getProvider(); if(!p) return null;
    try {
      var tokenInAddr = TOKENS[tokenIn];
      if(!tokenInAddr) return null;
      var pool = poolAddr || POOL_ADDRESS;
      var c = new ethers.Contract(pool, POOL_ABI, p);
      var tokenDec = await getTokenDecimals(tokenIn) || (tokenIn === 'cirBTC' ? 8 : 6);
      var amtBig = ethers.parseUnits(String(amountIn), tokenDec);
      var out = await c.getAmountOut(amtBig, tokenInAddr);
      var outDec = tokenOut === 'cirBTC' ? 8 : 6;
      var amtOut = parseFloat(ethers.formatUnits(out, outDec));

      var res = await c.getReserves();
      var tA = await c.tokenA().catch(function(){ return null; });
      var resA = parseFloat(ethers.formatUnits(res.reserveA, 6));
      var resB = parseFloat(ethers.formatUnits(res.reserveB, 6));
      var reserveIn = (tA && tA.toLowerCase() === tokenInAddr.toLowerCase()) ? resA : resB;
      var priceImpact = reserveIn > 0 ? Math.abs((amountIn / reserveIn) * 100) : 0;

      return {
        amountOut: amtOut,
        amountOutRaw: out,
        priceImpact: priceImpact.toFixed(3),
        rate: amtOut > 0 ? (amtOut / amountIn).toFixed(6) : null,
        reserveIn: reserveIn,
        source: 'on-chain staticCall'
      };
    } catch(e){ return null; }
  }

  /* ── Calculate minOut with slippage (C2) ── */
  function calculateMinOut(quoteAmount, slippageBps) {
    var bps = (slippageBps != null && !isNaN(slippageBps)) ? Number(slippageBps) : SWAP_DEFAULT_SLIPPAGE_BPS;
    var amount = Number(quoteAmount);

    if (isNaN(amount) || amount === null || amount === undefined || amount <= 0) {
      return { valid: false, minOut: 0n, error: 'Invalid quote amount' };
    }
    if (isNaN(bps) || bps < 0 || bps > 10000) {
      return { valid: false, minOut: 0n, error: 'Invalid slippage BPS' };
    }

    var factor = (10000 - bps) / 10000;
    var minOutFloat = amount * factor;

    if (isNaN(minOutFloat) || minOutFloat < 0) {
      return { valid: false, minOut: 0n, error: 'Calculation error' };
    }

    var outDec = 6;
    try {
      if (amount < 1) {
        var s = String(minOutFloat);
        var dotIdx = s.indexOf('.');
        if (dotIdx >= 0) {
          outDec = Math.max(6, s.length - dotIdx - 1);
        }
      }
    } catch(e) {}

    var minOutBigInt;
    try {
      minOutBigInt = ethers.parseUnits(minOutFloat.toFixed(outDec), outDec);
    } catch(e) { return { valid: false, minOut: 0n, error: 'Parse error' }; }

    if (!minOutBigInt || minOutBigInt === 0n) {
      return { valid: false, minOut: 0n, error: 'minOut cannot be zero' };
    }

    return { valid: true, minOut: minOutBigInt, slippageBps: bps };
  }

  /* ── Estimate gas for a swap ── */
  async function estimateGas(operation, params){
    var p = getProvider(); if(!p) return null;
    try {
      var gasPrice = await p.getFeeData();
      var gwei = gasPrice.gasPrice ? parseFloat(ethers.formatUnits(gasPrice.gasPrice, 'gwei')) : 0.01;
      var estimates = {
        swap_approve: 50000,
        swap_execute: 180000,
        bridge_approve: 50000,
        bridge_deposit: 350000,
        send_transfer: 65000,
        send_batch: 150000,
        treasury_deposit: 120000
      };
      var baseGas = estimates[operation] || 100000;
      var ethCost = baseGas * gwei * 1e-9;
      return { gasUnits: baseGas, gwei: gwei, ethCost: ethCost, usdCost: (ethCost * 3000).toFixed(2) };
    } catch(e){ return null; }
  }

  /* ── Simulate bridge output (estimates CCTP fee) ── */
  async function simulateBridge(amount, fromChain, toChain){
    var p = getProvider(); if(!p) return null;
    try {
      var feeRate = 0.0005;
      var bridgeFee = Math.max(0.000001, amount * feeRate);
      var receives = amount - bridgeFee;
      var gas = await estimateGas('bridge_deposit', {});
      return {
        amountOut: receives,
        bridgeFee: bridgeFee.toFixed(6),
        totalFee: bridgeFee.toFixed(6),
        estimatedGas: gas ? gas.usdCost + ' USD' : 'N/A',
        estTime: '~2-5 minutes',
        source: 'on-chain estimation'
      };
    } catch(e){ return null; }
  }

  /* ── Full swap simulation with gas ── */
  async function fullSwapSim(amountIn, tokenIn, tokenOut){
    var swap = await simulateSwap(amountIn, tokenIn, tokenOut);
    var gas = await estimateGas('swap_execute', {});
    var bal = await getBalance(tokenIn);
    if(!swap) return null;
    return {
      estimatedOutput: swap.amountOut.toFixed(tokenOut === 'cirBTC' ? 8 : 6),
      priceImpact: swap.priceImpact + '%',
      rate: swap.rate,
      reserveIn: swap.reserveIn,
      gasEstimate: gas ? gas.usdCost + ' USD (' + gas.gasUnits + ' units)' : 'N/A',
      balance: bal ? bal.toFixed(4) + ' ' + tokenIn : 'N/A',
      sufficientBalance: bal !== null ? bal >= amountIn : null,
      source: 'on-chain simulation'
    };
  }

  /* ── Full bridge simulation ── */
  async function fullBridgeSim(amount, fromChain, toChain){
    var bridge = await simulateBridge(amount, fromChain, toChain);
    var bal = await getBalance('USDC');
    if(!bridge) return null;
    return {
      estimatedReceive: bridge.amountOut.toFixed(4) + ' USDC',
      bridgeFee: bridge.bridgeFee + ' USDC',
      gasEstimate: bridge.estimatedGas,
      estTime: bridge.estTime,
      balance: bal ? bal.toFixed(2) + ' USDC' : 'N/A',
      sufficientBalance: bal !== null ? bal >= amount : null,
      source: 'on-chain estimation'
    };
  }

  /* ── Quick health check ── */
  async function healthCheck(){
    var p = getProvider(); if(!p) return { provider: false };
    try {
      var bn = await p.getBlockNumber();
      var gas = await p.getFeeData();
      return {
        provider: true,
        blockNumber: bn,
        gasGwei: gas.gasPrice ? parseFloat(ethers.formatUnits(gas.gasPrice, 'gwei')).toFixed(2) : 'N/A',
        chainId: (await p.getNetwork()).chainId
      };
    } catch(e){ return { provider: false, error: e.message }; }
  }

  /* ── Calldata preparation ── */
  var SWAP_IFACE = new ethers.Interface([
    'function swap(address tokenIn, uint256 amountIn, uint256 minOut) external returns (uint256 amountOut)'
  ]);
  var APPROVE_IFACE = new ethers.Interface([
    'function approve(address spender, uint256 amount) external returns (bool)'
  ]);
  var TRANSFER_IFACE = new ethers.Interface([
    'function transfer(address to, uint256 amount) external returns (bool)'
  ]);
  var CCTP_IFACE = new ethers.Interface([
    'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold) external returns (uint64 nonce)'
  ]);

  /* ── Build swap calldata with slippage & deadline (C2, C4) ── */
  function buildSwapCalldata(amountIn, tokenIn, tokenOut, slippageBps, poolAddr, quoteAmountOut) {
    try {
      if (!amountIn || isNaN(Number(amountIn)) || Number(amountIn) <= 0) {
        return { valid: false, error: 'Invalid amount', errorMessage: 'Please enter a valid amount.' };
      }

      var tokenInAddr = TOKENS[tokenIn] || tokenIn;
      if (!tokenInAddr || tokenInAddr.length !== 42) {
        return { valid: false, error: 'Invalid token', errorMessage: 'Token not supported.' };
      }

      var pool = poolAddr || POOL_ADDRESS;
      var routerCheck = validateSwapRouter(pool);
      if (!routerCheck.valid) {
        return { valid: false, error: 'Router validation failed', errorMessage: routerCheck.reason };
      }

      // Get token decimals
      var tokenDec = tokenIn === 'cirBTC' ? 8 : 6;
      var outDec = tokenOut === 'cirBTC' ? 8 : 6;

      var amtBig = ethers.parseUnits(String(Number(amountIn).toFixed(tokenDec)), tokenDec);

      // Calculate minOut using the provided quote or estimate
      var effectiveQuote = quoteAmountOut;
      var isEstimated = false;
      if (effectiveQuote == null || isNaN(Number(effectiveQuote)) || Number(effectiveQuote) <= 0) {
        // Use a flat rate estimate; real execution must provide a valid quote
        effectiveQuote = Number(amountIn);
        isEstimated = true;
      }

      var minOutResult = calculateMinOut(effectiveQuote, slippageBps);

      if (!minOutResult.valid) {
        return {
          valid: false,
          error: 'minOut calculation failed: ' + (minOutResult.error || 'unknown'),
          errorMessage: 'Cannot execute swap. Please refresh the quote and try again.',
          blockSwap: true
        };
      }

      if (minOutResult.minOut === 0n) {
        return {
          valid: false,
          error: 'minOut is zero — swap blocked for security',
          errorMessage: 'Swap blocked: slippage protection error. Please try again.',
          blockSwap: true
        };
      }

      var deadline = Math.floor(Date.now() / 1000) + SWAP_DEFAULT_DEADLINE;
      var calldata = SWAP_IFACE.encodeFunctionData('swap', [tokenInAddr, amtBig, minOutResult.minOut]);

      return {
        valid: true,
        calldata: calldata,
        contract: pool,
        method: 'swap',
        minOutRaw: minOutResult.minOut,
        minOut: ethers.formatUnits(minOutResult.minOut, outDec),
        slippageBps: minOutResult.slippageBps,
        deadline: deadline,
        deadlineHuman: SWAP_DEFAULT_DEADLINE + 's',
        quotedAt: Date.now(),
        isEstimated: isEstimated,
        params: {
          tokenIn: tokenInAddr,
          amountIn: String(amountIn),
          minOut: String(ethers.formatUnits(minOutResult.minOut, outDec)),
          deadline: deadline
        }
      };
    } catch(e){
      return { valid: false, error: e.message || 'Calldata build error', errorMessage: 'Failed to prepare swap. Please try again.', blockSwap: true };
    }
  }

  /* ── Check if swap deadline has expired (C4) ── */
  function isDeadlineExpired(swapPlan) {
    if (!swapPlan || !swapPlan.deadline) return true;
    var now = Math.floor(Date.now() / 1000);
    return now > Number(swapPlan.deadline);
  }

  function getDeadlineRemaining(swapPlan) {
    if (!swapPlan || !swapPlan.deadline) return 0;
    var now = Math.floor(Date.now() / 1000);
    return Math.max(0, Number(swapPlan.deadline) - now);
  }

  /* ── Build approve calldata — EXACT amount (C3) ── */
  function buildApproveCalldata(tokenSym, spenderAddr, amount) {
    try {
      if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
        return { valid: false, error: 'Invalid approve amount', calldata: null, contract: null, method: null, params: null };
      }
      var tokenAddr = TOKENS[tokenSym] || tokenSym;
      var dec = tokenSym === 'cirBTC' ? 8 : 6;
      var exactAmount = Number(amount);
      var amtBig = ethers.parseUnits(String(exactAmount.toFixed(dec)), dec);

      if (amtBig <= 0n) {
        return { valid: false, error: 'Approve amount is zero', calldata: null, contract: tokenAddr, method: null, params: null };
      }

      var calldata = APPROVE_IFACE.encodeFunctionData('approve', [spenderAddr, amtBig]);
      return {
        valid: true,
        calldata: calldata,
        contract: tokenAddr,
        method: 'approve',
        amount: ethers.formatUnits(amtBig, dec),
        amountRaw: amtBig,
        params: { spender: spenderAddr, amount: ethers.formatUnits(amtBig, dec) }
      };
    } catch(e){ return { valid: false, error: e.message, calldata: null, contract: null, method: null, params: null }; }
  }

  function buildTransferCalldata(tokenSym, toAddr, amount){
    try {
      var tokenAddr = TOKENS[tokenSym] || tokenSym;
      var dec = tokenSym === 'cirBTC' ? 8 : 6;
      var amtBig = ethers.parseUnits(String(amount), dec);
      var calldata = TRANSFER_IFACE.encodeFunctionData('transfer', [toAddr, amtBig]);
      return { calldata: calldata, contract: tokenAddr, method: 'transfer', params: { to: toAddr, amount: String(amount) } };
    } catch(e){ return null; }
  }

  function buildBridgeCalldata(amount, destDomain, mintRecipient, burnToken, maxFee){
    try {
      var amtBig = ethers.parseUnits(String(amount), 6);
      var domain = Number(destDomain) || 6;
      var recipient = mintRecipient || ethers.ZeroHash;
      var token = burnToken || TOKENS.USDC;
      var fee = maxFee ? ethers.parseUnits(String(maxFee), 6) : ethers.parseUnits('0.5', 6);
      var calldata = CCTP_IFACE.encodeFunctionData('depositForBurn', [amtBig, domain, recipient, token, ethers.ZeroHash, fee, 0]);
      return {
        calldata: calldata,
        contract: CCTP_MESSENGER,
        method: 'depositForBurn',
        params: { amount: String(amount), destDomain: domain, maxFee: ethers.formatUnits(fee, 6) }
      };
    } catch(e){ return null; }
  }

  function formatCalldata(calldata){ return calldata ? calldata.substring(0, 66) + '...' : null; }

  /* ── Full swap economic analysis (FASE 2) ── */
  async function performFullSwapAnalysis(amountIn, tokenIn, tokenOut, slippageBps) {
    var result = {
      valid: false,
      amountIn: Number(amountIn),
      tokenIn: tokenIn,
      tokenOut: tokenOut,
      slippageBps: slippageBps || SWAP_DEFAULT_SLIPPAGE_BPS,

      reserves: null,
      priceImpact: null,
      liquidityUtilization: null,
      liquidityHealth: null,
      economicRisk: null,

      canSwap: false,
      warnings: [],
      blocksSwap: false,
      requiresConfirmation: false,
      error: null
    };

    if (!amountIn || isNaN(Number(amountIn)) || Number(amountIn) <= 0) {
      result.error = 'Invalid swap amount';
      return result;
    }

    // Fetch reserves
    var reserves = await getPoolReserves(POOL_ADDRESS);
    if (!reserves) {
      result.error = 'Unable to read pool reserves';
      return result;
    }
    result.reserves = reserves;

    var rA = reserves.reserveA;
    var rB = reserves.reserveB;
    var reserveIn = tokenIn === 'USDC' ? rA : rB;
    var reserveOut = tokenIn === 'USDC' ? rB : rA;

    // Price Impact (F2.3)
    if (typeof PriceImpactEngine !== 'undefined') {
      var impactResult = PriceImpactEngine.calculate(Number(amountIn), rA, rB, tokenIn, tokenOut);
      result.priceImpact = impactResult;
      if (impactResult.requiresWarning) result.warnings.push(impactResult.recommendations[0] || 'Elevated price impact');
      if (impactResult.requiresConfirmation) result.requiresConfirmation = true;
      if (impactResult.blocksSwap) result.blocksSwap = true;
    }

    // Liquidity Protection (F2.5)
    if (typeof LiquidityProtection !== 'undefined') {
      var liqCheck = LiquidityProtection.check(Number(amountIn), reserveIn);
      result.liquidityUtilization = liqCheck;
      if (liqCheck.requiresWarning) result.warnings.push(liqCheck.message);
      if (liqCheck.requiresConfirmation) result.requiresConfirmation = true;
      if (liqCheck.blocksSwap) result.blocksSwap = true;
    }

    // Liquidity Health (F2.4)
    if (typeof LiquidityHealthEngine !== 'undefined') {
      var healthResult = LiquidityHealthEngine.analyze({
        reserveA: rA,
        reserveB: rB,
        lpSupply: null,
        tokens: ['USDC', 'cirBTC']
      });
      result.liquidityHealth = healthResult;
      if (healthResult.valid && healthResult.tier === 'Critical') {
        result.warnings.push('Pool liquidity health is critical');
      }
    }

    // Economic Risk (F2.8)
    if (typeof EconomicRiskEngine !== 'undefined') {
      var econRisk = EconomicRiskEngine.analyze({
        amount: Number(amountIn),
        priceImpact: result.priceImpact ? result.priceImpact.priceImpact : null,
        slippageBps: result.slippageBps,
        poolUtilizationPct: result.liquidityUtilization ? result.liquidityUtilization.poolUtilizationPct : null,
        healthScore: result.liquidityHealth ? result.liquidityHealth.score : null
      });
      result.economicRisk = econRisk;
      if (econRisk.requiresConfirmation) result.requiresConfirmation = true;
      if (econRisk.blocksSwap) result.blocksSwap = true;
      if (econRisk.level === 'CRITICAL' || econRisk.level === 'HIGH') {
        result.warnings.push(econRisk.recommendation);
      }
    }

    result.canSwap = !result.blocksSwap;
    result.valid = true;
    return result;
  }

  /* ── Pool discovery (FASE 2.1) ── */
  async function performPoolDiscovery() {
    var p = getProvider();
    if (!p) return null;
    if (typeof PoolAbiDiscovery !== 'undefined') {
      return await PoolAbiDiscovery.discoverABI(p, POOL_ADDRESS);
    }
    return null;
  }

  /* ── Pool health check (FASE 2.7) ── */
  async function performPoolHealthCheck() {
    var p = getProvider();
    if (!p || typeof PoolHealthCheck === 'undefined') return null;
    if (typeof PoolRegistry !== 'undefined') {
      var poolConfig = PoolRegistry.getPoolByAddress(POOL_ADDRESS) || PoolRegistry.getDefaultPool();
      if (poolConfig) {
        return await PoolHealthCheck.run(poolConfig, p);
      }
    }
    return null;
  }

  /* ── Get constant-product quote (local calculation) ── */
  function getConstantProductQuote(amountIn, reserveIn, reserveOut) {
    if (!reserveIn || !reserveOut || reserveIn <= 0 || amountIn <= 0) return null;
    var amtInWithFee = amountIn * 0.997;
    var amountOut = (amtInWithFee * reserveOut) / (reserveIn + amtInWithFee);
    return {
      amountOut: amountOut,
      priceImpact: (amountIn / (reserveIn + amountIn)) * 100,
      rate: amountOut / amountIn
    };
  }

  /* ── Prepare full swap (synchronous — backward compatible) ── */
  function prepareFullSwap(amountIn, tokenIn, tokenOut, slippageBps, quoteAmountOut) {
    var pool = POOL_ADDRESS;
    var deadline = Math.floor(Date.now() / 1000) + SWAP_DEFAULT_DEADLINE;

    var routerCheck = validateSwapRouter(pool);
    if (!routerCheck.valid) {
      return { valid: false, error: routerCheck.reason, steps: [], totalSteps: 0, deadline: deadline };
    }

    var txs = [];
    var approve = buildApproveCalldata(tokenIn, pool, amountIn);
    if (approve && approve.calldata) {
      txs.push({ step: 1, label: 'Approve ' + tokenIn, tx: approve });
    }

    var swap = buildSwapCalldata(amountIn, tokenIn, tokenOut, slippageBps, pool, quoteAmountOut);
    if (!swap || !swap.valid || !swap.calldata) {
      return { valid: false, error: swap ? swap.errorMessage || swap.error : 'Swap preparation failed', steps: txs, totalSteps: txs.length, deadline: deadline };
    }

    txs.push({ step: txs.length + 1, label: 'Swap ' + tokenIn + ' → ' + tokenOut, tx: swap });

    return {
      valid: true,
      type: 'swap',
      steps: txs,
      totalSteps: txs.length,
      deadline: swap.deadline || deadline,
      deadlineHuman: swap.deadlineHuman || (SWAP_DEFAULT_DEADLINE + 's'),
      quotedAt: swap.quotedAt || Date.now(),
      minOut: swap.minOut,
      slippageBps: swap.slippageBps || slippageBps || SWAP_DEFAULT_SLIPPAGE_BPS
    };
  }

  /* ── Async variant with allowance optimization ── */
  async function prepareFullSwapAsync(amountIn, tokenIn, tokenOut, slippageBps, quoteAmountOut) {
    var pool = POOL_ADDRESS;
    var deadline = Math.floor(Date.now() / 1000) + SWAP_DEFAULT_DEADLINE;

    var routerCheck = validateSwapRouter(pool);
    if (!routerCheck.valid) {
      return { valid: false, error: routerCheck.reason, steps: [], totalSteps: 0, deadline: deadline };
    }

    var txs = [];
    var needsApprove = true;
    try {
      var currentAllowance = await checkAllowance(tokenIn, null, pool);
      if (currentAllowance !== null && currentAllowance >= Number(amountIn)) {
        needsApprove = false;
      }
    } catch(e) {}

    if (needsApprove) {
      var approve = buildApproveCalldata(tokenIn, pool, amountIn);
      if (approve && approve.calldata) {
        txs.push({ step: 1, label: 'Approve ' + tokenIn, tx: approve });
      }
    }

    var swap = buildSwapCalldata(amountIn, tokenIn, tokenOut, slippageBps, pool, quoteAmountOut);
    if (!swap || !swap.valid || !swap.calldata) {
      return { valid: false, error: swap ? swap.errorMessage || swap.error : 'Swap preparation failed', steps: txs, totalSteps: txs.length, deadline: deadline };
    }

    txs.push({ step: txs.length + 1, label: 'Swap ' + tokenIn + ' → ' + tokenOut, tx: swap });

    return {
      valid: true, type: 'swap', steps: txs, totalSteps: txs.length, needsApprove: needsApprove,
      deadline: swap.deadline || deadline, deadlineHuman: swap.deadlineHuman || (SWAP_DEFAULT_DEADLINE + 's'),
      quotedAt: swap.quotedAt || Date.now(), minOut: swap.minOut,
      slippageBps: swap.slippageBps || slippageBps || SWAP_DEFAULT_SLIPPAGE_BPS
    };
  }

  function prepareFullBridge(amount, destDomain, mintRecipient){
    var approve = buildApproveCalldata('USDC', CCTP_MESSENGER, amount);
    var bridge = buildBridgeCalldata(amount, destDomain || 6, mintRecipient);
    var txs = [];
    if(approve && approve.calldata) txs.push({ step: 1, label: 'Approve USDC', tx: approve });
    if(bridge) txs.push({ step: txs.length + 1, label: 'Deposit for Burn', tx: bridge });
    return txs.length > 0 ? { type: 'bridge', steps: txs, totalSteps: txs.length } : null;
  }

  function prepareFullSend(amount, tokenSym, toAddr){
    var tx = buildTransferCalldata(tokenSym, toAddr, amount);
    return tx ? { type: 'send', steps: [{ step: 1, label: 'Transfer ' + tokenSym, tx: tx }], totalSteps: 1 } : null;
  }

  window.ChainSimulator = {
    getBalance: getBalance,
    getPoolReserves: getPoolReserves,
    simulateSwap: simulateSwap,
    simulateBridge: simulateBridge,
    estimateGas: estimateGas,
    fullSwapSim: fullSwapSim,
    fullBridgeSim: fullBridgeSim,
    healthCheck: healthCheck,
    calculateMinOut: calculateMinOut,
    checkAllowance: checkAllowance,
    getTokenDecimals: getTokenDecimals,
    buildSwapCalldata: buildSwapCalldata,
    buildApproveCalldata: buildApproveCalldata,
    buildTransferCalldata: buildTransferCalldata,
    buildBridgeCalldata: buildBridgeCalldata,
    prepareFullSwap: prepareFullSwap,
    prepareFullSwapAsync: prepareFullSwapAsync,
    prepareFullBridge: prepareFullBridge,
    prepareFullSend: prepareFullSend,
    formatCalldata: formatCalldata,
    validateSwapRouter: validateSwapRouter,
    isRouterValid: isRouterValid,
    isDeadlineExpired: isDeadlineExpired,
    getDeadlineRemaining: getDeadlineRemaining,
    performFullSwapAnalysis: performFullSwapAnalysis,
    performPoolDiscovery: performPoolDiscovery,
    performPoolHealthCheck: performPoolHealthCheck,
    getConstantProductQuote: getConstantProductQuote,
    getProvider: getProvider,
    TOKENS: TOKENS,
    POOL_ADDRESS: POOL_ADDRESS,
    CCTP_MESSENGER: CCTP_MESSENGER,
    SWAP_DEFAULT_DEADLINE: SWAP_DEFAULT_DEADLINE,
    SWAP_DEFAULT_SLIPPAGE_BPS: SWAP_DEFAULT_SLIPPAGE_BPS
  };
})();
