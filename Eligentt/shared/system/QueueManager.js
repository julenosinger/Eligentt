/**
 * Elligentt QueueManager — Priority Queue with FIFO/Delay/Retry/DeadLetter (Phase 6)
 * Attached to: window.QueueManager
 */
(function () {
  'use strict';
  var _queues = {};

  function create(name) {
    _queues[name] = { items: [], processed: 0, failed: 0, deadLetter: [] };
    return name;
  }

  function enqueue(queueName, payload, opts) {
    var q = _queues[queueName];
    if (!q) return null;
    var o = opts || {};
    var item = {
      id: 'q_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5),
      payload: payload, priority: o.priority || 0, delay: o.delay || 0,
      maxRetries: o.maxRetries || 3, retries: 0, createdAt: Date.now(), status: 'pending'
    };
    q.items.push(item);
    q.items.sort(function (a, b) { return b.priority - a.priority; });
    try { if (typeof EventBus !== 'undefined') EventBus.emit('QUEUE_ENQUEUE', { queue: queueName, itemId: item.id }); } catch (_e) {}
    return item.id;
  }

  function dequeue(queueName) {
    var q = _queues[queueName];
    if (!q) return null;
    var now = Date.now();
    for (var i = 0; i < q.items.length; i++) {
      var item = q.items[i];
      if (item.status !== 'pending') continue;
      if (item.delay && (now - item.createdAt) < item.delay) continue;
      item.status = 'processing';
      return item;
    }
    return null;
  }

  function ack(queueName, itemId) {
    var q = _queues[queueName];
    if (!q) return;
    var idx = _findIndex(q, itemId);
    if (idx !== -1) { q.items.splice(idx, 1); q.processed++; }
  }

  function nack(queueName, itemId) {
    var q = _queues[queueName];
    if (!q) return;
    var idx = _findIndex(q, itemId);
    if (idx !== -1) {
      var item = q.items[idx];
      item.retries++;
      if (item.retries >= item.maxRetries) { item.status = 'dead'; q.deadLetter.push(q.items.splice(idx, 1)[0]); q.failed++; }
      else { item.status = 'pending'; }
    }
  }

  function _findIndex(q, id) { for (var i = 0; i < q.items.length; i++) { if (q.items[i].id === id) return i; } return -1; }

  function purge(queueName, itemId) {
    var q = _queues[queueName];
    if (!q) return;
    var idx = _findIndex(q, itemId);
    if (idx !== -1) q.items.splice(idx, 1);
  }

  function getPending(queueName) {
    var q = _queues[queueName]; return q ? q.items.filter(function (i) { return i.status === 'pending'; }) : [];
  }
  function getDeadLetter(queueName) { var q = _queues[queueName]; return q ? q.deadLetter.slice() : []; }
  function getStats(queueName) {
    var q = _queues[queueName];
    if (!q) return { pending: 0, processing: 0, dead: 0, processed: 0, failed: 0 };
    return { pending: q.items.filter(function (i) { return i.status === 'pending'; }).length, processing: q.items.filter(function (i) { return i.status === 'processing'; }).length, dead: q.deadLetter.length, processed: q.processed, failed: q.failed };
  }

  function clear(name) { if (name) delete _queues[name]; else _queues = {}; }
  function getAllStats() { var r = {}; Object.keys(_queues).forEach(function (k) { r[k] = getStats(k); }); return r; }

  window.QueueManager = {
    VERSION: '1.0.0', create: create, enqueue: enqueue, dequeue: dequeue,
    ack: ack, nack: nack, purge: purge, getPending: getPending,
    getDeadLetter: getDeadLetter, getStats: getStats, getAllStats: getAllStats, clear: clear
  };
})();
