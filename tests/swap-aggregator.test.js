/**
 * AUTONOMA-SWAP — SwapAggregator / LocalAdapter / TowerAdapter tests.
 * ═══════════════════════════════════════════════════════════════════════
 * Proves Tower is now an ADDITIONAL liquidity source compared against the
 * Elligentt local pools (never a priority, never a pure fallback), and that
 * external calldata/spender/target are validated before execution.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const towerSrc = fs.readFileSync(path.join(root, 'shared', 'TowerAdapter.js'), 'utf8');
const localSrc = fs.readFileSync(path.join(root, 'shared', 'LocalAdapter.js'), 'utf8');
const aggSrc = fs.readFileSync(path.join(root, 'shared', 'SwapAggregator.js'), 'utf8');
const srcHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function evalModule(src, win) {
  const fn = new Function('window', src);
  fn.call(null, win);
}

function makeWindow() {
  return { TowerAdapter: undefined, LocalAdapter: undefined, SwapAggregator: undefined };
}

function fakeSwapMath() {
  return {
    calcMinOut: (o, b) => {
      const ob = BigInt(o); const bb = BigInt(Math.floor(Number(b) || 0));
      return (ob * (10000n - bb)) / 10000n;
    },
  };
}

function towerQuote(src, over) {
  return Object.assign({
    source: src, ok: true, tokenIn: 'USDC', tokenOut: 'EURC', chainId: 5042002,
    amountInRaw: 1000000n, expectedOutRaw: 1000000n, minOutRaw: 995000n,
    priceImpactBps: null, feeBps: null, route: null, calldata: null, to: null,
    spender: null, expiresAt: Date.now() + 60000, executionType: 'tower',
  }, over || {});
}

describe('SwapAggregator.pickBest — deterministic selection', () => {
  let agg;
  beforeEach(() => { const w = makeWindow(); evalModule(aggSrc, w); agg = w.SwapAggregator; });

  it('1. Tower melhor → Tower selecionada', () => {
    const r = agg.pickBest([
      towerQuote('tower', { expectedOutRaw: 1015000n, minOutRaw: 1009925n }),
      towerQuote('local', { expectedOutRaw: 1012000n, minOutRaw: 1006940n, executionType: 'local' }),
    ]);
    expect(r.ok).toBe(true);
    expect(r.best.source).toBe('tower');
  });

  it('2. Local melhor → Local selecionada', () => {
    const r = agg.pickBest([
      towerQuote('tower', { expectedOutRaw: 1005000n }),
      towerQuote('local', { expectedOutRaw: 1012000n, executionType: 'local' }),
    ]);
    expect(r.ok).toBe(true);
    expect(r.best.source).toBe('local');
  });

  it('7. ambas indisponíveis → bloqueio', () => {
    const r = agg.pickBest([
      { source: 'tower', ok: false, error: 'x' },
      { source: 'local', ok: false, error: 'y' },
    ]);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NO_ROUTE_AVAILABLE');
  });

  it('8. amount inválido (expectedOut 0) → rejeitada, usa a outra', () => {
    const r = agg.pickBest([
      towerQuote('tower', { expectedOutRaw: 0n, minOutRaw: 0n }),
      towerQuote('local', { expectedOutRaw: 1012000n, executionType: 'local' }),
    ]);
    expect(r.ok).toBe(true);
    expect(r.best.source).toBe('local');
  });

  it('tie em expectedOut → maior minOutRaw vence', () => {
    const r = agg.pickBest([
      towerQuote('tower', { expectedOutRaw: 1000000n, minOutRaw: 990000n }),
      towerQuote('local', { expectedOutRaw: 1000000n, minOutRaw: 995000n, executionType: 'local' }),
    ]);
    expect(r.best.source).toBe('local');
  });
});

describe('SwapAggregator.getBestQuote — isolation + selection', () => {
  beforeEach(() => { delete globalThis.TowerAdapter; delete globalThis.LocalAdapter; });
  afterEach(() => { delete globalThis.TowerAdapter; delete globalThis.LocalAdapter; });

  function evalAgg() {
    const w = makeWindow(); evalModule(aggSrc, w); return w.SwapAggregator;
  }
  const opts = { tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 1000000n, slippageBps: 50, chainId: 5042002 };

  it('3. Tower offline → Local selecionada', async () => {
    globalThis.TowerAdapter = { getQuote: async () => ({ source: 'tower', ok: false, error: 'offline' }) };
    globalThis.LocalAdapter = { getQuote: async () => towerQuote('local', { executionType: 'local' }) };
    const agg = evalAgg();
    const r = await agg.getBestQuote(opts);
    expect(r.ok).toBe(true);
    expect(r.best.source).toBe('local');
  });

  it('4. Local offline → Tower selecionada', async () => {
    globalThis.TowerAdapter = { getQuote: async () => towerQuote('tower') };
    globalThis.LocalAdapter = { getQuote: async () => ({ source: 'local', ok: false, error: 'offline' }) };
    const agg = evalAgg();
    const r = await agg.getBestQuote(opts);
    expect(r.ok).toBe(true);
    expect(r.best.source).toBe('tower');
  });

  it('5. Tower timeout (rejection) → Local selecionada', async () => {
    globalThis.TowerAdapter = { getQuote: async () => { throw new Error('timeout'); } };
    globalThis.LocalAdapter = { getQuote: async () => towerQuote('local', { executionType: 'local' }) };
    const agg = evalAgg();
    const r = await agg.getBestQuote(opts);
    expect(r.ok).toBe(true);
    expect(r.best.source).toBe('local');
  });

  it('5b. Tower hang (nunca resolve) → Local selecionada sem esperar além do timeout', async () => {
    globalThis.TowerAdapter = { getQuote: () => new Promise(() => {}) }; // hangs forever
    globalThis.LocalAdapter = { getQuote: async () => towerQuote('local', { executionType: 'local' }) };
    const agg = evalAgg();
    const r = await agg.getBestQuote(Object.assign({}, opts, { timeoutMs: 100 }));
    expect(r.ok).toBe(true);
    expect(r.best.source).toBe('local');
  });

  it('6. Tower resposta inválida → Local selecionada', async () => {
    globalThis.TowerAdapter = { getQuote: async () => ({ source: 'tower', ok: true, expectedOutRaw: 0n, minOutRaw: 0n }) };
    globalThis.LocalAdapter = { getQuote: async () => towerQuote('local', { executionType: 'local' }) };
    const agg = evalAgg();
    const r = await agg.getBestQuote(opts);
    expect(r.ok).toBe(true);
    expect(r.best.source).toBe('local');
  });

  it('7. ambas indisponíveis → bloqueio', async () => {
    globalThis.TowerAdapter = { getQuote: async () => ({ source: 'tower', ok: false }) };
    globalThis.LocalAdapter = { getQuote: async () => ({ source: 'local', ok: false }) };
    const agg = evalAgg();
    const r = await agg.getBestQuote(opts);
    expect(r.ok).toBe(false);
  });

  it('9. token mismatch → quote rejeitada', async () => {
    globalThis.TowerAdapter = { getQuote: async () => towerQuote('tower', { tokenOut: 'cirBTC' }) };
    globalThis.LocalAdapter = { getQuote: async () => towerQuote('local', { executionType: 'local' }) };
    const agg = evalAgg();
    const r = await agg.getBestQuote(opts);
    expect(r.ok).toBe(true);
    expect(r.best.source).toBe('local');
  });

  it('10. chain mismatch → quote rejeitada', async () => {
    globalThis.TowerAdapter = { getQuote: async () => towerQuote('tower', { chainId: 1 }) };
    globalThis.LocalAdapter = { getQuote: async () => towerQuote('local', { executionType: 'local' }) };
    const agg = evalAgg();
    const r = await agg.getBestQuote(opts);
    expect(r.ok).toBe(true);
    expect(r.best.source).toBe('local');
  });

  it('14. stale quote (expiresAt no passado) → rejeitada', async () => {
    globalThis.TowerAdapter = { getQuote: async () => towerQuote('tower', { expiresAt: Date.now() - 1000 }) };
    globalThis.LocalAdapter = { getQuote: async () => towerQuote('local', { executionType: 'local' }) };
    const agg = evalAgg();
    const r = await agg.getBestQuote(opts);
    expect(r.ok).toBe(true);
    expect(r.best.source).toBe('local');
  });
});

describe('TowerAdapter.getQuote + validateResponse — external calldata safety', () => {
  beforeEach(() => { delete globalThis.fetch; delete globalThis.walletAddress; delete globalThis.SwapMath; globalThis.SwapMath = fakeSwapMath(); });
  afterEach(() => { delete globalThis.fetch; delete globalThis.SwapMath; });

  function evalTower() { const w = makeWindow(); evalModule(towerSrc, w); return w.TowerAdapter; }

  const ADDR = '0x2de8906a641d65d490bc60a4179d961d59742bcb';

  it('getQuote normaliza + recompõe minOut via SwapMath (não confia no minOut da Tower)', async () => {
    globalThis.fetch = async () => ({
      json: async () => ({ ok: true, data: { expectedOut: '1000000', minOut: '1', priceImpact: 0.5, feeBps: 25, calldata: '0xabcd', to: ADDR, spender: ADDR } }),
    });
    const t = evalTower();
    const q = await t.getQuote({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 1000000n, slippageBps: 50 });
    expect(q.ok).toBe(true);
    expect(q.source).toBe('tower');
    expect(q.expectedOutRaw).toBe(1000000n);
    expect(q.minOutRaw).toBe(995000n); // recomputed locally, Tower's "1" ignored
    expect(q.calldata).toBe('0xabcd');
  });

  it('11. invalid spender → validateResponse bloqueia', () => {
    const t = evalTower();
    const r = t.validateResponse({ calldata: '0xabcd', to: ADDR, spender: '0x0000000000000000000000000000000000000000', expectedOutRaw: 1n });
    expect(r.ok).toBe(false);
  });

  it('12. invalid target → validateResponse bloqueia', () => {
    const t = evalTower();
    const r = t.validateResponse({ calldata: '0xabcd', to: '0x0000000000000000000000000000000000000000', expectedOutRaw: 1n });
    expect(r.ok).toBe(false);
  });

  it('13. invalid calldata → validateResponse bloqueia', () => {
    const t = evalTower();
    const r = t.validateResponse({ calldata: 'not-hex', to: ADDR, expectedOutRaw: 1n });
    expect(r.ok).toBe(false);
  });

  it('19/20. Tower falha sem quebrar o agregador (ok:false estruturado)', async () => {
    globalThis.fetch = async () => { throw new Error('network'); };
    const t = evalTower();
    const q = await t.getQuote({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 1000000n, slippageBps: 50 });
    expect(q.ok).toBe(false);
    expect(q.source).toBe('tower');
  });
});

describe('LocalAdapter.getQuote — local pools independentes', () => {
  beforeEach(() => {
    delete globalThis.findRoute; delete globalThis.calcRouteOutputRaw; delete globalThis.getRouteFee;
    delete globalThis.getCachedProvider; delete globalThis.ethers; delete globalThis.getTokAddr;
    delete globalThis.SwapMath; globalThis.SwapMath = fakeSwapMath();
  });
  afterEach(() => {
    delete globalThis.findRoute; delete globalThis.calcRouteOutputRaw; delete globalThis.getRouteFee;
    delete globalThis.getCachedProvider; delete globalThis.ethers; delete globalThis.getTokAddr;
    delete globalThis.SwapMath;
  });

  function evalLocal() { const w = makeWindow(); evalModule(localSrc, w); return w.LocalAdapter; }
  const ROUTE = { type: 'direct', noLiq: false, pools: [{ id: 'p1', address: '0x0000000000000000000000000000000000000000', tokenA: 'USDC', tokenB: 'EURC' }], hops: ['USDC', 'EURC'] };

  it('19. local pool funciona sem Tower', async () => {
    globalThis.findRoute = () => ROUTE;
    globalThis.calcRouteOutputRaw = () => ({ ok: true, amountOutRaw: 1012000n });
    globalThis.getRouteFee = () => 30;
    const l = evalLocal();
    const q = await l.getQuote({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 1000000n, slippageBps: 50 });
    expect(q.ok).toBe(true);
    expect(q.source).toBe('local');
    expect(q.expectedOutRaw).toBe(1012000n);
    expect(q.minOutRaw).toBe(1006940n);
    expect(q.executionType).toBe('local');
  });

  it('local sem rota → ok:false', async () => {
    globalThis.findRoute = () => null;
    const l = evalLocal();
    const q = await l.getQuote({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 1000000n, slippageBps: 50 });
    expect(q.ok).toBe(false);
  });

  it('local quote falha → ok:false', async () => {
    globalThis.findRoute = () => ROUTE;
    globalThis.calcRouteOutputRaw = () => ({ ok: false, error: 'ZERO_LIQUIDITY' });
    const l = evalLocal();
    const q = await l.getQuote({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 1000000n, slippageBps: 50 });
    expect(q.ok).toBe(false);
  });
});

describe('SwapAggregator — Tower quoted for ALL pairs + strict validation', () => {
  beforeEach(() => { delete globalThis.TowerAdapter; delete globalThis.LocalAdapter; });
  afterEach(() => { delete globalThis.TowerAdapter; delete globalThis.LocalAdapter; });

  function evalAgg() {
    const w = makeWindow(); evalModule(aggSrc, w); return w.SwapAggregator;
  }
  const opts = { tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 1000000n, slippageBps: 50, chainId: 5042002 };
  const ADDR = '0x2de8906a641d65d490bc60a4179d961d59742bcb';

  it('1/27. Tower é consultada mesmo quando existe pool local (hasLocalPool=true)', async () => {
    let towerCalls = 0, localCalls = 0;
    globalThis.TowerAdapter = { getQuote: async () => { towerCalls++; return towerQuote('tower', { expectedOutRaw: 1001400n, calldata: '0xabcd', to: ADDR }); } };
    globalThis.LocalAdapter = { getQuote: async () => { localCalls++; return towerQuote('local', { expectedOutRaw: 998200n, executable: true }); } };
    const agg = evalAgg();
    const r = await agg.getBestQuote(Object.assign({}, opts, { hasLocalPool: true }));
    expect(towerCalls).toBe(1);
    expect(localCalls).toBe(1);
    expect(r.quotes.some(q => q.source === 'tower')).toBe(true);
    expect(r.quotes.some(q => q.source === 'local')).toBe(true);
  });

  it('3. Tower + Local são cotados em paralelo (ambos chamados)', async () => {
    const callOrder = [];
    globalThis.TowerAdapter = { getQuote: async () => { callOrder.push('tower'); return towerQuote('tower', { calldata: '0xabcd', to: ADDR }); } };
    globalThis.LocalAdapter = { getQuote: async () => { callOrder.push('local'); return towerQuote('local', { executable: true }); } };
    const agg = evalAgg();
    await agg.getBestQuote(Object.assign({}, opts, { hasLocalPool: true }));
    expect(callOrder).toContain('tower');
    expect(callOrder).toContain('local');
  });

  it('12. tokenIn mismatch → quote inválida (rejeitada)', async () => {
    globalThis.TowerAdapter = { getQuote: async () => towerQuote('tower', { tokenIn: 'EURC' }) };
    globalThis.LocalAdapter = { getQuote: async () => towerQuote('local', { executable: true }) };
    const agg = evalAgg();
    const r = await agg.getBestQuote(opts);
    expect(r.best.source).toBe('local');
  });

  it('13. tokenOut mismatch → quote inválida (rejeitada)', async () => {
    globalThis.TowerAdapter = { getQuote: async () => towerQuote('tower', { tokenOut: 'cirBTC' }) };
    globalThis.LocalAdapter = { getQuote: async () => towerQuote('local', { executable: true }) };
    const agg = evalAgg();
    const r = await agg.getBestQuote(opts);
    expect(r.best.source).toBe('local');
  });

  it('14. chain mismatch → quote inválida (rejeitada)', async () => {
    globalThis.TowerAdapter = { getQuote: async () => towerQuote('tower', { chainId: 1 }) };
    globalThis.LocalAdapter = { getQuote: async () => towerQuote('local', { executable: true }) };
    const agg = evalAgg();
    const r = await agg.getBestQuote(opts);
    expect(r.best.source).toBe('local');
  });

  it('15. amount mismatch → quote inválida (rejeitada)', async () => {
    globalThis.TowerAdapter = { getQuote: async () => towerQuote('tower', { amountInRaw: 999999n }) };
    globalThis.LocalAdapter = { getQuote: async () => towerQuote('local', { executable: true }) };
    const agg = evalAgg();
    const r = await agg.getBestQuote(opts);
    expect(r.best.source).toBe('local');
  });

  it('quote sem tokenIn (campo obrigatório ausente) → inválida', async () => {
    globalThis.TowerAdapter = { getQuote: async () => ({ source: 'tower', ok: true, tokenOut: 'EURC', amountInRaw: 1000000n, chainId: 5042002, expectedOutRaw: 1000000n, minOutRaw: 995000n }) };
    globalThis.LocalAdapter = { getQuote: async () => towerQuote('local', { executable: true }) };
    const agg = evalAgg();
    const r = await agg.getBestQuote(opts);
    expect(r.best.source).toBe('local');
  });

  it('16. quote expirada → inválida (rejeitada)', async () => {
    globalThis.TowerAdapter = { getQuote: async () => towerQuote('tower', { expiresAt: Date.now() - 1000 }) };
    globalThis.LocalAdapter = { getQuote: async () => towerQuote('local', { executable: true }) };
    const agg = evalAgg();
    const r = await agg.getBestQuote(opts);
    expect(r.best.source).toBe('local');
  });

  it('22/24. Tower calldata inválida/spender zero → não executável (towerExecutionValid)', () => {
    const a = evalAgg();
    expect(a.towerExecutionValid({ calldata: 'not-hex', to: ADDR, spender: ADDR })).toBe(false);
    expect(a.towerExecutionValid({ calldata: '0xabcd', to: ADDR, spender: '0x0000000000000000000000000000000000000000' })).toBe(false);
    expect(a.towerExecutionValid({ calldata: '0xabcd', to: '0x0000000000000000000000000000000000000000', spender: ADDR })).toBe(false);
    expect(a.towerExecutionValid({ calldata: '0xabcd', to: ADDR, spender: ADDR })).toBe(true);
  });

  it('6/28/29. Tower pior NÃO desaparece — permanece em quotes[] e continua executável', async () => {
    globalThis.TowerAdapter = { getQuote: async () => towerQuote('tower', { expectedOutRaw: 900000n, calldata: '0xabcd', to: ADDR }) };
    globalThis.LocalAdapter = { getQuote: async () => towerQuote('local', { expectedOutRaw: 998200n, executable: true }) };
    const agg = evalAgg();
    const r = await agg.getBestQuote(Object.assign({}, opts, { hasLocalPool: true }));
    expect(r.best.source).toBe('local');
    const tower = r.quotes.find(q => q.source === 'tower');
    expect(tower).toBeTruthy(); // Tower stays in the comparison
    expect(tower.executable).toBe(true); // valid calldata → executable (independent of local pool)
  });

  it('10/11. Local offline → Tower ainda aparece; ambos offline → bloqueio', async () => {
    globalThis.TowerAdapter = { getQuote: async () => towerQuote('tower', { calldata: '0xabcd', to: ADDR }) };
    globalThis.LocalAdapter = { getQuote: async () => ({ source: 'local', ok: false }) };
    const agg = evalAgg();
    const r1 = await agg.getBestQuote(Object.assign({}, opts, { hasLocalPool: false }));
    expect(r1.quotes.some(q => q.source === 'tower')).toBe(true);

    globalThis.TowerAdapter = { getQuote: async () => ({ source: 'tower', ok: false }) };
    const r2 = await agg.getBestQuote(Object.assign({}, opts, { hasLocalPool: false }));
    expect(r2.bestExecutable).toBeNull();
    expect(r2.executable).toBe(false);
  });
});

describe('index.html — structural invariants', () => {
  it('SwapAggregator é usado no updateSwapRate (Tower não é mais prioridade)', () => {
    expect(srcHtml).toContain('SwapAggregator.getBestQuote');
    expect(srcHtml).toContain("source = 'Tower Exchange'");
    expect(srcHtml).toContain("source = 'Elligentt Pool'");
    expect(srcHtml).toContain('agg.bestExecutable');
    expect(srcHtml).toContain('const hasLocalPool = !!(route && !route.noLiq)');
    expect(srcHtml).toContain('chainId: 5042002');
    expect(srcHtml).toContain('resolveSelection');
    expect(srcHtml).toContain('SWP._towerQuoteData = selected.calldata ? selected : null');
  });

  it('approval exato (não 2×) + receipt + re-read de allowance', () => {
    expect(srcHtml).not.toContain('amtBig * 2n');
    expect(srcHtml).toContain('approve(approveTarget, amtBig');
    expect(srcHtml).toContain('appReceipt.status !== 1');
    expect(srcHtml).toContain('newAllowance');
  });

  it('race guard de quote presente', () => {
    expect(srcHtml).toContain('_swapQuoteSeq');
    expect(srcHtml).toContain('if (quoteSeq !== _swapQuoteSeq) return;');
  });

  it('execution lock preservado (_swpExecuting)', () => {
    expect(srcHtml).toContain('_swpExecuting');
  });

  it('Tower-only execution path valida calldata + recompõe minOut localmente', () => {
    expect(srcHtml).toContain('async function swpExecuteTowerOnly');
    expect(srcHtml).toContain('TowerAdapter.validateResponse');
    expect(srcHtml).toContain('SwapMath.calcMinOut(expectedOutRaw, slippageBps)');
  });

  it('módulos canônicos preservados (swapMath/poolEngine/poolRouter/poolExecutor)', () => {
    for (const f of ['swapMath.js', 'poolEngine.js', 'poolRouter.js', 'poolExecutor.js']) {
      expect(fs.existsSync(path.join(root, 'shared', f))).toBe(true);
    }
    expect(srcHtml).toContain('/shared/swapMath.js');
    expect(srcHtml).toContain('/shared/poolEngine.js');
    expect(srcHtml).toContain('/shared/poolRouter.js');
    expect(srcHtml).toContain('/shared/poolExecutor.js');
    expect(srcHtml).toContain('/shared/TowerAdapter.js');
    expect(srcHtml).toContain('/shared/LocalAdapter.js');
    expect(srcHtml).toContain('/shared/SwapAggregator.js');
  });
});
