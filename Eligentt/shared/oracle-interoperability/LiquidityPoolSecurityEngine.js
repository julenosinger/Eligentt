/**
 * LiquidityPoolSecurityEngine — Pool vs oracle price validation
 * Read-only monitoring. Never blocks swaps or liquidity operations.
 */
(function(){
  'use strict';

  function _safe(cb, def){ try { return cb(); } catch(_e){ return def; } }

  function getPoolPrice(tokenA, tokenB){
    try {
      var rA = 0, rB = 0;
      if (typeof findPool === 'function'){
        var pair = findPool(tokenA, tokenB);
        if (pair && typeof poolData !== 'undefined'){
          var pd = poolData[pair.id];
          if (pd && pd.loaded && pd.reserveA > 0 && pd.reserveB > 0){
            rA = pair.tokenA === tokenA ? pd.reserveA : pd.reserveB;
            rB = pair.tokenA === tokenA ? pd.reserveB : pd.reserveA;
          }
        }
      }
      if (rA > 0 && rB > 0) return rA / rB;
    } catch(_e){}
    return null;
  }

  function getOraclePrice(asset){
    try {
      if (typeof OracleInterop !== 'undefined' && OracleInterop.getMarketData){
        var md = OracleInterop.getMarketData(asset);
        if (md && md.price && md.price > 0) return md.price;
      }
    } catch(_e){}
    return null;
  }

  function validatePoolOracle(poolPrice, oraclePrice, tokenA, tokenB){
    if (!poolPrice || !oraclePrice || poolPrice <= 0 || oraclePrice <= 0){
      return { status: 'unknown', deviation: null, poolPrice: poolPrice, oraclePrice: oraclePrice };
    }
    var dev = Math.abs(poolPrice - oraclePrice) / oraclePrice;
    var status = dev <= 0.01 ? 'SAFE' : dev <= 0.02 ? 'WARNING' : dev <= 0.05 ? 'MODERATE' : dev <= 0.10 ? 'HIGH_RISK' : 'CRITICAL';
    return {
      status: status, deviation: dev, deviationPct: (dev * 100).toFixed(2),
      poolPrice: poolPrice, oraclePrice: oraclePrice,
      tokenA: tokenA, tokenB: tokenB,
      timestamp: Math.floor(Date.now()/1000)
    };
  }

  function getPoolSecurityStatus(tokenA, tokenB){
    var poolP = getPoolPrice(tokenA, tokenB);
    var oracleP = tokenA === tokenB ? 1.0 : getOraclePrice(tokenA);
    if (!poolP && !oracleP) return { status: 'no_data', pools: [], timestamp: Math.floor(Date.now()/1000) };
    if (!oracleP && tokenA !== tokenB){
      oracleP = getOraclePrice(tokenB);
      if (oracleP && poolP){ oracleP = poolP / oracleP; }
    }
    return validatePoolOracle(poolP, oracleP || 1.0, tokenA, tokenB);
  }

  function getAllPoolStatuses(){
    var pairs = [];
    try {
      if (typeof POOL_REGISTRY !== 'undefined'){
        Object.keys(POOL_REGISTRY).forEach(function(k){
          var p = POOL_REGISTRY[k];
          pairs.push({ id: k, tokenA: p.tokenA, tokenB: p.tokenB, address: p.address });
        });
      }
    } catch(_e){}
    var results = [];
    pairs.forEach(function(p){
      results.push(getPoolSecurityStatus(p.tokenA, p.tokenB));
    });
    return { pools: results, total: results.length, timestamp: Math.floor(Date.now()/1000) };
  }

  if (typeof window !== 'undefined'){
    var base = window.OracleInterop || {};
    base.PoolSecurity = {
      getPoolPrice: getPoolPrice,
      getOraclePrice: getOraclePrice,
      validatePoolOracle: validatePoolOracle,
      getPoolSecurityStatus: getPoolSecurityStatus,
      getAllPoolStatuses: getAllPoolStatuses
    };
    window.OracleInterop = base;
  }
})();
