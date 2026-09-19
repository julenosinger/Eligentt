/**
 * FASE 3 — Billing/Liquidity "Under Construction" + compact Footer +
 * Unified Balance Arc Mainnet-only guard.
 * ═══════════════════════════════════════════════════════════════════════
 * Pure source inspection — no DOM required.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function between(start, end) {
  const i = html.indexOf(start);
  if (i < 0) return '';
  const j = html.indexOf(end, i);
  return html.slice(i, j < 0 ? html.length : j);
}

function footerRegion() {
  const i = html.indexOf('<footer class="site-footer"');
  if (i < 0) return '';
  const j = html.indexOf('</footer>', i);
  return html.slice(i, j < 0 ? html.length : j + 9);
}

describe('Billing — Under Construction (FASE 3)', () => {
  it('Billing page exists and shows Under Construction', () => {
    const page = between('<div class="page" id="page-invoices">', '<div class="page" id="page-recipients">');
    expect(page).toContain('Billing');
    expect(page).toContain('Under Construction');
  });

  it('old Billing content (invoices/payment links) is no longer rendered', () => {
    const page = between('<div class="page" id="page-invoices">', '<div class="page" id="page-recipients">');
    expect(page).not.toContain('billing-view-links');
    expect(page).not.toContain('pl-cards-body');
    expect(page).not.toContain('inv-tbody');
  });
});

describe('Liquidity — Under Construction (FASE 3)', () => {
  it('Liquidity page exists and shows Under Construction', () => {
    const page = between('<div class="page" id="page-pool">', '<div class="page" id="page-send">');
    expect(page).toContain('Liquidity');
    expect(page).toContain('Under Construction');
  });

  it('old Liquidity content (pool grid / positions) is no longer rendered', () => {
    const page = between('<div class="page" id="page-pool">', '<div class="page" id="page-send">');
    expect(page).not.toContain('pool-grid');
    expect(page).not.toContain('pool-list-view');
    expect(page).not.toContain('pool-detail-view');
  });
});

describe('Footer — compact + Arc Mainnet only (FASE 3)', () => {
  const footer = footerRegion();

  it('contains the essential status/brand/legal content', () => {
    expect(footer).toContain('All systems operational');
    expect(footer).toContain('© 2025 Elligentt');
    expect(footer).toContain('Built on');
    expect(footer).toContain('arc-logo-on-dark.svg');
    expect(footer).toContain('Powered by');
    expect(footer).toContain('USDC &amp; App Kit');
    expect(footer).toContain('Privacy Policy');
    expect(footer).toContain('Terms of Service');
    expect(footer).toContain('Cookie Policy');
  });

  it('has no Arc Testnet references', () => {
    expect(footer).not.toContain('5042002');
    expect(footer).not.toContain('Arc Testnet');
    expect(footer).not.toContain('testnet.arcscan.app');
  });
});

describe('Unified Balance — Arc Mainnet-only guard (FASE 3)', () => {
  it('has a Mainnet guard + guard placeholder', () => {
    expect(html).toContain('function ubIsMainnet');
    expect(html).toContain('id="ub-guard"');
    expect(html).toContain('Arc Mainnet Required');
    expect(html).toContain('Please switch your wallet to Arc Mainnet');
    expect(html).toContain('Number(activeChainId) === 5042');
  });

  it('guard blocks on non-Mainnet (fail-closed, no Testnet fallback)', () => {
    const init = between('function ubInit', 'function ubRefresh');
    expect(init).toContain("Number(activeChainId) !== 5042");
    expect(init).toContain("ubShowState('guard')");
    // No fallback to Testnet
    expect(init).not.toContain('5042002');
  });

  it('removed UB sections are absent', () => {
    expect(html).not.toContain('id="ub-financial-center"');
    expect(html).not.toContain('id="ub-intelligence"');
    expect(html).not.toContain('id="ub-agents-card"');
    expect(html).not.toContain('id="ub-aos-card"');
    expect(html).not.toContain('id="ub-automation-card"');
    expect(html).not.toContain('id="ub-system-card"');
  });
});

describe('Swap — unchanged (FASE 3 regression guard)', () => {
  it('Swap providers/aggregator are intact', () => {
    expect(html).toContain('SwapAggregator.getBestQuote');
    expect(html).toContain('/shared/TowerAdapter.js');
    expect(html).toContain('/shared/LiFiAdapter.js');
    expect(html).toContain('/shared/SwapAggregator.js');
    expect(html).toContain("source = 'Tower Exchange'");
    expect(html).toContain("source = 'LI.FI'");
  });
});
