/**
 * SCHEDULE ENGINE — Duplicate execution / idempotency tests
 * ═══════════════════════════════════════════════════════════════════════
 * Verifies the shared execution claim (ScheduleEngine.claimExecution) that
 * guarantees exactly-N on-chain executions for an intent with maxExecutions=N.
 *
 * Root cause covered: two independent scheduler loops (AgentScheduleExecutor +
 * BatchExecutionEngine) both executed the same due schedule. The shared claim
 * ensures only ONE executor can claim a given execution slot (scheduleId|nextRun).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');

function extractScheduleEngine(srcHtml) {
  const start = srcHtml.indexOf('const ScheduleEngine = (() => {');
  if (start < 0) throw new Error('ScheduleEngine not found');
  const bodyStart = srcHtml.indexOf('{', start);
  let depth = 0, end = -1;
  for (let j = bodyStart; j < srcHtml.length; j++) {
    if (srcHtml[j] === '{') depth++;
    else if (srcHtml[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
  }
  return srcHtml.slice(start, end + 1) + ')();';
}

function makeEngine() {
  const mem = {};
  const localStorageMock = {
    _data: {},
    getItem(k) { return this._data[k] ?? null; },
    setItem(k, v) { this._data[k] = String(v); },
    removeItem(k) { delete this._data[k]; },
  };
  const context = {
    Store: { load: () => [], save: () => {} },
    localStorage: localStorageMock,
    document: { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} },
    Date, JSON, Object, Array,
  };
  vm.createContext(context);
  vm.runInContext(extractScheduleEngine(src), context);
  return { engine: vm.runInContext('ScheduleEngine', context), localStorage: localStorageMock };
}

const KEY = 'SCH1|2026-01-01T00:00:00.000Z';

describe('ScheduleEngine execution claim (idempotency)', () => {
  it('first executor claims the slot', () => {
    const { engine } = makeEngine();
    expect(engine.claimExecution(KEY, 'agent_schedule_executor')).toBe(true);
  });

  it('a second concurrent executor is rejected (no double execution)', () => {
    const { engine } = makeEngine();
    engine.claimExecution(KEY, 'agent_schedule_executor');
    expect(engine.claimExecution(KEY, 'batch_execution_engine')).toBe(false);
    expect(engine.isExecutionClaimed(KEY)).toBe(true);
  });

  it('the SAME executor cannot re-claim a held slot (multi-tab protection)', () => {
    const { engine } = makeEngine();
    engine.claimExecution(KEY, 'agent_schedule_executor');
    // A second tab/instance using the same executor name must be rejected too —
    // otherwise two tabs would both broadcast the same scheduled operation.
    expect(engine.claimExecution(KEY, 'agent_schedule_executor')).toBe(false);
    expect(engine.isExecutionClaimed(KEY)).toBe(true);
  });

  it('release only works for the owner', () => {
    const { engine } = makeEngine();
    engine.claimExecution(KEY, 'agent_schedule_executor');
    expect(engine.releaseExecutionClaim(KEY, 'batch_execution_engine')).toBe(false);
    expect(engine.releaseExecutionClaim(KEY, 'agent_schedule_executor')).toBe(true);
    expect(engine.isExecutionClaimed(KEY)).toBe(false);
  });

  it('slot is claimable again after release (recurring schedules)', () => {
    const { engine } = makeEngine();
    engine.claimExecution(KEY, 'agent_schedule_executor');
    engine.releaseExecutionClaim(KEY, 'agent_schedule_executor');
    expect(engine.claimExecution(KEY, 'agent_schedule_executor')).toBe(true);
  });

  it('distinct execution slots are independent', () => {
    const { engine } = makeEngine();
    const next = 'SCH1|2026-01-02T00:00:00.000Z';
    expect(engine.claimExecution(KEY, 'agent_schedule_executor')).toBe(true);
    expect(engine.claimExecution(next, 'agent_schedule_executor')).toBe(true);
  });

  it('claims persist to localStorage (multi-tab protection)', () => {
    const { engine, localStorage } = makeEngine();
    engine.claimExecution(KEY, 'batch_execution_engine');
    const persisted = JSON.parse(localStorage.getItem('elligentt_sched_claims_v1'));
    expect(persisted[KEY]).toBeDefined();
    expect(persisted[KEY].executor).toBe('batch_execution_engine');
  });

  it('claim is removed from persistence after release', () => {
    const { engine, localStorage } = makeEngine();
    engine.claimExecution(KEY, 'agent_schedule_executor');
    engine.releaseExecutionClaim(KEY, 'agent_schedule_executor');
    const persisted = JSON.parse(localStorage.getItem('elligentt_sched_claims_v1'));
    expect(persisted[KEY]).toBeUndefined();
  });
});
