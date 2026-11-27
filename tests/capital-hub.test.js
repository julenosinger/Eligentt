/**
 * Capital Hub (Treasury) — data-layer + integration guards.
 * Loads shared/capitalHub.js in a sandbox with stubbed globals (no network, no wallet, no funds).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const src = fs.readFileSync(path.join(root, 'shared/capitalHub.js'), 'utf8');
const W = '0x' + '1'.repeat(40);
const W2 = '0x' + '2'.repeat(40);

function load(over = {}) {
  const store = {};
  const ctx = {
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    walletAddress: W,
    getActiveChain: () => ({ chainId: 5042, name: 'Arc Mainnet', testnet: false }),
    CHAIN_REGISTRY: { 5042: { explorer: 'https://explorer.arc.io' } },
    _ubGwCache: { data: null, ts: 0, addr: '', status: 'idle' },
    console, BigInt, Date, Promise, AbortController, setTimeout, clearTimeout, Object, JSON, Array, String, Number, Math,
    fetch: () => Promise.reject(new Error('no network in tests')),
    ...over,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}
const rows = (a) => [{ domain: 26, domainName: 'Arc', balance: a[0] }, { domain: 0, domainName: 'Ethereum', balance: a[1] }];

describe('exact decimal helpers', () => {
  const { CapitalHub: C } = load();
  it('parses and formats without float', () => {
    expect(C.toAtomic('12.345678', 6)).toBe(12345678n);
    expect(C.toAtomic('0.00000001', 8)).toBe(1n);
    expect(C.fmt(12345678n, 6)).toBe('12.345678');
    expect(C.fmt(1234567890123n, 6, 6)).toBe('1,234,567.890123');
  });
  it('rejects malformed or over-precise input instead of rounding', () => {
    expect(C.toAtomic('1e3', 6)).toBeNull();
    expect(C.toAtomic('-1', 6)).toBeNull();
    expect(C.toAtomic('1.1234567', 6)).toBeNull();
    expect(C.toAtomic('', 6)).toBeNull();
  });
  it('USD style display truncates, never rounds up', () => {
    expect(C.fmtMin2(1999999n, 6)).toBe('1.99');
    expect(C.fmtMin2(5n, 6)).toBe('0.00');
  });
});

describe('Gateway state comes only from the shared cache', () => {
  it('no wallet -> nowallet; other wallet cache -> idle (never shown)', () => {
    expect(load({ walletAddress: '' }).CapitalHub.gateway().state).toBe('nowallet');
    const c = load();
    c._ubGwCache = { data: { USDC: rows(['1', '2']), errors: {} }, ts: Date.now(), addr: W2, status: 'ok' };
    expect(c.CapitalHub.gateway().state).toBe('idle');
  });
  it('error / loading / stale are distinct, and an asset error is not a zero', () => {
    const c = load();
    c._ubGwCache = { data: { USDC: rows(['1', '2']), EURC: null, cirBTC: null, errors: { EURC: 'x' } }, ts: Date.now(), addr: W, status: 'ok' };
    let g = c.CapitalHub.gateway();
    expect(g.state).toBe('ok');
    expect(c.CapitalHub.total(g, 'USDC')).toBe(3000000n);
    expect(c.CapitalHub.total(g, 'EURC')).toBeNull();
    expect(g.errAssets).toContain('EURC');
    c._ubGwCache.ts = Date.now() - 120000; expect(c.CapitalHub.gateway().state).toBe('stale');
    c._ubGwCache.status = 'error'; expect(c.CapitalHub.gateway().state).toBe('error');
    c._ubGwCache.status = 'loading'; expect(c.CapitalHub.gateway().state).toBe('loading');
  });
  it('an asset is listed on a network only if Gateway returned a row for it there', () => {
    const c = load();
    c._ubGwCache = { data: { USDC: rows(['1', '2']), EURC: [{ domain: 26, domainName: 'Arc', balance: '5' }], cirBTC: [], errors: {} }, ts: Date.now(), addr: W, status: 'ok' };
    const nets = c.CapitalHub.networks(c.CapitalHub.gateway());
    const eth = nets.find((n) => n.domain === 0), arc = nets.find((n) => n.domain === 26);
    expect(Object.keys(eth.assets)).toEqual(['USDC']);
    expect(Object.keys(arc.assets)).toEqual(['USDC', 'EURC']);
  });
  it('wallet and vault capital are separate sources (never summed into the unified balance)', () => {
    const c = load({ UB: { state: { assets: [{ token: 'USDC', balance: 50 }] } }, VaultStore: { get: () => ({ chainBalances: { usdc: '999' }, lastChainFetch: 1 }) } });
    c._ubGwCache = { data: { USDC: rows(['1', '2']), errors: {} }, ts: Date.now(), addr: W, status: 'ok' };
    expect(c.CapitalHub.total(c.CapitalHub.gateway(), 'USDC')).toBe(3000000n);
    expect(c.CapitalHub.walletBalances().USDC).toBe(50);
    expect(c.CapitalHub.vaultBalances().usdc).toBe('999');
  });
});

describe('operation journal', () => {
  let c;
  beforeEach(() => { c = load(); c._ubGwCache = { data: { USDC: rows(['10', '0']), errors: {} }, ts: Date.now(), addr: W, status: 'ok' }; });
  it('is idempotent by id (no duplicate records)', () => {
    c.CapitalHub.record({ id: 'a', type: 'Deposit', asset: 'USDC', amount: '1', status: 'Processing' });
    c.CapitalHub.record({ id: 'a', status: 'Confirmed' });
    const l = c.CapitalHub.ops();
    expect(l).toHaveLength(1);
    expect(l[0].status).toBe('Confirmed');
  });
  it('is scoped to the connected wallet and the environment', () => {
    c.CapitalHub.record({ id: 'a', type: 'Deposit', asset: 'USDC', amount: '1', status: 'Processing' });
    c.walletAddress = W2; expect(c.CapitalHub.ops()).toHaveLength(0);
    c.walletAddress = W; c.getActiveChain = () => ({ chainId: 11155111, name: 'x', testnet: true }); expect(c.CapitalHub.ops()).toHaveLength(0);
  });
  it('a confirmed source transaction is only Processing; credit evidence promotes it', () => {
    c.CapitalHub.noteDeposit({ token: 'USDC', chainId: 5042, chainName: 'Arc Mainnet', amount: '5', txHash: '0x' + 'a'.repeat(64) });
    expect(c.CapitalHub.ops()[0].status).toBe('Processing');
    c.CapitalHub.reconcileDeposits();
    expect(c.CapitalHub.ops()[0].status).toBe('Processing');                 // balance unchanged -> no promotion
    c._ubGwCache.data.USDC = rows(['14.999999', '0']); c.CapitalHub.reconcileDeposits();
    expect(c.CapitalHub.ops()[0].status).toBe('Processing');                 // one micro-unit short -> still Processing
    c._ubGwCache.data.USDC = rows(['15', '0']); c.CapitalHub.reconcileDeposits();
    expect(c.CapitalHub.ops()[0].status).toBe('Confirmed');
  });
  it('without a prior balance a deposit is never auto-confirmed; it escalates to Requires Review', () => {
    c._ubGwCache.status = 'error';
    c.CapitalHub.noteDeposit({ token: 'USDC', chainId: 5042, amount: '5', txHash: '0x' + 'b'.repeat(64) });
    c._ubGwCache = { data: { USDC: rows(['500', '0']), errors: {} }, ts: Date.now(), addr: W, status: 'ok' };
    c.CapitalHub.reconcileDeposits();
    expect(c.CapitalHub.ops()[0].status).toBe('Processing');
    const all = JSON.parse(c.localStorage.getItem('elligentt_capital_hub_ops_v1')); all[0].ts -= 2 * 3600000; c.localStorage.setItem('elligentt_capital_hub_ops_v1', JSON.stringify(all));
    c.CapitalHub.reconcileDeposits();
    expect(c.CapitalHub.ops()[0].status).toBe('Requires Review');
  });
  it('the journal is bounded', () => {
    for (let i = 0; i < 350; i++) c.CapitalHub.record({ id: 'x' + i, type: 'Deposit', asset: 'USDC', amount: '1', status: 'Processing' });
    expect(JSON.parse(c.localStorage.getItem('elligentt_capital_hub_ops_v1')).length).toBeLessThanOrEqual(300);
  });
});

describe('Treasury integration (index.html)', () => {
  it('menu order: Overview, Vault, Capital Hub, Liquidity ... and no new main tab', () => {
    const ids = [...html.matchAll(/id="trs-nav-([a-z-]+)"/g)].map((m) => m[1]);
    expect(ids.slice(0, 4)).toEqual(['overview', 'vault', 'capital-hub', 'liquidity']);
    expect(ids).toEqual(['overview', 'vault', 'capital-hub', 'liquidity', 'fast-bridge', 'rebalancing', 'analytics', 'settlements', 'mint', 'fee-revenue']);
    expect(html).not.toContain('id="nav-capital-hub"');
  });
  it('has one section, the scripts, and the lazy show hook', () => {
    expect((html.match(/id="trs-capital-hub"/g) || []).length).toBe(1);
    ['capitalHub.js', 'capitalHubUI.js', 'capitalHubTabs.js', 'capitalHubManage.js'].forEach((f) => expect(html).toContain('<script src="/shared/' + f + '"></script>'));
    expect(html).toContain("else if (name === 'capital-hub') { if (window.CapitalHubUI) window.CapitalHubUI.onShow(); }");
  });
  it('the deposit hook is observer-only and wrapped so it can never affect the deposit', () => {
    const i = html.indexOf('window.CapitalHub.noteDeposit');
    expect(i).toBeGreaterThan(-1);
    const line = html.slice(html.lastIndexOf('\n', i), html.indexOf('\n', i));
    expect(line).toMatch(/try \{/);
    expect(line).toMatch(/catch \(_\)/);
  });
  it('all Capital Hub CSS is scoped to #trs-capital-hub', () => {
    const a = html.indexOf('<style id="capital-hub-ui">'), b = html.indexOf('</style>', a);
    const css = html.slice(a, b).replace(/\/\*[\s\S]*?\*\//g, '');
    css.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('<style') && !l.startsWith('@keyframes') && !/^@media/.test(l)).forEach((l) => {
      l.split('}').filter(Boolean).forEach((r) => { const sel = r.split('{')[0]; if (sel.trim()) expect(sel, l.slice(0, 60)).toContain('#trs-capital-hub'); });
    });
  });
  it('financial engine files are untouched by this feature', () => {
    const guard = fs.readFileSync(path.join(root, 'shared/GatewaySpendService.js'), 'utf8');
    expect(guard).not.toContain('CapitalHub');
    expect(fs.readFileSync(path.join(root, 'functions/api/gateway/transfer.js'), 'utf8')).not.toContain('CapitalHub');
  });
  it('no secrets or new endpoints are introduced by the Capital Hub modules', () => {
    ['capitalHub.js', 'capitalHubUI.js', 'capitalHubTabs.js', 'capitalHubManage.js'].forEach((f) => {
      const t = fs.readFileSync(path.join(root, 'shared', f), 'utf8');
      expect(t).not.toMatch(/api[_-]?key|secret|privateKey|mnemonic/i);
      (t.match(/['"`]\/api\/[^'"`?]*/g) || []).forEach((u) => expect(u).toBe("'/api/gateway/transfer"));
    });
  });
});

describe('Manage Funds Phase 0 is presentation only', () => {
  const manage = fs.readFileSync(path.join(root, 'shared/capitalHubManage.js'), 'utf8');
  it('defines the five Quick Actions in order, Deposit selected first', () => {
    const keys = [...manage.matchAll(/\{ k: '([a-z]+)',\s+t: '([^']+)'/g)].map((m) => m[1] + ':' + m[2]);
    expect(keys).toEqual(['deposit:Deposit', 'send:Send', 'crosschain:Cross-chain', 'charge:Charge in USDC', 'withdraw:Withdraw']);
    expect(manage).toContain("act: 'deposit'");
  });
  it('contains no signing, sending, approval, burn, mint or network code', () => {
    ['fetch(', 'XMLHttpRequest', 'signTypedData', 'eth_sign', 'eth_send', 'sendTransaction', 'ethers', '.approve(', 'depositForBurn', 'gatewayMint', '/v1/transfer', '/api/', 'GatewaySpendService', 'setInterval', 'setTimeout'].forEach((w) => expect(manage, w).not.toContain(w));
  });
  it('primary action buttons are rendered disabled and say native execution is not enabled', () => {
    expect(manage).toMatch(/class="ch-act ch-act-primary ch-wide" disabled aria-disabled="true"/);
    expect(manage).toContain('Native execution is not enabled yet');
  });
  it('existing flows are reached only through the existing launchers', () => {
    expect(manage).toContain('UI.launch(');
    expect(manage).not.toMatch(/showPage\(|saSetOrigin|ubGwDepOpen/);
  });
  it('steps are neutral (no active / done classes) and details never invent fees or times', () => {
    expect(manage).not.toMatch(/ch-step(-on|-done|-active)/);
    expect(manage).toContain("['Estimated fee', NA]");
    expect(manage).toContain("['Estimated time', NA]");
  });
  it('the footer is the neutral security note and the old three-card layout is gone', () => {
    expect(manage).toContain('Secure execution · Every operation is signed by your wallet · Powered by');
    const tabs = fs.readFileSync(path.join(root, 'shared/capitalHubTabs.js'), 'utf8');
    expect(tabs).not.toContain('ch-mf-');
  });
});
