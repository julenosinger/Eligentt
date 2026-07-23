/**
 * OracleDashboardEngine — Dashboard data provider
 * Read-only data layer. No UI implementation. Future UI consumption ready.
 */
(function(){
  'use strict';

  function _safe(cb, def){ try { return cb(); } catch(_e){ return def; } }

  function getOracleHealth(){
    return _safe(function(){
      if (typeof OracleInterop !== 'undefined' && OracleInterop.HealthMonitor){
        return OracleInterop.HealthMonitor.getHealth();
      }
      return { oracle: 'unknown', rpc: 'unknown', ccip: 'unknown', feeds: 0, healthyFeeds: 0 };
    }, { oracle: 'unknown', rpc: 'unknown', ccip: 'unknown', feeds: 0, healthyFeeds: 0 });
  }

  function getFeedsStatus(){
    var feeds = _safe(function(){
      if (typeof OracleInterop !== 'undefined' && OracleInterop.Registry){
        return OracleInterop.Registry.getAllFeeds();
      }
      return [];
    }, []);
    return feeds.map(function(f){
      return {
        key: f.key, description: f.description || f.key,
        address: f.address || '', health: f.health || 'unknown',
        heartbeat: f.heartbeat || 0, decimals: f.decimals || 0
      };
    });
  }

  function getTreasurySnapshot(){
    return _safe(function(){
      if (typeof OracleInterop !== 'undefined' && OracleInterop.TreasuryAnalytics){
        return {
          health: OracleInterop.TreasuryAnalytics.getTreasuryHealth(),
          allocation: OracleInterop.TreasuryAnalytics.getAssetAllocation(),
          diversification: OracleInterop.TreasuryAnalytics.getDiversificationScore(),
          fxExposure: OracleInterop.TreasuryAnalytics.getFXExposure()
        };
      }
      return {};
    }, {});
  }

  function getCrossChainSnapshot(){
    return _safe(function(){
      if (typeof OracleInterop !== 'undefined' && OracleInterop.CrossChain){
        return OracleInterop.CrossChain.getCrossChainAnalytics();
      }
      return { chains: [], supportedProtocols: [] };
    }, { chains: [], supportedProtocols: [] });
  }

  function getRecommendationSnapshot(){
    return _safe(function(){
      if (typeof OracleInterop !== 'undefined' && OracleInterop.Recommendations){
        return OracleInterop.Recommendations.getAllRecommendations();
      }
      return { treasury: [], oracle: [], crosschain: [], risk: [] };
    }, { treasury: [], oracle: [], crosschain: [], risk: [] });
  }

  function getDashboardData(){
    return {
      oracle: getOracleHealth(),
      feeds: getFeedsStatus(),
      treasury: getTreasurySnapshot(),
      crossChain: getCrossChainSnapshot(),
      recommendations: getRecommendationSnapshot(),
      timestamp: Math.floor(Date.now()/1000),
      version: '2.0.0'
    };
  }

  if (typeof window !== 'undefined'){
    var base = window.OracleInterop || {};
    base.Dashboard = {
      getOracleHealth: getOracleHealth,
      getFeedsStatus: getFeedsStatus,
      getTreasurySnapshot: getTreasurySnapshot,
      getCrossChainSnapshot: getCrossChainSnapshot,
      getRecommendationSnapshot: getRecommendationSnapshot,
      getDashboardData: getDashboardData
    };
    window.OracleInterop = base;
  }
})();
