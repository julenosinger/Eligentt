/**
 * billing-date-fields.test.js
 * ═══════════════════════════════════════════════════════════════════════
 * Guards the Billing date fields (invoice filters + due date). They must
 * reuse the shared EnglishDatePicker (calendar, date-only) instead of the
 * native `type="date"` input, display MM/DD/YYYY, and keep the internal
 * value as ISO YYYY-MM-DD (the exact contract the invoice backend & flows
 * already consume — no time component, no timezone shift).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function billingSection() {
  const start = html.indexOf('id="page-invoices"');
  const end = html.indexOf('id="page-recipients"');
  return html.slice(start, end);
}

// Extract the shared EnglishDatePicker's pure isoToDisplay to verify the
// exact display format the Billing fields will show.
function loadIsoToDisplay() {
  const start = html.indexOf('function isoToDisplay(iso, mode){');
  const end = html.indexOf('function applyDisplay(el){', start);
  const block = html.slice(start, end);
  const fn = new Function(block + '\nreturn isoToDisplay;');
  return fn();
}

describe('Billing date fields — reuse the shared EnglishDatePicker', () => {
  const b = billingSection();

  it('all three Billing date fields use the shared picker (data-eldp="date")', () => {
    expect(b).toMatch(/id="inv-filter-date-from"[^>]*data-eldp="date"/);
    expect(b).toMatch(/id="inv-filter-date-to"[^>]*data-eldp="date"/);
    expect(b).toMatch(/id="inv-due"[^>]*data-eldp="date"/);
  });

  it('date fields are readonly + cursor pointer (no manual typing)', () => {
    expect(b).toMatch(/id="inv-filter-date-from"[^>]*readonly/);
    expect(b).toMatch(/id="inv-filter-date-to"[^>]*readonly/);
    expect(b).toMatch(/id="inv-due"[^>]*readonly/);
    expect(b).toContain('cursor:pointer');
  });

  it('no native type="date" remains in the Billing section', () => {
    expect(b).not.toContain('type="date"');
  });

  it('date fields display placeholder MM/DD/YYYY', () => {
    expect(b).toContain('placeholder="MM/DD/YYYY"');
  });

  it('filter fields keep onchange="renderInvoices()"', () => {
    expect(b).toContain('onchange="renderInvoices()"');
  });

  it('due date field triggers the live preview on change', () => {
    expect(b).toContain('onchange="invPreviewUpdate()"');
  });
});

describe('Billing date value contract — ISO YYYY-MM-DD (unchanged)', () => {
  it('programmatic setters still write an ISO date (no time component)', () => {
    expect(html).toContain("setVal('inv-due', d.toISOString().slice(0, 10))");
    expect(html).toContain("setVal('inv-due', dueDate.toISOString().slice(0,10))");
  });

  it('createInvoice still reads inv-due .value (ISO YYYY-MM-DD)', () => {
    const fn = html.slice(html.indexOf('function createInvoice('), html.indexOf('// Collect line items'));
    expect(fn).toContain("document.getElementById('inv-due')?.value");
    expect(fn).toContain('const due');
  });

  it('date filters still compare ISO strings in renderInvoices()', () => {
    const fn = html.slice(html.indexOf('function renderInvoices('), html.indexOf('function invDueCountdown('));
    expect(fn).toContain("document.getElementById('inv-filter-date-from').value");
    expect(fn).toContain("document.getElementById('inv-filter-date-to').value");
  });

  it('scheduleFromInvoice still consumes inv.due as a date-only string (no behavior change)', () => {
    const fn = html.slice(html.indexOf('function scheduleFromInvoice('), html.indexOf('// Schedule view filter'));
    expect(fn).toContain("new Date(inv.due + 'T00:00:00Z')");
  });
});

describe('EnglishDatePicker — date mode display format', () => {
  const isoToDisplay = loadIsoToDisplay();

  it('renders a date-only ISO as MM/DD/YYYY', () => {
    expect(isoToDisplay('2026-10-20', 'date')).toBe('10/20/2026');
    expect(isoToDisplay('2026-01-05', 'date')).toBe('01/05/2026');
  });

  it('renders a datetime ISO as MM/DD/YYYY HH:mm (24h)', () => {
    expect(isoToDisplay('2026-10-20T14:30', 'datetime')).toBe('10/20/2026 14:30');
  });

  it('returns empty for missing ISO', () => {
    expect(isoToDisplay('', 'date')).toBe('');
    expect(isoToDisplay(null, 'date')).toBe('');
  });
});
