/**
 * agentExecOTP.js — Email OTP authorization for Autonoma financial operations.
 *
 * Flow:
 *   1. requestOTP(intentId, operation, amount, asset, destination)
 *      → POST /api/agent/exec-otp { action:'request', ... }
 *      → returns { ok, sent, email, expiresIn }
 *
 *   2. verifyOTP(intentId, code)
 *      → POST /api/agent/exec-otp { action:'verify', intentId, code }
 *      → returns { ok, execToken, circleWalletId, circleWalletAddress, ... }
 *
 *   3. Caller stores the execToken and passes it to the execution path.
 *      The execution gate accepts execToken in place of a front-end Authorization object.
 *
 * Usage (in Autonoma chat handler):
 *   const req = await AgentExecOTP.requestOTP(intentId, 'payment', 0.01, 'USDC', '0x...');
 *   // show OTP input UI
 *   const res = await AgentExecOTP.verifyOTP(intentId, userEnteredCode);
 *   if (res.ok) { // proceed with execution using res.execToken }
 */
(function (root) {
  'use strict';

  var API_BASE = '/api/agent/exec-otp';
  var _pendingIntents = {}; // intentId → { operation, amount, asset, destination, requestedAt }

  function _getToken() {
    try {
      if (typeof AuthManager !== 'undefined' && AuthManager.getSessionToken) {
        var t = AuthManager.getSessionToken();
        if (t) return t;
      }
    } catch (_) {}
    try { return sessionStorage.getItem('elligente_st'); } catch (_) {}
    try { return localStorage.getItem('elligente_session'); } catch (_) {}
    return null;
  }

  async function _post(body) {
    var token = _getToken();
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    var resp = await fetch(API_BASE, {
      method: 'POST',
      headers: headers,
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    var ct = resp.headers.get('content-type') || '';
    var text = await resp.text();
    if (!ct.includes('application/json')) {
      throw new Error(resp.status >= 500 ? 'Server error. Please try again.' : 'Service unavailable.');
    }
    var data;
    try { data = JSON.parse(text); } catch (_) { throw new Error('Invalid server response.'); }
    if (!resp.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  /**
   * requestOTP — Phase 1: request an OTP for a specific intent.
   * @param {string} intentId   — unique id for this execution intent
   * @param {string} operation  — 'payment' | 'swap' | 'bridge' | etc.
   * @param {number} amount     — numeric amount
   * @param {string} asset      — 'USDC' | 'EURC' | etc.
   * @param {string} destination — recipient address (optional for non-send ops)
   * @returns {Promise<{ok:boolean, sent:boolean, email:string, expiresIn:number}>}
   */
  async function requestOTP(intentId, operation, amount, asset, destination) {
    var res = await _post({
      action: 'request',
      intentId: intentId,
      operation: operation || '',
      amount: amount || 0,
      asset: asset || 'USDC',
      destination: destination || '',
    });
    if (res.ok) {
      _pendingIntents[intentId] = {
        operation: operation, amount: amount, asset: asset,
        destination: destination, requestedAt: Date.now(),
      };
    }
    return res;
  }

  /**
   * verifyOTP — Phase 2: verify the code and obtain an execToken.
   * @param {string} intentId
   * @param {string} code — 6-digit string entered by the user
   * @returns {Promise<{ok:boolean, execToken:string, circleWalletAddress:string, ...}>}
   */
  async function verifyOTP(intentId, code) {
    var res = await _post({
      action: 'verify',
      intentId: intentId,
      code: String(code).replace(/\s/g, ''),
    });
    if (res.ok) delete _pendingIntents[intentId];
    return res;
  }

  /**
   * isPending — returns true if an OTP was recently requested for this intent.
   */
  function isPending(intentId) {
    var p = _pendingIntents[intentId];
    if (!p) return false;
    return (Date.now() - p.requestedAt) < 5 * 60 * 1000;
  }

  /**
   * generateIntentId — stable id for a given operation so re-sends reuse the
   * same KV entry (idempotent OTP request).
   */
  function generateIntentId(operation, amount, asset, destination) {
    var parts = [operation || '', String(amount || 0), asset || '', destination || '', Math.floor(Date.now() / 60000)].join(':');
    // Simple djb2 hash — not crypto, just for dedup
    var h = 5381;
    for (var i = 0; i < parts.length; i++) h = ((h << 5) + h) ^ parts.charCodeAt(i);
    return 'intent_' + (h >>> 0).toString(16) + '_' + Math.random().toString(36).slice(2, 7);
  }

  root.AgentExecOTP = {
    requestOTP: requestOTP,
    verifyOTP: verifyOTP,
    isPending: isPending,
    generateIntentId: generateIntentId,
  };

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : {}));
