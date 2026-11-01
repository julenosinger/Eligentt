/**
 * Unit tests for Tax scan logic.
 *
 * Because the Pages Function uses top-level `fetch` (a CF global), we test
 * the pure logic units directly — status classification, chain map, address
 * validation, and a lightweight integration via an extracted helper that
 * accepts fetch as a parameter (testable without re-importing the module).
 */

import { describe, it, expect, vi } from 'vitest';

/* ── Duplicate the pure helpers here so no real HTTP is needed ───────────── */

const ETHERSCAN_CHAIN = { ethereum: 1, base: 8453, arbitrum: 42161, optimism: 10, polygon: 137 };

function scanLabel(r) {
  if (!r) return '…';
  switch (r.status) {
    case 'done':           return r.ops > 0 ? r.ops + ' ops' : '0 ops';
    case 'not_configured': return 'Not configured';
    case 'coming_soon':    return 'Coming soon';
    case 'not_supported':  return 'N/A';
    case 'rate_limited':   return 'Rate limited';
    case 'failed':         return 'Failed';
    default:               return r.error ? 'Error' : r.ops + ' ops';
  }
}

function isEvmAddress(a)    { return /^0x[0-9a-fA-F]{40}$/.test(a); }
function isSolanaAddress(a) { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) && !isEvmAddress(a); }

/* Inline countEtherscanOps using injected fetch (no side-effects) */
async function countEtherscanOps(chainId, address, apiKey, fetchFn, retries = 2) {
  const actions = ['txlist', 'tokentx', 'txlistinternal'];
  let total = 0;
  for (const action of actions) {
    let attempt = 0;
    while (attempt <= retries) {
      // arc-studio-allow-onchain-literal
      const url = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=account&action=${action}&address=${encodeURIComponent(address)}&startblock=0&endblock=99999999&page=1&offset=100&sort=asc&apikey=${apiKey}`;
      try {
        const resp = await fetchFn(url, { signal: AbortSignal.timeout(10000) });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        if (data.message && /rate limit/i.test(data.message)) {
          const err = new Error('RATE_LIMIT');
          err.rateLimit = true;
          throw err;
        }
        if (data.status === '0' && data.message === 'No transactions found') { total += 0; break; }
        if (data.status !== '1' && !Array.isArray(data.result)) throw new Error(data.message || 'Etherscan error');
        total += Array.isArray(data.result) ? data.result.length : 0;
        break;
      } catch (e) {
        if (e.rateLimit && attempt < retries) {
          await new Promise(r => setTimeout(r, 10)); // tiny wait in tests
          attempt++; continue;
        }
        throw e;
      }
    }
  }
  return total;
}

async function scanEvmWithFetch(network, address, apiKey, fetchFn) {
  if (!apiKey) return { network, ops: 0, status: 'not_configured', error: 'ETHERSCAN_API_KEY not set' };
  const chainId = ETHERSCAN_CHAIN[network];
  try {
    const ops = await countEtherscanOps(chainId, address, apiKey, fetchFn);
    return { network, ops, status: 'done' };
  } catch (e) {
    if (e.rateLimit) return { network, ops: 0, status: 'rate_limited', error: 'Rate limit — retry in a moment' };
    return { network, ops: 0, status: 'failed', error: e.message.slice(0, 120) };
  }
}

/* ─────────────────────────────────────────────────────────────────────────── */

describe('scanLabel helper', () => {
  it('done with ops > 0', ()        => expect(scanLabel({ status:'done', ops:42 })).toBe('42 ops'));
  it('done with ops = 0', ()        => expect(scanLabel({ status:'done', ops:0  })).toBe('0 ops'));
  it('not_configured', ()           => expect(scanLabel({ status:'not_configured', ops:0 })).toBe('Not configured'));
  it('coming_soon', ()              => expect(scanLabel({ status:'coming_soon',    ops:0 })).toBe('Coming soon'));
  it('not_supported', ()            => expect(scanLabel({ status:'not_supported',  ops:0 })).toBe('N/A'));
  it('rate_limited', ()             => expect(scanLabel({ status:'rate_limited',   ops:0 })).toBe('Rate limited'));
  it('failed', ()                   => expect(scanLabel({ status:'failed',         ops:0, error:'timeout' })).toBe('Failed'));
  it('null input → ellipsis', ()    => expect(scanLabel(null)).toBe('…'));
});

describe('Etherscan chain map', () => {
  it('covers all 5 EVM networks', () => {
    expect(Object.keys(ETHERSCAN_CHAIN)).toEqual(['ethereum','base','arbitrum','optimism','polygon']);
  });
  it('Ethereum → 1',   () => expect(ETHERSCAN_CHAIN.ethereum).toBe(1));
  it('Base → 8453',    () => expect(ETHERSCAN_CHAIN.base).toBe(8453));
  it('Arbitrum → 42161', () => expect(ETHERSCAN_CHAIN.arbitrum).toBe(42161));
  it('Optimism → 10',  () => expect(ETHERSCAN_CHAIN.optimism).toBe(10));
  it('Polygon → 137',  () => expect(ETHERSCAN_CHAIN.polygon).toBe(137));
});

describe('address type detection', () => {
  it('0x address is EVM',     () => expect(isEvmAddress('0x1234567890123456789012345678901234567890')).toBe(true));
  it('base58 is Solana',      () => expect(isSolanaAddress('GsbwXfJraMomNxBcjYLiMZFMKWmFahATaJjLAaFBBMB1')).toBe(true));
  it('EVM is not Solana',     () => expect(isSolanaAddress('0x1234567890123456789012345678901234567890')).toBe(false));
  it('empty string is neither', () => {
    expect(isEvmAddress('')).toBe(false);
    expect(isSolanaAddress('')).toBe(false);
  });
});

describe('missing ETHERSCAN_API_KEY', () => {
  it('returns not_configured when no key', async () => {
    const r = await scanEvmWithFetch('ethereum', '0x1234567890123456789012345678901234567890', '', vi.fn());
    expect(r.status).toBe('not_configured');
    expect(r.ops).toBe(0);
  });
  it('returns not_configured for all 5 EVM nets', async () => {
    for (const net of Object.keys(ETHERSCAN_CHAIN)) {
      const r = await scanEvmWithFetch(net, '0x1234567890123456789012345678901234567890', '', vi.fn());
      expect(r.status).toBe('not_configured');
    }
  });
});

describe('rate-limit handling', () => {
  it('returns rate_limited after all retries on rate-limit response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: '0', message: 'Max rate limit reached', result: 'Max rate limit reached' }),
    });
    const r = await scanEvmWithFetch('ethereum', '0x1234567890123456789012345678901234567890', 'testkey', mockFetch);
    expect(r.status).toBe('rate_limited');
    expect(r.ops).toBe(0);
  });

  it('retries on rate limit before giving up', async () => {
    let callN = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callN++;
      // First call: rate limit; second call: success
      if (callN <= 1) return { ok: true, json: async () => ({ status: '0', message: 'Max rate limit reached' }) };
      return { ok: true, json: async () => ({ status: '1', message: 'OK', result: [{}] }) };
    });
    const r = await scanEvmWithFetch('ethereum', '0x1234567890123456789012345678901234567890', 'testkey', mockFetch);
    expect(r.status).toBe('done');
    expect(r.ops).toBeGreaterThan(0);
    expect(callN).toBeGreaterThan(1); // retried at least once
  });
});

describe('successful Etherscan response', () => {
  it('counts txlist + tokentx + txlistinternal', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url) => {
      const action = new URL(url).searchParams.get('action');
      const result =
        action === 'txlist'          ? [{},{},{}] :
        action === 'tokentx'         ? [{},{}]    :
        action === 'txlistinternal'  ? [{}]        : [];
      return { ok: true, json: async () => ({ status: '1', message: 'OK', result }) };
    });
    const r = await scanEvmWithFetch('base', '0x1234567890123456789012345678901234567890', 'testkey', mockFetch);
    expect(r.status).toBe('done');
    expect(r.ops).toBe(6);
  });

  it('"No transactions found" → 0 ops, status done', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: '0', message: 'No transactions found', result: [] }),
    });
    const r = await scanEvmWithFetch('polygon', '0x1234567890123456789012345678901234567890', 'testkey', mockFetch);
    expect(r.status).toBe('done');
    expect(r.ops).toBe(0);
  });

  it('uses correct chainid in URL for each network', async () => {
    const seen = {};
    const mockFetch = vi.fn().mockImplementation(async (url) => {
      const u    = new URL(url);
      const cid  = parseInt(u.searchParams.get('chainid'));
      const net  = u.searchParams.get('action'); // we read chainid
      seen[cid] = true;
      return { ok: true, json: async () => ({ status: '1', message: 'OK', result: [] }) };
    });
    for (const [net, chainId] of Object.entries(ETHERSCAN_CHAIN)) {
      await scanEvmWithFetch(net, '0x1234567890123456789012345678901234567890', 'testkey', mockFetch);
      expect(seen[chainId]).toBe(true);
      seen[chainId] = false; // reset for next
    }
  });
});

describe('one network failing does not affect others', () => {
  it('polygon rate-limited, ethereum still succeeds', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url) => {
      const chainId = parseInt(new URL(url).searchParams.get('chainid'));
      if (chainId === 137) // polygon
        return { ok: true, json: async () => ({ status: '0', message: 'Max rate limit reached' }) };
      return { ok: true, json: async () => ({ status: '1', message: 'OK', result: [{}] }) };
    });
    const rEth  = await scanEvmWithFetch('ethereum', '0x1234567890123456789012345678901234567890', 'key', mockFetch);
    const rPoly = await scanEvmWithFetch('polygon',  '0x1234567890123456789012345678901234567890', 'key', mockFetch);
    expect(rEth.status).toBe('done');
    expect(rEth.ops).toBeGreaterThan(0);
    expect(rPoly.status).toBe('rate_limited');
    expect(rPoly.ops).toBe(0);
  });
});

describe('no API key in response body', () => {
  it('error messages never contain the secret key value', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('network error'));
    const r = await scanEvmWithFetch('ethereum', '0x1234567890123456789012345678901234567890', 'SUPER_SECRET_KEY_XYZ', mockFetch);
    expect(JSON.stringify(r)).not.toContain('SUPER_SECRET_KEY_XYZ');
  });
});

describe('scan.js module — static invariants (no HTTP required)', () => {
  it('scan.js exists at the expected path', async () => {
    const src = await import('fs').then(fs => fs.promises.readFile('/home/user/app/functions/api/tax/scan.js','utf8'));
    expect(src).toContain('ETHERSCAN_API_KEY');
    expect(src).toContain('not_configured');
    expect(src).toContain('coming_soon');
    expect(src).toContain('not_supported');
    expect(src).toContain('rate_limited');
    // Key must never be in any response literal
    expect(src).not.toMatch(/['"`]SUPER_SECRET/);
    // Throttle must be present
    expect(src).toContain('throttleEtherscan');
    // Etherscan V2 endpoint used
    expect(src).toContain('api.etherscan.io/v2/api');
  });

  it('scan.js never uses eth_getTransactionCount for EVM networks (only nonce, not full history)', async () => {
    const src = await import('fs').then(fs => fs.promises.readFile('/home/user/app/functions/api/tax/scan.js','utf8'));
    // The EVM scan path uses Etherscan V2, not eth_getTransactionCount (nonce-only)
    // The entire file must not CALL eth_getTransactionCount in any fetch body
    // (the comment in scanArc that says it's NOT used is acceptable)
    const fetchBodies = src.match(/body:\s*JSON\.stringify\([^)]+\)/g) || [];
    const usesNonce = fetchBodies.some(b => b.includes('eth_getTransactionCount'));
    expect(usesNonce).toBe(false);
  });
});
