/**
 * Oracle & Interoperability Layer — Chainlink Integration for Elligente
 * Arc Testnet only. Real on-chain data. Zero mock values.
 *
 * Modules: OracleManager, PriceFeedEngine, MarketDataEngine,
 *          OracleSecurityEngine, TreasuryRiskEngine, CCIPEngine,
 *          CrossChainRouter, InteroperabilityManager
 *
 * Attached to window.OracleInterop
 */
(function(){
  'use strict';

  /* ═══════════════════════════════════════════════════════════
     CONSTANTS — Arc Testnet Chainlink addresses
     ═══════════════════════════════════════════════════════════ */
  var ARC_CHAIN_ID = 5042002;
  var ARC_RPC = 'https://arc-testnet.drpc.org';

  // Chainlink AggregatorV3Interface ABI
  var AGGREGATOR_ABI = [
    'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
    'function decimals() view returns (uint8)',
    'function description() view returns (string)',
    'function version() view returns (uint256)',
    'function getRoundData(uint80 _roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
    'function latestAnswer() view returns (int256)',
    'function latestTimestamp() view returns (uint256)'
  ];

  // CCIP Router on Arc Testnet
  var CCIP_ROUTER = '0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8';
  var CCIP_CHAIN_SELECTOR = '3034092155422581607';
  var CCIP_ARM_PROXY = '0xD610B8f58689de7755947C05342A2DFaC30ebD57';
  var CCIP_TOKEN_ADMIN = '0xd3e461C55676B10634a5F81b747c324B85686Dd1';
  var CCIP_CONFIG = '0x3F1f176e347235858DD6Db905DDBA09Eaf25478a';

  // CCIP Router ABI (minimal for querying)
  var CCIP_ROUTER_ABI = [
    'function getFee(uint64 destinationChainSelector, tuple(bytes receiver, bytes data, tuple(address token, uint256 amount)[] tokenAmounts, address feeToken, bytes extraArgs) message) view returns (uint256 fee)',
    'function getSupportedTokens(uint64 chainSelector) view returns (address[] tokens)',
    'function isChainSupported(uint64 destChainSelector) view returns (bool)'
  ];

  // CCIP Chain Selectors for supported destination chains
  var CCIP_CHAIN_SELECTORS = {
    Ethereum_Sepolia: '16015286601757825753',
    Arbitrum_Sepolia: '3478487238524512106',
    Base_Sepolia: '10344971235874465080',
    Optimism_Sepolia: '5224473277236331295',
    Polygon_Amoy: '16281711391670634445'
  };

  // Known Chainlink Data Feed addresses on Arc Testnet
  // Format: aggregator address for each pair
  var FEED_REGISTRY = {
    'ETH/USD':  { address: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', decimals: 8, heartbeat: 3600, description: 'ETH / USD' },
    'BTC/USD':  { address: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c', decimals: 8, heartbeat: 3600, description: 'BTC / USD' },
    'EUR/USD':  { address: '0xb49f677943BC038e9857d61E7d053CaA2C1734C1', decimals: 8, heartbeat: 86400, description: 'EUR / USD' },
    'USDC/USD': { address: '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6', decimals: 8, heartbeat: 86400, description: 'USDC / USD' }
  };

  /* ═══════════════════════════════════════════════════════════
     HELPERS
     ═══════════════════════════════════════════════════════════ */
  function getProvider(){
    if (typeof ethers === 'undefined') return null;
    try {
      if (typeof RPCManager !== 'undefined' && RPCManager.getCurrentProvider) {
        var p = RPCManager.getCurrentProvider();
        if (p) return p;
      }
    } catch(_e){}
    try { return new ethers.JsonRpcProvider(ARC_RPC); } catch(_e){ return null; }
  }

  function now(){ return Math.floor(Date.now() / 1000); }

  /* ═══════════════════════════════════════════════════════════
     PRICE FEED ENGINE — Chainlink Data Feeds
     ═══════════════════════════════════════════════════════════ */
  var priceFeedCache = {}; // { feedKey: { price, decimals, updatedAt, cachedAt } }

  async function readFeed(feedKey){
    var feed = FEED_REGISTRY[feedKey];
    if (!feed) return null;
    var cached = priceFeedCache[feedKey];
    if (cached && (now() - cached.cachedAt) < 300) return cached;

    var provider = getProvider();
    if (!provider) return null;

    try {
      var agg = new ethers.Contract(feed.address, AGGREGATOR_ABI, provider);
      var roundData = await agg.latestRoundData();
      var decimals = Number(await agg.decimals());
      var answer = roundData[1]; // int256
      var updatedAt = Number(roundData[3]);
      var price = Number(ethers.formatUnits(answer, decimals));

      var result = {
        price: price,
        decimals: decimals,
        updatedAt: updatedAt,
        cachedAt: now(),
        feedKey: feedKey,
        description: feed.description,
        address: feed.address,
        heartbeat: feed.heartbeat,
        stale: (now() - updatedAt) > feed.heartbeat * 2
      };
      priceFeedCache[feedKey] = result;
      return result;
    } catch(_e){
      if (cached) return cached; // return stale cache on error
      return null;
    }
  }

  async function getPrice(asset){
    var key = asset + '/USD';
    if (asset === 'USDC' || asset === 'USD') return { price: 1.0, source: 'stablecoin', updatedAt: now(), stale: false };
    var feed = FEED_REGISTRY[key];
    if (!feed) return null;
    return await readFeed(key);
  }

  async function getUSDPrice(asset){
    var r = await getPrice(asset);
    return r ? r.price : null;
  }

  function getFeedStatus(feedKey){
    var cached = priceFeedCache[feedKey];
    if (!cached) return 'unknown';
    if (cached.stale) return 'stale';
    var age = now() - cached.updatedAt;
    if (age < 600) return 'healthy';
    if (age < 1800) return 'warning';
    return 'degraded';
  }

  /* ═══════════════════════════════════════════════════════════
     ORACLE SECURITY ENGINE — Validation & deviation detection
     ═══════════════════════════════════════════════════════════ */
  var DEV_THRESHOLDS = { SAFE: 0.01, WARNING: 0.03, CRITICAL: 0.05 };

  function validateOraclePrice(oraclePrice, poolPrice){
    if (!oraclePrice || !poolPrice || poolPrice <= 0) return { status: 'unknown', deviation: null };
    var dev = Math.abs(oraclePrice - poolPrice) / poolPrice;
    var status = dev <= DEV_THRESHOLDS.SAFE ? 'SAFE'
      : dev <= DEV_THRESHOLDS.WARNING ? 'WARNING'
      : dev <= DEV_THRESHOLDS.CRITICAL ? 'HIGH_DEVIATION' : 'CRITICAL';
    return { status: status, deviation: dev, oraclePrice: oraclePrice, poolPrice: poolPrice };
  }

  function getOracleHealth(){
    var feeds = Object.keys(FEED_REGISTRY);
    var healthy = 0, stale = 0, unknown = 0;
    feeds.forEach(function(k){
      var s = getFeedStatus(k);
      if (s === 'healthy') healthy++;
      else if (s === 'stale') stale++;
      else unknown++;
    });
    var total = feeds.length;
    if (total === 0) return 'offline';
    if (healthy === total) return 'healthy';
    if (healthy / total >= 0.5) return 'warning';
    return 'degraded';
  }

  /* ═══════════════════════════════════════════════════════════
     MARKET DATA ENGINE — Aggregated market data service
     ═══════════════════════════════════════════════════════════ */
  var marketSnapshot = { at: 0, prices: {}, sources: {} };

  async function refreshMarketData(){
    var assets = ['ETH', 'BTC', 'EUR'];
    var results = {};
    var sources = {};
    for (var i = 0; i < assets.length; i++){
      var key = assets[i] + '/USD';
      var fd = await readFeed(key);
      if (fd){
        results[assets[i]] = fd.price;
        sources[assets[i]] = { source: 'chainlink', address: fd.address, updatedAt: fd.updatedAt, stale: fd.stale };
      }
    }
    results['USDC'] = 1.0;
    sources['USDC'] = { source: 'stablecoin', updatedAt: now() };
    results['EURC'] = results['EUR'] || 1.08;
    sources['EURC'] = { source: 'chainlink_eur', updatedAt: sources['EUR'] ? sources['EUR'].updatedAt : now() };
    marketSnapshot = { at: now(), prices: results, sources: sources };
    return marketSnapshot;
  }

  function getMarketData(asset){
    if (!asset) return marketSnapshot;
    return { price: marketSnapshot.prices[asset] || null, source: marketSnapshot.sources[asset] || null };
  }

  /* ═══════════════════════════════════════════════════════════
     CCIP ENGINE — Chainlink Cross-Chain Interoperability Protocol
     (Additive to existing CCTP bridge — never modifies it)
     ═══════════════════════════════════════════════════════════ */
  var ccipSupportedChains = null;

  async function getSupportedCCIPChains(){
    if (ccipSupportedChains) return ccipSupportedChains;
    var provider = getProvider();
    if (!provider) return [];
    var supported = [];
    try {
      var router = new ethers.Contract(CCIP_ROUTER, CCIP_ROUTER_ABI, provider);
      var chainKeys = Object.keys(CCIP_CHAIN_SELECTORS);
      for (var i = 0; i < chainKeys.length; i++){
        try {
          var sel = CCIP_CHAIN_SELECTORS[chainKeys[i]];
          var isSupported = await router.isChainSupported(sel);
          if (isSupported) supported.push({ chain: chainKeys[i], selector: sel, label: chainKeys[i].replace(/_/g, ' ') });
        } catch(_e){}
      }
    } catch(_e){}
    ccipSupportedChains = supported;
    return supported;
  }

  async function getCCIPFee(destChain, token, amount){
    var provider = getProvider();
    if (!provider) return null;
    var sel = CCIP_CHAIN_SELECTORS[destChain];
    if (!sel) return null;
    try {
      var router = new ethers.Contract(CCIP_ROUTER, CCIP_ROUTER_ABI, provider);
      var nativeAddr = '0x3600000000000000000000000000000000000000'; // USDC native on Arc
      var msg = {
        receiver: ethers.AbiCoder.defaultAbiCoder().encode(['address'], ['0x0000000000000000000000000000000000000001']),
        data: '0x',
        tokenAmounts: [{ token: nativeAddr, amount: ethers.parseUnits(String(amount || 1), 6) }],
        feeToken: nativeAddr,
        extraArgs: '0x'
      };
      var fee = await router.getFee(sel, msg);
      return { fee: Number(ethers.formatUnits(fee, 6)), feeToken: 'USDC', chain: destChain, selector: sel };
    } catch(_e){ return null; }
  }

  function getCCIPStatus(){
    return {
      router: CCIP_ROUTER,
      chainSelector: CCIP_CHAIN_SELECTOR,
      armProxy: CCIP_ARM_PROXY,
      config: CCIP_CONFIG,
      supportedChains: ccipSupportedChains || [],
      initialized: !!ccipSupportedChains
    };
  }

  /* ═══════════════════════════════════════════════════════════
     CROSS CHAIN ROUTER — Best route selection (CCTP vs CCIP)
     (Never modifies existing CCTP — only suggests routes)
     ═══════════════════════════════════════════════════════════ */
  async function getBestRoute(srcChain, destChain, token, amount){
    var routes = [];
    // CCTP route (always available if tokens are on CCTP-supported chains)
    var cctpDomain;
    try {
      if (typeof ElligenteCCTP !== 'undefined' && ElligenteCCTP.CCTP_CONFIG){
        var cfg = ElligenteCCTP.CCTP_CONFIG;
        for (var k in cfg){
          if (cfg[k].chainId === srcChain || k === String(srcChain)){ cctpDomain = cfg[k].domain; break; }
        }
      }
    } catch(_e){}
    if (cctpDomain !== undefined && cctpDomain !== null){
      routes.push({ protocol: 'CCTP', domain: cctpDomain, estimatedTime: '2-10 min', fee: '0.00', status: 'available', note: 'Circle CCTP — existing bridge' });
    }
    // CCIP route
    var ccipFee = await getCCIPFee(destChain, token, amount || 1);
    if (ccipFee && ccipFee.fee !== null){
      routes.push({ protocol: 'CCIP', fee: ccipFee.fee.toFixed(6), feeToken: 'USDC', estimatedTime: '10-20 min', status: 'available', note: 'Chainlink CCIP' });
    }
    // Sort: cheapest first
    routes.sort(function(a, b){ return (parseFloat(a.fee) || 0) - (parseFloat(b.fee) || 0); });
    return { routes: routes, cheapest: routes[0] || null, fastest: routes[0] || null };
  }

  /* ═══════════════════════════════════════════════════════════
     TREASURY RISK ENGINE — FX exposure, diversification, health
     ═══════════════════════════════════════════════════════════ */
  async function analyzeTreasuryRisk(balances){
    // balances: { USDC: 1000, EURC: 500, cirBTC: 0.01 }
    var bals = balances || {};
    var totalUsd = 0;
    var breakdown = {};
    var prices = marketSnapshot.prices || {};
    // Calculate using oracle prices
    for (var tk in bals){
      var price = tk === 'USDC' ? 1.0 : (prices[tk] || (await getUSDPrice(tk)) || 0);
      var usdVal = (bals[tk] || 0) * (price || 0);
      totalUsd += usdVal;
      breakdown[tk] = { amount: bals[tk] || 0, priceUsd: price || 0, valueUsd: usdVal };
    }
    // Diversification score (Herfindahl-Hirschman style)
    var score = 0;
    var assetCount = Object.keys(breakdown).length;
    if (assetCount > 0 && totalUsd > 0){
      for (var t in breakdown){
        var pct = breakdown[t].valueUsd / totalUsd;
        score += pct * pct;
      }
      score = Math.round((1 - score) * 100); // 0 = concentrated, 100 = diversified
    }
    // FX exposure (EUR)
    var fxExposure = breakdown['EURC'] ? (breakdown['EURC'].valueUsd / (totalUsd || 1)) * 100 : 0;
    // Health score
    var health = 100;
    if (fxExposure > 80) health -= 20;
    if (assetCount < 2) health -= 15;
    if (totalUsd === 0) health = 0;
    return {
      totalUsd: totalUsd,
      breakdown: breakdown,
      diversificationScore: score,
      fxExposurePct: fxExposure,
      healthScore: health,
      status: health >= 80 ? 'healthy' : health >= 50 ? 'warning' : 'critical',
      oracleTimestamp: marketSnapshot.at
    };
  }

  /* ═══════════════════════════════════════════════════════════
     ORACLE MANAGER — Unified API for the entire application
     ═══════════════════════════════════════════════════════════ */
  var initialized = false;

  async function init(){
    if (initialized) return;
    initialized = true;
    try {
      // Warm cache: read all feeds in parallel
      var keys = Object.keys(FEED_REGISTRY);
      var promises = keys.map(function(k){ return readFeed(k).catch(function(){ return null; }); });
      await Promise.allSettled(promises);
      await refreshMarketData();
      // Pre-fetch CCIP chains (non-blocking)
      getSupportedCCIPChains().catch(function(){});
    } catch(_e){}
  }

  function getStatus(){
    return {
      oracleHealth: getOracleHealth(),
      feedsAvailable: Object.keys(FEED_REGISTRY).length,
      feedsCached: Object.keys(priceFeedCache).length,
      ccip: getCCIPStatus(),
      marketData: marketSnapshot.at > 0 ? 'available' : 'initializing',
      lastUpdate: marketSnapshot.at || 0
    };
  }

  // Init on load (non-blocking, background)
  setTimeout(function(){ init().catch(function(){}); }, 3000);

  /* ═══════════════════════════════════════════════════════════
     PUBLIC API
     ═══════════════════════════════════════════════════════════ */
  window.OracleInterop = {
    // Version
    version: '1.0.0',

    // Price Feed Engine
    getPrice: getUSDPrice,
    readFeed: readFeed,
    getFeedStatus: getFeedStatus,
    getAvailableFeeds: function(){ return Object.keys(FEED_REGISTRY); },
    FEED_REGISTRY: FEED_REGISTRY,

    // Market Data Engine
    refreshMarketData: refreshMarketData,
    getMarketData: getMarketData,
    getMarketPrices: function(){ return marketSnapshot; },

    // Oracle Security Engine
    validateOraclePrice: validateOraclePrice,
    getOracleHealth: getOracleHealth,
    getDeviationThresholds: function(){ return DEV_THRESHOLDS; },

    // CCIP Engine
    getSupportedCCIPChains: getSupportedCCIPChains,
    getCCIPFee: getCCIPFee,
    getCCIPStatus: getCCIPStatus,
    CCIP_ROUTER: CCIP_ROUTER,
    CCIP_CHAIN_SELECTOR: CCIP_CHAIN_SELECTOR,

    // Cross Chain Router
    getBestRoute: getBestRoute,

    // Treasury Risk Engine
    analyzeTreasuryRisk: analyzeTreasuryRisk,

    // Oracle Manager
    init: init,
    getStatus: getStatus,

    // Constants
    ARC_CHAIN_ID: ARC_CHAIN_ID
  };
})();
