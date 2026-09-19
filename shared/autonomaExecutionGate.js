/**
 * AutonomaExecutionGate — Chat financial-execution identity + policy/auth gate
 *
 * Chat-layer only. Does NOT modify ScheduleEngine / MS-2/MS-3/MS-4 claims.
 *
 * NEW user Chat action → unique executionId
 * Same Chat action routed twice → SAME executionId → one claim
 * Completed execution does NOT permanently block a NEW Chat command
 * with identical financial parameters.
 *
 * Attached to window.AutonomaExecutionGate
 */
(function () {
  'use strict';

  var STORE_KEY = 'elligentt_autonoma_exec_gate_v1';
  var IN_FLIGHT_MS = 90000;
  var ARC_CHAIN_ID = 5042002;
  var SUPPORTED_CHAIN_IDS = [5042002, 11155111, 84532, 421614, 11155420, 80002];
  var DOMAIN_BY_CHAIN = {
    5042002: 26,
    11155111: 0,
    84532: 6,
    421614: 3,
    11155420: 2,
    80002: 7
  };

  function _store() {
    try {
      var r = localStorage.getItem(STORE_KEY);
      return r ? JSON.parse(r) : { byId: {}, inflightFp: {} };
    } catch (e) {
      return { byId: {}, inflightFp: {} };
    }
  }
  function _save(s) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) {}
  }

  function fingerprint(opts) {
    var dest = opts.destination || opts.recipient || '';
    if (typeof dest === 'string' && /^0x[a-fA-F0-9]{40}$/.test(dest)) dest = dest.toLowerCase();
    else dest = String(dest || '');
    return [
      opts.operation || '',
      String(opts.amount || ''),
      String(opts.asset || ''),
      dest,
      String(opts.sourceChainId || ''),
      String(opts.destChainId || opts.destDomain || '')
    ].join('|').toLowerCase();
  }

  function newExecutionId() {
    return 'chat_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }

  function resolveExecutionId(opts) {
    var s = _store();
    var now = Date.now();
    if (opts.executionId) {
      var rec = s.byId[opts.executionId];
      if (rec && (rec.status === 'submitted' || rec.status === 'executed' || rec.status === 'confirmed')) {
        return { ok: false, executionId: opts.executionId, reason: 'duplicate_intent', duplicate: true };
      }
      if (rec && rec.status === 'executing' && (now - rec.ts) < IN_FLIGHT_MS) {
        return { ok: false, executionId: opts.executionId, reason: 'duplicate_intent', duplicate: true };
      }
      return { ok: true, executionId: opts.executionId, created: !rec };
    }
    var fp = fingerprint(opts);
    var inflight = s.inflightFp[fp];
    if (inflight && inflight.executionId && (now - inflight.ts) < IN_FLIGHT_MS) {
      var irec = s.byId[inflight.executionId];
      if (irec && irec.status === 'executing') {
        return { ok: false, executionId: inflight.executionId, reason: 'duplicate_intent', duplicate: true };
      }
    }
    return { ok: true, executionId: newExecutionId(), created: true };
  }

  function claim(executionId, fp) {
    var s = _store();
    var now = Date.now();
    s.byId[executionId] = { ts: now, status: 'executing', fp: fp };
    s.inflightFp[fp] = { ts: now, executionId: executionId };
    var ids = Object.keys(s.byId);
    if (ids.length > 300) {
      ids.sort(function (a, b) { return (s.byId[a].ts || 0) - (s.byId[b].ts || 0); });
      for (var i = 0; i < ids.length - 300; i++) delete s.byId[ids[i]];
    }
    _save(s);
  }

  function markSubmitted(executionId, txHash) {
    var s = _store();
    var rec = s.byId[executionId] || { ts: Date.now() };
    rec.status = txHash ? 'submitted' : 'failed';
    rec.txHash = txHash || rec.txHash || null;
    rec.ts = Date.now();
    s.byId[executionId] = rec;
    if (rec.fp && s.inflightFp[rec.fp] && s.inflightFp[rec.fp].executionId === executionId) {
      delete s.inflightFp[rec.fp];
    }
    _save(s);
  }

  function markConfirmed(executionId, txHash) {
    var s = _store();
    var rec = s.byId[executionId] || { ts: Date.now() };
    rec.status = 'confirmed';
    rec.txHash = txHash || rec.txHash || null;
    rec.ts = Date.now();
    s.byId[executionId] = rec;
    if (rec.fp && s.inflightFp[rec.fp] && s.inflightFp[rec.fp].executionId === executionId) {
      delete s.inflightFp[rec.fp];
    }
    _save(s);
  }

  function markFailed(executionId) {
    var s = _store();
    var rec = s.byId[executionId];
    if (!rec) return;
    rec.status = 'failed';
    rec.ts = Date.now();
    if (rec.fp && s.inflightFp[rec.fp] && s.inflightFp[rec.fp].executionId === executionId) {
      delete s.inflightFp[rec.fp];
    }
    _save(s);
  }

  function isSupportedChain(chainId) {
    return SUPPORTED_CHAIN_IDS.indexOf(Number(chainId)) !== -1;
  }

  function isSupportedRoute(sourceChainId, destChainId) {
    var s = Number(sourceChainId);
    var d = Number(destChainId);
    if (!isSupportedChain(s) || !isSupportedChain(d)) return false;
    if (s === d) return false;
    return true;
  }

  function destChainIdFromDomain(domain) {
    var dom = Number(domain);
    var keys = Object.keys(DOMAIN_BY_CHAIN);
    for (var i = 0; i < keys.length; i++) {
      if (DOMAIN_BY_CHAIN[keys[i]] === dom) return Number(keys[i]);
    }
    return null;
  }

  function _mod(name) {
    try {
      if (typeof window !== 'undefined' && window[name] != null) return window[name];
      if (typeof globalThis !== 'undefined' && globalThis[name] != null) return globalThis[name];
    } catch (e) {}
    return null;
  }

  function evaluate(opts) {
    opts = opts || {};
    var operation = opts.operation || '';
    var wm = _mod('AgentWalletManager');
    var az = _mod('AgentAuthorization');
    var pe = _mod('PolicyEngine');

    if (!wm) return { ok: false, reason: 'Agent Wallet unavailable' };
    if (typeof wm.isShutdown === 'function' && wm.isShutdown()) return { ok: false, reason: 'Agent wallet is shut down' };
    if (typeof wm.isPaused === 'function' && wm.isPaused()) return { ok: false, reason: 'Agent wallet is paused' };
    var agentAddr = typeof wm.getAgentAddress === 'function' ? wm.getAgentAddress() : null;
    if (!agentAddr) return { ok: false, reason: 'Missing Agent Wallet' };

    if (!az) return { ok: false, reason: 'Authorization system unavailable' };
    if (typeof az.hasOperationAuth !== 'function' || !az.hasOperationAuth(operation)) {
      return { ok: false, reason: 'Agent is not authorized for ' + operation };
    }

    var userWallet = opts.userWallet || (typeof walletAddress === 'string' ? walletAddress : null);
    var active = typeof az.getActive === 'function' ? az.getActive() : [];
    if (!active || !active.length) {
      return { ok: false, reason: 'No active agent authorization for the current wallet' };
    }
    var matched = null;
    for (var i = 0; i < active.length; i++) {
      var a = active[i];
      if (a.grantedBy && userWallet && String(a.grantedBy).toLowerCase() !== String(userWallet).toLowerCase()) continue;
      if (a.agentWallet && String(a.agentWallet).toLowerCase() !== String(agentAddr).toLowerCase()) continue;
      matched = a;
      break;
    }
    if (!matched) {
      return { ok: false, reason: 'authorization was granted by a different wallet' };
    }

    var dest = opts.destination || '';
    if (dest && !/^0x[a-fA-F0-9]{40}$/.test(String(dest))) dest = '';
    var network = opts.network || 'Arc Testnet';
    var authCheck = az.validateExecution({
      operation: operation,
      amount: Number(opts.amount) || 0,
      asset: opts.asset || 'USDC',
      network: network,
      contract: opts.contract || '',
      destination: dest
    });
    if (!authCheck || !authCheck.valid) {
      return { ok: false, reason: (authCheck && authCheck.reason) || 'Authorization scope denied' };
    }

    if (!pe || typeof pe.validateExecution !== 'function') {
      return { ok: false, reason: 'Policy engine unavailable' };
    }
    var report;
    try {
      report = pe.validateExecution({
        operation: operation,
        amount: Number(opts.amount) || 0,
        asset: opts.asset || 'USDC',
        network: network,
        contract: opts.contract || '',
        destination: dest,
        simulationHash: opts.simulationHash || null,
        authId: matched.id,
        maxRiskLevel: matched.maxRiskLevel || 'MEDIUM'
      });
    } catch (e) {
      return { ok: false, reason: 'Policy engine error: ' + (e.message || e) };
    }
    if (!report || !report.valid) {
      var reasons = (report && report.failedRules) ? report.failedRules.map(function (r) { return r.rule + ': ' + r.reason; }).join(' | ') : '';
      return { ok: false, reason: 'Policy: ' + (reasons || (report && report.reason) || 'denied') };
    }

    if (operation === 'bridge' || operation === 'crosschain') {
      var src = opts.sourceChainId != null ? Number(opts.sourceChainId) : ARC_CHAIN_ID;
      var dst = opts.destChainId != null ? Number(opts.destChainId) : destChainIdFromDomain(opts.destDomain);
      if (dst == null && opts.destDomain != null) dst = destChainIdFromDomain(opts.destDomain);
      if (!isSupportedRoute(src, dst)) {
        return { ok: false, reason: 'Unsupported bridge route' };
      }
    }

    var idRes = resolveExecutionId(opts);
    if (!idRes.ok) return idRes;
    var fp = fingerprint(opts);
    claim(idRes.executionId, fp);
    return { ok: true, executionId: idRes.executionId, fp: fp, auth: matched };
  }

  var API = {
    evaluate: evaluate,
    resolveExecutionId: resolveExecutionId,
    fingerprint: fingerprint,
    markSubmitted: markSubmitted,
    markConfirmed: markConfirmed,
    markFailed: markFailed,
    isSupportedRoute: isSupportedRoute,
    isSupportedChain: isSupportedChain,
    destChainIdFromDomain: destChainIdFromDomain,
    newExecutionId: newExecutionId,
    SUPPORTED_CHAIN_IDS: SUPPORTED_CHAIN_IDS.slice(),
    DOMAIN_BY_CHAIN: DOMAIN_BY_CHAIN,
    version: '3.0.0'
  };

  if (typeof window !== 'undefined') window.AutonomaExecutionGate = API;
  else if (typeof globalThis !== 'undefined') globalThis.AutonomaExecutionGate = API;
})();
