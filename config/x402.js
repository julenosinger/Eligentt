/**
 * Elligentt — x402 Payments configuration (frontend, read-only).
 * ═══════════════════════════════════════════════════════════════════════
 * Display/feature constants for the Autonoma "x402 Payments" section.
 * NO secrets, keys, or wallet addresses live here. The authoritative
 * integration state is served by GET /api/x402/status.
 *
 * Attached to window.X402Config.
 */
(function () {
  'use strict';

  const X402Config = Object.freeze({
    // Phase 1: infrastructure only. Real payments remain disabled until
    // network + EIP-3009 settlement compatibility is confirmed server-side.
    FEATURE_GATE_DEFAULT: false,

    VERSION: 2,
    ENDPOINT: '/api/x402',

    // Local storage keys (namespaced — never touches existing keys).
    STORAGE_HISTORY: 'elligentt_x402_history_v1',
    STORAGE_SUBMITTED: 'elligentt_x402_submitted_v1',

    // Human-readable network labels (mirror of the server table, display only).
    NETWORK_LABELS: Object.freeze({
      'eip155:84532': 'Base Sepolia',
      'eip155:8453': 'Base',
      'eip155:137': 'Polygon PoS',
      'eip155:5042': 'Arc Mainnet',
    }),

    // Amount in atomic units → display USD (USDC = 6 decimals).
    DECIMALS: 6,
  });

  if (typeof window !== 'undefined') window.X402Config = X402Config;
  if (typeof globalThis !== 'undefined') globalThis.X402Config = X402Config;
})();
