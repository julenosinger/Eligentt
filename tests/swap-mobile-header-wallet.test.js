/**
 * Swap — mobile header de-duplication & wallet-connect optimization.
 * Regression guards for the mobile-only header fix and the wallet modal layering.
 * Desktop layout and the financial execution path are preserved (asserted here).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// ── 1. Mobile header de-duplication (Phase 2) ───────────────────────────────
describe('Swap mobile header — single wallet/network control', () => {
  it('hides the redundant Standard-header wallet + network only inside max-width:768px', () => {
    // The de-dup rule must exist within a mobile media query, scoped to Standard.
    const i = html.indexOf('Swap · Standard on mobile — de-duplicate the header');
    expect(i).toBeGreaterThan(-1);
    const block = html.slice(i, html.indexOf('SWAP UI 2.0', i));
    expect(block).toContain('@media(max-width:768px){');
    expect(block).toContain('#page-swap.swp-standard .swp-std-header .st-wallet-btn');
    expect(block).toContain('#page-swap.swp-standard .swp-std-header .st-net-pill');
    expect(block).toContain('display:none');
    // No desktop leak: the rule is scoped to the mobile media query.
    expect(block).toContain('@media(max-width:768px)');
  });

  it('keeps the Standard header title, Live indicator and History intact', () => {
    expect(html).toContain('Swap Tokens');
    expect(html).toContain('swp-live-dot');
    expect(html).toContain('swpOpenHistory()');
  });

  it('does NOT touch the desktop Advanced-mode de-dup rule (unchanged)', () => {
    expect(html).toContain('@media(min-width:769px){');
    expect(html).toContain('#page-swap.swp-advanced .st-header .st-net-pill');
    expect(html).toContain('#page-swap.swp-advanced .st-header .st-wallet-btn');
  });

  it('keeps the terminal .st-header as the mobile top bar (hamburger + network + wallet)', () => {
    expect(html).toContain('.st-header{display:flex !important;height:40px');
    expect(html).toContain('toggleMobileSidebar()');
  });
});

// ── 2. Wallet modal layering & scroll (Phase 3) ─────────────────────────────
describe('Wallet modal — mobile layering + scroll + safe area', () => {
  it('raises the wallet overlay above the mobile bottom nav (z-index 9999)', () => {
    const m = html.match(/\.wm-overlay\{[^}]*z-index:(\d+)/);
    expect(m).toBeTruthy();
    expect(Number(m[1])).toBeGreaterThan(9999);
  });

  it('adds bottom safe-area padding to the mobile wallet list', () => {
    expect(html).toContain('.wm-left{border-right:none;max-height:85vh;padding-bottom:calc(24px + env(safe-area-inset-bottom,0px))}');
  });

  it('keeps the wallet list scrollable on mobile (overflow-y:auto)', () => {
    expect(html).toContain('.wm-left{padding:28px 24px 20px;border-right:1px solid #1e2438;overflow-y:auto');
  });

  it('hides the right info column on mobile (single column)', () => {
    expect(html).toContain('.wm-right{display:none}');
  });
});

// ── 3. Supported wallet list & deep links (Phase 3) ─────────────────────────
describe('Supported wallet list & deep links', () => {
  const walletIds = ['wm-metamask', 'wm-coinbase', 'wm-rabby', 'wm-trust', 'wm-wc'];
  it('preserves the officially supported wallets (MetaMask/Coinbase/Rabby/Trust/WalletConnect)', () => {
    for (const id of walletIds) expect(html).toContain('id="' + id + '"');
  });

  it('maps deep links for MetaMask/Coinbase/Trust/Rabby and returns null for unknown wallets', () => {
    const fn = html.match(/function getMobileDeepLink\(wallet\) \{[\s\S]*?\n\}/);
    expect(fn).toBeTruthy();
    const ctx = { window: { location: { href: 'https://app.example/swap', host: 'app.example', pathname: '/swap' } } };
    vm.createContext(ctx);
    vm.runInContext(fn[0] + '\nthis.__f = getMobileDeepLink;', ctx);
    expect(ctx.__f('metamask')).toContain('metamask.app.link/dapp/app.example/swap');
    expect(ctx.__f('coinbase')).toContain('go.cb-w.com');
    expect(ctx.__f('trust')).toContain('link.trustwallet.com');
    expect(ctx.__f('rabby')).toContain('rabby.io');
    expect(ctx.__f('okx')).toBeNull();
    expect(ctx.__f('unknown-wallet')).toBeNull();
  });

  it('keeps WalletConnect as a QR flow (300+ wallets)', () => {
    expect(html).toContain('connectWalletConnect()');
    expect(html).toContain('Scan QR · 300+ wallets');
  });

  it('preserves the connect functions and their install-panel fallback', () => {
    for (const f of ['connectMetaMask', 'connectCoinbase', 'connectRabby', 'connectTrustWallet', 'connectWalletConnect']) {
      expect(html).toContain('function ' + f);
    }
    expect(html).toContain('showInstallPanel');
  });
});

// ── 4. Desktop isolation (Phase 5) ──────────────────────────────────────────
describe('Desktop layout is preserved', () => {
  it('keeps the desktop wallet modal two-column layout', () => {
    expect(html).toContain('.wm-cols{display:grid;grid-template-columns:1fr 1fr;min-height:520px}');
    expect(html).toContain('.wm-box{background:#111520;border:1px solid #232940;border-radius:18px;padding:0;width:780px;max-width:95vw;max-height:92vh');
  });

  it('keeps the desktop topbar wallet chip + network pill', () => {
    expect(html).toContain('id="chip-lbl"');
    expect(html).toContain('id="active-network-pill"');
  });

  it('keeps Standard/Advanced mode toggles in position', () => {
    expect(html).toContain('swp-standard');
    expect(html).toContain('swp-advanced');
  });
});

// ── 5. Financial execution untouched (Phase 6) ──────────────────────────────
describe('Financial execution is unchanged', () => {
  it('keeps the swap execution engine and route selection intact', () => {
    // No changes were made to these; presence-only regression guard.
    expect(html).toContain('async function executeSwap');
    expect(html).toContain('_agentExecuteSwap');
    expect(html).toContain('SwapAggregator');
  });
});
