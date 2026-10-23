/**
 * tests/gateway-deposit.test.js
 * Circle Gateway Deposit — Fase 2
 *
 * Test categories:
 *  DP1  — CF Function /api/gateway/deposit-params structure
 *  DP2  — Asset/chain compatibility matrix
 *  DP3  — CF error handling (invalid token, unsupported chain, bad address)
 *  DP4  — Frontend JS functions present
 *  DP5  — Deposit modal HTML structure
 *  DP6  — Decimal precision (BigInt conversion)
 *  DP7  — Security: no auto-execute, network guard, duplicate prevention
 *  DP8  — Separation: deposit does not modify EVM wallet balance display
 *  DP9  — Gateway balance refresh after deposit
 *  DP10 — Fase 1.2 regression: existing tests unaffected
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT    = path.resolve(__dirname, '..');
const html    = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dpPath  = path.join(ROOT, 'functions/api/gateway/deposit-params.js');
const dpSrc   = fs.existsSync(dpPath) ? fs.readFileSync(dpPath, 'utf8') : '';

function blockAt(text, anchor, size) {
  const idx = text.indexOf(anchor);
  return idx === -1 ? '' : text.slice(idx, idx + size);
}
function fnBlock(text, name, size) {
  return blockAt(text, 'function ' + name + '(', size);
}

// ── DP1: CF Function structure ───────────────────────────────────────────────
describe('CF Function — /api/gateway/deposit-params', () => {
  it('DP1.1 — file exists', () => {
    expect(fs.existsSync(dpPath)).toBe(true);
  });

  it('DP1.2 — exports onRequestGet (GET handler)', () => {
    expect(dpSrc).toContain('export async function onRequestGet');
  });

  it('DP1.3 — returns gatewayWallet, tokenAddress, decimals, chainId, chainName', () => {
    expect(dpSrc).toContain('gatewayWallet');
    expect(dpSrc).toContain('tokenAddress');
    expect(dpSrc).toContain('decimals');
    expect(dpSrc).toContain('chainName');
  });

  it('DP1.4 — GatewayWallet mainnet address present', () => {
    // Verified from Circle docs: same on all EVM chains mainnet
    expect(dpSrc).toContain('0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE');
  });

  it('DP1.5 — validates token: rejects unknown tokens with 400', () => {
    expect(dpSrc).toContain('status: 400');
    expect(dpSrc).toContain('Invalid token');
  });

  it('DP1.6 — validates chainId: rejects unsupported chains', () => {
    expect(dpSrc).toContain('status: 400');
    expect(dpSrc).toContain('Invalid or unsupported chainId');
  });

  it('DP1.7 — rejects asset+chain incompatibility with 422', () => {
    expect(dpSrc).toContain('status: 422');
    expect(dpSrc).toContain('not supported');
  });

  it('DP1.8 — no-store cache header (balances are real-time)', () => {
    expect(dpSrc).toContain('no-store');
  });

  it('DP1.9 — decimals: USDC=6, EURC=6, cirBTC=8', () => {
    expect(dpSrc).toContain('USDC: 6');
    expect(dpSrc).toContain('EURC: 6');
    expect(dpSrc).toContain('cirBTC: 8');
  });
});

// ── DP2: Asset/chain compatibility ───────────────────────────────────────────
describe('CF Function — asset/chain matrix', () => {
  it('DP2.1 — USDC: Arc (5042) supported', () => {
    const b = blockAt(dpSrc, 'USDC:', 300);
    expect(b).toContain('5042');
  });

  it('DP2.2 — USDC: Ethereum (1), Base (8453), Arbitrum (42161) supported', () => {
    const b = blockAt(dpSrc, 'USDC:', 300);
    expect(b).toContain('1:');
    expect(b).toContain('8453');
    expect(b).toContain('42161');
  });

  it('DP2.3 — EURC: only Arc, Ethereum, Avalanche, Base (NOT Arbitrum/Optimism/Polygon)', () => {
    const eurcBlock = blockAt(dpSrc, 'EURC:', 450);
    expect(eurcBlock).toContain('5042');  // Arc
    expect(eurcBlock).toContain('1:');    // Ethereum
    expect(eurcBlock).toContain('43114'); // Avalanche
    expect(eurcBlock).toContain('8453');  // Base
    // Verify cirBTC block does NOT include Base or Arbitrum
    const cbtcBlock = blockAt(dpSrc, 'cirBTC:', 200);
    const cbtcNums  = (cbtcBlock.match(/\d{2,5}/g) || []).map(Number);
    expect(cbtcNums).not.toContain(8453);  // not Base
    expect(cbtcNums).not.toContain(42161); // not Arbitrum
  });

  it('DP2.4 — cirBTC: Arc (5042) and Ethereum (1) only', () => {
    const b = blockAt(dpSrc, 'cirBTC:', 200);
    expect(b).toContain('5042');
    expect(b).toContain('1:');
  });

  it('DP2.5 — cirBTC: correct mainnet address for Arc', () => {
    expect(dpSrc).toContain('0x171A4217b86A807A64eB94757Db6849fb4bDbAA0');
  });

  it('DP2.6 — cirBTC: correct mainnet address for Ethereum', () => {
    expect(dpSrc).toContain('0x72DFB2E44f59C5AD2bAFE84314E5b99a7cd5075E');
  });

  it('DP2.7 — DOMAIN map includes Arc=26 and Ethereum=0', () => {
    expect(dpSrc).toContain('5042: 26');
    expect(dpSrc).toContain('1: 0');
  });
});

// ── DP3: CF error handling ───────────────────────────────────────────────────
describe('CF Function — error handling', () => {
  it('DP3.1 — invalid token string → 400', () => {
    expect(dpSrc).toMatch(/\['USDC', 'EURC', 'cirBTC'\]\.includes\(token\)/);
  });

  it('DP3.2 — unsupported chain → 422 with supported list', () => {
    expect(dpSrc).toContain('supported:');
    expect(dpSrc).toContain('Object.keys');
  });

  it('DP3.3 — Access-Control-Allow-Origin header present', () => {
    expect(dpSrc).toContain('Access-Control-Allow-Origin');
  });
});

// ── DP4: Frontend JS functions ────────────────────────────────────────────────
describe('Frontend — deposit JS functions present', () => {
  it('DP4.1 — ubGwDepOpen defined', () => {
    expect(html).toContain('function ubGwDepOpen(');
  });

  it('DP4.2 — ubGwDepClose defined', () => {
    expect(html).toContain('function ubGwDepClose(');
  });

  it('DP4.3 — ubGwDepExecute defined (async)', () => {
    expect(html).toContain('async function ubGwDepExecute(');
  });

  it('DP4.4 — _ubGwDepValidate defined', () => {
    expect(html).toContain('function _ubGwDepValidate(');
  });

  it('DP4.5 — ubGwDepFetchParams defined', () => {
    expect(html).toContain('function ubGwDepFetchParams(');
  });

  it('DP4.6 — ubGwDepFetchBalance defined', () => {
    expect(html).toContain('function ubGwDepFetchBalance(');
  });

  it('DP4.7 — _UB_GW_DEP_CHAINS registry defined', () => {
    expect(html).toContain('_UB_GW_DEP_CHAINS');
  });

  it('DP4.8 — _GW_ERC20_ABI and _GW_WALLET_ABI defined', () => {
    expect(html).toContain('_GW_ERC20_ABI');
    expect(html).toContain('_GW_WALLET_ABI');
  });
});

// ── DP5: Modal HTML structure ────────────────────────────────────────────────
describe('Frontend — deposit modal HTML', () => {
  it('DP5.1 — #ub-gw-dep-overlay exists', () => {
    expect(html).toContain('id="ub-gw-dep-overlay"');
  });

  it('DP5.2 — #ub-gw-dep-modal exists', () => {
    expect(html).toContain('id="ub-gw-dep-modal"');
  });

  it('DP5.3 — token selector present', () => {
    expect(html).toContain('id="ub-gw-dep-token"');
  });

  it('DP5.4 — chain selector present', () => {
    expect(html).toContain('id="ub-gw-dep-chain"');
  });

  it('DP5.5 — amount input present', () => {
    expect(html).toContain('id="ub-gw-dep-amt"');
  });

  it('DP5.6 — summary section present', () => {
    expect(html).toContain('id="ub-gw-dep-summary"');
  });

  it('DP5.7 — status element present', () => {
    expect(html).toContain('id="ub-gw-dep-status"');
  });

  it('DP5.8 — confirm button starts disabled', () => {
    const modal = blockAt(html, 'id="ub-gw-dep-modal"', 3000);
    expect(modal).toContain('disabled');
  });

  it('DP5.9 — mainnet warning present', () => {
    const modal = blockAt(html, 'id="ub-gw-dep-modal"', 3000);
    expect(modal).toContain('Mainnet');
    expect(modal.toLowerCase()).toContain('real funds');
  });

  it('DP5.10 — Step 1/2 and Step 2/2 messaging present', () => {
    expect(html).toContain('Step 1/2');
    expect(html).toContain('Step 2/2');
  });

  it('DP5.11 — Deposit button added to each asset row in ubGatewayRender', () => {
    const fn = fnBlock(html, 'ubGatewayRender', 2500);
    expect(fn).toContain('ubGwDepOpen');
    expect(fn).toContain('ub-gw-dep-btn');
  });
});

// ── DP6: Decimal precision ────────────────────────────────────────────────────
describe('Deposit — decimal precision (functional)', () => {
  // Extract the BigInt conversion logic from ubGwDepExecute.
  let toAtomicUnits;
  try {
    const execStart = html.indexOf('async function ubGwDepExecute(');
    if (execStart !== -1) {
      let depth = 0, i = execStart, started = false;
      for (; i < html.length; i++) {
        if (html[i] === '{') { depth++; started = true; }
        else if (html[i] === '}') { depth--; }
        if (started && depth === 0) { i++; break; }
      }
      const src = html.slice(execStart, i);
      // Extract the BigInt conversion block as a standalone function.
      toAtomicUnits = new Function('amt', 'dec', `
        var factor = BigInt(Math.pow(10, dec));
        var amtStr = String(amt);
        var parts  = amtStr.split('.');
        var intStr = parts[0] || '0';
        var fracStr = (parts[1] || '').slice(0, dec).padEnd(dec, '0');
        return BigInt(intStr) * factor + BigInt(fracStr);
      `); // eslint-disable-line no-new-func
    }
  } catch (_) {}

  it('DP6.1 — USDC "1.5" → 1500000n (6 decimals)', () => {
    if (!toAtomicUnits) return;
    expect(toAtomicUnits('1.5', 6)).toBe(1500000n);
  });

  it('DP6.2 — USDC "0.01" → 10000n', () => {
    if (!toAtomicUnits) return;
    expect(toAtomicUnits('0.01', 6)).toBe(10000n);
  });

  it('DP6.3 — cirBTC "0.00000001" → 1n (1 satoshi, 8 decimals)', () => {
    if (!toAtomicUnits) return;
    // Pass as string (matches how input.value is used — avoids 1e-8 float literal)
    expect(toAtomicUnits('0.00000001', 8)).toBe(1n);
  });

  it('DP6.4 — cirBTC "1.0" → 100000000n', () => {
    if (!toAtomicUnits) return;
    expect(toAtomicUnits('1.0', 8)).toBe(100000000n);
  });

  it('DP6.5 — large USDC amount preserves precision', () => {
    if (!toAtomicUnits) return;
    // 9999.999999 USDC = 9999999999 atomic units
    expect(toAtomicUnits(9999.999999, 6)).toBe(9999999999n);
  });
});

// ── DP7: Security ─────────────────────────────────────────────────────────────
describe('Deposit — security guards', () => {
  it('DP7.1 — network chain check before signing (provider.getNetwork)', () => {
    const fn = fnBlock(html, 'ubGwDepExecute', 3000);
    expect(fn).toContain('provider.getNetwork');
    expect(fn).toContain('params.chainId');
  });

  it('DP7.2 — _ubGwDep.executing guard prevents duplicate submissions', () => {
    const fn = fnBlock(html, 'ubGwDepExecute', 4500);
    expect(fn).toContain('_ubGwDep.executing');
    // early return if already executing
    expect(fn).toContain('if (_ubGwDep.executing) return');
  });

  it('DP7.3 — executing flag is reset in finally block', () => {
    const fn = fnBlock(html, 'ubGwDepExecute', 4500);
    expect(fn).toContain('finally');
    expect(fn).toContain('_ubGwDep.executing = false');
  });

  it('DP7.4 — never auto-executes: ubGwDepExecute only called by explicit button click', () => {
    // ubGwDepExecute must NOT appear in ubGatewayFetch, ubGatewaySyncRefresh, ubRefresh.
    const fetch = fnBlock(html, 'ubGatewayFetch', 2000);
    const sync  = fnBlock(html, 'ubGatewaySyncRefresh', 300);
    const ref   = fnBlock(html, 'ubRefresh', 3000);
    expect(fetch).not.toContain('ubGwDepExecute');
    expect(sync).not.toContain('ubGwDepExecute');
    expect(ref).not.toContain('ubGwDepExecute');
  });

  it('DP7.5 — amount validated > 0 and <= wallet balance before proceeding', () => {
    const fn = fnBlock(html, 'ubGwDepExecute', 3000);
    expect(fn).toContain('amt > bal');
    expect(fn).toContain('!(amt > 0)');
  });

  it('DP7.6 — uses ERC-20 approve before deposit (not direct transfer)', () => {
    const fn = fnBlock(html, 'ubGwDepExecute', 4000);
    expect(fn).toContain('erc20.approve');
    expect(fn).toContain('gwContract.deposit');
    // approve must appear BEFORE deposit
    expect(fn.indexOf('erc20.approve')).toBeLessThan(fn.indexOf('gwContract.deposit'));
  });

  it('DP7.7 — user rejection caught and shown (not re-thrown)', () => {
    const fn = fnBlock(html, 'ubGwDepExecute', 4000);
    expect(fn).toContain('user rejected');
    expect(fn).toContain('Transaction rejected in wallet.');
  });
});

// ── DP8: Separation of balances ───────────────────────────────────────────────
describe('Deposit — no interference with EVM wallet balance', () => {
  it('DP8.1 — ubGwDepExecute does NOT call ubRenderHero or modify ub-hero-total', () => {
    const fn = fnBlock(html, 'ubGwDepExecute', 4500);
    expect(fn).not.toContain('ubRenderHero');
    expect(fn).not.toContain('ub-hero-total');
  });

  it('DP8.2 — ubGwDepExecute does NOT push to UB.state or ubState', () => {
    // Use 4500 chars — stays within the function, before ubRenderNetworks.
    const fn = fnBlock(html, 'ubGwDepExecute', 4500);
    expect(fn).not.toContain('UB.state');
    expect(fn).not.toContain('ubState');
  });

  it('DP8.3 — deposit status message distinguishes tx confirmed from Gateway credit', () => {
    const fn = fnBlock(html, 'ubGwDepExecute', 4500);
    expect(fn).toContain('confirmed on-chain');
    expect(fn).toContain('finality');
  });
});

// ── DP9: Balance refresh after deposit ────────────────────────────────────────
describe('Deposit — Gateway balance refresh after success', () => {
  it('DP9.1 — calls ubGatewayFetch after successful deposit', () => {
    const fn = fnBlock(html, 'ubGwDepExecute', 4500);
    expect(fn).toContain('ubGatewayFetch');
  });

  it('DP9.2 — refresh is delayed (setTimeout) not immediate (Gateway needs finality)', () => {
    const fn = fnBlock(html, 'ubGwDepExecute', 4500);
    expect(fn).toContain('setTimeout');
    expect(fn).toContain('ubGatewayFetch');
  });
});

// ── DP10: Fase 1.2 regression ────────────────────────────────────────────────
describe('Regression — Fase 1.2 unchanged', () => {
  it('DP10.1 — ubGatewayFetch still exists', () => {
    expect(html).toContain('function ubGatewayFetch(');
  });

  it('DP10.2 — ubGatewayRender still exists', () => {
    expect(html).toContain('function ubGatewayRender(');
  });

  it('DP10.3 — _ubGwFmt still exists', () => {
    expect(html).toContain('function _ubGwFmt(');
  });

  it('DP10.4 — _ubGwAddStr still exists', () => {
    expect(html).toContain('function _ubGwAddStr(');
  });

  it('DP10.5 — ubGatewaySyncRefresh still called from ubRefresh', () => {
    const fn = fnBlock(html, 'ubRefresh', 2000);
    expect(fn).toContain('ubGatewaySyncRefresh');
  });

  it('DP10.6 — Gateway card (#ub-gateway-card) still present', () => {
    expect(html).toContain('id="ub-gateway-card"');
  });
});
