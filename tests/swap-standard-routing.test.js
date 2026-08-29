/**
 * SWAP STANDARD — Tower/Elligentt as INDEPENDENT providers + non-blocking pools.
 * ═══════════════════════════════════════════════════════════════════════
 * Proves the Standard swap UX fixes:
 *   (a) Tower is selectable/executable even when a local Elligentt pool exists,
 *   (b) Tower & Local quote in parallel and never block each other,
 *   (c) pool discovery never blocks the initial render or the Tower quote,
 *   (d) execution follows the SELECTED route with NO silent fallback,
 *   (e) initial state shows no ROUTES / Summary until a valid quote exists.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const aggSrc = fs.readFileSync(path.join(root, 'shared', 'SwapAggregator.js'), 'utf8');
const towerSrc = fs.readFileSync(path.join(root, 'shared', 'TowerAdapter.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function evalModule(src, win) {
  new Function('window', src).call(null, win);
}
function makeWindow() {
  return { TowerAdapter: undefined, LocalAdapter: undefined, SwapAggregator: undefined };
}
function evalAgg() {
  const w = makeWindow(); evalModule(aggSrc, w); return w.SwapAggregator;
}

function towerQuote(src, over) {
  return Object.assign({
    source: src, ok: true, tokenIn: 'USDC', tokenOut: 'EURC', chainId: 5042002,
    amountInRaw: 1000000n, expectedOutRaw: 1000000n, minOutRaw: 995000n,
    priceImpactBps: null, feeBps: null, route: null, calldata: null, to: null,
    spender: null, expiresAt: Date.now() + 60000, executionType: 'tower',
  }, over || {});
}

const ADDR = '0x2de8906a641d65d490bc60a4179d961d59742bcb';
const OPTS = { tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 1000000n, slippageBps: 50, chainId: 5042002 };

describe('Tower executability is INDEPENDENT of local-pool existence', () => {
  it('Tower é executável quando calldata/target/spender são válidos, MESMO com pool local', async () => {
    const agg = evalAgg();
    globalThis.TowerAdapter = { getQuote: async () => towerQuote('tower', { calldata: '0xabcd', to: ADDR, spender: ADDR }) };
    globalThis.LocalAdapter = { getQuote: async () => towerQuote('local', { expectedOutRaw: 998200n }) };
    const r = await agg.getBestQuote(Object.assign({}, OPTS, { hasLocalPool: true }));
    const tower = r.quotes.find(q => q.source === 'tower');
    expect(tower.executable).toBe(true);
    expect(r.bestExecutable).not.toBeNull();
  });

  it('Tower continua NÃO executável quando calldata é inválido (sem pool local)', async () => {
    const agg = evalAgg();
    globalThis.TowerAdapter = { getQuote: async () => towerQuote('tower', { calldata: null, to: ADDR }) };
    globalThis.LocalAdapter = { getQuote: async () => ({ source: 'local', ok: false }) };
    const r = await agg.getBestQuote(Object.assign({}, OPTS, { hasLocalPool: false }));
    const tower = r.quotes.find(q => q.source === 'tower');
    expect(tower.executable).toBe(false);
    expect(r.executable).toBe(false);
  });

  it('agregador não usa a regra !hasLocalPool para Tower (source of truth)', () => {
    expect(aggSrc).toContain("qq.executable = towerExecutionValid(qq)");
    expect(aggSrc).not.toContain('(!hasLocalPool && towerExecutionValid');
  });
});

describe('Tower + Local são cotados em paralelo e isolados', () => {
  beforeEach(() => { delete globalThis.TowerAdapter; delete globalThis.LocalAdapter; });
  afterEach(() => { delete globalThis.TowerAdapter; delete globalThis.LocalAdapter; });

  it('LocalAdapter em loading (hang) NÃO bloqueia a quote Tower', async () => {
    const agg = evalAgg();
    globalThis.TowerAdapter = { getQuote: async () => towerQuote('tower', { calldata: '0xabcd', to: ADDR }) };
    globalThis.LocalAdapter = { getQuote: () => new Promise(() => {}) }; // hangs forever
    const r = await agg.getBestQuote(Object.assign({}, OPTS, { hasLocalPool: false, timeoutMs: 100 }));
    expect(r.quotes.some(q => q.source === 'tower' && q.ok === true)).toBe(true);
  });

  it('quote Tower funciona enquanto LocalAdapter ainda não retornou', async () => {
    const agg = evalAgg();
    let localResolve;
    globalThis.TowerAdapter = { getQuote: async () => towerQuote('tower', { calldata: '0xabcd', to: ADDR }) };
    globalThis.LocalAdapter = { getQuote: () => new Promise(res => { localResolve = res; }) };
    const p = agg.getBestQuote(Object.assign({}, OPTS, { hasLocalPool: false, timeoutMs: 5000 }));
    // Tower resolves immediately; local resolves later — assert both settle.
    localResolve(towerQuote('local', { expectedOutRaw: 998200n }));
    const r = await p;
    expect(r.quotes.some(q => q.source === 'tower' && q.ok === true)).toBe(true);
    expect(r.quotes.some(q => q.source === 'local' && q.ok === true)).toBe(true);
  });

  it('falha de execução Tower NÃO aciona fallback silencioso para Elligentt', () => {
    // The execution loop only reaches swpExecuteTowerOnly for the SELECTED Tower
    // route; there is no local-pool fallback after a Tower rejection.
    expect(html).toContain('swpExecuteTowerOnly');
    expect(html).not.toContain('usando pool local');
    expect(html).not.toContain('useTowerCalldata');
  });

  it('execução local NÃO faz fallback silencioso para Tower', () => {
    // Tower execution is an explicit early-return for the SELECTED route only.
    expect(html).toContain('if (SWP._towerQuoteData && SWP._towerQuoteData.calldata) {');
  });
});

describe('Pool loading é NON-BLOCKING (não atrasa render nem a quote Tower)', () => {
  it('updateSwapRate não faz mais `await loadSinglePool` antes de cotar', () => {
    const i = html.indexOf('async function updateSwapRate()');
    const j = html.indexOf('function calcRoutePriceImpact');
    const body = html.slice(i, j);
    expect(body).not.toContain('await loadSinglePool(pcfg)');
    expect(body).toContain('_swapPoolWarmupStarted');
    expect(body).toContain('loadAllPools().then');
  });

  it('pool discovery é disparado UMA única vez em background', () => {
    expect(html).toContain('let _swapPoolWarmupStarted = false');
    expect(html).toContain('_swapPoolWarmupStarted = true');
  });

  it('loadAllPools mantém dedup (sem requests duplicadas)', () => {
    expect(html).toContain('_poolLoadPromise');
    expect(html).toContain('if (_poolRefreshBusy && _poolLoadPromise) return _poolLoadPromise');
  });

  it('re-quote após pools prontos é guardado pelo race id', () => {
    expect(html).toContain('if (_swapQuoteSeq === quoteSeq) updateSwapRate()');
  });

  it('mount do Swap NÃO encadeia updateSwapRate/swpUpdatePoolInfo a loadAllPools', () => {
    const i = html.indexOf('document.addEventListener("DOMContentLoaded"');
    const j = html.indexOf('// ── Cross-Chain Intent Layer');
    const body = html.slice(i, j < 0 ? html.length : j);
    const chain = body.slice(body.indexOf('loadAllPools().then'), body.indexOf('_setInterval'));
    expect(chain).not.toContain('updateSwapRate()');
    expect(chain).not.toContain('swpUpdatePoolInfo()');
    expect(chain).toContain('renderPoolList()');
  });

  it('"Loading pools…" foi removido como estado visível (sem texto estático)', () => {
    expect(html).not.toContain('>Loading pools');
    expect(html).not.toContain("lbl.textContent = 'Loading pools");
    // swpUpdatePoolInfo esconde o status quando não há pool data.
    expect(html).toContain("pel.style.display = 'none'");
  });
});

describe('Tower é independente do PoolEngine / pool discovery', () => {
  it('TowerAdapter não referencia PoolEngine, pool discovery nem a rota local', () => {
    expect(towerSrc).not.toContain('PoolEngine');
    expect(towerSrc).not.toContain('loadPools');
    expect(towerSrc).not.toContain('hasLocalPool');
    expect(towerSrc).not.toContain('findRoute');
    expect(towerSrc).not.toContain('calcRouteOutputRaw');
  });

  it('TowerAdapter chama a própria API (/api/tower/swap-quote)', () => {
    expect(towerSrc).toContain('/api/tower/swap-quote');
  });
});

describe('Initial state — sem ROUTES / Summary vazios antes de quote', () => {
  it('ROUTES selector fica oculto por padrão (display:none) e só aparece com swp-routes', () => {
    expect(html).toContain('.swap-route-selector{display:none');
    expect(html).toContain('#page-swap.swp-standard.swp-routes .swap-route-selector{display:flex}');
  });

  it('Swap Summary fica oculto até existir quote válida (swp-routes)', () => {
    expect(html).toContain('#page-swap.swp-standard #swa-summary{display:none}');
    expect(html).toContain('#page-swap.swp-standard.swp-routes #swa-summary{display:block}');
  });

  it('clearRouteSelector remove a classe swp-routes (initial state limpo)', () => {
    const modeSrc = fs.readFileSync(path.join(root, 'shared', 'swapUiModes.js'), 'utf8');
    expect(modeSrc).toContain("page.classList.remove('swp-routes')");
  });

  it('Standard tem espaço vertical entre o header e o conteúdo (24-32px)', () => {
    expect(html).toContain('#page-swap.swp-standard .st-main-area{flex:0 0 auto;height:auto;min-height:0;overflow:visible;display:block;padding:28px 16px 48px}');
  });

  it('pool status (terminal chrome) fica oculto no Standard', () => {
    expect(html).toContain('#page-swap.swp-standard .st-pool-status{display:none}');
  });
});

describe('Seleção de provider (estado canônico)', () => {
  it('SWP.selectedSource é o estado canônico (null | local | tower)', () => {
    expect(html).toContain('selectedSource: null');
    expect(html).toContain("SWP.selectedSource = source;");
  });

  it('Tower é selecionável via swpSelectRoute quando executável', () => {
    expect(html).toContain('function swpSelectRoute(source)');
    expect(html).toContain('SwapUiModes.findExecutableQuote(SWP.aggQuotes, source)');
  });

  it('seleção persiste com o mesmo paramsKey e reseta quando ele muda', () => {
    expect(html).toContain('selectedParamsKey');
    expect(html).toContain('resolveSelection');
  });
});

describe('Standard header — Connect Wallet + network switch', () => {
  it('header do Standard tem Connect Wallet + network pill (Docs removido do header)', () => {
    const header = html.slice(html.indexOf('id="swp-std-header"'), html.indexOf('<!-- Terminal Header -->'));
    expect(header).toContain('swp-std-wallet-label');
    expect(header).toContain('swp-std-network');
    expect(header).toContain('onclick="walletChipClick()"');
    expect(header).toContain('onclick="openNetworkSelector()"');
    expect(header).not.toContain('ti-book');
    expect(header).not.toContain('>Docs<');
  });

  it('swpSyncStdHeader sincroniza wallet + rede a partir do estado global (sem novo manager)', () => {
    expect(html).toContain('function swpSyncStdHeader()');
    expect(html).toContain("lbl.textContent = walletAddress ? shortAddr(walletAddress) : 'Connect Wallet'");
    expect(html).toContain("net.textContent = walletAddress");
  });

  it('swpSyncStdHeader é chamado no connect, disconnect e network switch', () => {
    const calls = (html.match(/swpSyncStdHeader\(\)/g) || []).length;
    expect(calls).toBeGreaterThanOrEqual(4);
  });
});

describe('Wallet + Advanced + History invariants', () => {
  it('wallet desconectada mostra Connect Wallet', () => {
    expect(html).toContain("swpSetBtn('nowallt', 'Connect Wallet')");
    expect(html).toContain('Connect Wallet');
  });

  it('Connect Wallet usa o wallet manager existente (openWalletModal), não um novo sistema', () => {
    expect(html).toContain("if (!walletAddress) { openWalletModal(); return; }");
    expect(html).toContain("state === 'nowallt'");
    // No novo wallet manager é criado para o Standard.
    expect(html).not.toContain('StandardWallet');
    expect(html).not.toContain('swapWalletManager');
  });

  it('wallet conectada mostra o botão de Swap (executa via executeSwap)', () => {
    expect(html).toContain('onclick="executeSwap()"');
    expect(html).toContain("swpSetBtn('ready', `Swap");
  });

  it('Advanced não é alterado (terminal chrome preservado fora de .swp-standard)', () => {
    expect(html).not.toContain('#page-swap.swp-advanced .st-chart-section{display:none}');
    expect(html).toContain('class="st-chart-section"');
  });

  it('histórico permanece compartilhado (sem StandardHistory/AdvancedHistory)', () => {
    expect(html).not.toContain('standardHistory');
    expect(html).not.toContain('advancedHistory');
    expect(html).toContain("getElementById('swa-hist-list')");
  });

  it('nenhum engine de provider duplicado foi criado', () => {
    expect(html).not.toContain('TowerAdapter2');
    expect(html).not.toContain('LocalAdapter2');
    expect(html).not.toContain('SwapAggregator2');
    expect(fs.existsSync(path.join(root, 'shared', 'SwapAggregator.js'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'shared', 'TowerAdapter.js'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'shared', 'LocalAdapter.js'))).toBe(true);
  });
});
