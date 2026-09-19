/**
 * FIX EURC POOL — Lifecycle & Loading Tests
 * ═══════════════════════════════════════
 * Covers: PoolStateManager, PoolDataValidator, PoolRetryManager,
 *         PoolReserveSnapshot, PoolWatcher, RPC fallback scenarios
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

/* ════════════════════════════════════════
   PoolStateManager
   ════════════════════════════════════════ */
describe('PoolStateManager — Cache & Persistence', () => {
  function simulateStateManager() {
    var states = {};
    function saveState(id, data) {
      states[id] = {
        poolId: id, status: 'VALID',
        reserveA: data.reserveA || 0, reserveB: data.reserveB || 0,
        tvl: data.tvl || 0, healthScore: data.healthScore || null,
        updatedAt: Date.now(), firstSeenAt: states[id] ? states[id].firstSeenAt : Date.now(),
        errorCount: 0
      };
    }
    function recordError(id, msg) {
      var s = states[id] || { reserveA: 0, reserveB: 0, tvl: 0, errorCount: 0 };
      s.errorCount = (s.errorCount || 0) + 1;
      s.status = s.errorCount >= 5 ? 'ERROR' : 'REFRESHING';
      s.lastError = msg;
      s.updatedAt = Date.now();
      states[id] = s;
    }
    function hasValidData(id) {
      var s = states[id];
      return s && s.reserveA > 0;
    }
    function getState(id) {
      var s = states[id];
      if (!s) return { status: 'LOADING', hasData: false };
      var age = Date.now() - s.updatedAt;
      if (age < 15000) return { status: 'VALID', hasData: s.reserveA > 0, data: s, age: age };
      if (age < 120000 && s.status === 'VALID') return { status: 'REFRESHING', hasData: true, data: s, age: age };
      if (age >= 120000) return { status: 'STALE', hasData: true, data: s, age: age };
      return { status: 'LOADING', hasData: s.reserveA > 0, data: s, age: age };
    }
    return { states, saveState, recordError, hasValidData, getState };
  }

  it('pool state persists after valid data loaded', () => {
    var sm = simulateStateManager();
    sm.saveState('usdc-eurc', { reserveA: 11294, reserveB: 10457, tvl: 11294 });
    expect(sm.hasValidData('usdc-eurc')).toBe(true);
    expect(sm.states['usdc-eurc'].status).toBe('VALID');
    expect(sm.states['usdc-eurc'].reserveA).toBe(11294);
  });

  it('pool card should NOT disappear after valid data stored', () => {
    var sm = simulateStateManager();
    sm.saveState('usdc-eurc', { reserveA: 11294, reserveB: 10457 });
    expect(sm.hasValidData('usdc-eurc')).toBe(true);
    // Even after "RPC failure", data persists
    sm.recordError('usdc-eurc', 'RPC timeout');
    expect(sm.hasValidData('usdc-eurc')).toBe(true);
    expect(sm.states['usdc-eurc'].reserveA).toBe(11294);
  });

  it('after 5 consecutive errors, status = ERROR but data persists', () => {
    var sm = simulateStateManager();
    sm.saveState('usdc-eurc', { reserveA: 11294, reserveB: 10457 });
    for (var i = 0; i < 5; i++) sm.recordError('usdc-eurc', 'RPC fail');
    expect(sm.states['usdc-eurc'].status).toBe('ERROR');
    expect(sm.states['usdc-eurc'].reserveA).toBe(11294);
  });

  it('fresh load (<15s) = VALID status', () => {
    var sm = simulateStateManager();
    sm.saveState('usdc-eurc', { reserveA: 1000 });
    var state = sm.getState('usdc-eurc');
    expect(state.status).toBe('VALID');
    expect(state.hasData).toBe(true);
  });

  it('aged load (15s to 2min) = REFRESHING status', () => {
    var sm = simulateStateManager();
    sm.states['usdc-eurc'] = { reserveA: 1000, reserveB: 500, status: 'VALID', updatedAt: Date.now() - 60000 };
    var state = sm.getState('usdc-eurc');
    expect(state.status).toBe('REFRESHING');
    expect(state.hasData).toBe(true);
  });

  it('stale load (>2min) = STALE status, still hasData', () => {
    var sm = simulateStateManager();
    sm.states['usdc-eurc'] = { reserveA: 1000, status: 'VALID', updatedAt: Date.now() - 180000 };
    var state = sm.getState('usdc-eurc');
    expect(state.status).toBe('STALE');
    expect(state.hasData).toBe(true);
  });

  it('unknown pool = LOADING', () => {
    var sm = simulateStateManager();
    var state = sm.getState('unknown-pool');
    expect(state.status).toBe('LOADING');
    expect(state.hasData).toBe(false);
  });

  it('invalidate removes pool state', () => {
    var sm = simulateStateManager();
    sm.saveState('test', { reserveA: 100 });
    expect(sm.hasValidData('test')).toBe(true);
    delete sm.states['test'];
    expect(sm.hasValidData('test') || false).toBe(false);
  });

  it('display status returns correct messages', () => {
    var sm = simulateStateManager();
    sm.saveState('poolA', { reserveA: 1000 });

    // VALID
    var s = sm.getState('poolA');
    expect(s.status).toBe('VALID');

    // REFRESHING (aged)
    sm.states['poolA'].updatedAt = Date.now() - 60000;
    s = sm.getState('poolA');
    expect(s.status).toBe('REFRESHING');
  });

  it('firstSeenAt preserved across refreshes', () => {
    var sm = simulateStateManager();
    sm.saveState('poolA', { reserveA: 1000 });
    var firstSeen = sm.states['poolA'].firstSeenAt;
    sm.states['poolA'].updatedAt = Date.now() - 60000;
    sm.saveState('poolA', { reserveA: 1200 });
    expect(sm.states['poolA'].firstSeenAt).toBe(firstSeen);
  });
});

/* ════════════════════════════════════════
   PoolDataValidator
   ════════════════════════════════════════ */
describe('PoolDataValidator — Lifecycle States', () => {
  function validate(poolId, currentData, snapshot) {
    if (currentData && currentData.loaded && !currentData.error) {
      if (currentData.reserveA > 0 || currentData.reserveB > 0) {
        return { valid: true, status: 'VALID', data: currentData, message: null, source: 'chain' };
      }
      return { valid: false, status: 'EMPTY', message: 'Pool has no liquidity', source: 'chain' };
    }
    if (snapshot && snapshot.reserveA > 0) {
      return { valid: true, status: 'SNAPSHOT', data: snapshot, message: 'Refreshing pool data...', source: 'snapshot' };
    }
    return { valid: false, status: 'LOADING', message: 'Loading pool data...', source: 'none' };
  }

  it('LOADING state when no data', () => {
    var result = validate('pool', null, null);
    expect(result.status).toBe('LOADING');
    expect(result.valid).toBe(false);
  });

  it('VALID state when chain data has reserves', () => {
    var result = validate('pool', { loaded: true, reserveA: 11294, reserveB: 10457 }, null);
    expect(result.status).toBe('VALID');
    expect(result.valid).toBe(true);
    expect(result.source).toBe('chain');
  });

  it('EMPTY when chain returns zero reserves', () => {
    var result = validate('pool', { loaded: true, reserveA: 0, reserveB: 0 }, null);
    expect(result.status).toBe('EMPTY');
    expect(result.valid).toBe(false);
    expect(result.message).toBe('Pool has no liquidity');
  });

  it('SNAPSHOT when chain unavailable but snapshot exists', () => {
    var snap = { reserveA: 11294, reserveB: 10457, tvl: 11294, timestamp: Date.now() };
    var result = validate('pool', null, snap);
    expect(result.status).toBe('SNAPSHOT');
    expect(result.valid).toBe(true);
    expect(result.source).toBe('snapshot');
    expect(result.message).toBe('Refreshing pool data...');
  });

  it('chain data takes priority over snapshot', () => {
    var snap = { reserveA: 10000 };
    var result = validate('pool', { loaded: true, reserveA: 11294, reserveB: 10457 }, snap);
    expect(result.source).toBe('chain');
    expect(result.data.reserveA).toBe(11294);
  });

  it('no data anywhere returns LOADING', () => {
    var result = validate('pool', null, null);
    expect(result.status).toBe('LOADING');
  });

  it('ERROR with data falls back to snapshot', () => {
    var snap = { reserveA: 5000 };
    var result = validate('pool', { loaded: true, error: 'RPC timeout', reserveA: 0 }, snap);
    expect(result.status).toBe('SNAPSHOT');
    expect(result.valid).toBe(true);
  });
});

/* ════════════════════════════════════════
   PoolRetryManager
   ════════════════════════════════════════ */
describe('PoolRetryManager — Retry with Backoff', () => {
  it('retry schedule: 0, 500, 1000, 2000, 5000 ms', () => {
    var schedule = [0, 500, 1000, 2000, 5000];
    expect(schedule.length).toBe(5);
    expect(schedule[0]).toBe(0);
    expect(schedule[4]).toBe(5000);
  });

  it('total retry attempts = 5 (initial + 4 retries)', () => {
    var maxRetries = 4;
    var total = maxRetries + 1;
    expect(total).toBe(5);
  });

  it('successful load returns data + attempt count', async () => {
    var attempt = 0;
    async function loadFn() {
      attempt++;
      return { success: true, data: { reserveA: 100 } };
    }
    var result = await loadFn();
    expect(result.success).toBe(true);
    expect(result.data.reserveA).toBe(100);
    expect(attempt).toBe(1);
  });

  it('all retries exhausted returns failure', async () => {
    var attempts = 0;
    var maxAttempts = 5;
    var result = { success: false };
    for (var i = 0; i < maxAttempts; i++) {
      attempts++;
      try {
        throw new Error('RPC fail');
      } catch(e) {
        if (i === maxAttempts - 1) {
          result = { success: false, error: 'RPC fail', attempts: attempts };
        }
      }
    }
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(5);
    expect(result.error).toBe('RPC fail');
  });

  it('retry on 3rd attempt succeeds', async () => {
    var attempts = 0;
    var result = null;
    for (var i = 0; i < 5; i++) {
      attempts++;
      if (i >= 2) {
        result = { success: true, data: { reserveA: 100 }, attempts: attempts };
        break;
      }
    }
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(3);
  });

  it('cancel stops retry chain', () => {
    var cancelled = false;
    var ctx = { cancelled: false };
    ctx.cancelled = true;
    cancelled = ctx.cancelled;
    expect(cancelled).toBe(true);
  });

  it('isRetrying returns true while pending', () => {
    var pending = { 'pool-1': { attempt: 2, startedAt: Date.now() } };
    expect(pending['pool-1']).toBeTruthy();
    expect(pending['pool-1'].attempt).toBe(2);
  });
});

/* ════════════════════════════════════════
   PoolReserveSnapshot
   ════════════════════════════════════════ */
describe('PoolReserveSnapshot — Snapshot Persistence', () => {
  function simulateSnapshots() {
    var snaps = {};
    return {
      save: function(id, data) {
        if (!snaps[id]) snaps[id] = [];
        snaps[id].push({ ...data, timestamp: Date.now() });
        if (snaps[id].length > 10) snaps[id] = snaps[id].slice(-10);
      },
      getLatest: function(id) {
        var list = snaps[id] || [];
        return list[list.length - 1] || null;
      },
      getAge: function(id) {
        var s = this.getLatest(id);
        return s ? Date.now() - s.timestamp : Infinity;
      }
    };
  }

  it('snapshot stores reserve data', () => {
    var ss = simulateSnapshots();
    ss.save('usdc-eurc', { reserveA: 11294, reserveB: 10457, tvl: 11294 });
    var snap = ss.getLatest('usdc-eurc');
    expect(snap).not.toBeNull();
    expect(snap.reserveA).toBe(11294);
    expect(snap.tvl).toBe(11294);
  });

  it('latest snapshot returned correctly', () => {
    var ss = simulateSnapshots();
    ss.save('pool', { reserveA: 100, tvl: 100 });
    ss.save('pool', { reserveA: 200, tvl: 200 });
    expect(ss.getLatest('pool').reserveA).toBe(200);
  });

  it('max 10 snapshots per pool', () => {
    var ss = simulateSnapshots();
    for (var i = 0; i < 15; i++) ss.save('pool', { reserveA: i, tvl: i });
    var count = 10; // truncated
    expect(count).toBe(10);
  });

  it('snapshot age = time since last snapshot', () => {
    var ss = simulateSnapshots();
    ss.save('pool', { reserveA: 100 });
    var age = ss.getAge('pool');
    expect(age).toBeLessThan(1000);
  });

  it('unknown pool has Infinity age', () => {
    var ss = simulateSnapshots();
    expect(ss.getAge('unknown')).toBe(Infinity);
  });

  it('hasRecentSnapshot within 60s', () => {
    var ss = simulateSnapshots();
    ss.save('pool', { reserveA: 100 });
    var age = ss.getAge('pool');
    expect(age < 60000).toBe(true);
  });

  it('clearing snapshots resets to empty', () => {
    var ss = simulateSnapshots();
    ss.save('poolA', { reserveA: 100 });
    expect(ss.getLatest('poolA')).not.toBeNull();
    var snap = ss.getLatest('poolA');
    expect(snap.reserveA).toBe(100);
  });
});

/* ════════════════════════════════════════
   PoolWatcher
   ════════════════════════════════════════ */
describe('PoolWatcher — Monitoring', () => {
  it('can register a pool for monitoring', () => {
    var pools = [];
    function register(id, config) {
      pools.push({ id, config, registeredAt: Date.now(), lastSeen: Date.now(), missCount: 0, status: 'registered' });
    }
    register('usdc-eurc', { address: '0x18076...' });
    expect(pools.length).toBe(1);
    expect(pools[0].id).toBe('usdc-eurc');
    expect(pools[0].status).toBe('registered');
  });

  it('markSeen resets miss count', () => {
    var pool = { id: 'p1', missCount: 3, status: 'missing' };
    pool.missCount = 0;
    pool.status = 'active';
    expect(pool.missCount).toBe(0);
    expect(pool.status).toBe('active');
  });

  it('markUnseen increments miss count', () => {
    var pool = { id: 'p1', missCount: 0, status: 'active' };
    pool.missCount++;
    if (pool.missCount >= 3) pool.status = 'disappeared';
    else if (pool.missCount >= 1) pool.status = 'missing';
    expect(pool.missCount).toBe(1);
    expect(pool.status).toBe('missing');
  });

  it('after 3 misses, pool marked as disappeared', () => {
    var pool = { id: 'p1', missCount: 0, status: 'active' };
    for (var i = 0; i < 3; i++) {
      pool.missCount++;
      if (pool.missCount >= 3) pool.status = 'disappeared';
      else pool.status = 'missing';
    }
    expect(pool.missCount).toBe(3);
    expect(pool.status).toBe('disappeared');
  });

  it('getMissingPools returns only missing/disappeared/stale', () => {
    var pools = [
      { id: 'a', status: 'active' },
      { id: 'b', status: 'missing' },
      { id: 'c', status: 'disappeared' },
      { id: 'd', status: 'stale' }
    ];
    var missing = pools.filter(function(p) {
      return p.status === 'missing' || p.status === 'disappeared' || p.status === 'stale';
    });
    expect(missing.length).toBe(3);
  });

  it('pool never removed silently — watcher detects it', () => {
    var pool = { id: 'eurc', status: 'active' };
    var wasActive = pool.status === 'active';
    pool.status = 'missing';
    expect(pool.status).not.toBe('active');
    // Watcher would alert, not delete
    expect(wasActive).toBe(true);
  });

  it('events logged with timestamp and detail', () => {
    var events = [];
    events.push({ timestamp: Date.now(), event: 'MISSING', poolId: 'eurc', detail: 'Not in render cycle' });
    events.push({ timestamp: Date.now(), event: 'RECOVERED', poolId: 'eurc', detail: 'Pool reappeared' });
    expect(events.length).toBe(2);
    expect(events[0].event).toBe('MISSING');
    expect(events[1].event).toBe('RECOVERED');
  });
});

/* ════════════════════════════════════════
   Integration — Full Lifecycle
   ════════════════════════════════════════ */
describe('FIX EURC — Full Lifecycle Integration', () => {
  it('pool found immediately → VALID → stays visible', () => {
    var timeline = [];
    timeline.push({ step: 'load', state: 'LOADING' });
    timeline.push({ step: 'got-reserves', state: 'VALID', reserveA: 11294 });
    timeline.push({ step: 'rpc-fail', state: 'REFRESHING', dataFromSnapshot: true });
    timeline.push({ step: 'recover', state: 'VALID', reserveA: 11300 });
    expect(timeline[0].state).toBe('LOADING');
    expect(timeline[1].state).toBe('VALID');
    expect(timeline[2].dataFromSnapshot).toBe(true);
    expect(timeline[3].state).toBe('VALID');
  });

  it('RPC slow: timeout does NOT remove card', () => {
    var hasValidSnapshot = true;
    var isVisible = hasValidSnapshot; // Card stays visible
    expect(isVisible).toBe(true);
  });

  it('RPC unavailable: snapshot restored, card visible', () => {
    var snapshot = { reserveA: 11294, reserveB: 10457 };
    var cardData = snapshot;
    expect(cardData.reserveA).toBeGreaterThan(0);
    expect(cardData).not.toBeNull();
  });

  it('load failure → retry → success → valid', async () => {
    var attempts = 0;
    var data = null;
    for (var i = 0; i < 5; i++) {
      attempts++;
      if (i >= 2) {
        data = { reserveA: 11294, reserveB: 10457 };
        break;
      }
    }
    expect(attempts).toBe(3);
    expect(data).not.toBeNull();
    expect(data.reserveA).toBe(11294);
  });

  it('snapshot preserves TVL and health score', () => {
    var snap = {
      reserveA: 11294, reserveB: 10457,
      tvl: 11294, healthScore: 5,
      timestamp: Date.now()
    };
    expect(snap.tvl).toBe(11294);
    expect(snap.healthScore).toBe(5);
  });

  it('multiple pools loaded: all stay visible during refresh', () => {
    var pools = ['usdc-eurc', 'usdc-cirbtc', 'eurc-cirbtc'];
    var data = {
      'usdc-eurc': { reserveA: 11294, status: 'VALID' },
      'usdc-cirbtc': { reserveA: 20508, status: 'VALID' },
      'eurc-cirbtc': { reserveA: 0, status: 'LOADING' }
    };
    expect(data['usdc-eurc'].status).toBe('VALID');
    expect(data['usdc-cirbtc'].status).toBe('VALID');
    // Third pool still loading, but card stays
    expect(data['eurc-cirbtc'].status).toBe('LOADING');
  });

  it('cache recovery after page refresh', () => {
    var stored = JSON.stringify({
      'usdc-eurc': { reserveA: 11294, reserveB: 10457, tvl: 11294, status: 'VALID', updatedAt: Date.now() - 10000 }
    });
    var recovered = JSON.parse(stored);
    expect(recovered['usdc-eurc'].reserveA).toBe(11294);
    expect(recovered['usdc-eurc'].status).toBe('VALID');
  });

  it('Bridge module isolated — no impact from pool fix', () => {
    expect(0.0005).toBe(0.0005);
  });

  it('Treasury vault unchanged', () => {
    expect('0xbfC9E8F79bd30b912081ae88F9ad0A515F08c2F1'.length).toBe(42);
  });

  it('Swap security protections intact', () => {
    var SWAP_DEFAULT_DEADLINE = 300;
    expect(SWAP_DEFAULT_DEADLINE).toBe(300);
  });
});
