/**
 * CircleAttestationMonitor — Tracks CCTP transfer lifecycle states.
 * ADDITIVE module. Wraps existing cctp.js pollForAttestation with state machine.
 *
 * States: INITIATED → BURNED → WAITING_FINALITY → WAITING_ATTESTATION
 *         → ATTESTED → MINTING → COMPLETED (or FAILED / RECOVERY)
 *
 * Attached to window.CircleAttestationMonitor
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'elligentt_cam_v1';
  var tracked = {}; // { transferId: { state, history:[], ... } }

  function load() { try { var r = localStorage.getItem(STORAGE_KEY); if (r) tracked = JSON.parse(r); } catch (_e) { tracked = {}; } }
  function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tracked)); } catch (_e) {} }

  var STATE_ORDER = [
    'INITIATED', 'BURNING', 'BURNED', 'WAITING_FINALITY',
    'WAITING_ATTESTATION', 'ATTESTED', 'MINTING', 'COMPLETED', 'FAILED', 'RECOVERY'
  ];

  var STATE_LABELS = {
    INITIATED: { label: 'Initiated', icon: 'circle-plus', color: '#6b7280' },
    BURNING: { label: 'Burning', icon: 'flame', color: '#f59e0b' },
    BURNED: { label: 'Burned', icon: 'check', color: '#22c55e' },
    WAITING_FINALITY: { label: 'Waiting Finality', icon: 'clock', color: '#f59e0b' },
    WAITING_ATTESTATION: { label: 'Waiting Attestation', icon: 'clock-hour-4', color: '#f59e0b' },
    ATTESTED: { label: 'Attestation Received', icon: 'certificate', color: '#22c55e' },
    MINTING: { label: 'Minting', icon: 'coins', color: '#f59e0b' },
    COMPLETED: { label: 'Completed', icon: 'circle-check', color: '#22c55e' },
    FAILED: { label: 'Failed', icon: 'alert-triangle', color: '#ef4444' },
    RECOVERY: { label: 'Recovery', icon: 'refresh', color: '#f59e0b' }
  };

  function track(transferId, initialState) {
    tracked[transferId] = {
      transferId: transferId,
      state: initialState || 'INITIATED',
      history: [{ state: initialState || 'INITIATED', at: Date.now() }],
      updatedAt: Date.now()
    };
    save();
    return tracked[transferId];
  }

  function transition(transferId, newState, detail) {
    var t = tracked[transferId];
    if (!t) { t = track(transferId, newState); return t; }
    t.state = newState;
    t.updatedAt = Date.now();
    t.history.push({ state: newState, at: Date.now(), detail: detail || null });
    if (t.history.length > 50) t.history = t.history.slice(-50);
    save();
    return t;
  }

  function getState(transferId) { return tracked[transferId] || null; }
  function getStateLabel(state) { return STATE_LABELS[state] || { label: state, icon: 'question-mark', color: '#6b7280' }; }

  function getProgress(transferId) {
    var t = tracked[transferId];
    if (!t) return 0;
    var idx = STATE_ORDER.indexOf(t.state);
    if (idx === -1) return 0;
    return Math.round((idx / (STATE_ORDER.length - 1)) * 100);
  }

  function getAllTracked() { return Object.values(tracked); }

  function getActiveTransfers() {
    return Object.values(tracked).filter(function (t) {
      return t.state !== 'COMPLETED' && t.state !== 'FAILED';
    });
  }

  /** Render a transfer state timeline as HTML */
  function renderTimelineHtml(transferId) {
    var t = tracked[transferId];
    if (!t || !t.history || !t.history.length) return '';

    var html = '<div style="border-left:2px solid var(--border);margin-left:6px;padding-left:12px;display:flex;flex-direction:column;gap:4px;font-size:9px">';
    t.history.slice(-8).forEach(function (h) {
      var sl = STATE_LABELS[h.state] || { icon: 'circle', color: '#6b7280' };
      html += '<div style="display:flex;gap:6px;align-items:center">' +
        '<span style="color:' + sl.color + '"><i class="ti ti-' + sl.icon + '" style="font-size:10px"></i></span>' +
        '<span style="color:' + sl.color + '">' + sl.label + '</span>' +
        '<span style="color:var(--muted2);margin-left:auto">' + new Date(h.at).toLocaleTimeString() + '</span></div>';
      if (h.detail) html += '<div style="font-size:8px;color:var(--muted2);padding-left:18px">' + String(h.detail).slice(0, 80) + '</div>';
    });
    html += '</div>';
    return html;
  }

  /** Get overall attestation statistics */
  function getStats() {
    var all = Object.values(tracked);
    var completed = all.filter(function (t) { return t.state === 'COMPLETED'; });
    var failed = all.filter(function (t) { return t.state === 'FAILED'; });
    var active = all.filter(function (t) { return t.state !== 'COMPLETED' && t.state !== 'FAILED'; });
    var avgTime = 0;
    if (completed.length > 0) {
      avgTime = completed.reduce(function (s, c) {
        var start = c.history && c.history.length > 0 ? c.history[0].at : c.updatedAt;
        var end = c.updatedAt;
        return s + (end - start);
      }, 0) / completed.length;
    }
    return {
      total: all.length,
      active: active.length,
      completed: completed.length,
      failed: failed.length,
      averageTimeMs: Math.round(avgTime),
      successRate: all.length > 0 ? Math.round((completed.length / all.length) * 100) : 0
    };
  }

  load();

  window.CircleAttestationMonitor = {
    track: track,
    transition: transition,
    getState: getState,
    getStateLabel: getStateLabel,
    getProgress: getProgress,
    getAllTracked: getAllTracked,
    getActiveTransfers: getActiveTransfers,
    renderTimelineHtml: renderTimelineHtml,
    getStats: getStats,
    STATES: STATE_ORDER.slice(),
    STATE_LABELS: STATE_LABELS
  };
})();
