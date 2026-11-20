/**
 * Autonoma 3.0 — App Capability Manifest (server-side, read-only).
 * ═══════════════════════════════════════════════════════════════════════════════
 * Describes the Elligentt module ecosystem and the READ-ONLY tools Autonoma may
 * invoke through the trusted tool registry. This manifest reflects ACTUAL
 * implementation — modules marked `implemented:false` are exposed as capability
 * metadata only (the model is told they are unavailable, never given fake data).
 *
 * The manifest is DATA, not an executor. It never contains API keys, private keys
 * or session tokens.
 *
 * Tool-name mapping:
 *   - The trusted registry (trustedTools.js) exposes REAL tool names the model
 *     can call. Server-read tools use the legacy names `balance`, `history`,
 *     `wallet_info`; client-read tools use `contacts.*`, `queue.list`,
 *     `invoices.list`, `paymentLinks.list`.
 *   - `concept` below is the Phase-3.0 conceptual name (documentation only).
 */

export const APP_CAPABILITIES = Object.freeze({
  modules: [
    {
      id: 'recipients', name: 'Recipients / Contacts',
      purpose: 'Saved contacts (name, address, network) across supported chains',
      readTools: ['contacts.list', 'contacts.search', 'contacts.get'],
      dataSource: 'client (localStorage)', implemented: true,
    },
    {
      id: 'unifiedBalance', name: 'Unified Balance',
      purpose: 'Circle Agent Wallet token balances',
      readTools: ['balance'], concept: 'balances.get',
      dataSource: 'Circle Agent Wallet (Circle W3S API)', implemented: true,
    },
    {
      id: 'transactions', name: 'Transaction History',
      purpose: 'Recent Circle Agent Wallet transactions and status',
      readTools: ['history'], concept: 'transactions.list',
      dataSource: 'Circle Agent Wallet (Circle W3S API)', implemented: true,
    },
    {
      id: 'smartWallet', name: 'Circle Agent Wallet',
      purpose: 'The canonical agent identity (wallet id / address / chain)',
      readTools: ['wallet_info'],
      dataSource: 'Circle Agent Wallet', implemented: true,
    },
    {
      id: 'queue', name: 'Queue',
      purpose: 'Pending execution queue',
      readTools: ['queue.list'], concept: 'queue.list',
      dataSource: 'client (localStorage)', implemented: true,
    },
    {
      id: 'invoices', name: 'Invoices',
      purpose: 'Invoices issued to the user',
      readTools: ['invoices.list'], concept: 'invoices.list',
      dataSource: 'client (localStorage)', implemented: true,
    },
    {
      id: 'paymentLinks', name: 'Payment Links',
      purpose: 'Payment links created by the user',
      readTools: ['paymentLinks.list'], concept: 'paymentLinks.list',
      dataSource: 'client (localStorage)', implemented: true,
    },
    {
      id: 'schedule', name: 'Schedule',
      purpose: 'Scheduled and recurring payments',
      readTools: ['schedule.list'],
      dataSource: 'client (localStorage)', implemented: false,
    },
    {
      id: 'send', name: 'Send Assets', purpose: 'Send USDC / EURC / cirBTC',
      writeTools: ['send'], implemented: true,
    },
    {
      id: 'swap', name: 'Swap', purpose: 'Token swaps on Arc Mainnet',
      readTools: ['swap.getSupportedAssets'],
      dataSource: 'SwapAggregator (client)', implemented: false, writeTools: ['swap'],
    },
    {
      id: 'bridge', name: 'Bridge', purpose: 'Cross-chain bridging (CCTP v2 / LI.FI)',
      readTools: ['bridge.getSupportedNetworks'],
      dataSource: 'client', implemented: false, writeTools: ['bridge'],
    },
    {
      id: 'batch', name: 'Batch Payments / Multisend',
      purpose: 'Multi-recipient payments', writeTools: [], implemented: true,
    },
    {
      id: 'liquidity', name: 'Liquidity', purpose: 'Liquidity pool positions',
      readTools: ['liquidity.listPositions'],
      dataSource: 'client', implemented: false,
    },
    {
      id: 'rwa', name: 'RWA', purpose: 'Real-world assets',
      readTools: ['rwa.listPositions'],
      dataSource: 'client', implemented: false,
    },
    {
      id: 'tax', name: 'Tax', purpose: 'Tax reports',
      readTools: ['tax.getReports'],
      dataSource: 'client', implemented: false,
    },
    {
      id: 'treasury', name: 'Treasury', purpose: 'Treasury vault',
      readTools: ['treasury.getOverview'],
      dataSource: 'server', implemented: false,
    },
  ],
});

/** Server-side read tools — REAL tool names (executed in the server read loop). */
export const SERVER_READ_TOOLS = Object.freeze(['balance', 'history', 'wallet_info']);

/** Client-side read tools — REAL tool names (bridged to the frontend). */
export const CLIENT_READ_TOOLS = Object.freeze([
  'contacts.list', 'contacts.search', 'contacts.get',
  'queue.list', 'invoices.list', 'paymentLinks.list',
]);

/** Every read-only tool name (server + client). */
export const READ_TOOL_IDS = Object.freeze([...SERVER_READ_TOOLS, ...CLIENT_READ_TOOLS]);

export function getModule(id) {
  return APP_CAPABILITIES.modules.find((m) => m.id === id) || null;
}

export function isReadTool(name) { return READ_TOOL_IDS.indexOf(name) !== -1; }

/** Human-friendly module inventory for docs/prompt metadata (no secrets). */
export function capabilitySummary() {
  return APP_CAPABILITIES.modules.map((m) => ({
    id: m.id, name: m.name, purpose: m.purpose,
    readTools: m.readTools || [], writeTools: m.writeTools || [],
    implemented: m.implemented !== false,
  }));
}
