const EventIndexer = (() => {
  'use strict';

  const STORE_KEY = 'elligente_events';
  const MAX_EVENTS = 500;

  const EVENT_TYPES = {
    PAYMENT_CREATED:   'PaymentCreated',
    PAYMENT_EXECUTED:  'PaymentExecuted',
    PAYMENT_FAILED:    'PaymentFailed',
    BRIDGE_INITIATED:  'BridgeInitiated',
    BRIDGE_COMPLETED:  'BridgeCompleted',
    TREASURY_DEPOSIT:  'TreasuryDeposit',
    TREASURY_WITHDRAW: 'TreasuryWithdraw',
    RELAYER_FULFILL:   'RelayerFulfill',
    MINT_COMPLETE:     'MintComplete',
  };

  function _load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (_) { return []; }
  }

  function _save(events) {
    try {
      if (events.length > MAX_EVENTS) events = events.slice(0, MAX_EVENTS);
      localStorage.setItem(STORE_KEY, JSON.stringify(events));
    } catch (_) {}
  }

  function record(event) {
    if (!event || !event.type) return;
    const events = _load();

    if (event.txHash) {
      const existing = events.find(e => e.txHash === event.txHash && e.type === event.type);
      if (existing) {
        Object.assign(existing, event, { updatedAt: Date.now() });
        _save(events);
        return existing;
      }
    }

    const entry = {
      id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36),
      type: event.type,
      txHash: event.txHash || null,
      blockNumber: event.blockNumber || null,
      timestamp: event.timestamp || Date.now(),
      status: event.status || 'confirmed',
      wallet: event.wallet || null,
      amount: event.amount || null,
      asset: event.asset || null,
      chain: event.chain || 'Arc Testnet',
      intentId: event.intentId || null,
      metadata: event.metadata || null,
      createdAt: Date.now(),
    };

    events.unshift(entry);
    _save(events);
    return entry;
  }

  function getAll(filter) {
    let events = _load();
    if (filter) {
      if (filter.type) events = events.filter(e => e.type === filter.type);
      if (filter.wallet) events = events.filter(e => e.wallet && e.wallet.toLowerCase() === filter.wallet.toLowerCase());
      if (filter.status) events = events.filter(e => e.status === filter.status);
      if (filter.since) events = events.filter(e => e.timestamp >= filter.since);
      if (filter.limit) events = events.slice(0, filter.limit);
    }
    return events;
  }

  function getByTxHash(txHash) {
    if (!txHash) return null;
    return _load().find(e => e.txHash === txHash) || null;
  }

  function getStats() {
    const events = _load();
    const stats = { total: events.length, byType: {}, byStatus: {} };
    for (const e of events) {
      stats.byType[e.type] = (stats.byType[e.type] || 0) + 1;
      stats.byStatus[e.status] = (stats.byStatus[e.status] || 0) + 1;
    }
    return stats;
  }

  function clear() {
    _save([]);
  }

  return { EVENT_TYPES, record, getAll, getByTxHash, getStats, clear };
})();

if (typeof window !== 'undefined') window.EventIndexer = EventIndexer;
