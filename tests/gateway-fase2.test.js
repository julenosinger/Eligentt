/**
 * gateway-fase2.test.js
 * ═══════════════════════════════════════════════════════════════════════════
 * Fase 2 — Circle Gateway integration in Send, Swap and Bridge.
 *
 * Tests verify:
 *  GF2-1  HTML structure — origin toggle and swap source selector present
 *  GF2-2  JS functions present and correctly wired
 *  GF2-3  GATEWAY_SPEND_BLOCKED guards send, swap and bridge execution
 *  GF2-4  Bridge route injection for Gateway provider
 *  GF2-5  No double-counting, no balance merge, no silent fallback
 *  GF2-6  No regressions in saDispatchSend, swpExecuteLiFi, executeBridgeOrTurbo
 *
 * All tests are structural / source-analysis — no real transactions are made.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src  = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// ── GF2-1: HTML structure ───────────────────────────────────────────────────
describe('GF2-1 — HTML: origin toggle and swap source selector', () => {
  it('Send: #sa-origin-bar present', () => {
    expect(src).toContain('id="sa-origin-bar"');
  });
  it('Send: #sa-origin-evm button present', () => {
    expect(src).toContain('id="sa-origin-evm"');
  });
  it('Send: #sa-origin-gw button present', () => {
    expect(src).toContain('id="sa-origin-gw"');
  });
  it('Send: #sa-gw-notice (informational) present', () => {
    expect(src).toContain('id="sa-gw-notice"');
  });
  it('Send: #sa-gw-bal-pill for GW balance display', () => {
    expect(src).toContain('id="sa-gw-bal-pill"');
  });
  it('Swap: #swp-gw-source-row present', () => {
    expect(src).toContain('id="swp-gw-source-row"');
  });
  it('Swap: #swp-src-evm button present', () => {
    expect(src).toContain('id="swp-src-evm"');
  });
  it('Swap: #swp-src-gw button present', () => {
    expect(src).toContain('id="swp-src-gw"');
  });
  it('Swap: #swp-gw-bal-label for GW balance display', () => {
    expect(src).toContain('id="swp-gw-bal-label"');
  });
  it('Bridge: Gateway route provider injected in _fetchBridgeRoutes', () => {
    expect(src).toContain("provider:   'gateway'");
  });
  it('Bridge: "Validation Pending" badge string for Gateway', () => {
    expect(src).toContain('Validation Pending');
  });
});

// ── GF2-2: JS functions ─────────────────────────────────────────────────────
describe('GF2-2 — JS: functions present and wired', () => {
  it('saSetOrigin function defined', () => {
    expect(src).toContain('function saSetOrigin(mode)');
  });
  it('saLoadGatewayBalance function defined', () => {
    expect(src).toContain('function saLoadGatewayBalance()');
  });
  it('saExecGateway function defined', () => {
    expect(src).toContain('async function saExecGateway()');
  });
  it('saDispatchSend patched to call saExecGateway when _saGwOrigin=true', () => {
    const idx = src.indexOf('_saGwOrigin && !_saCPNMode');
    expect(idx).toBeGreaterThan(-1);
    const snippet = src.slice(idx, idx + 80);
    expect(snippet).toContain('saExecGateway');
  });
  it('swpSetSource function defined', () => {
    expect(src).toContain('function swpSetSource(mode)');
  });
  it('swpLoadGatewayBalance function defined', () => {
    expect(src).toContain('function swpLoadGatewayBalance()');
  });
  it('swpExecuteLiFi patched to intercept when _swpGwSource=true', () => {
    expect(src).toContain('_swpExecuteLiFiOrig');
    const idx = src.indexOf('_swpGwSource');
    expect(idx).toBeGreaterThan(-1);
  });
  it('executeBridgeOrTurbo handles gateway provider', () => {
    // Use executeBridgeOrTurbo body to find the gateway branch
    const fnIdx  = src.indexOf('function executeBridgeOrTurbo()');
    expect(fnIdx).toBeGreaterThan(-1);
    const fnBody = src.slice(fnIdx, fnIdx + 5000);
    expect(fnBody).toContain("route.provider === 'gateway'");
  });
  it('_fetchBridgeRoutes adds gateway route when GatewaySpendService.isSupported', () => {
    const routeBlock = src.indexOf("Provider 3: Circle Gateway");
    expect(routeBlock).toBeGreaterThan(-1);
  });
});

// ── GF2-3: GATEWAY_SPEND_BLOCKED guards ─────────────────────────────────────
describe('GF2-3 — GATEWAY_SPEND_BLOCKED blocks execution in all three modules', () => {
  it('GATEWAY_SPEND_BLOCKED is declared (Fase 2.9.2: now false — security approved)', () => {
    expect(src).toContain('var GATEWAY_SPEND_BLOCKED = false');
  });
  it('saExecGateway uses inline EIP-712 sign + POST to /api/gateway/transfer (Fase 2.9.3)', () => {
    const fnIdx = src.indexOf('async function saExecGateway()');
    expect(fnIdx).toBeGreaterThan(-1);
    const fnBody = src.slice(fnIdx, fnIdx + 8000);
    // Fase 2.9.3: GatewaySpendService is server-side CF only; browser uses inline impl.
    expect(fnBody).toContain('eth_signTypedData_v4');
    expect(fnBody).toContain('BurnIntent');
    expect(fnBody).toContain('toast(');
  });
  it('swpExecuteLiFi patch blocks Gateway source with informational message (no GATEWAY_SPEND_BLOCKED check)', () => {
    const patchIdx = src.indexOf('_swpExecuteLiFiOrig = swpExecuteLiFi');
    expect(patchIdx).toBeGreaterThan(-1);
    const patchBody = src.slice(patchIdx, patchIdx + 500);
    // Swap still blocked for Gateway (P2P not DEX) — but with an honest message, not a flag check.
    expect(patchBody).toContain('toast(');
    expect(patchBody).toContain('return;');
  });
  it('executeBridgeOrTurbo Gateway branch shows informational message (no GATEWAY_SPEND_BLOCKED check)', () => {
    const fnIdx  = src.indexOf('function executeBridgeOrTurbo()');
    expect(fnIdx).toBeGreaterThan(-1);
    const fnBody = src.slice(fnIdx, fnIdx + 5000);
    const gwIdx  = fnBody.indexOf("if (route.provider === 'gateway')");
    expect(gwIdx).toBeGreaterThan(-1);
    const gwBody = fnBody.slice(gwIdx, gwIdx + 400);
    // Bridge still blocked for Gateway (P2P not bridge router) — honest info message.
    expect(gwBody).toContain('toast(');
    expect(gwBody).toContain('return;');
  });
  it('GATEWAY_SPEND_BLOCKED comment references CF infra checklist (Fase 2.9.2)', () => {
    // Flag is now false; comment documents what CF infra must be configured.
    expect(src).toContain('GATEWAY_OPS_KV');
    expect(src).toContain('DO_INTERNAL_SECRET');
  });
});

// ── GF2-4: Bridge route injection ───────────────────────────────────────────
describe('GF2-4 — Bridge: Gateway route shape and rendering', () => {
  it('Gateway route has _gwBlocked field', () => {
    expect(src).toContain('_gwBlocked:');
  });
  it('Gateway route has steps: 2 (sign + mint)', () => {
    expect(src).toContain('steps:      2,     // sign burn intent + on-chain mint');
  });
  it('Gateway route has _maxFeeNote with explicit ceil value', () => {
    expect(src).toContain('≤2.01 USDC');
    expect(src).toContain('MAX_FEE');
  });
  it('Gateway route restricted to USDC/EURC only (cirBTC excluded)', () => {
    // gwSupportedTokens defined immediately before the route object
    expect(src).toContain("var gwSupportedTokens = ['USDC', 'EURC']");
    // The comment after the declaration explicitly mentions cirBTC exclusion
    expect(src).toContain('cirBTC GW support not yet verified');
  });
  it('Gateway route rendered with badge for blocked state', () => {
    expect(src).toContain("route.provider === 'gateway' && route._gwBlocked");
  });
  it('Gateway route execSec = 30 (fastest competitor to CCTP ~120s)', () => {
    expect(src).toContain('execSec:    30,    // typically <30s for Gateway mint');
  });
  it('brSelectRoute still works: gateway route can be selected', () => {
    // brSelectRoute uses _bridgeRoutes[idx] — gateway provider does not bypass it
    const brSelectIdx = src.indexOf('function brSelectRoute(idx)');
    expect(brSelectIdx).toBeGreaterThan(-1);
    // Gateway is selectable (available: true) but blocked on execute
    const gwRouteIdx = src.indexOf("provider:   'gateway'");
    const gwBlock = src.slice(gwRouteIdx, gwRouteIdx + 350);
    expect(gwBlock).toContain('available:  true');
  });
});

// ── GF2-5: No double-counting, no balance merge ──────────────────────────────
describe('GF2-5 — No double-counting or balance merge', () => {
  // Fase 2.7: saLoadGatewayBalance now reads from the shared _ubGwCache via
  // ubGetGatewayBalance() — it no longer calls /api/gateway/balances directly.
  // The shared cache is the single fetch path; no independent fetch is allowed.
  it('saLoadGatewayBalance reads from shared cache (ubGetGatewayBalance), not EVM state', () => {
    const fnIdx = src.indexOf('function saLoadGatewayBalance()');
    const fnBody = src.slice(fnIdx, fnIdx + 1000);
    expect(fnBody).toContain('ubGetGatewayBalance');  // reads shared cache
    expect(fnBody).not.toContain("fetch('/api/gateway/balances");  // no direct fetch
    expect(fnBody).not.toContain('_saLastBalance');
    expect(fnBody).not.toContain('UB.state');
  });
  // Fase 2.7: swpLoadGatewayBalance also reads from shared cache.
  it('swpLoadGatewayBalance reads from shared cache (ubGetGatewayBalance), not swap balance state', () => {
    const fnIdx = src.indexOf('function swpLoadGatewayBalance()');
    const fnBody = src.slice(fnIdx, fnIdx + 1000);
    expect(fnBody).toContain('ubGetGatewayBalance');  // reads shared cache
    expect(fnBody).not.toContain("fetch('/api/gateway/balances");  // no direct fetch
    expect(fnBody).not.toContain('swp-bal-in-val');
    expect(fnBody).not.toContain('SWP.balance');
  });
  it('EVM balance display (swp-bal-in-val) not modified by swpSetSource', () => {
    const fnIdx = src.indexOf('function swpSetSource(mode)');
    const fnBody = src.slice(fnIdx, fnIdx + 600);
    expect(fnBody).not.toContain('swp-bal-in-val');
  });
  it('saSetOrigin does not alter _saLastBalance or EVM balance cache', () => {
    const fnIdx = src.indexOf('function saSetOrigin(mode)');
    const fnBody = src.slice(fnIdx, fnIdx + 600);
    expect(fnBody).not.toContain('_saLastBalance');
  });
  it('Gateway route outAmt is informational — not summed into EVM totals', () => {
    // GW route outAmt = input amount (1:1 before fee). Verify it's NOT added to lifiRoutes.
    const gwRouteIdx = src.indexOf("Provider 3: Circle Gateway");
    const afterGw = src.slice(gwRouteIdx, gwRouteIdx + 2000);
    // It pushes gwRoute separately, not merged into lifiRoutes array
    expect(afterGw).toContain('routes.push(gwRoute)');
    expect(afterGw).not.toContain('lifiRoutes.push(gwRoute)');
  });
});

// ── GF2-6: No regressions in existing dispatch functions ────────────────────
describe('GF2-6 — No regressions in saDispatchSend, swpExecuteLiFi, executeBridgeOrTurbo', () => {
  it('saDispatchSend CPN path preserved — original function calls saExecuteCPNPayout', () => {
    // The original saDispatchSend (before our patch) handles CPN.
    // Our patch stores it in _saDispatchSendOrig and calls it for non-GW paths.
    const origFnIdx = src.indexOf('function saDispatchSend()');
    expect(origFnIdx).toBeGreaterThan(-1);
    const origBody = src.slice(origFnIdx, origFnIdx + 200);
    expect(origBody).toContain('saExecuteCPNPayout');
    expect(origBody).toContain('_saCPNMode');
  });
  it('saDispatchSend patch stores original as _saDispatchSendOrig and calls it for EVM path', () => {
    expect(src).toContain('var _saDispatchSendOrig = saDispatchSend');
    expect(src).toContain('_saDispatchSendOrig.apply(this, arguments)');
  });
  it('swpExecuteLiFi patch preserves original call when _swpGwSource=false', () => {
    const origIdx = src.indexOf('_swpExecuteLiFiOrig.apply(this, arguments)');
    expect(origIdx).toBeGreaterThan(-1);
  });
  it('executeBridgeOrTurbo cctp path is unchanged and calls executeBridgeViaCCTP', () => {
    // Search within executeBridgeOrTurbo body (starts at the function definition)
    const fnIdx = src.indexOf('function executeBridgeOrTurbo()');
    expect(fnIdx).toBeGreaterThan(-1);
    const fnBody = src.slice(fnIdx, fnIdx + 4000);
    const cctpIdx = fnBody.indexOf("if (route.provider === 'cctp')");
    const gwIdx   = fnBody.indexOf("if (route.provider === 'gateway')");
    expect(cctpIdx).toBeGreaterThan(-1);
    expect(gwIdx).toBeGreaterThan(cctpIdx); // gateway added AFTER cctp
    expect(fnBody.slice(cctpIdx, cctpIdx + 80)).toContain('executeBridgeViaCCTP');
  });
  it('executeBridgeOrTurbo lifi path is unchanged and calls executeBridgeViaLiFi', () => {
    const fnIdx = src.indexOf('function executeBridgeOrTurbo()');
    const fnBody = src.slice(fnIdx, fnIdx + 4000);
    const lifiIdx = fnBody.indexOf("if (route.provider === 'lifi')");
    const gwIdx   = fnBody.indexOf("if (route.provider === 'gateway')");
    expect(lifiIdx).toBeGreaterThan(-1);
    expect(gwIdx).toBeGreaterThan(lifiIdx); // gateway added AFTER lifi
    expect(fnBody.slice(lifiIdx, lifiIdx + 80)).toContain('executeBridgeViaLiFi');
  });
  it('_saGwOrigin defaults to false (EVM wallet is default source in Send)', () => {
    expect(src).toContain('var _saGwOrigin = false');
  });
  it('_swpGwSource defaults to false (wallet is default source in Swap)', () => {
    expect(src).toContain('var _swpGwSource = false');
  });
});
