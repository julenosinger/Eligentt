/**
 * Unified Balance — structural composition test.
 * ═══════════════════════════════════════════════════════════════════════
 * Verifies the reorganized page hierarchy (Screen Live → Quick Actions → Assets)
 * and that the merchant hub still reads real data (no hardcoded values, no
 * duplicated logic). Pure source inspection — no DOM required.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const hub = fs.readFileSync(path.join(root, 'shared', 'ubMerchantHub.js'), 'utf8');

describe('Unified Balance — reorganized page composition', () => {
  it('financial telemetry is a collapsible card OUTSIDE the Screen Live', () => {
    expect(html).toContain('id="ub-financial-center"');
    expect(html).toContain('id="ub-fin-card"');
    expect(html).toContain('id="ub-fin-body"');
    expect(html).toContain('function ubToggleFinancial');
    // financial-center is nested inside the collapsible fin-card, not the live screen
    const finCard = html.indexOf('id="ub-fin-card"');
    const finCenter = html.indexOf('id="ub-financial-center"');
    expect(finCenter).toBeGreaterThan(finCard);
    // fin-card sits after the Screen Live and before Quick Actions
    const screenIdx = html.indexOf('id="ub-live-screen"');
    const qaIdx = html.indexOf('id="ub-quick-actions"');
    expect(screenIdx).toBeLessThan(finCard);
    expect(finCard).toBeLessThan(qaIdx);
  });

  it('order: Quick Actions after Screen Live, then Assets, then extended merchant hub', () => {
    const qa = html.indexOf('id="ub-quick-actions"');
    const assets = html.indexOf('id="ub-asset-tbody"');
    const hub = html.indexOf('id="ub-merchant-hub"');
    expect(qa).toBeGreaterThan(-1);
    expect(assets).toBeGreaterThan(-1);
    expect(hub).toBeGreaterThan(-1);
    expect(qa).toBeLessThan(assets);
    expect(assets).toBeLessThan(hub);
  });

  it('financial center renders Cash Flow + Reserved Funds + Monthly Overview + Financial Summary', () => {
    const fn = hub.slice(hub.indexOf('function renderFinancialCenter'), hub.indexOf('function renderExtendedHub'));
    expect(fn).toContain('renderCashFlow()');
    expect(fn).toContain('renderReservedMoney()');
    expect(fn).toContain('renderMonthlyOverview()');
    expect(fn).toContain('renderFinancialSummary()');
    // Scheduled Liabilities stays a metric inside Financial Summary (existing renderer)
    expect(hub).toContain("metricBox('Scheduled Liabilities'");
  });

  it('Quick Actions moved out of the financial center into its own zone', () => {
    const fn = hub.slice(hub.indexOf('function renderFinancialCenter'), hub.indexOf('function renderExtendedHub'));
    expect(fn).not.toContain('renderQuickActions()');
    expect(hub).toContain("qa.innerHTML = renderQuickActions()");
  });

  it('renderAll targets quick-actions + merchant-hub (financial-center now owned by UBLive)', () => {
    expect(hub).toContain("getElementById('ub-quick-actions')");
    expect(hub).toContain("getElementById('ub-merchant-hub')");
  });

  it('still reads real data (collectors/calcs preserved — no hardcoded values)', () => {
    for (const s of ['collectSchedules', 'collectInvoices', 'collectPaymentLinks', 'collectTransactionHistory', 'collectVault', 'calcCashFlow', 'calcMonthlyOverview']) {
      expect(hub).toContain('function ' + s);
    }
    expect(hub).toContain('UB.state.totalUSD');
  });
});
