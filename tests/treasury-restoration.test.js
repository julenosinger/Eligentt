/**
 * Treasury restoration — the sidebar entry and route were hidden in the Mainnet-only release
 * (commit 3c5f623) while the page, vault engine and permissions stayed in the code base.
 * These checks pin the restored navigation and prove nothing financial was touched.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const count = (s, needle) => s.split(needle).length - 1;

describe('Treasury navigation', () => {
  it('has exactly one nav item and one page', () => {
    expect(count(html, 'id="nav-treasury"')).toBe(1);
    expect(count(html, 'id="page-treasury"')).toBe(1);
  });
  it('the nav item sits under PROTOCOL and opens the treasury route', () => {
    const proto = html.indexOf('<div class="nav-group" style="margin-top:4px">Protocol</div>');
    const nav = html.indexOf('id="nav-treasury"');
    const manage = html.indexOf('<div class="nav-group" style="margin-top:4px">Manage</div>');
    expect(proto).toBeGreaterThan(-1);
    expect(nav).toBeGreaterThan(proto);
    expect(nav).toBeLessThan(manage);
    expect(html).toContain('id="nav-treasury" onclick="showPage(\'treasury\')"');
  });
  it('showPage no longer redirects treasury to send and refreshes the vault view on entry', () => {
    expect(html).not.toContain("if (id === 'treasury') { showPage('send'); return; }");
    expect(html).toContain("if (id === 'treasury') {\n      setTimeout(() => { if (typeof vaultRefreshUI === 'function') vaultRefreshUI(); }, 50);");
  });
  it('the Treasury entry points elsewhere in the app (Autonoma actions) use the same route', () => {
    expect(html).toContain(`action:"showPage('treasury')"`);
  });
});

describe('Treasury page lifecycle is unchanged', () => {
  it('vault engine and UI refresh are still defined', () => {
    ['async function vaultRefreshUI(', 'const VaultChain = (() =>', 'function vaultRefreshAll', 'function treasuryDeposit'].forEach((s) => expect(html, s).toContain(s));
  });
  it('the 5s refresh only runs while the Treasury page is active (no work when it is closed)', () => {
    const i = html.indexOf("document.getElementById('nav-treasury')?.addEventListener('click'");
    expect(i).toBeGreaterThan(-1);
    const block = html.slice(i, i + 1600);
    expect(block).toContain("document.getElementById('page-treasury')?.classList.contains('active')");
    expect(block).toContain('VaultChain.fetchVaultBalances()');
    expect(count(html, "document.getElementById('nav-treasury')?.addEventListener('click'")).toBe(1);
  });
  it('the page has no Testnet chain references', () => {
    const a = html.indexOf('id="page-treasury"');
    const b = html.indexOf('<!-- end page-treasury -->');
    const region = html.slice(a, b);
    expect(region).not.toMatch(/5042002|Arc_Testnet|Sepolia/);
  });
});

describe('Financial infrastructure is untouched', () => {
  it('the vault address in the page code equals the configured one', () => {
    const cfg = fs.readFileSync(path.join(root, 'config/contracts.js'), 'utf8');
    const m = /TREASURY_VAULT_ADDRESS:\s*'(0x[0-9a-fA-F]{40})'/.exec(cfg);
    expect(m).toBeTruthy();
    expect(html).toContain("const TREASURY_VAULT_ADDRESS = '" + m[1] + "'");
  });
  it('treasury modules and the fee endpoint are still shipped and loaded', () => {
    ['shared/treasurySync.js', 'shared/treasuryIndexer.js', 'shared/treasuryGuard.js', 'shared/agentTreasury.js', 'shared/autonomaTreasuryManager.js', 'shared/domain/treasury/TreasuryDomain.js', 'shared/pages/treasury/TreasuryPage.js', 'functions/api/treasury/fees.js']
      .forEach((f) => expect(fs.existsSync(path.join(root, f)), f).toBe(true));
    ['/shared/treasurySync.js', '/shared/treasuryIndexer.js', '/shared/treasuryGuard.js'].forEach((s) => expect(html).toContain('src="' + s + '"'));
  });
});
