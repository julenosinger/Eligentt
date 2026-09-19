/**
 * AIRecommendationEngine — Treasury/market/risk/oracle recommendations
 * Read-only. For AI Agent consumption only. No execution, no permissions.
 */
(function(){
  'use strict';

  function _safe(cb, def){ try { return cb(); } catch(_e){ return def; } }

  function getTreasuryRecommendations(){
    var recs = [];
    var health = _safe(function(){ return window.OracleInterop.TreasuryAnalytics ? window.OracleInterop.TreasuryAnalytics.getTreasuryHealth() : null; }, null);
    if (health){
      if (health.diversification < 30) recs.push({ severity: 'WARNING', category: 'treasury', text: 'Treasury diversification is low (' + health.diversification + '/100). Consider allocating across multiple assets.', action: 'Open Treasury to rebalance' });
      if (health.fxExposure > 70) recs.push({ severity: 'WARNING', category: 'treasury', text: 'FX exposure to EUR is ' + health.fxExposure + '%. Consider reducing EURC allocation.', action: 'Swap EURC for USDC' });
      if (health.assets < 2 && health.totalUsd > 100) recs.push({ severity: 'INFO', category: 'treasury', text: 'Only ' + health.assets + ' asset(s) in treasury. Diversifying reduces single-asset risk.', action: 'Acquire additional assets' });
      if (health.score >= 80) recs.push({ severity: 'GOOD', category: 'treasury', text: 'Treasury health is strong (' + health.score + '/100).', action: '' });
    }
    return recs;
  }

  function getOracleRecommendations(){
    var recs = [];
    var mon = _safe(function(){ return window.OracleInterop.HealthMonitor ? window.OracleInterop.HealthMonitor.getHealth() : null; }, null);
    if (mon){
      if (mon.oracle === 'degraded' || mon.oracle === 'offline') recs.push({ severity: 'CRITICAL', category: 'oracle', text: 'Oracle feeds are ' + mon.oracle + '. Prices may be inaccurate.', action: 'Check Chainlink feed status' });
      else if (mon.oracle === 'warning') recs.push({ severity: 'WARNING', category: 'oracle', text: 'Oracle health is at warning level. Some feeds may be stale.', action: 'Monitor feed freshness' });
      if (mon.ccip === 'degraded') recs.push({ severity: 'WARNING', category: 'oracle', text: 'CCIP router connectivity degraded. Cross-chain operations may be affected.', action: 'Check CCIP router status' });
    }
    var feedKeys = _safe(function(){ return window.OracleInterop.getAvailableFeeds ? window.OracleInterop.getAvailableFeeds() : []; }, []);
    feedKeys.forEach(function(k){
      var s = _safe(function(){ return window.OracleInterop.getFeedStatus ? window.OracleInterop.getFeedStatus(k) : 'unknown'; }, 'unknown');
      if (s === 'stale') recs.push({ severity: 'WARNING', category: 'oracle', text: 'Feed ' + k + ' is stale. Price data may be outdated.', action: 'Wait for feed update' });
    });
    return recs;
  }

  function getCrossChainRecommendations(){
    var recs = [];
    var ccip = _safe(function(){ return window.OracleInterop.HealthMonitor ? window.OracleInterop.HealthMonitor.getCCIPStatus() : 'unknown'; }, 'unknown');
    if (ccip === 'unknown'){
      recs.push({ severity: 'INFO', category: 'crosschain', text: 'CCIP chain discovery not yet complete. Cross-chain routing data pending.', action: 'Wait for initialization' });
    } else if (ccip === 'healthy'){
      recs.push({ severity: 'GOOD', category: 'crosschain', text: 'CCIP is operational. Cross-chain routes available via Chainlink CCIP.', action: '' });
    }
    return recs;
  }

  function getRiskRecommendations(){
    var recs = [];
    var fx = _safe(function(){ return window.OracleInterop.TreasuryAnalytics ? window.OracleInterop.TreasuryAnalytics.getFXExposure() : null; }, null);
    if (fx && fx.fxExposurePct > 80){
      recs.push({ severity: 'HIGH', category: 'risk', text: 'EURC exposure is ' + fx.fxExposurePct + '% — high single-currency risk.', action: 'Diversify treasury allocation' });
    }
    var health = _safe(function(){ return window.OracleInterop.TreasuryAnalytics ? window.OracleInterop.TreasuryAnalytics.getTreasuryHealth() : null; }, null);
    if (health && health.score < 30){
      recs.push({ severity: 'CRITICAL', category: 'risk', text: 'Treasury health critically low (' + health.score + '/100). Review allocations.', action: 'Rebalance treasury' });
    }
    return recs;
  }

  function getAllRecommendations(){
    return {
      treasury: getTreasuryRecommendations(),
      oracle: getOracleRecommendations(),
      crosschain: getCrossChainRecommendations(),
      risk: getRiskRecommendations(),
      timestamp: Math.floor(Date.now()/1000)
    };
  }

  if (typeof window !== 'undefined'){
    var base = window.OracleInterop || {};
    base.Recommendations = {
      getTreasuryRecommendations: getTreasuryRecommendations,
      getOracleRecommendations: getOracleRecommendations,
      getCrossChainRecommendations: getCrossChainRecommendations,
      getRiskRecommendations: getRiskRecommendations,
      getAllRecommendations: getAllRecommendations
    };
    window.OracleInterop = base;
  }
})();
