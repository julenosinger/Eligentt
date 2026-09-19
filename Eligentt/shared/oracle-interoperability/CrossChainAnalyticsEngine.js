/**
 * CrossChainAnalyticsEngine — Interoperability route analytics
 * Read-only. Cheapest/fastest route analysis. Never interferes with Bridge.
 */
(function(){
  'use strict';

  function _getCCTPRoute(destChain, amount, token){
    var domain;
    try {
      if (typeof ElligenteCCTP !== 'undefined' && ElligenteCCTP.CCTP_CONFIG){
        var cfg = ElligenteCCTP.CCTP_CONFIG;
        for (var k in cfg){
          if ((cfg[k].name || '').replace('_',' ').toLowerCase() === (destChain||'').replace('_',' ').toLowerCase() ||
              String(cfg[k].chainId) === String(destChain) || String(cfg[k].domain) === String(destChain)){
            domain = cfg[k].domain; break;
          }
        }
        // search by chain name
        if (domain === undefined){
          for (var k2 in cfg){
            var name = (cfg[k2].name || '').toLowerCase();
            if (name.indexOf((destChain||'').toLowerCase()) !== -1){ domain = cfg[k2].domain; break; }
          }
        }
      }
    } catch(_e){}
    if (domain !== undefined && domain !== null){
      return { protocol: 'CCTP', domain: domain, estimatedTime: '2-10 min', fee: '0.00 (protocol fee varies)', status: 'available', note: 'Circle Cross-Chain Transfer Protocol' };
    }
    return null;
  }

  function _getCCIPRoute(destChain, amount, token){
    var route = null;
    try {
      if (typeof OracleInterop !== 'undefined' && OracleInterop.getCCIPFee){
        route = OracleInterop.getCCIPFee(destChain, token, amount);
      }
    } catch(_e){}
    if (route){ route.protocol = 'CCIP'; route.estimatedTime = '10-20 min'; route.status = 'available'; route.note = 'Chainlink CCIP'; }
    return route;
  }

  function getOptimalRoute(destChain, amount, token){
    var cctp = _getCCTPRoute(destChain, amount, token);
    var ccip = _getCCIPRoute(destChain, amount, token);
    var routes = [];
    if (cctp) routes.push(cctp);
    if (ccip) routes.push(ccip);
    routes.sort(function(a, b){ return (parseFloat(a.fee) || 9999) - (parseFloat(b.fee) || 9999); });
    return {
      destChain: destChain, amount: amount, token: token || 'USDC',
      routes: routes,
      optimal: routes[0] || null,
      totalProtocols: routes.length,
      timestamp: Math.floor(Date.now()/1000)
    };
  }

  function getCheapestRoute(destChain, amount, token){
    var r = getOptimalRoute(destChain, amount, token);
    return { cheapest: r.routes[0] || null, all: r.routes };
  }

  function getFastestRoute(destChain, amount, token){
    var r = getOptimalRoute(destChain, amount, token);
    r.routes.sort(function(a, b){
      var timeA = parseInt(String(a.estimatedTime).split('-')[0]) || 99;
      var timeB = parseInt(String(b.estimatedTime).split('-')[0]) || 99;
      return timeA - timeB;
    });
    return { fastest: r.routes[0] || null, all: r.routes };
  }

  function getCrossChainAnalytics(){
    var chains = ['Ethereum_Sepolia','Base_Sepolia','Arbitrum_Sepolia','Optimism_Sepolia','Polygon_Amoy'];
    var results = [];
    chains.forEach(function(c){
      results.push(getOptimalRoute(c, 100, 'USDC'));
    });
    return {
      chains: results,
      supportedProtocols: ['CCTP','CCIP'],
      cctpAvailable: results.some(function(r){ return r.routes.some(function(rt){ return rt.protocol === 'CCTP'; }); }),
      ccipAvailable: results.some(function(r){ return r.routes.some(function(rt){ return rt.protocol === 'CCIP'; }); }),
      timestamp: Math.floor(Date.now()/1000)
    };
  }

  if (typeof window !== 'undefined'){
    var base = window.OracleInterop || {};
    base.CrossChain = {
      getOptimalRoute: getOptimalRoute,
      getCheapestRoute: getCheapestRoute,
      getFastestRoute: getFastestRoute,
      getCrossChainAnalytics: getCrossChainAnalytics
    };
    window.OracleInterop = base;
  }
})();
