/**
 * Billing Activation Tests — 25 scenarios
 * Verifies that the Billing page HTML is fully activated (no Under Construction),
 * all required DOM IDs are present, backend defaults are Arc Mainnet,
 * and no regressions exist in other pages.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
const invoiceJs = fs.readFileSync(path.resolve(__dirname, '../functions/api/invoice.js'), 'utf8');
const payLinksJs = fs.readFileSync(path.resolve(__dirname, '../functions/api/payment-links.js'), 'utf8');

// ── 1. Billing page is no longer "Under Construction" ──────────────────────
describe('Billing: page activation', () => {
  it('1. Under Construction text is removed from billing page', () => {
    // Get only the billing page section
    const billingStart = html.indexOf('id="page-invoices"');
    const billingEnd = html.indexOf('id="page-recipients"');
    const billingSection = html.slice(billingStart, billingEnd);
    expect(billingSection).not.toContain('Under Construction');
  });

  it('2. Billing page has AVAILABLE ROUTES structure (billing views)', () => {
    expect(html).toContain('id="billing-view-invoices"');
    expect(html).toContain('id="billing-view-links"');
  });

  it('3. Billing segmented control buttons present with correct data-mode', () => {
    expect(html).toContain('class="btn billing-seg-btn" data-mode="invoices"');
    expect(html).toContain('class="btn billing-seg-btn" data-mode="links"');
  });
});

// ── 2. Overview stats IDs ──────────────────────────────────────────────────
describe('Billing: stats DOM IDs', () => {
  it('4. Total revenue stat element present', () => {
    expect(html).toContain('id="inv-stat-revenue"');
  });
  it('5. Outstanding stat element present', () => {
    expect(html).toContain('id="inv-stat-outstanding"');
  });
  it('6. Paid total stat element present', () => {
    expect(html).toContain('id="inv-stat-paid-total"');
  });
  it('7. Cross-chain volume stat present', () => {
    expect(html).toContain('id="inv-stat-xchain"');
  });
  it('8. Success rate stat present', () => {
    expect(html).toContain('id="inv-stat-rate"');
  });
  it('9. Overdue count stat present', () => {
    expect(html).toContain('id="inv-stat-overdue"');
  });
  it('10. Extended stats IDs (invfi-stat-*) present', () => {
    expect(html).toContain('id="invfi-stat-total-revenue"');
    expect(html).toContain('id="invfi-stat-paid-total"');
    expect(html).toContain('id="invfi-stat-xchain-vol"');
  });
});

// ── 3. Create Invoice form IDs ─────────────────────────────────────────────
describe('Billing: create invoice form', () => {
  it('11. Invoice number input present', () => {
    expect(html).toContain('id="inv-num"');
  });
  it('12. Recipient address input present', () => {
    expect(html).toContain('id="inv-to-addr"');
  });
  it('13. Amount input present', () => {
    expect(html).toContain('id="inv-amount"');
  });
  it('14. Currency selector present', () => {
    expect(html).toContain('id="inv-currency"');
  });
  it('15. Payment method checkboxes present (USDC, EURC, CCTP, cross-chain)', () => {
    expect(html).toContain('id="inv-pm-usdc"');
    expect(html).toContain('id="inv-pm-eurc"');
    expect(html).toContain('id="inv-pm-xchain"');
    expect(html).toContain('id="inv-pm-cctpv2"');
  });
  it('16. Cross-chain network checkboxes use correct class (invfi-net-cb)', () => {
    expect(html).toContain('class="invfi-net-cb"');
  });
  it('17. CCTP v2 network checkboxes use correct class (invfi-cctpv2-net-cb)', () => {
    expect(html).toContain('class="invfi-cctpv2-net-cb"');
  });
  it('18. Line items container present', () => {
    expect(html).toContain('id="inv-line-items"');
  });
  it('19. Tab buttons present (inv-tab-list, inv-tab-create)', () => {
    expect(html).toContain('id="inv-tab-list"');
    expect(html).toContain('id="inv-tab-create"');
  });
  it('20. Panels present (inv-panel-list, inv-panel-create)', () => {
    expect(html).toContain('id="inv-panel-list"');
    expect(html).toContain('id="inv-panel-create"');
  });
  it('21. Invoice tbody present for renderInvoices()', () => {
    expect(html).toContain('id="inv-tbody"');
  });
  it('22. Empty state element present', () => {
    expect(html).toContain('id="inv-empty"');
  });
});

// ── 4. Payment Links DOM IDs ───────────────────────────────────────────────
describe('Billing: payment links DOM', () => {
  it('23. Payment links cards body present (pl-cards-body)', () => {
    expect(html).toContain('id="pl-cards-body"');
  });
  it('24. Payment links empty state present (pl-empty)', () => {
    expect(html).toContain('id="pl-empty"');
  });
  it('25. Payment links create form area present (pl-create-form-area)', () => {
    expect(html).toContain('id="pl-create-form-area"');
  });
});

// ── 5. Invoice drawer ──────────────────────────────────────────────────────
describe('Billing: invoice drawer', () => {
  it('26. Invoice drawer overlay present', () => {
    expect(html).toContain('id="invfi-drawer-overlay"');
  });
  it('27. Invoice drawer panel present', () => {
    expect(html).toContain('id="invfi-drawer"');
  });
  it('28. Invoice drawer content container present', () => {
    expect(html).toContain('id="invfi-drawer-content"');
  });
});

// ── 6. Arc Mainnet default in backend ─────────────────────────────────────
describe('Billing: Arc Mainnet defaults', () => {
  it('29. invoice.js defaults to Arc Mainnet (not Arc Testnet)', () => {
    expect(invoiceJs).toContain("chain || 'Arc Mainnet'");
    expect(invoiceJs).not.toContain("chain || 'Arc Testnet'");
  });
  it('30. payment-links.js defaults to Arc Mainnet (not Arc Testnet)', () => {
    expect(payLinksJs).toContain("chain || 'Arc Mainnet'");
    expect(payLinksJs).not.toContain("chain || 'Arc Testnet'");
  });
});

// ── 7. Cross-chain support indicators ─────────────────────────────────────
describe('Billing: cross-chain support', () => {
  it('31. Arc Mainnet network option present in cross-chain checklist', () => {
    expect(html).toContain('value="Arc Mainnet"');
  });
  it('32. Base network option present in cross-chain checklist', () => {
    // Arc → Base cross-chain
    const billingSection = html.slice(html.indexOf('id="page-invoices"'), html.indexOf('id="page-recipients"'));
    expect(billingSection).toContain('value="Base"');
  });
  it('33. Ethereum network option present in cross-chain checklist', () => {
    const billingSection = html.slice(html.indexOf('id="page-invoices"'), html.indexOf('id="page-recipients"'));
    expect(billingSection).toContain('value="Ethereum"');
  });
});

// ── 8. No regressions in other pages ─────────────────────────────────────
describe('Billing: zero regressions', () => {
  it('34. Swap page still present', () => {
    expect(html).toContain('id="page-swap"');
  });
  it('35. Bridge page still present', () => {
    expect(html).toContain('id="page-bridge"');
  });
  it('36. Send Assets page still present', () => {
    expect(html).toContain('id="page-send"');
  });
  it('37. Unified Balance page still present', () => {
    expect(html).toContain('id="page-xchain"');
  });
  it('38. Batch Payments page still present', () => {
    expect(html).toContain('id="page-batch"');
  });
  it('39. billingSetMode function still present', () => {
    expect(html).toContain('function billingSetMode(');
  });
  it('40. renderInvoices function still present', () => {
    expect(html).toContain('function renderInvoices(');
  });
  it('41. renderPayLinks function still present', () => {
    expect(html).toContain('function renderPayLinks(');
  });
  it('42. createInvoice function still present', () => {
    expect(html).toContain('function createInvoice(');
  });
  it('43. invSwitchTab function still present', () => {
    expect(html).toContain('function invSwitchTab(');
  });
  it('44. payInvoice function still present', () => {
    expect(html).toContain('function payInvoice(');
  });
  it('45. createPayLink function still present', () => {
    expect(html).toContain('function createPayLink(');
  });
  it('46. No mock data in billing functions', () => {
    const billingFnStart = html.indexOf('function billingSetMode(');
    const billingFnEnd = html.indexOf('function showPage(');
    const billingFns = html.slice(billingFnStart, billingFnEnd);
    // No hardcoded fake invoice data
    expect(billingFns).not.toContain('mock');
    expect(billingFns).not.toContain('MOCK');
    expect(billingFns).not.toContain('fake_invoice');
  });
  it('47. invToggleCrosschain function wires to correct panel ID', () => {
    expect(html).toContain("getElementById('invfi-xchain-networks')");
  });
  it('48. invToggleCCTPv2 function wires to correct panel ID', () => {
    expect(html).toContain("getElementById('invfi-cctpv2-networks')");
  });
  it('49. Invoice drawer has onclick invfiCloseDrawer on overlay', () => {
    expect(html).toContain('onclick="invfiCloseDrawer()"');
  });
  it('50. Search and filter inputs wired to renderInvoices', () => {
    const billingSection = html.slice(html.indexOf('id="page-invoices"'), html.indexOf('id="page-recipients"'));
    expect(billingSection).toContain('oninput="renderInvoices()"');
    expect(billingSection).toContain('onchange="renderInvoices()"');
  });
});
