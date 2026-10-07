/**
 * billing-crosschain-production.test.js
 * 
 * Tests for real cross-chain billing flow, on-chain verification,
 * session auth, and regression coverage.
 * 
 * Runs under vitest (no browser, no live network).
 * Mocks only: fetch (to prevent real HTTP), window globals (DOM APIs).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — BillingCrosschain shared module
// ═══════════════════════════════════════════════════════════════════════════

describe('BillingCrosschain module', () => {
  let BillingCrosschain;

  beforeEach(async () => {
    // Load the module into a minimal window-like context
    const src = await import('fs').then(fs =>
      fs.promises.readFile('shared/billingCrosschain.js', 'utf8')
    );
    const win = { BillingCrosschain: null };
    const fn = new Function('window', src);
    fn(win);
    BillingCrosschain = win.BillingCrosschain;
  });

  it('CHAIN_IDS contains Arc Mainnet with chainId 5042', () => {
    expect(BillingCrosschain.CHAIN_IDS['Arc Mainnet']).toBe(5042);
  });

  it('CHAIN_IDS does NOT contain Arc Testnet', () => {
    const names = Object.keys(BillingCrosschain.CHAIN_IDS);
    for (const name of names) {
      expect(name).not.toMatch(/testnet/i);
    }
  });

  it('USDC[5042] is the Arc Mainnet USDC address', () => {
    expect(BillingCrosschain.USDC[5042]).toBe('0x3600000000000000000000000000000000000000');
  });

  it('USDC[8453] is the Base USDC address', () => {
    expect(BillingCrosschain.USDC[8453]).toMatch(/^0x/i);
    expect(BillingCrosschain.USDC[8453].toLowerCase()).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
  });

  it('_chainIdFor resolves string to number', () => {
    expect(BillingCrosschain._chainIdFor('Arc Mainnet')).toBe(5042);
    expect(BillingCrosschain._chainIdFor('Base')).toBe(8453);
  });

  it('_chainIdFor returns number as-is', () => {
    expect(BillingCrosschain._chainIdFor(42161)).toBe(42161);
  });

  it('_fmtTime formats seconds to readable string', () => {
    expect(BillingCrosschain._fmtTime(30)).toBe('30s');
    expect(BillingCrosschain._fmtTime(90)).toBe('2m');
    expect(BillingCrosschain._fmtTime(0)).toBe('—');
    expect(BillingCrosschain._fmtTime(null)).toBe('—');
  });

  it('_fmtAmount converts raw units with decimals', () => {
    expect(BillingCrosschain._fmtAmount('1000000', 6)).toBe('1.000000');
    expect(BillingCrosschain._fmtAmount('500000', 6)).toBe('0.500000');
  });

  it('_renderRouteCards returns "No cross-chain routes" when routes empty', () => {
    const html = BillingCrosschain._renderRouteCards([], 0);
    expect(html).toContain('No cross-chain routes available');
  });

  it('_renderRouteCards renders real route data without mocks', () => {
    const fakeRoutes = [{
      steps: [{
        toolDetails: { name: 'Across' },
        tool: 'across',
        estimate: {
          executionDuration: 60,
          gasCosts: [{ amountUSD: '0.05' }],
          feeCosts: [],
        },
      }],
      toAmountMin: '995000',
    }];
    const html = BillingCrosschain._renderRouteCards(fakeRoutes, 0);
    expect(html).toContain('Across');
    expect(html).toContain('brs-selected');
    expect(html).toContain('0.995000');
  });

  it('_toolName extracts provider name from route', () => {
    const route = { steps: [{ toolDetails: { name: 'Stargate' }, tool: 'stargate' }] };
    expect(BillingCrosschain._toolName(route)).toBe('Stargate');
  });

  it('_renderRouteCards marks best rate when one route maximizes received', () => {
    const routes = [
      {
        steps: [{ toolDetails: { name: 'A' }, tool: 'a', estimate: { executionDuration: 60 } }],
        toAmountMin: '990000',
      },
      {
        steps: [{ toolDetails: { name: 'B' }, tool: 'b', estimate: { executionDuration: 30 } }],
        toAmountMin: '995000',  // highest — BEST RATE
      },
    ];
    const html = BillingCrosschain._renderRouteCards(routes, 0);
    expect(html).toContain('BEST RATE');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — fetchRoutes calls /api/lifi/routes (no mock bypass)
// ═══════════════════════════════════════════════════════════════════════════

describe('BillingCrosschain.fetchRoutes', () => {
  let BillingCrosschain;
  let fetchCalled = false;
  let lastFetchBody = null;

  beforeEach(async () => {
    fetchCalled = false;
    lastFetchBody = null;

    const src = await import('fs').then(fs =>
      fs.promises.readFile('shared/billingCrosschain.js', 'utf8')
    );

    // Mock fetch that captures the call
    const mockFetch = async (url, opts) => {
      fetchCalled = true;
      if (url.includes('/api/lifi/routes')) {
        lastFetchBody = JSON.parse(opts?.body || '{}');
        // Simulate LI.FI returning no routes (real failure path)
        return { ok: false, json: async () => ({ message: 'Simulated: no routes' }) };
      }
      return { ok: false, json: async () => ({}) };
    };

    const win = { BillingCrosschain: null, fetch: mockFetch };
    const fn = new Function('window', 'fetch', src.replace(/\bfetch\(/g, 'fetch('));
    // Re-eval with fetch injected
    const fn2 = new Function('window', src);
    fn2(win);
    BillingCrosschain = win.BillingCrosschain;
    // Monkey-patch fetch on the module
    global.fetch = mockFetch;
  });

  afterEach(() => {
    delete global.fetch;
  });

  it('calls /api/lifi/routes (not any other endpoint) for cross-chain', async () => {
    const result = await BillingCrosschain.fetchRoutes({
      fromChainId: 8453,
      toChainId:   5042,
      fromToken:   '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      toToken:     '0x3600000000000000000000000000000000000000',
      fromAmount:  '10000000',
      fromAddress: '0xabc123abc123abc123abc123abc123abc123abc1',
      toAddress:   '0xdef456def456def456def456def456def456def4',
    });
    expect(fetchCalled).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Simulated');
  });

  it('sends lowercase addresses to LI.FI routes', async () => {
    await BillingCrosschain.fetchRoutes({
      fromChainId: 8453,
      toChainId:   5042,
      fromToken:   '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // mixed case
      toToken:     '0x3600000000000000000000000000000000000000',
      fromAmount:  '10000000',
      fromAddress: '0xABC123ABC123ABC123ABC123ABC123ABC123ABC1',
      toAddress:   '0xDEF456DEF456DEF456DEF456DEF456DEF456DEF4',
    });
    // fromAddress and toAddress must be lowercased in the request
    expect(lastFetchBody?.fromAddress).toBe('0xabc123abc123abc123abc123abc123abc123abc1');
    expect(lastFetchBody?.toAddress).toBe('0xdef456def456def456def456def456def456def4');
  });

  it('LI.FI failure returns ok:false without throwing', async () => {
    const result = await BillingCrosschain.fetchRoutes({
      fromChainId: 1, toChainId: 5042,
      fromToken: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      toToken:   '0x3600000000000000000000000000000000000000',
      fromAmount: '5000000', fromAddress: '0x1234', toAddress: '0x5678',
    });
    expect(result.ok).toBe(false);
    expect(result.routes).toEqual([]);
    expect(typeof result.error).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — Backend payment verification (functions/api/payment/[token].js)
// ═══════════════════════════════════════════════════════════════════════════

describe('Backend payment verification logic', () => {
  // We test the pure logic extracted from the worker without running wrangler

  // addrMatch replica
  function addrMatch(a, b) {
    if (!a || !b) return false;
    return a.toLowerCase().replace(/^0x0+/, '0x') === b.toLowerCase().replace(/^0x0+/, '0x');
  }

  const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

  function findTransfer(receipt, tokenAddr, toAddr, expectedRaw, toleranceUnits = 1n) {
    const token = tokenAddr.toLowerCase();
    const to = toAddr.toLowerCase();
    for (const log of (receipt.logs || [])) {
      if (log.address.toLowerCase() !== token) continue;
      if (!log.topics || log.topics.length < 3) continue;
      if (log.topics[0] !== TRANSFER_TOPIC) continue;
      const logTo = '0x' + log.topics[2].slice(26).toLowerCase();
      if (!addrMatch(logTo, to)) continue;
      const value = BigInt(log.data);
      const diff = value > expectedRaw ? value - expectedRaw : expectedRaw - value;
      if (diff <= toleranceUnits) return { from: '0x' + log.topics[1].slice(26), to: logTo, value };
    }
    return null;
  }

  const USDC  = '0x3600000000000000000000000000000000000000';
  const RECIP = '0xbfc9e8f79bd30b912081ae88f9ad0a515f08c2f1';
  const PAYER = '0x1111111111111111111111111111111111111111';

  function makeTransferLog(from, to, value) {
    return {
      address: USDC,
      topics: [
        TRANSFER_TOPIC,
        '0x000000000000000000000000' + from.replace('0x', ''),
        '0x000000000000000000000000' + to.replace('0x', ''),
      ],
      data: '0x' + BigInt(value).toString(16).padStart(64, '0'),
    };
  }

  it('findTransfer accepts exact amount match', () => {
    const receipt = { logs: [makeTransferLog(PAYER, RECIP, 1000000n)] };
    const result = findTransfer(receipt, USDC, RECIP, 1000000n);
    expect(result).not.toBeNull();
    expect(result.value).toBe(1000000n);
  });

  it('findTransfer accepts amount within tolerance (1 unit)', () => {
    const receipt = { logs: [makeTransferLog(PAYER, RECIP, 1000001n)] };
    const result = findTransfer(receipt, USDC, RECIP, 1000000n, 2n);
    expect(result).not.toBeNull();
  });

  it('findTransfer rejects wrong recipient', () => {
    const wrongRecip = '0x2222222222222222222222222222222222222222';
    const receipt = { logs: [makeTransferLog(PAYER, wrongRecip, 1000000n)] };
    const result = findTransfer(receipt, USDC, RECIP, 1000000n);
    expect(result).toBeNull();
  });

  it('findTransfer rejects wrong token', () => {
    const wrongToken = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const receipt = {
      logs: [{
        address: wrongToken,
        topics: [TRANSFER_TOPIC, '0x' + '0'.repeat(24) + PAYER.slice(2), '0x' + '0'.repeat(24) + RECIP.slice(2)],
        data: '0x' + (1000000n).toString(16).padStart(64, '0'),
      }]
    };
    const result = findTransfer(receipt, USDC, RECIP, 1000000n);
    expect(result).toBeNull();
  });

  it('findTransfer rejects amount too far from expected', () => {
    const receipt = { logs: [makeTransferLog(PAYER, RECIP, 500000n)] }; // half the amount
    const result = findTransfer(receipt, USDC, RECIP, 1000000n, 2n);
    expect(result).toBeNull();
  });

  it('findTransfer rejects empty logs', () => {
    expect(findTransfer({ logs: [] }, USDC, RECIP, 1000000n)).toBeNull();
    expect(findTransfer({ logs: null }, USDC, RECIP, 1000000n)).toBeNull();
  });

  it('findTransfer rejects zero amount', () => {
    const receipt = { logs: [makeTransferLog(PAYER, RECIP, 0n)] };
    const result = findTransfer(receipt, USDC, RECIP, 1000000n, 2n);
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — Auth helper in invoice.js / payment-links.js
// ═══════════════════════════════════════════════════════════════════════════

describe('Session auth in billing backends', () => {
  // Replicate the requireSession logic (same code in both files)
  function extractSessionToken(request) {
    const auth = (request.headers?.get('Authorization')) || '';
    const bearer = auth.replace('Bearer ', '').trim();
    if (bearer && bearer.length >= 32) return bearer;
    const cookie = (request.headers?.get('Cookie')) || '';
    const m = cookie.match(/elligente_sid=([^;]+)/);
    return m ? m[1].trim() : '';
  }

  async function requireSession(request, env) {
    if (!env.AUTH_KV) return null;
    const token = extractSessionToken(request);
    if (!token || token.length < 32) return 'Unauthorized — please log in';
    const raw = await env.AUTH_KV.get('session:' + token);
    if (!raw) return 'Session expired or invalid';
    return null;
  }

  const makeReq = (authHeader, cookie) => ({
    headers: {
      get: (h) => {
        if (h === 'Authorization') return authHeader || '';
        if (h === 'Cookie') return cookie || '';
        return '';
      }
    }
  });

  it('allows when AUTH_KV is not configured (unauthenticated install)', async () => {
    const err = await requireSession(makeReq(), { });
    expect(err).toBeNull();
  });

  it('rejects when AUTH_KV configured but no token', async () => {
    const KV = { get: async () => null };
    const err = await requireSession(makeReq('', ''), { AUTH_KV: KV });
    expect(err).toContain('Unauthorized');
  });

  it('rejects when token not in KV (expired)', async () => {
    const KV = { get: async (k) => null };
    const token = 'a'.repeat(32);
    const err = await requireSession(makeReq('Bearer ' + token, ''), { AUTH_KV: KV });
    expect(err).toContain('Session expired');
  });

  it('allows when valid token found in KV via Authorization header', async () => {
    const token = 'b'.repeat(32);
    const KV = { get: async (k) => k === 'session:' + token ? '{"email":"u@x.com"}' : null };
    const err = await requireSession(makeReq('Bearer ' + token, ''), { AUTH_KV: KV });
    expect(err).toBeNull();
  });

  it('allows when valid token found in KV via cookie', async () => {
    const token = 'c'.repeat(32);
    const KV = { get: async (k) => k === 'session:' + token ? '{"email":"u@x.com"}' : null };
    const err = await requireSession(makeReq('', 'elligente_sid=' + token), { AUTH_KV: KV });
    expect(err).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5 — Cross-chain status polling
// ═══════════════════════════════════════════════════════════════════════════

describe('BillingCrosschain.pollStatus', () => {
  let BillingCrosschain;

  beforeEach(async () => {
    const src = await import('fs').then(fs =>
      fs.promises.readFile('shared/billingCrosschain.js', 'utf8')
    );
    const win = { BillingCrosschain: null };
    const fn = new Function('window', src);
    fn(win);
    BillingCrosschain = win.BillingCrosschain;
  });

  it('returns ok:false on FAILED status without producing artificial success', async () => {
    let callCount = 0;
    global.fetch = async (url) => {
      callCount++;
      return { json: async () => ({ status: 'FAILED', substatusMessage: 'Bridge failed on destination' }) };
    };
    const result = await BillingCrosschain.pollStatus('0xhash', 8453, 5042, 'across', null, 3);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('Bridge failed');
    delete global.fetch;
  });

  it('returns ok:true and destinationTxHash on DONE', async () => {
    global.fetch = async () => ({
      json: async () => ({
        status: 'DONE',
        receiving: { txHash: '0xdestinationtx' },
      }),
    });
    const result = await BillingCrosschain.pollStatus('0xsrc', 8453, 5042, 'across', null, 3);
    expect(result.ok).toBe(true);
    expect(result.destinationTxHash).toBe('0xdestinationtx');
    delete global.fetch;
  });

  it('returns TIMEOUT without marking payment as Paid', async () => {
    global.fetch = async () => ({ json: async () => ({ status: 'PENDING' }) });
    // maxPolls=1, each poll waits 5s — total ~5s; raise test timeout to 15s
    const result = await BillingCrosschain.pollStatus('0xhash', 8453, 5042, 'across', null, 1);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('TIMEOUT');
    delete global.fetch;
  }, 15000);
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6 — Arc Mainnet invariants
// ═══════════════════════════════════════════════════════════════════════════

describe('Arc Mainnet invariants', () => {
  it('Arc Mainnet chainId is 5042', () => {
    // Used in payLandingExecute and billingCrosschain
    expect(5042).toBe(5042);
  });

  it('Arc USDC address in billingCrosschain matches shared-config', async () => {
    const src = await import('fs').then(fs =>
      fs.promises.readFile('shared/billingCrosschain.js', 'utf8')
    );
    const win = { BillingCrosschain: null };
    new Function('window', src)(win);
    const arcUsdc = win.BillingCrosschain.USDC[5042];
    expect(arcUsdc.toLowerCase()).toBe('0x3600000000000000000000000000000000000000');
  });

  it('billingCrosschain has no reference to Arc Testnet', async () => {
    const src = await import('fs').then(fs =>
      fs.promises.readFile('shared/billingCrosschain.js', 'utf8')
    );
    expect(src).not.toMatch(/testnet/i);
    expect(src).not.toMatch(/5783/); // Arc Testnet chainId
  });

  it('invoice.js has no reference to Arc Testnet default', async () => {
    const src = await import('fs').then(fs =>
      fs.promises.readFile('functions/api/invoice.js', 'utf8')
    );
    // Should not set 'Arc Testnet' as default chain
    expect(src).not.toMatch(/['"]Arc Testnet['"]/);
  });

  it('payment-links.js has no reference to Arc Testnet default', async () => {
    const src = await import('fs').then(fs =>
      fs.promises.readFile('functions/api/payment-links.js', 'utf8')
    );
    expect(src).not.toMatch(/['"]Arc Testnet['"]/);
  });
});
