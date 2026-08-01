/**
 * CCTPHealthMonitor — Monitors Circle API, RPCs, attestation latency & mint status.
 * ADDITIVE module. Provides real-time health dashboard for CCTP V2 infrastructure.
 *
 * Health levels: HEALTHY → WARNING → DEGRADED → OFFLINE
 *
 * Attached to window.CCTPHealthMonitor
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'elligentt_chm_v1';

  var health = {
    circleAPI: { status: 'UNKNOWN', latencyMs: 0, lastCheck: 0 },
    arcRPC: { status: 'UNKNOWN', latencyMs: 0, lastCheck: 0 },
    sourceRPCs: {}, // { chainId: { status, latencyMs, lastCheck } }
    attestation: { avgLatencyMs: 0, totalChecks: 0, lastCheck: 0 },
    mint: { avgLatencyMs: 0, totalChecks: 0, lastCheck: 0 },
    overall: 'UNKNOWN'
  };

  var CHECK_INTERVAL = 60000; // 60s between checks
  var monitorTimer = null;
  var checkCounts = { api: 0, rpc: 0, attestation: 0, mint: 0 };

  var SOURCE_RPCS = {
    11155111: { rpc: 'https://ethereum-sepolia-rpc.publicnode.com', name: 'Ethereum Sepolia' },
    84532: { rpc: 'https://sepolia.base.org', name: 'Base Sepolia' },
    421614: { rpc: 'https://sepolia-rollup.arbitrum.io/rpc', name: 'Arbitrum Sepolia' },
    11155420: { rpc: 'https://sepolia.optimism.io', name: 'Optimism Sepolia' },
    80002: { rpc: 'https://rpc-amoy.polygon.technology', name: 'Polygon Amoy' }
  };

  function _statusFromLatency(ms, threshold) {
    if (ms <= 0) return 'UNKNOWN';
    var t = threshold || 5000;
    if (ms < t) return 'HEALTHY';
    if (ms < t * 2) return 'WARNING';
    if (ms < t * 5) return 'DEGRADED';
    return 'OFFLINE';
  }

  function _overallStatus(statuses) {
    if (statuses.indexOf('OFFLINE') !== -1) return 'OFFLINE';
    if (statuses.indexOf('DEGRADED') !== -1) return 'DEGRADED';
    if (statuses.indexOf('WARNING') !== -1) return 'WARNING';
    if (statuses.indexOf('UNKNOWN') !== -1 && statuses.every(function (s) { return s === 'HEALTHY' || s === 'UNKNOWN'; })) return 'WARNING';
    return 'HEALTHY';
  }

  /** Check Circle Iris API */
  async function checkCircleAPI() {
    var start = Date.now();
    var status = 'OFFLINE';
    try {
      var resp = await fetch('https://iris-api-sandbox.circle.com/v2/messages/26?transactionHash=0x0000000000000000000000000000000000000000000000000000000000000000', { signal: AbortSignal.timeout(10000) });
      status = resp.ok || resp.status === 404 ? 'HEALTHY' : 'DEGRADED';
    } catch (_e) { status = 'OFFLINE'; }

    var latency = Date.now() - start;
    health.circleAPI = { status: _statusFromLatency(latency, 3000), latencyMs: latency, lastCheck: Date.now() };
    checkCounts.api++;
    save();
    _updateOverall();
  }

  /** Check Arc RPC */
  async function checkArcRPC() {
    var start = Date.now();
    var status = 'OFFLINE';
    try {
      if (typeof ethers !== 'undefined') {
        var rpc = 'https://arc-testnet.drpc.org';
        try { if (typeof ElligenteChains !== 'undefined' && ElligenteChains.CHAIN_REGISTRY[5042002]) rpc = ElligenteChains.CHAIN_REGISTRY[5042002].rpc; } catch (_e) {}
        var provider = new ethers.JsonRpcProvider(rpc);
        await provider.getBlockNumber();
        status = 'HEALTHY';
      }
    } catch (_e) { status = 'OFFLINE'; }

    var latency = Date.now() - start;
    health.arcRPC = { status: _statusFromLatency(latency, 5000), latencyMs: latency, lastCheck: Date.now() };
    checkCounts.rpc++;
    save();
    _updateOverall();
  }

  /** Check a source chain RPC */
  async function checkSourceRPC(chainId) {
    var cfg = SOURCE_RPCS[chainId];
    if (!cfg) return;

    var start = Date.now();
    var status = 'OFFLINE';
    try {
      if (typeof ethers !== 'undefined') {
        var provider = new ethers.JsonRpcProvider(cfg.rpc);
        await provider.getBlockNumber();
        status = 'HEALTHY';
      }
    } catch (_e) { status = 'OFFLINE'; }

    var latency = Date.now() - start;
    health.sourceRPCs[chainId] = { status: _statusFromLatency(latency, 5000), latencyMs: latency, chainName: cfg.name, lastCheck: Date.now() };
    save();
    _updateOverall();
  }

  /** Check all source RPCs */
  async function checkAllSourceRPCs() {
    var chainIds = Object.keys(SOURCE_RPCS);
    for (var i = 0; i < chainIds.length; i++) {
      await checkSourceRPC(Number(chainIds[i]));
    }
  }

  /** Record an attestation latency measurement */
  function recordAttestationLatency(ms) {
    if (!isFinite(ms) || ms <= 0) return;
    checkCounts.attestation++;
    health.attestation.avgLatencyMs = Math.round(((health.attestation.avgLatencyMs * (checkCounts.attestation - 1)) + ms) / checkCounts.attestation);
    health.attestation.totalChecks = checkCounts.attestation;
    health.attestation.lastCheck = Date.now();
    save();
  }

  /** Record a mint latency measurement */
  function recordMintLatency(ms) {
    if (!isFinite(ms) || ms <= 0) return;
    checkCounts.mint++;
    health.mint.avgLatencyMs = Math.round(((health.mint.avgLatencyMs * (checkCounts.mint - 1)) + ms) / checkCounts.mint);
    health.mint.totalChecks = checkCounts.mint;
    health.mint.lastCheck = Date.now();
    save();
  }

  function _updateOverall() {
    var statuses = [health.circleAPI.status, health.arcRPC.status];
    var srcIds = Object.keys(health.sourceRPCs);
    for (var i = 0; i < srcIds.length; i++) {
      statuses.push(health.sourceRPCs[srcIds[i]].status);
    }
    health.overall = _overallStatus(statuses);
  }

  /** Full health check cycle */
  async function runFullCheck() {
    await Promise.allSettled([
      checkCircleAPI(),
      checkArcRPC(),
      checkAllSourceRPCs()
    ]);
    return getHealth();
  }

  function getHealth() { return JSON.parse(JSON.stringify(health)); }

  function getStatusColor(status) {
    return { HEALTHY: 'var(--green)', WARNING: 'var(--yellow)', DEGRADED: 'var(--yellow)', OFFLINE: 'var(--red)', UNKNOWN: 'var(--muted2)' }[status] || 'var(--muted2)';
  }

  /** Render health dashboard HTML */
  function renderHealthHtml() {
    var h = health;
    function row(label, status, detail) {
      return '<div style="display:flex;align-items:center;gap:7px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.03);font-size:9.5px">' +
        '<span style="width:7px;height:7px;border-radius:50%;flex-shrink:0;background:' + getStatusColor(status) + '"></span>' +
        '<span style="color:var(--text);min-width:120px">' + label + '</span>' +
        '<span style="color:' + getStatusColor(status) + ';font-weight:600;text-transform:capitalize">' + status.toLowerCase() + '</span>' +
        '<span style="color:var(--muted2);margin-left:auto;font-size:8px">' + detail + '</span></div>';
    }

    var html = row('Circle Iris API', h.circleAPI.status, h.circleAPI.latencyMs + 'ms');
    html += row('Arc RPC', h.arcRPC.status, h.arcRPC.latencyMs + 'ms');

    var srcIds = Object.keys(h.sourceRPCs);
    for (var i = 0; i < srcIds.length; i++) {
      var s = h.sourceRPCs[srcIds[i]];
      if (s.chainName) html += row(s.chainName + ' RPC', s.status, s.latencyMs + 'ms');
    }

    html += row('Attestation Avg', h.attestation.totalChecks > 0 ? 'HEALTHY' : 'UNKNOWN', h.attestation.totalChecks > 0 ? h.attestation.avgLatencyMs + 'ms avg' : 'no data');
    html += row('Mint Avg', h.mint.totalChecks > 0 ? 'HEALTHY' : 'UNKNOWN', h.mint.totalChecks > 0 ? h.mint.avgLatencyMs + 'ms avg' : 'no data');

    html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;margin-top:4px;border-top:1px solid var(--border);font-size:10px">' +
      '<span style="color:var(--muted2)">Overall:</span>' +
      '<span style="font-weight:700;color:' + getStatusColor(h.overall) + ';text-transform:capitalize">' + h.overall.toLowerCase() + '</span>' +
      '</div>';

    return html;
  }

  /** Start periodic monitoring */
  function start(intervalMs) {
    if (monitorTimer) return;
    var interval = intervalMs || CHECK_INTERVAL;
    monitorTimer = setInterval(function () { runFullCheck(); }, interval);
    runFullCheck(); // immediate first check
  }

  function stop() {
    if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
  }

  function load() { try { var r = localStorage.getItem(STORAGE_KEY); if (r) { var p = JSON.parse(r); Object.assign(health, p); } } catch (_e) {} }
  function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(health)); } catch (_e) {} }

  load();

  window.CCTPHealthMonitor = {
    checkCircleAPI: checkCircleAPI,
    checkArcRPC: checkArcRPC,
    checkSourceRPC: checkSourceRPC,
    checkAllSourceRPCs: checkAllSourceRPCs,
    runFullCheck: runFullCheck,
    getHealth: getHealth,
    getStatusColor: getStatusColor,
    renderHealthHtml: renderHealthHtml,
    recordAttestationLatency: recordAttestationLatency,
    recordMintLatency: recordMintLatency,
    start: start,
    stop: stop
  };
})();
