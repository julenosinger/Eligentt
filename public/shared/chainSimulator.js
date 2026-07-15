/**
 * Elligentt Chain Simulator — Real on-chain simulation
 * Uses ethers.js staticCall/view to get real data from deployed contracts.
 * Non-blocking: falls back silently if provider/contract unavailable.
 * Attached to window.ChainSimulator
 */
(function(){
  'use strict';

  var ARC_RPC = 'https://arc-testnet.drpc.org';
  var readProvider = null;

  function getProvider(){
    if(readProvider) return readProvider;
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
      var tokenDec = tokenIn === 'cirBTC' ? 8 : 6;
      var amtBig = ethers.parseUnits(String(amountIn), tokenDec);
      var out = await c.getAmountOut(amtBig, tokenInAddr);
      var outDec = tokenOut === 'cirBTC' ? 8 : 6;
      var amtOut = parseFloat(ethers.formatUnits(out, outDec));

      // Get reserves for slippage calc
      var res = await c.getReserves();
      var tA = await c.tokenA();
      var resA = parseFloat(ethers.formatUnits(res.reserveA, 6));
      var resB = parseFloat(ethers.formatUnits(res.reserveB, 6));
      var reserveIn = tA.toLowerCase() === tokenInAddr.toLowerCase() ? resA : resB;
      var spotRate = reserveIn > 0 ? (resA * resB) / (reserveIn * reserveIn) : 1;
      var priceImpact = reserveIn > 0 ? Math.abs((amountIn / reserveIn) * 100) : 0;

      return {
        amountOut: amtOut,
        priceImpact: priceImpact.toFixed(3),
        rate: amtOut > 0 ? (amtOut / amountIn).toFixed(6) : null,
        reserveIn: reserveIn,
        source: 'on-chain staticCall'
      };
    } catch(e){ return null; }
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
      var feeRate = 0.0005; // 0.05% standard
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

  function buildSwapCalldata(amountIn, tokenIn, tokenOut, slippagePct, poolAddr, hopMin){
    try {
      var tokenInAddr = TOKENS[tokenIn] || tokenIn;
      var minOut = 0;
      if(hopMin) minOut = hopMin;
      else if(amountIn > 0 && slippagePct !== undefined){
        // Estimate minOut from rate if available
        var rate = tokenIn === 'USDC' ? 1.0 : null;
        if(!rate) minOut = 0;
      }
      var amountInDec = tokenIn === 'cirBTC' ? 8 : 6;
      var amtBig = ethers.parseUnits(String(amountIn), amountInDec);
      var calldata = SWAP_IFACE.encodeFunctionData('swap', [tokenInAddr, amtBig, minOut || 0n]);
      return {
        calldata: calldata,
        contract: poolAddr || POOL_ADDRESS,
        method: 'swap',
        params: { tokenIn: tokenInAddr, amountIn: String(amountIn), minOut: String(minOut || 0) }
      };
    } catch(e){ return null; }
  }

  function buildApproveCalldata(tokenSym, spenderAddr, amount){
    try {
      var tokenAddr = TOKENS[tokenSym] || tokenSym;
      var dec = tokenSym === 'cirBTC' ? 8 : 6;
      var amtBig = ethers.parseUnits(String(amount * 2), dec); // approve double for safety
      var calldata = APPROVE_IFACE.encodeFunctionData('approve', [spenderAddr, amtBig]);
      return { calldata: calldata, contract: tokenAddr, method: 'approve', params: { spender: spenderAddr, amount: ethers.formatUnits(amtBig, dec) } };
    } catch(e){ return null; }
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

  function prepareFullSwap(amountIn, tokenIn, tokenOut, slippagePct){
    var approve = buildApproveCalldata(tokenIn, POOL_ADDRESS, amountIn);
    var swap = buildSwapCalldata(amountIn, tokenIn, tokenOut, slippagePct, POOL_ADDRESS);
    var txs = [];
    if(approve) txs.push({ step: 1, label: 'Approve ' + tokenIn, tx: approve });
    if(swap) txs.push({ step: txs.length + 1, label: 'Swap ' + tokenIn + ' → ' + tokenOut, tx: swap });
    return txs.length > 0 ? { type: 'swap', steps: txs, totalSteps: txs.length } : null;
  }

  function prepareFullBridge(amount, destDomain, mintRecipient){
    var approve = buildApproveCalldata('USDC', CCTP_MESSENGER, amount);
    var bridge = buildBridgeCalldata(amount, destDomain || 6, mintRecipient);
    var txs = [];
    if(approve) txs.push({ step: 1, label: 'Approve USDC', tx: approve });
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
    buildSwapCalldata: buildSwapCalldata,
    buildApproveCalldata: buildApproveCalldata,
    buildTransferCalldata: buildTransferCalldata,
    buildBridgeCalldata: buildBridgeCalldata,
    prepareFullSwap: prepareFullSwap,
    prepareFullBridge: prepareFullBridge,
    prepareFullSend: prepareFullSend,
    formatCalldata: formatCalldata,
    getProvider: getProvider,
    TOKENS: TOKENS,
    POOL_ADDRESS: POOL_ADDRESS,
    CCTP_MESSENGER: CCTP_MESSENGER
  };
})();

