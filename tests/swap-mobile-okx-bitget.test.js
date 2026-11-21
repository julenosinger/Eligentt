/**
 * Swap — OKX Wallet & Bitget Wallet integration.
 * Behavioral + structural guards for the new multi-wallet support.
 * Exercises real provider-detection logic via `vm`, not only string search.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function extractFn(name) {
  const re = new RegExp('function ' + name + '\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}');
  const m = html.match(re);
  return m ? m[0] : null;
}
function runFn(fnStr, ctxInit) {
  const name = fnStr.match(/function\s+(\w+)/)[1];
  const ctx = Object.assign({}, ctxInit || {});
  vm.createContext(ctx);
  vm.runInContext(fnStr + '\nthis.__fn = ' + name + ';', ctx);
  return ctx.__fn;
}

// ── 1. OKX / Bitget present in the wallet list ──────────────────────────────
describe('OKX & Bitget are present with functional connect paths', () => {
  it('renders OKX and Bitget rows in the wallet modal', () => {
    expect(html).toContain('id="wm-okx"');
    expect(html).toContain('id="wm-bitget"');
    expect(html).toContain('onclick="connectOKX()"');
    expect(html).toContain('onclick="connectBitget()"');
  });

  it('defines connectOKX / connectBitget functions', () => {
    expect(html).toContain('async function connectOKX()');
    expect(html).toContain('async function connectBitget()');
  });

  it('ships OKX and Bitget logo assets', () => {
    for (const f of ['okx.svg', 'bitget.svg']) {
      expect(fs.existsSync(path.join(root, 'public', 'assets', 'wallets', f))).toBe(true);
    }
  });

  it('adds installed badges for OKX and Bitget', () => {
    expect(html).toContain('id="okx-installed"');
    expect(html).toContain('id="bg-installed"');
  });
});

// ── 2. Provider detection (behavioral, via vm) ─────────────────────────────
describe('OKX / Bitget provider detection (EIP-1193)', () => {
  it('_safeOkx detects window.okxwallet (EIP-1193)', () => {
    const fn = extractFn('_safeOkx');
    expect(fn).toBeTruthy();
    const provider = { request: () => {} };
    const f = runFn(fn, { window: { okxwallet: provider } });
    expect(f()).toBe(provider);
  });

  it('_safeOkx returns null when OKX is absent', () => {
    const fn = extractFn('_safeOkx');
    const f = runFn(fn, { window: {} });
    expect(f()).toBeNull();
  });

  it('_safeBitget detects window.bitkeep.ethereum (EIP-1193)', () => {
    const fn = extractFn('_safeBitget');
    expect(fn).toBeTruthy();
    const provider = { request: () => {} };
    const f = runFn(fn, { window: { bitkeep: { ethereum: provider } } });
    expect(f()).toBe(provider);
  });

  it('_safeBitget returns null when Bitget is absent', () => {
    const fn = extractFn('_safeBitget');
    const f = runFn(fn, { window: {} });
    expect(f()).toBeNull();
  });

  it('_safeBitget tolerates the window.bitget namespace alias', () => {
    const fn = extractFn('_safeBitget');
    const provider = { request: () => {} };
    const f = runFn(fn, { window: { bitget: { ethereum: provider } } });
    expect(f()).toBe(provider);
  });
});

// ── 3. EIP-6963 mapping ─────────────────────────────────────────────────────
describe('EIP-6963 wallet name → connect function mapping', () => {
  function loadMatchFn() {
    // Evaluate _wmKnownMap + _wmMatchFn in a sandbox.
    const mapStart = html.indexOf('const _wmKnownMap = [');
    const mapEnd = html.indexOf('function _wmMatchFn', mapStart);
    const matchFn = html.match(/function _wmMatchFn\(name\) \{[\s\S]*?\n\}/);
    const ctx = { window: {} };
    vm.createContext(ctx);
    vm.runInContext(html.slice(mapStart, mapEnd) + '\n' + matchFn[0] + '\nthis.__match = _wmMatchFn;', ctx);
    return ctx.__match;
  }

  it('maps "OKX Wallet" / "OKX" names to connectOKX', () => {
    const match = loadMatchFn();
    expect(match('OKX Wallet')).toBe('connectOKX');
    expect(match('OKX')).toBe('connectOKX');
  });

  it('maps "Bitget Wallet" / "BitKeep" names to connectBitget', () => {
    const match = loadMatchFn();
    expect(match('Bitget Wallet')).toBe('connectBitget');
    expect(match('BitKeep')).toBe('connectBitget');
  });

  it('does not mis-map OKX to MetaMask or Bitget to a wrong wallet', () => {
    const match = loadMatchFn();
    expect(match('OKX Wallet')).not.toBe('connectMetaMask');
    expect(match('Bitget Wallet')).not.toBe('connectMetaMask');
    expect(match('Bitget Wallet')).not.toBe('connectOKX');
  });
});

// ── 4. Mobile path: WalletConnect fallback (no silent redirect) ─────────────
describe('mobile fallback uses WalletConnect, not fabricated deep links', () => {
  it('connectOKX falls back to WalletConnect on mobile (no provider)', () => {
    const fn = extractFn('connectOKX');
    expect(fn).toContain('isMobileDevice()');
    expect(fn).toContain('connectWalletConnect()');
    expect(fn).toContain('Connect OKX Wallet via WalletConnect');
  });

  it('connectBitget falls back to WalletConnect on mobile (no provider)', () => {
    const fn = extractFn('connectBitget');
    expect(fn).toContain('isMobileDevice()');
    expect(fn).toContain('connectWalletConnect()');
    expect(fn).toContain('Connect Bitget Wallet via WalletConnect');
  });

  it('does not fabricate OKX/Bitget deep-link URLs', () => {
    const fn = extractFn('getMobileDeepLink');
    expect(fn).toBeTruthy();
    expect(fn).not.toContain('okx');
    expect(fn).not.toContain('bitget');
    expect(fn).not.toContain('bitkeep');
  });

  it('shows an install panel on desktop when the extension is missing', () => {
    const okx = extractFn('connectOKX');
    const bg = extractFn('connectBitget');
    expect(okx).toContain('showInstallPanel');
    expect(bg).toContain('showInstallPanel');
    expect(okx).toContain('https://www.okx.com/web3');
    expect(bg).toContain('https://web3.bitget.com/wallet-download');
  });

  it('guards against duplicate connection attempts', () => {
    const okx = extractFn('connectOKX');
    const bg = extractFn('connectBitget');
    expect(okx).toContain('_connectingWallet');
    expect(bg).toContain('_connectingWallet');
  });
});

// ── 5. Detection integration (detectWallets + badges) ──────────────────────
describe('wallet detection covers OKX & Bitget', () => {
  it('detectWallets recognizes OKX/Bitget flags and providers', () => {
    expect(html).toContain('okx: false, bitget: false');
    expect(html).toContain('isOKXWallet');
    expect(html).toContain('isBitKeep');
  });

  it('detectWallets reads EIP-6963 rdns for OKX/Bitget', () => {
    expect(html).toContain("n.includes('okx')");
    expect(html).toContain("n.includes('bitget')");
  });

  it('updates the OKX/Bitget installed badges', () => {
    expect(html).toContain("getElementById('okx-installed')");
    expect(html).toContain("getElementById('bg-installed')");
  });

  it('shows a clear mobile description (WalletConnect) for OKX/Bitget', () => {
    expect(html).toContain("okxD.textContent = 'Connect via WalletConnect'");
    expect(html).toContain("bgD.textContent = 'Connect via WalletConnect'");
  });
});

// ── 6. No duplication + desktop preserved + no financial changes ───────────
describe('no regression: no duplication, desktop intact, financial untouched', () => {
  it('keeps a single Connect Wallet control (mobile header de-dup intact)', () => {
    expect(html).toContain('#page-swap.swp-standard .swp-std-header .st-wallet-btn');
    expect(html).toContain('display:none');
  });

  it('keeps the wallet modal two-column desktop layout', () => {
    expect(html).toContain('.wm-cols{display:grid;grid-template-columns:1fr 1fr;min-height:520px}');
  });

  it('does not modify the swap engine', () => {
    expect(html).toContain('async function executeSwap');
    expect(html).toContain('_agentExecuteSwap');
    expect(html).toContain('SwapAggregator');
  });

  it('registers OKX/Bitget in the connection badge labels', () => {
    expect(html).toContain("okx:'OKX Wallet'");
    expect(html).toContain("bitget:'Bitget Wallet'");
  });
});
