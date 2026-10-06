/**
 * Send Assets — balance + gas-check network reactivity regression tests.
 * ═══════════════════════════════════════════════════════════════════════════
 * Reproduces the two reported bugs and locks their fixes in place:
 *
 *   1. The Send "Available balance" was showing "—" because the read path did
 *      not always follow the ACTIVE network. These tests assert the balance is
 *      read exclusively via BalanceService on the active (source) chain, that a
 *      stale async result can never overwrite a newer one (anti-race), and that
 *      every chain-change path re-runs the Send refresh (no page reload).
 *
 *   2. The Destination/Source Gas Check was not following the active network.
 *      These tests assert the gas check re-validates on chain change, that Arc
 *      (5042) keeps its USDC-gas exemption, and that a cross-chain Send checks
 *      BOTH the source (activeChainId) and destination (saDestChainId) gas,
 *      resolving each gas token from CHAIN_REGISTRY.nativeCurrency.
 *
 * Source-level tests: they read the actual production index.html.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

function between(start, end) {
  const i = html.indexOf(start);
  if (i < 0) return '';
  const j = html.indexOf(end, i);
  return html.slice(i, j < 0 ? html.length : j);
}

describe('Send Assets — balance follows the active network (bug 1)', () => {
  it('reads the balance via BalanceService on the active (source) chain', () => {
    const fn = between('async function saRefreshBalance', '// ── Set MAX');
    expect(fn).toContain('var chain = getActiveChain();');
    expect(fn).toContain('var chainId = chain ? chain.chainId : activeChainId;');
    expect(fn).toContain('BalanceService.getTokenBalance(walletAddress, sym, chainId)');
  });

  it('keeps the anti-race guard so a stale chain result cannot overwrite a newer one', () => {
    const fn = between('async function saRefreshBalance', '// ── Set MAX');
    expect(fn).toContain('saBalReqId');
    expect(fn).toContain('if (reqId !== saBalReqId) return;');
  });

  it('never transforms a null/failed read into a fake 0 balance', () => {
    const fn = between('async function saRefreshBalance', '// ── Set MAX');
    expect(fn).toContain('if (v == null)');
    expect(fn).not.toContain('v == null ? 0');
    expect(fn).not.toContain('parseFloat(v) || 0');
  });

  it('re-runs balance + network + route (and gas check) from saUpdateNetwork', () => {
    const fn = between('function saUpdateNetwork()', '// ── Populate destination networks');
    expect(fn).toContain('saPopulateDestNetworks();');
    expect(fn).toContain('saRefreshBalance();');
    expect(fn).toContain('saUpdateRoute();');
    expect(fn).toContain('__DGVRefreshActive');
  });

  it('registers a single CHAIN_CHANGED listener that re-runs the Send refresh', () => {
    const fn = between('function saUpdateNetwork()', '// ── Populate destination networks');
    expect(fn).toContain('EventBus.on(\'CHAIN_CHANGED\', _handle)');
    expect(fn).toContain('window.__saChainChangedSubscribed');
  });

  it('every chain-change path re-runs saUpdateNetwork (selector, switchNetwork, internal wallet)', () => {
    expect(html).toContain('await refreshBalance();\n    if (typeof saUpdateNetwork === \'function\') saUpdateNetwork();');
    expect(html).toContain('_refreshAllSurfaceBalances();\n      if (typeof saUpdateNetwork === \'function\') saUpdateNetwork();');
    expect(html).toContain('refreshBalance().catch(() => {});\n    if (typeof saUpdateNetwork === \'function\') saUpdateNetwork();');
  });
});

describe('Send Assets — gas check follows the network (bug 2)', () => {
  it('keeps Arc Mainnet (5042) as USDC-gas exempt', () => {
    const dgv = between('var THRESHOLDS = {', 'function thresholdFor');
    expect(dgv).toContain('5042:');
    expect(dgv).toContain('exempt: true');
  });

  it('resolves each gas token from CHAIN_REGISTRY.nativeCurrency (no single hardcoded gas)', () => {
    const dgv = between('DESTINATION GAS SAFETY CHECK', 'AUTONOMA CHAT COMPOSER');
    expect(dgv).toContain("var native = (chain.nativeCurrency && chain.nativeCurrency.symbol) || 'ETH';");
  });

  it('checks DESTINATION gas on saDestChainId for cross-chain sends', () => {
    const dgv = between('DESTINATION GAS SAFETY CHECK', 'AUTONOMA CHAT COMPOSER');
    expect(dgv).toContain("pageId: 'page-send'");
    expect(dgv).toContain('getChainId: function(){ return safeGet(function(){ return saDestChainId; }); }');
  });

  it('checks SOURCE gas on activeChainId for cross-chain sends (Arc → Base / Base → Arc each side)', () => {
    const dgv = between('DESTINATION GAS SAFETY CHECK', 'AUTONOMA CHAT COMPOSER');
    expect(dgv).toContain('saSrcCtl');
    expect(dgv).toContain("title: 'Source Gas Check'");
    expect(dgv).toContain('getChainId: function(){ return safeGet(function(){ return activeChainId; }); }');
  });

  it('gates the Send button on both source and destination gas', () => {
    const dgv = between('DESTINATION GAS SAFETY CHECK', 'AUTONOMA CHAT COMPOSER');
    expect(dgv).toContain("if (t.closest('#sa-send-btn')) { saCtl.gate(e); saSrcCtl.gate(e); return; }");
  });

  it('re-runs the gas check immediately on chain change via the exposed hook', () => {
    const dgv = between('DESTINATION GAS SAFETY CHECK', 'AUTONOMA CHAT COMPOSER');
    expect(dgv).toContain('window.__DGVRefreshActive = refreshActive;');
  });
});
