/**
 * SCHEDULE ENGINE — Duplicate execution / idempotency tests (MS-2)
 * ═══════════════════════════════════════════════════════════════════════
 * Verifies the shared execution claim (ScheduleEngine.claimExecution) that
 * guarantees exactly-N on-chain executions for an intent with maxExecutions=N.
 *
 * MS-2 changes:
 *   - claimExecution is now ASYNC and returns { acquired, claim, reason }.
 *   - The claim store RE-READS localStorage on every operation, so TWO separate
 *     engine instances (simulating two browser tabs/workers sharing the same
 *     origin storage) correctly reject a concurrent second claim.
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

function makeLocalStorage() {
  const data = {};
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem(k, v) { data[k] = String(v); },
    removeItem(k) { delete data[k]; },
    _data: data,
  };
}

function makeContext(sharedLocalStorage) {
  return {
    Store: { load: () => [], save: () => {} },
    localStorage: sharedLocalStorage,
    document: { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} },
    Date, JSON, Object, Array, Promise, Math, Number, String,
  };
}

function makeEngine(sharedLocalStorage) {
  const context = makeContext(sharedLocalStorage);
  vm.createContext(context);
  vm.runInContext(extractScheduleEngine(src), context);
  return { engine: vm.runInContext('ScheduleEngine', context), context };
}

const KEY = 'SCH1|2026-01-01T00:00:00.000Z';
const META = { scheduleId: 'SCH1', occurrenceId: KEY, wallet: '0xaaa', chain: 'Arc Testnet' };

describe('ScheduleEngine execution claim (idempotency, MS-2)', () => {
  it('first executor claims the slot (async)', async () => {
    const { engine } = makeEngine(makeLocalStorage());
    const res = await engine.claimExecution(KEY, 'agent_schedule_executor', META);
    expect(res.acquired).toBe(true);
    expect(res.claim.occurrenceId).toBe(KEY);
    expect(res.claim.scheduleId).toBe('SCH1');
    expect(res.claim.status).toBe('claimed');
  });

  it('a second concurrent executor is rejected (no double execution)', async () => {
    const { engine } = makeEngine(makeLocalStorage());
    await engine.claimExecution(KEY, 'agent_schedule_executor', META);
    const res = await engine.claimExecution(KEY, 'batch_execution_engine', META);
    expect(res.acquired).toBe(false);
    expect(engine.isExecutionClaimed(KEY)).toBe(true);
  });

  it('TWO INSTANCES: only one wins the claim (cross-tab protection)', async () => {
    const ls = makeLocalStorage();
    const A = makeEngine(ls);
    const B = makeEngine(ls);
    const ra = await A.engine.claimExecution(KEY, 'agent_schedule_executor', META);
    const rb = await B.engine.claimExecution(KEY, 'agent_schedule_executor', META);
    expect(ra.acquired).toBe(true);
    expect(rb.acquired).toBe(false);
    expect(rb.reason).toBe('held_other');
  });

  it('the SAME executor cannot re-claim a held slot (multi-tab protection)', async () => {
    const { engine } = makeEngine(makeLocalStorage());
    await engine.claimExecution(KEY, 'agent_schedule_executor', META);
    const res = await engine.claimExecution(KEY, 'agent_schedule_executor', META);
    expect(res.acquired).toBe(false);
    expect(res.reason).toBe('held_self');
  });

  it('release only works for the owner', async () => {
    const { engine } = makeEngine(makeLocalStorage());
    await engine.claimExecution(KEY, 'agent_schedule_executor', META);
    expect(engine.releaseExecutionClaim(KEY, 'batch_execution_engine')).toBe(false);
    expect(engine.releaseExecutionClaim(KEY, 'agent_schedule_executor')).toBe(true);
    expect(engine.isExecutionClaimed(KEY)).toBe(false);
  });

  it('slot is claimable again after release (recurring schedules)', async () => {
    const { engine } = makeEngine(makeLocalStorage());
    await engine.claimExecution(KEY, 'agent_schedule_executor', META);
    engine.releaseExecutionClaim(KEY, 'agent_schedule_executor');
    const res = await engine.claimExecution(KEY, 'agent_schedule_executor', META);
    expect(res.acquired).toBe(true);
  });

  it('distinct occurrence slots are independent (occurrence 1 vs occurrence 2)', async () => {
    const { engine } = makeEngine(makeLocalStorage());
    const next = 'SCH1|2026-01-02T00:00:00.000Z';
    const r1 = await engine.claimExecution(KEY, 'agent_schedule_executor', META);
    const r2 = await engine.claimExecution(next, 'agent_schedule_executor', { ...META, occurrenceId: next });
    expect(r1.acquired).toBe(true);
    expect(r2.acquired).toBe(true);
  });

  it('claims persist to localStorage (multi-tab protection)', async () => {
    const ls = makeLocalStorage();
    const { engine } = makeEngine(ls);
    await engine.claimExecution(KEY, 'batch_execution_engine', META);
    const persisted = JSON.parse(ls.getItem('elligentt_sched_claims_v1'));
    expect(persisted[KEY]).toBeDefined();
    expect(persisted[KEY].executor).toBe('batch_execution_engine');
    expect(persisted[KEY].owner).toBeDefined();
  });

  it('claim is removed from persistence after release', async () => {
    const ls = makeLocalStorage();
    const { engine } = makeEngine(ls);
    await engine.claimExecution(KEY, 'agent_schedule_executor', META);
    engine.releaseExecutionClaim(KEY, 'agent_schedule_executor');
    const persisted = JSON.parse(ls.getItem('elligentt_sched_claims_v1'));
    expect(persisted[KEY]).toBeUndefined();
  });
});

describe('ScheduleEngine claim — terminal & submitted states (MS-2.2/2.3/2.6)', () => {
  it('a CONFIRMED occurrence can never be re-claimed', async () => {
    const { engine } = makeEngine(makeLocalStorage());
    await engine.claimExecution(KEY, 'agent_schedule_executor', META);
    engine.updateExecutionClaim(KEY, 'agent_schedule_executor', { status: 'confirmed', txHash: '0xabc' });
    const res = await engine.claimExecution(KEY, 'batch_execution_engine', META);
    expect(res.acquired).toBe(false);
    expect(res.reason).toBe('terminal_confirmed');
  });

  it('a FAILED occurrence can never be re-claimed', async () => {
    const { engine } = makeEngine(makeLocalStorage());
    await engine.claimExecution(KEY, 'agent_schedule_executor', META);
    engine.updateExecutionClaim(KEY, 'agent_schedule_executor', { status: 'failed', txHash: null });
    const res = await engine.claimExecution(KEY, 'batch_execution_engine', META);
    expect(res.acquired).toBe(false);
    expect(res.reason).toBe('terminal_failed');
  });

  it('a SUBMITTED occurrence (txHash known) is never re-broadcast even after lease expiry', async () => {
    const ls = makeLocalStorage();
    const A = makeEngine(ls);
    await A.engine.claimExecution(KEY, 'agent_schedule_executor', META, 50); // 50ms lease
    A.engine.updateExecutionClaim(KEY, 'agent_schedule_executor', { status: 'submitted', txHash: '0xdeadbeef' });
    await new Promise((r) => setTimeout(r, 80)); // let the lease expire
    const B = makeEngine(ls); // fresh instance (simulates another tab after expiry)
    const res = await B.engine.claimExecution(KEY, 'batch_execution_engine', META);
    expect(res.acquired).toBe(false);
    expect(res.reason).toBe('submitted');
  });

  it('lease renewal extends the ownership window', async () => {
    const { engine } = makeEngine(makeLocalStorage());
    await engine.claimExecution(KEY, 'agent_schedule_executor', META, 50);
    expect(engine.renewExecutionClaim(KEY, 'agent_schedule_executor', 60000)).toBe(true);
    // Still held by same owner, not expired.
    const res = await engine.claimExecution(KEY, 'batch_execution_engine', META);
    expect(res.acquired).toBe(false);
  });

  it('renew does not work for a different executor', async () => {
    const { engine } = makeEngine(makeLocalStorage());
    await engine.claimExecution(KEY, 'agent_schedule_executor', META);
    expect(engine.renewExecutionClaim(KEY, 'batch_execution_engine', 60000)).toBe(false);
  });
});
