/**
 * autonoma-doc-flows.test.js
 * ═══════════════════════════════════════════════════════════════════════
 * Guards the guided CSV document flows in Autonoma (Execute Now / Schedule /
 * Recurring / Payroll):
 *
 *   · each flow has its own handler (exposed on window for inline onclick)
 *   · Schedule offers the time submenu + a confirmation step
 *   · Recurring exposes only executor-supported frequencies (hourly/30-min are
 *     explicitly marked unsupported — no simulated recurrence)
 *   · Execute Now / Payroll review recipients and highlight duplicates
 *   · duplicate/invalid detection + double-click guard + status confirmation
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const intelSrc = fs.readFileSync(path.join(root, 'shared', 'autonomaDocumentIntelligence.js'), 'utf8');

function loadIntel() {
  const w = {};
  new Function('window', intelSrc).call(null, w);
  return w.AutonomaDocIntel;
}

describe('Autonoma doc flows — handlers exposed', () => {
  it('exposes Execute Now / Schedule / Recurring / Payroll flow entry points', () => {
    expect(html).toContain('function autDocFlowExecute()');
    expect(html).toContain('function autDocFlowSchedule()');
    expect(html).toContain('function autDocFlowRecurring()');
    expect(html).toContain('function autDocFlowPayroll()');
  });

  it('exposes the window.* action handlers for inline onclick', () => {
    expect(html).toContain('window.autDocFlowExecuteDo = function');
    expect(html).toContain('window.autDocFlowSchedulePick = function');
    expect(html).toContain('window.autDocFlowScheduleCustomConfirm = function');
    expect(html).toContain('window.autDocFlowScheduleDo = function');
    expect(html).toContain('window.autDocFlowRecurringPick = function');
    expect(html).toContain('window.autDocFlowRecurringConfirm = function');
    expect(html).toContain('window.autDocFlowRecurringDo = function');
  });
});

describe('Schedule flow — time submenu + confirmation', () => {
  it('offers the time submenu options', () => {
    expect(html).toContain("label:'Execute Now'");
    expect(html).toContain("label:'In 30 minutes'");
    expect(html).toContain("label:'In 1 hour'");
    expect(html).toContain("label:'In 1 day'");
    expect(html).toContain("label:'Custom date and time'");
  });

  it('shows a predicted date/time and a confirm step', () => {
    const fn = html.slice(html.indexOf('function autDocFlowScheduleConfirm('), html.indexOf('window.autDocFlowScheduleDo'));
    expect(fn).toContain('Scheduled for');
    expect(fn).toContain('Confirm and Schedule');
  });

  it('requires confirmation before scheduling (ScheduleEngine.create in Do)', () => {
    const fn = html.slice(html.indexOf('function autDocScheduleAll('), html.indexOf('function autDocDispatchAll('));
    expect(fn).toContain('ScheduleEngine.create({');
    expect(fn).toContain('nextRun: nextRunIso');
  });
});

describe('Recurring flow — supported frequencies only', () => {
  it('exposes supported frequencies (daily/weekly/biweekly/monthly)', () => {
    expect(html).toContain("{ key:'daily', label:'Daily', supported:true }");
    expect(html).toContain("{ key:'weekly', label:'Weekly', supported:true }");
    expect(html).toContain("{ key:'biweekly', label:'Bi-weekly', supported:true }");
    expect(html).toContain("{ key:'monthly', label:'Monthly', supported:true }");
  });

  it('marks hourly / every-30-min as unsupported (no simulated recurrence)', () => {
    expect(html).toContain("{ key:'hourly', label:'Hourly', supported:false }");
    expect(html).toContain("{ key:'m30', label:'Every 30 min', supported:false }");
  });

  it('schedules with freq + maxEx via the real executor', () => {
    const fn = html.slice(html.indexOf('window.autDocFlowRecurringDo = function'), html.indexOf('// ── Payroll ──'));
    expect(fn).toContain('autDocScheduleAll(freq, firstIso, maxEx)');
  });
});

describe('Execute Now / Payroll — review + duplicates + guard', () => {
  it('Execute Now reviews count/total/network/recipients before confirming', () => {
    const fn = html.slice(html.indexOf('function autDocFlowExecute()'), html.indexOf('window.autDocFlowExecuteDo'));
    expect(fn).toContain('Payments');
    expect(fn).toContain('Recipients');
    expect(fn).toContain('Confirm and Execute');
    expect(fn).toContain('Cancel');
  });

  it('Payroll reviews recipients and routes to Pay Now / Schedule / Recurring', () => {
    const fn = html.slice(html.indexOf('function autDocFlowPayroll()'), html.indexOf('window.autDocExecute = function'));
    expect(fn).toContain('Recipients');
    expect(fn).toContain("label:'Pay Now'");
    expect(fn).toContain("label:'Schedule'");
    expect(fn).toContain("label:'Recurring'");
  });

  it('detects duplicate addresses (highlight) + double-click guard', () => {
    expect(html).toContain('function autDocDuplicateIdx()');
    expect(html).toContain('var autDocBusy = false');
    expect(html).toContain('if (autDocBusy) return;');
  });

  it('dispatches through the Circle AI Smart Wallet (no mock executor)', () => {
    const fn = html.slice(html.indexOf('function autDocDispatchAll()'), html.indexOf('// ── Execute Now ──'));
    expect(fn).toContain('AIWallet.submitIntent({');
  });
});

describe('AutonomaDocIntel — CSV validation', () => {
  const Intel = loadIntel();

  it('detects duplicate addresses', () => {
    const A = '0x' + '11'.repeat(20);
    const csv = 'address,amount,token\n' + A + ',100,USDC\n' + A + ',50,USDC\n';
    const r = Intel.parseCSV(csv);
    expect(r.rows.length).toBe(2); // both valid rows present
    expect(r.errors.some((e) => /duplicate/i.test(e))).toBe(true);
  });

  it('skips invalid addresses (blocked from execution)', () => {
    const B = '0x' + '22'.repeat(20);
    const csv = 'address,amount,token\nnot-an-address,100,USDC\n' + B + ',50,USDC\n';
    const r = Intel.parseCSV(csv);
    expect(r.rows.length).toBe(1); // invalid row excluded
    expect(r.rows[0].address.toLowerCase()).toBe(B);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('skips rows with an invalid amount', () => {
    const B = '0x' + '22'.repeat(20);
    const csv = 'address,amount,token\n' + B + ',abc,USDC\n' + B + ',50,USDC\n';
    const r = Intel.parseCSV(csv);
    expect(r.rows.length).toBeLessThanOrEqual(1);
  });

  it('parseFile returns a success result with summary + rows', () => {
    const B = '0x' + '22'.repeat(20);
    const csv = 'address,amount,token\n' + B + ',100,USDC\n';
    const r = Intel.parseFile('test.csv', csv, false, '');
    expect(r.success).toBe(true);
    expect(r.rows.length).toBe(1);
    expect(r.summary.totalPayments).toBe(1);
  });

  it('parses multiple tokens and networks (no single-network assumption)', () => {
    const A = '0x' + '11'.repeat(20);
    const B = '0x' + '22'.repeat(20);
    const csv = 'address,amount,token,chain\n' + A + ',100,USDC,Arc_Mainnet\n' + B + ',50,EURC,Base\n';
    const r = Intel.parseFile('t.csv', csv, false, '');
    expect(r.success).toBe(true);
    expect(r.rows.length).toBe(2);
    expect(r.summary.tokenSummary.length).toBe(2); // USDC + EURC
    expect(r.rows[0]._chain).toBe('Arc_Mainnet');
    expect(r.rows[1]._chain).toBe('Base');
  });
});

describe('Execute Now — duplicate blocking + real states', () => {
  it('blocks execution and offers duplicate removal', () => {
    expect(html).toContain('function autDocRemoveDuplicates()');
    expect(html).toContain('window.autDocFlowExecuteRemoveDups = function');
    expect(html).toContain("label:'Remove Duplicates'");
    expect(html).toContain("label:'Confirm and Execute'");
  });

  it('re-checks duplicates before dispatch (final guard)', () => {
    const fn = html.slice(html.indexOf('window.autDocFlowExecuteDo = function'), html.indexOf('// ── Schedule ──'));
    expect(fn).toContain('if (autDocDuplicateIdx().length > 0)');
  });

  it('counts requested vs rejected from submitIntent return value', () => {
    const fn = html.slice(html.indexOf('function autDocDispatchAll()'), html.indexOf('// ── Execute Now ──'));
    expect(fn).toContain('if (id) { requested++;');
    expect(fn).toContain('else rejected++;');
  });

  it('reports requested/rejected (never a false "completed")', () => {
    const fn = html.slice(html.indexOf('window.autDocFlowExecuteDo = function'), html.indexOf('// ── Schedule ──'));
    expect(fn).toContain("R.row('Requested', res.requested");
    expect(fn).toContain("R.row('Rejected', res.rejected");
    expect(fn).not.toContain("'Dispatched'");
  });
});

describe('Schedule / Recurring — idempotency + partial results', () => {
  it('schedules with a deterministic id (no duplicate on retry)', () => {
    const fn = html.slice(html.indexOf('function autDocScheduleAll('), html.indexOf('// Dispatch every row'));
    expect(fn).toContain("var id = 'SCH_DOC_' + _autDocHash(");
    expect(fn).toContain('ScheduleEngine.getById(id)');
  });

  it('reports created / failed / skipped distinctly', () => {
    expect(html).toContain("R.row('Created', res.created");
    expect(html).toContain("R.row('Failed', res.failed");
    expect(html).toContain("R.row('Skipped', res.skipped");
  });

  it('validates a future first-run time', () => {
    const fn = html.slice(html.indexOf('window.autDocFlowRecurringConfirm = function'), html.indexOf('window.autDocFlowRecurringDo'));
    expect(fn).toContain('<= Date.now()');
  });
});

describe('Totals separated by token and network', () => {
  it('computes token + network totals', () => {
    expect(html).toContain('function autDocTokenTotals()');
    expect(html).toContain('function autDocNetworkTotals()');
    expect(html).toContain('function autDocTotalsSection()');
  });

  it('renders totals-by-network (no single-network assumption)', () => {
    const fn = html.slice(html.indexOf('function autDocTotalsSection()'), html.indexOf('// Duplicate address detection'));
    expect(fn).toContain("R.section('Totals by network')");
  });
});
