import { describe, it, expect } from 'vitest';
import {
  buildLedgerEntry,
  recordLedgerEntry,
  recordLedgerEntries,
  readLedger,
  aggregateLedger,
  LEDGER_STAGES,
  LEDGER_STATUS,
} from '../functions/api/ledger.mjs';

function createMockKV() {
  const store = new Map();
  return {
    _store: store,
    async put(key, value) { store.set(key, value); },
    async get(key) { return store.get(key) ?? null; },
    async list({ prefix = '', limit = 1000 } = {}) {
      const keys = Array.from(store.keys())
        .filter(k => k.startsWith(prefix))
        .slice(0, limit)
        .map(name => ({ name }));
      return { keys };
    },
  };
}

describe('Treasury Ledger — Multi-Application accounting', () => {
  it('builds a normalized entry with defaults (ELLIGENT / default / 1)', () => {
    const e = buildLedgerEntry({ intentId: 'INT-1', stage: LEDGER_STAGES.VAULT_DEBIT, amount: 10, asset: 'USDC' });
    expect(e.application).toBe('ELLIGENT');
    expect(e.client).toBe('default');
    expect(e.version).toBe('1');
    expect(e.asset).toBe('usdc');
    expect(e.status).toBe(LEDGER_STATUS.PENDING);
    expect(typeof e.id).toBe('string');
    expect(typeof e.timestamp).toBe('number');
  });

  it('takes attribution from a context object', () => {
    const e = buildLedgerEntry({ context: { application: 'EXECDAAT', client: 'acme', version: '2' }, amount: 5 });
    expect(e.application).toBe('EXECDAAT');
    expect(e.client).toBe('acme');
    expect(e.version).toBe('2');
  });

  it('drops unknown fields (no secret leakage into the ledger)', () => {
    const e = buildLedgerEntry({ intentId: 'INT-1', privateKey: '0xdeadbeef', signature: '0xsig' });
    expect(e.privateKey).toBeUndefined();
    expect(e.signature).toBeUndefined();
  });

  it('is a no-op (never throws) when no KV is bound', async () => {
    const r = await recordLedgerEntry(null, { intentId: 'INT-1' });
    expect(r.recorded).toBe(false);
    expect(r.reason).toBe('no_kv');
    expect(r.entry.intentId).toBe('INT-1');
  });

  it('persists and reads back entries via KV', async () => {
    const kv = createMockKV();
    await recordLedgerEntry(kv, { context: { application: 'ELLIGENT', client: 'default' }, intentId: 'A', stage: LEDGER_STAGES.TREASURY_PAYMENT, amount: 100, status: LEDGER_STATUS.SUCCESS });
    await recordLedgerEntry(kv, { context: { application: 'EXECDAAT', client: 'acme' }, intentId: 'B', stage: LEDGER_STAGES.TREASURY_PAYMENT, amount: 40, status: LEDGER_STATUS.SUCCESS });
    const all = await readLedger(kv, {});
    expect(all.length).toBe(2);
    const execOnly = await readLedger(kv, { application: 'EXECDAAT' });
    expect(execOnly.length).toBe(1);
    expect(execOnly[0].intentId).toBe('B');
  });

  it('records multiple stages best-effort', async () => {
    const kv = createMockKV();
    const entries = await recordLedgerEntries(kv, [
      { intentId: 'C', stage: LEDGER_STAGES.VAULT_DEBIT, amount: 10 },
      { intentId: 'C', stage: LEDGER_STAGES.TREASURY_PAYMENT, amount: 10 },
    ]);
    expect(entries.length).toBe(2);
    const stored = await readLedger(kv, {});
    expect(stored.length).toBe(2);
  });

  it('aggregates per-application metrics', async () => {
    const entries = [
      { application: 'ELLIGENT', client: 'default', intentId: 'A', stage: LEDGER_STAGES.TREASURY_PAYMENT, amount: 100, status: LEDGER_STATUS.SUCCESS },
      { application: 'ELLIGENT', client: 'default', intentId: 'A', stage: LEDGER_STAGES.VAULT_CREDIT, amount: 100, status: LEDGER_STATUS.SUCCESS },
      { application: 'EXECDAAT', client: 'acme', intentId: 'B', stage: LEDGER_STAGES.TREASURY_PAYMENT, amount: 40, status: LEDGER_STATUS.SUCCESS },
    ];
    const agg = aggregateLedger(entries).sort((a, b) => a.application.localeCompare(b.application));
    const elligent = agg.find(a => a.application === 'ELLIGENT');
    const execdaat = agg.find(a => a.application === 'EXECDAAT');
    expect(elligent.treasuryPaid).toBe(100);
    expect(elligent.vaultCredited).toBe(100);
    expect(elligent.treasuryOutstanding).toBe(0);
    expect(elligent.intentCount).toBe(1);
    expect(execdaat.treasuryPaid).toBe(40);
    expect(execdaat.treasuryOutstanding).toBe(40); // paid, not yet reimbursed
  });

  it('readLedger is a no-op with no KV', async () => {
    const r = await readLedger(null, {});
    expect(r).toEqual([]);
  });
});
