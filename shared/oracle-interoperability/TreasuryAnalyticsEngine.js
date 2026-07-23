/**
 * TreasuryAnalyticsEngine — Advanced treasury analytics
 * Read-only. Never modifies balances or executes transactions.
 */
(function(){
  'use strict';

  function _getBalances(){
    var bals = {};
    try {
      // Agent Treasury
      if (typeof AgentTreasury !== 'undefined' && AgentTreasury.getBalances){
        var at = AgentTreasury.getBalances();
        if (at){ Object.keys(at).forEach(function(k){ bals[k] = (bals[k] || 0) + (at[k] || 0); }); }
      }
      // AI Wallet operational
      if (typeof AIWallet !== 'undefined' && AIWallet._vaultView){
        var vvUSDC = AIWallet._vaultView('USDC');
        if (vvUSDC && vvUSDC.real !== null) bals['USDC'] = (bals['USDC'] || 0) + (vvUSDC.real || 0);
        var vvEURC = AIWallet._vaultView('EURC');
        if (vvEURC && vvEURC.real !== null) bals['EURC'] = (bals['EURC'] || 0) + (vvEURC.real || 0);
      }
    } catch(_e){}
    return bals;
  }

  function _getPrices(){
    var prices = {};
    try {
      if (typeof OracleInterop !== 'undefined' && OracleInterop.getMarketPrices){
        var snap = OracleInterop.getMarketPrices();
        if (snap && snap.prices){ prices = snap.prices; }
      }
    } catch(_e){}
    if (!prices['USDC']) prices['USDC'] = 1.0;
    if (!prices['EURC']){ try { var r = typeof getTokenUSDRate === 'function' ? getTokenUSDRate('EURC') : null; prices['EURC'] = r || 1.08; } catch(_e){ prices['EURC'] = 1.08; } }
    if (!prices['cirBTC']){ try { var r2 = typeof getTokenUSDRate === 'function' ? getTokenUSDRate('cirBTC') : null; prices['cirBTC'] = r2 || 67000; } catch(_e){ prices['cirBTC'] = 67000; } }
    return prices;
  }

  function getDiversificationScore(){
    var bals = _getBalances();
    var prices = _getPrices();
    var totalUsd = 0, values = {};
    Object.keys(bals).forEach(function(tk){
      var usd = (bals[tk] || 0) * (prices[tk] || 0);
      totalUsd += usd;
      values[tk] = usd;
    });
    if (totalUsd <= 0) return { score: 0, assets: 0, breakdown: {} };
    var hhi = 0;
    Object.keys(values).forEach(function(tk){ var pct = values[tk] / totalUsd; hhi += pct * pct; });
    return {
      score: Math.round((1 - hhi) * 100), assets: Object.keys(values).length,
      totalUsd: totalUsd, breakdown: values
    };
  }

  function getFXExposure(){
    var bals = _getBalances();
    var prices = _getPrices();
    var totalUsd = 0, eurUsd = 0;
    Object.keys(bals).forEach(function(tk){
      var usd = (bals[tk] || 0) * (prices[tk] || 0);
      totalUsd += usd;
      if (tk === 'EURC') eurUsd = usd;
    });
    return {
      fxExposurePct: totalUsd > 0 ? Math.round((eurUsd / totalUsd) * 100) : 0,
      eurcValueUsd: eurUsd, totalUsd: totalUsd,
      status: totalUsd > 0 ? (eurUsd / totalUsd > 0.8 ? 'high' : eurUsd / totalUsd > 0.5 ? 'moderate' : 'low') : 'empty'
    };
  }

  function getAssetAllocation(){
    var bals = _getBalances();
    var prices = _getPrices();
    var totalUsd = 0, alloc = [];
    Object.keys(bals).forEach(function(tk){
      var usd = (bals[tk] || 0) * (prices[tk] || 0);
      totalUsd += usd;
      alloc.push({ asset: tk, amount: bals[tk], priceUsd: prices[tk] || 0, valueUsd: usd, pct: 0 });
    });
    if (totalUsd > 0){ alloc.forEach(function(a){ a.pct = Math.round((a.valueUsd / totalUsd) * 100); }); }
    alloc.sort(function(a, b){ return b.valueUsd - a.valueUsd; });
    return { totalUsd: totalUsd, allocation: alloc, assetCount: alloc.length };
  }

  function getTreasuryHealth(){
    var div = getDiversificationScore();
    var fx = getFXExposure();
    var score = 100;
    if (div.score < 30) score -= 20;
    if (div.assets < 2) score -= 15;
    if (fx.fxExposurePct > 80) score -= 20;
    else if (fx.fxExposurePct > 50) score -= 10;
    if (div.totalUsd === 0) score = 0;
    return {
      score: Math.max(0, score),
      status: score >= 80 ? 'healthy' : score >= 50 ? 'warning' : 'critical',
      diversification: div.score, fxExposure: fx.fxExposurePct,
      assets: div.assets, totalUsd: div.totalUsd,
      timestamp: Math.floor(Date.now()/1000)
    };
  }

  function getMarketExposure(){
    var alloc = getAssetAllocation();
    var exposure = {};
    alloc.allocation.forEach(function(a){
      var cat = a.asset === 'USDC' || a.asset === 'EURC' ? 'stablecoins'
        : a.asset === 'cirBTC' ? 'crypto' : 'other';
      exposure[cat] = (exposure[cat] || 0) + a.valueUsd;
    });
    return { totalUsd: alloc.totalUsd, categories: exposure };
  }

  if (typeof window !== 'undefined'){
    var base = window.OracleInterop || {};
    base.TreasuryAnalytics = {
      getDiversificationScore: getDiversificationScore,
      getFXExposure: getFXExposure,
      getAssetAllocation: getAssetAllocation,
      getTreasuryHealth: getTreasuryHealth,
      getMarketExposure: getMarketExposure
    };
    window.OracleInterop = base;
  }
})();
