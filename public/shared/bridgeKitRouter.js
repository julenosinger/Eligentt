/**
 * BridgeKitRouter — CCTP v2 primary / LI.FI fallback routing (single source of truth).
 * ═══════════════════════════════════════════════════════════════════════
 * Decides, for a cross-chain transfer, whether it routes through Circle CCTP v2
 * (via the Circle Bridge Kit) or falls back to LI.FI.
 *
 *   same chain                  → local transfer (handled by Send Assets, not here)
 *   USDC / EURC + CCTP domains  → Bridge Kit / CCTP (PRIMARY)
 *   any other token / pair      → LI.FI (FALLBACK)
 *
 * Arc Mainnet (chain 5042) is the canonical Arc network. Testnet identifiers
 * are never used anywhere in this module.
 *
 * The Circle Bridge Kit SDK is loaded lazily from `window.__BridgeKitVendor`
 * (bundled by scripts/build.js). The adapter is ALWAYS created from the browser
 * EIP-1193 provider (createViemAdapterFromProvider) — a private key is never
 * used on the frontend.
 *
 * Attached to window.BridgeKitRouter.
 */
(function () {
  'use strict';

  if (typeof window !== 'undefined' && window.BridgeKitRouter) return;

  // ── CCTP v2 chain/domain map (MAINNET ONLY) ──────────────────────────
  // kitId must match the Bridge Kit `chain` string literal exactly.
  // domain is the Circle CCTP destination domain. usdc is the native USDC
  // ERC-20 address on that chain.
  var CHAINS = {
    '1':     { kitId: 'Ethereum', domain: 0,  usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', name: 'Ethereum' },
    '10':    { kitId: 'Optimism', domain: 2,  usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', name: 'Optimism' },
    '42161': { kitId: 'Arbitrum', domain: 3,  usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', name: 'Arbitrum' },
    '8453':  { kitId: 'Base',     domain: 6,  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', name: 'Base' },
    '137':   { kitId: 'Polygon',  domain: 7,  usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', name: 'Polygon' },
    '5042':  { kitId: 'Arc',     domain: 26, usdc: '0x3600000000000000000000000000000000000000', name: 'Arc Mainnet' },
  };

  // Tokens eligible for CCTP v2 (USDC always; EURC as a Circle-issued expanded asset).
  var CCTP_TOKENS = { USDC: true, EURC: true };

  function chainEntry(chainId) { return CHAINS[String(chainId)] || null; }

  function isCCTPChain(chainId) { return !!chainEntry(chainId); }

  function isCCTPToken(token) {
    return !!token && !!CCTP_TOKENS[String(token).toUpperCase()];
  }

  /** Canonical Kit `chain` string for a numeric chain id, or null. */
  function getKitChainId(chainId) {
    var e = chainEntry(chainId);
    return e ? e.kitId : null;
  }

  /** Circle CCTP destination domain for a numeric chain id, or null. */
  function getDomain(chainId) {
    var e = chainEntry(chainId);
    return e ? e.domain : null;
  }

  /** True when this (token, chain pair) is eligible for CCTP v2. */
  function isEligible(fromChainId, toChainId, token) {
    if (!isCCTPToken(token)) return false;
    if (!isCCTPChain(fromChainId) || !isCCTPChain(toChainId)) return false;
    if (String(fromChainId) === String(toChainId)) return false; // same-chain = local, not CCTP
    return true;
  }

  /**
   * Routing decision for a cross-chain transfer.
   * @returns {{ provider: 'cctp' | 'lifi', reason: string }}
   */
  function route(fromChainId, toChainId, token) {
    if (String(fromChainId) === String(toChainId)) {
      return { provider: 'lifi', reason: 'same_chain' };
    }
    if (isEligible(fromChainId, toChainId, token)) {
      return { provider: 'cctp', reason: 'usdc_eurc_cctp_domains' };
    }
    return { provider: 'lifi', reason: 'not_cctp_eligible' };
  }

  // ── Bridge Kit SDK (lazy, via the vendor bundle) ────────────────────
  function vendor() {
    try { return window.__BridgeKitVendor || null; } catch (_e) { return null; }
  }

  /** True when the Bridge Kit vendor bundle + an EIP-1193 provider are usable. */
  function isAvailable() {
    return !!vendor();
  }

  function eip1193Provider() {
    try {
      if (typeof _rawProvider !== 'undefined' && _rawProvider && _rawProvider.request) return _rawProvider;
    } catch (_e) {}
    try {
      if (typeof _safeEth === 'function') { var e = _safeEth(); if (e && e.request) return e; }
    } catch (_e) {}
    try { if (window.ethereum && window.ethereum.request) return window.ethereum; } catch (_e) {}
    return null;
  }

  /** Create a viem adapter from the browser EIP-1193 provider (never a private key). */
  async function createAdapter(provider) {
    var v = vendor();
    if (!v) throw new Error('Bridge Kit unavailable');
    var p = provider || eip1193Provider();
    if (!p) throw new Error('No EIP-1193 wallet provider');
    return v.createViemAdapterFromProvider({ provider: p });
  }

  var _kitInstance = null;
  function _kit() {
    var v = vendor();
    if (!v) return null;
    // Singleton: onEvent() and bridge()/estimate()/retry() MUST share one kit
    // instance so lifecycle events are delivered to the same subscriber.
    if (!_kitInstance) _kitInstance = new v.BridgeKit();
    return _kitInstance;
  }

  function _bridgeArgs(fromChainId, toChainId, adapter, amount, token, recipientAddress) {
    var fromKit = getKitChainId(fromChainId);
    var toKit = getKitChainId(toChainId);
    if (!fromKit || !toKit) throw new Error('Chain not supported by CCTP');
    var to = { adapter: adapter, chain: toKit };
    if (recipientAddress) to.recipientAddress = recipientAddress;
    var params = {
      from: { adapter: adapter, chain: fromKit },
      to: to,
      amount: String(amount),
    };
    if (token && String(token).toUpperCase() === 'EURC') params.token = 'EURC';
    return params;
  }

  /** Subscribe to Bridge Kit lifecycle events (approve/burn/fetchAttestation/mint). */
  function onEvent(handler) {
    var kit = _kit();
    if (!kit) return null;
    kit.on('*', handler);
    return kit;
  }

  /** Estimate a CCTP bridge (fees + receive). Returns the kit's estimate result. */
  async function estimate(fromChainId, toChainId, amount, token, adapter) {
    var kit = _kit();
    if (!kit) throw new Error('Bridge Kit unavailable');
    var a = adapter || await createAdapter();
    return kit.estimate(_bridgeArgs(fromChainId, toChainId, a, amount, token, null));
  }

  /** Execute a CCTP bridge. Returns the kit's bridge result (with steps/state). */
  async function bridge(fromChainId, toChainId, amount, token, recipientAddress, adapter) {
    var kit = _kit();
    if (!kit) throw new Error('Bridge Kit unavailable');
    var a = adapter || await createAdapter();
    return kit.bridge(_bridgeArgs(fromChainId, toChainId, a, amount, token, recipientAddress));
  }

  /** Retry a failed/incomplete CCTP bridge (single burn, resume). */
  async function retry(result, adapter) {
    var kit = _kit();
    if (!kit) throw new Error('Bridge Kit unavailable');
    var a = adapter || await createAdapter();
    return kit.retry(result, { from: a, to: a });
  }

  window.BridgeKitRouter = {
    CHAINS: CHAINS,
    CCTP_TOKENS: CCTP_TOKENS,
    isCCTPChain: isCCTPChain,
    isCCTPToken: isCCTPToken,
    getKitChainId: getKitChainId,
    getDomain: getDomain,
    isEligible: isEligible,
    route: route,
    isAvailable: isAvailable,
    createAdapter: createAdapter,
    estimate: estimate,
    bridge: bridge,
    retry: retry,
    onEvent: onEvent,
    version: '1.0.0',
  };
})();
