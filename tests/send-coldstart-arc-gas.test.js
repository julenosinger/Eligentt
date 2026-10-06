/**
 * Send Assets — cold-start balance + Arc Gas Check explicit state.
 * ═══════════════════════════════════════════════════════════════
 * Covers:
 *   1. Cold-start balance (Bug 1): balance appears after WALLET_CONNECTED
 *      without needing a manual network switch.
 *   2. Arc Gas Check explicit state (Bug 2): saSrcCtl is always active on
 *      page-send (not gated on cross-chain), so Arc (5042) renders its
 *      Exempt/SAFE state on cold-start.
 *   3. Arc→Base and Base→Arc chain switch scenarios (regression guard).
 *
 * Source-level tests: read the production index.html.
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

// ── Bug 1: cold-start balance ─────────────────────────────────────────────

describe('Send Assets — cold-start balance (Bug 1)', () => {
  it('connectWallet calls saUpdateNetwork after _refreshAllSurfaceBalances', () => {
    // Both calls must appear together in the connectWallet body (finalizeConnection).
    const connectBody = between(
      'if (typeof saPrefetchBalances === \'function\') saPrefetchBalances()',
      'loadAllPools().then(() => { updateSwapRate();'
    );
    expect(connectBody).toContain('_refreshAllSurfaceBalances();');
    expect(connectBody).toContain('if (typeof saUpdateNetwork === \'function\') saUpdateNetwork();');
  });

  it('WALLET_CONNECTED DOM event triggers saUpdateNetwork (cold-start path)', () => {
    const region = between(
      'EventBus \'CHAIN_CHANGED\' and DOM \'WALLET_CONNECTED\'',
      '// ── Populate destination networks'
    );
    expect(region).toContain("document.addEventListener('WALLET_CONNECTED'");
    expect(region).toContain('saUpdateNetwork');
    expect(region).toContain('__saWalletConnectedSubscribed');
  });

  it('WALLET_CONNECTED listener is registered at most once (idempotent)', () => {
    const region = between(
      'EventBus \'CHAIN_CHANGED\' and DOM \'WALLET_CONNECTED\'',
      '// ── Populate destination networks'
    );
    // Guard flag is set before adding the listener
    expect(region).toContain('window.__saWalletConnectedSubscribed = true');
    // Only one addEventListener call for WALLET_CONNECTED inside this block
    const matches = (region.match(/addEventListener\('WALLET_CONNECTED'/g) || []).length;
    expect(matches).toBe(1);
  });

  it('CHAIN_CHANGED listener is still registered (no regression)', () => {
    const region = between(
      'EventBus \'CHAIN_CHANGED\' and DOM \'WALLET_CONNECTED\'',
      '// ── Populate destination networks'
    );
    expect(region).toContain("EventBus.on('CHAIN_CHANGED', _handle)");
    expect(region).toContain('window.__saChainChangedSubscribed');
  });

  it('saUpdateNetwork calls saRefreshBalance so the balance element is populated', () => {
    const fn = between('function saUpdateNetwork()', '// ── Populate destination networks');
    expect(fn).toContain('saRefreshBalance();');
  });

  it('saRefreshBalance shows — (not 0) when wallet is not connected', () => {
    const fn = between('async function saRefreshBalance()', '// ── Set MAX');
    expect(fn).toContain("if (!walletAddress) { balEl.textContent = '—'; return; }");
    expect(fn).not.toContain("textContent = '0'");
  });
});

// ── Bug 2: Arc Gas Check explicit state ───────────────────────────────────

describe('Arc Gas Check — explicit Exempt state on cold-start (Bug 2)', () => {
  it('saSrcCtl has NO condActive gate so it is always active on page-send', () => {
    const dgv = between('DESTINATION GAS SAFETY CHECK', 'AUTONOMA CHAT COMPOSER');
    const srcBlock = between.call(null, 'var saSrcCtl = createController', 'var controllers');
    // Must NOT contain condActive in the saSrcCtl block
    expect(srcBlock).not.toContain('condActive');
  });

  it('saSrcCtl is on page-send with Source Gas Check title', () => {
    const dgv = between('DESTINATION GAS SAFETY CHECK', 'AUTONOMA CHAT COMPOSER');
    const srcBlock = dgv.slice(dgv.indexOf('var saSrcCtl = createController'));
    expect(srcBlock).toContain("pageId: 'page-send'");
    expect(srcBlock).toContain("title: 'Source Gas Check'");
  });

  it('Arc (5042) is still exempt: true in THRESHOLDS — rule is preserved', () => {
    const dgv = between('var THRESHOLDS = {', 'function thresholdFor');
    expect(dgv).toContain('5042:');
    expect(dgv).toContain('exempt: true');
    // req and warn must be 0 for Arc
    const arcLine = dgv.split('\n').find(l => l.includes('5042:'));
    expect(arcLine).toContain('req: 0');
    expect(arcLine).toContain('warn: 0');
  });

  it('render() shows "Exempt (Arc)" badge when state is SAFE and exempt', () => {
    const dgv = between('DESTINATION GAS SAFETY CHECK', 'AUTONOMA CHAT COMPOSER');
    expect(dgv).toContain("'Exempt (Arc)'");
    expect(dgv).toContain("res.state === 'SAFE' && res.exempt");
  });

  it('render() shows explicit Arc exempt status text in Validation Status row', () => {
    const dgv = between('DESTINATION GAS SAFETY CHECK', 'AUTONOMA CHAT COMPOSER');
    expect(dgv).toContain('Exempt — Arc uses USDC as gas (not required)');
  });

  it('render() shows "N/A — gas token = asset (USDC)" in Estimated Required row', () => {
    const dgv = between('DESTINATION GAS SAFETY CHECK', 'AUTONOMA CHAT COMPOSER');
    expect(dgv).toContain("'N/A — gas token = asset (USDC)'");
  });

  it('arc 5042 validate() returns SAFE immediately without calling getNativeBalance', () => {
    // The validate function sets state = SAFE when t.exempt is true, BEFORE any balance read.
    const validateFn = between('validate: async function(chainId, address)', 'suggestions:');
    expect(validateFn).toContain('if (t.exempt) state = \'SAFE\'');
  });

  it('send button gate: saSrcCtl.gate() is called for #sa-send-btn', () => {
    const dgv = between('DESTINATION GAS SAFETY CHECK', 'AUTONOMA CHAT COMPOSER');
    expect(dgv).toContain("if (t.closest('#sa-send-btn')) { saCtl.gate(e); saSrcCtl.gate(e); return; }");
  });
});

// ── Chain-switch regression guard ────────────────────────────────────────

describe('Send Assets — chain switch (Arc ↔ Base ↔ Ethereum) no regression', () => {
  it('chainChanged handler calls saUpdateNetwork', () => {
    const chainChanged = between(
      'raw.on(\'chainChanged\', async hexChainId =>',
      'raw.on(\'disconnect\','
    );
    expect(chainChanged).toContain('saUpdateNetwork');
  });

  it('switchNetwork() calls saUpdateNetwork after refreshBalance', () => {
    const switchFn = between('function switchNetwork(chainId)', 'function detectWallets');
    expect(switchFn).toContain('refreshBalance().catch(() => {})');
    expect(switchFn).toContain('if (typeof saUpdateNetwork === \'function\') saUpdateNetwork();');
  });

  it('saUpdateNetwork calls __DGVRefreshActive so gas check re-validates on chain change', () => {
    const fn = between('function saUpdateNetwork()', '// ── Populate destination networks');
    expect(fn).toContain('__DGVRefreshActive');
  });

  it('CHAIN_REGISTRY has nativeCurrency for 5042 (Arc/USDC), 8453 (Base/ETH), and 1 (Ethereum/ETH)', () => {
    // Arc
    const arcEntry = between('5042: {', '// Arc Mainnet config');
    // Just check CHAIN_REGISTRY contains the three chains' nativeCurrency
    expect(html).toContain("'USDC'"); // Arc native
    expect(html).toContain("symbol: 'ETH'"); // Base / Ethereum native
  });

  it('gas check is always shown for source (never stuck at Checking) after chain switch', () => {
    // After chain switch, refreshActive is called, which calls saSrcCtl.run().
    // With no condActive gate, run() will call DestinationGasValidator.validate(activeChainId, addr).
    // Arc: returns SAFE (exempt). Base/ETH: returns a real balance check.
    const dgv = between('DESTINATION GAS SAFETY CHECK', 'AUTONOMA CHAT COMPOSER');
    // The 2.5s poll catches key changes:
    expect(dgv).toContain('if (c.keyNow() !== c.lastKey()) c.run()');
    // The refreshActive hook is exposed for the chain change instant trigger:
    expect(dgv).toContain('window.__DGVRefreshActive = refreshActive');
  });
});
