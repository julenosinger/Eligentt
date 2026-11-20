/**
 * Autonoma 1.2.3 — Server-authoritative prompt & trusted tool registry.
 * ═══════════════════════════════════════════════════════════════════════════════
 * The backend owns the trusted system instructions and the authoritative tool
 * definitions. The client may NOT redefine system-level policy, tool descriptions,
 * or tool parameters — this is the single source of truth.
 *
 * Tool schemas use STANDARD JSON Schema (top-level `required` array, never a
 * `required: true` inside individual properties).
 *
 * chat.js builds the tool list from this registry (never from client input) and
 * substitutes the trusted system prompt for any client `role: system` message.
 * Tool calls produced by the model remain UNTRUSTED proposals gated by the
 * frontend execution gate — this module does NOT execute anything.
 */

export const TRUSTED_SYSTEM_PROMPT = [
  'You are Autonoma 2, a conversational AI financial agent for the Elligentt dApp on Arc Mainnet (Chain ID 5042).',
  'The native gas token on Arc is USDC. Supported tokens: USDC, EURC, cirBTC.',
  '',
  'RULES:',
  '1. Be concise and conversational. Format amounts clearly (e.g. "500 USDC").',
  '2. For any READ operation, call the appropriate read-only tool: balance, history, wallet_info, contacts.list, contacts.search, contacts.get, queue.list, invoices.list, paymentLinks.list.',
  '3. For "show my contacts" / "search NAME in contacts" / "what address is saved for NAME", use contacts.list / contacts.search / contacts.get.',
  '4. For any write operation (send, swap, bridge, create), call the tool — it will ask for approval.',
  '5. Never invent balances, addresses, transaction hashes, contacts, or schedules.',
  '6. If the wallet is not connected or not provisioned, say so clearly.',
  '7. For multi-step workflows, describe each step before executing.',
  '8. Cross-chain routes use LI.FI. CCTP v2 is available for USDC bridging.',
  '9. Supported chains: Arc (5042), Ethereum (1), Base (8453), Arbitrum (42161), Optimism (10), Polygon (137).',
  '10. If a tool returns an error, explain it clearly without technical jargon.',
  '11. For "send to a name", resolve it from contacts if available, or ask for the address.',
].join('\n');

// Authoritative tool definitions (OpenAI function-calling format). Mirrors the
// frontend A2ToolRegistry but owned server-side. Schemas are standard JSON Schema.
export const TRUSTED_TOOLS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'balance',
      description: 'Retrieve the user\'s token balances. No parameters needed.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'history',
      description: 'Retrieve recent transactions. Optional: limit (number, default 10).',
      parameters: { type: 'object', properties: { limit: { type: 'number' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wallet_info',
      description: 'Get the user\'s wallet address, chain, and Circle wallet details.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'routes',
      description: 'Find routes for swapping or bridging tokens.',
      parameters: {
        type: 'object',
        properties: {
          fromToken: { type: 'string' },
          toToken: { type: 'string' },
          amount: { type: 'number' },
          fromChain: { type: 'string' },
          toChain: { type: 'string' },
        },
        required: ['fromToken', 'toToken', 'amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedules',
      description: 'List the user\'s scheduled and recurring payments.',
      parameters: { type: 'object', properties: {} },
    },
  },
  // ── Phase 3.0 read-only app-awareness tools ──────────────────────────────
  {
    type: 'function',
    function: {
      name: 'contacts.list',
      description: 'List the user\'s saved contacts (name, address, network). Optional: query (partial name search).',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'contacts.search',
      description: 'Search the user\'s saved contacts by name or address. Parameters: query (string, required).',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'contacts.get',
      description: 'Get a specific saved contact by name. Parameters: name (string, required).',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'queue.list',
      description: 'List the user\'s pending execution queue. No parameters needed.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'invoices.list',
      description: 'List the user\'s invoices. No parameters needed.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'paymentLinks.list',
      description: 'List the user\'s payment links. No parameters needed.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send',
      description: 'Send USDC, EURC, or cirBTC to a recipient.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          amount: { type: 'number' },
          token: { type: 'string', enum: ['USDC', 'EURC', 'cirBTC'] },
          memo: { type: 'string' },
        },
        required: ['to', 'amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'swap',
      description: 'Swap tokens.',
      parameters: {
        type: 'object',
        properties: {
          fromToken: { type: 'string', enum: ['USDC', 'EURC', 'cirBTC'] },
          toToken: { type: 'string', enum: ['USDC', 'EURC', 'cirBTC'] },
          amount: { type: 'number' },
        },
        required: ['fromToken', 'toToken', 'amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bridge',
      description: 'Bridge tokens between chains.',
      parameters: {
        type: 'object',
        properties: {
          fromChain: { type: 'string' },
          toChain: { type: 'string' },
          amount: { type: 'number' },
          token: { type: 'string' },
        },
        required: ['fromChain', 'toChain', 'amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_invoice',
      description: 'Create an invoice.',
      parameters: {
        type: 'object',
        properties: {
          client: { type: 'string' },
          amount: { type: 'number' },
          currency: { type: 'string', enum: ['USDC', 'EURC', 'cirBTC'] },
          description: { type: 'string' },
          due_days: { type: 'number' },
        },
        required: ['client', 'amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_schedule',
      description: 'Schedule a recurring payment.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          amount: { type: 'number' },
          recipient: { type: 'string' },
          frequency: { type: 'string', enum: ['once', 'daily', 'weekly', 'biweekly', 'monthly'] },
          token: { type: 'string' },
        },
        required: ['name', 'amount', 'recipient', 'frequency'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_payment_link',
      description: 'Create a payment link.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          amount: { type: 'number' },
          token: { type: 'string' },
          type: { type: 'string', enum: ['fixed', 'open', 'donation'] },
        },
        required: ['label'],
      },
    },
  },
]);

export const TRUSTED_TOOL_NAMES = new Set(TRUSTED_TOOLS.map((t) => t.function.name));
const TRUSTED_BY_NAME = Object.fromEntries(TRUSTED_TOOLS.map((t) => [t.function.name, t]));

// Tools that require explicit user confirmation (proposal-only). Financial
// execution remains gated by the frontend execution gate + AUTONOMA_AI_FINANCIAL_EXECUTION_ENABLED.
const WRITE_TOOL_NAMES = new Set(['send', 'swap', 'bridge', 'create_invoice', 'create_schedule', 'create_payment_link']);

/**
 * Resolve the authoritative tool list for a request.
 * `clientTools` (optional) may filter by name; names are validated against the
 * allowlist and definitions ALWAYS come from this registry (never client input).
 * Returns { ok:true, tools } or { ok:false, reason }.
 */
export function resolveTools(clientTools) {
  if (!clientTools || !clientTools.length) return { ok: true, tools: TRUSTED_TOOLS.slice() };
  const names = [];
  for (const t of clientTools) {
    const name = t && t.function && t.function.name;
    if (!name || !TRUSTED_TOOL_NAMES.has(name)) {
      return { ok: false, reason: 'unauthorized_tool: ' + (name || '(unknown)') };
    }
    if (names.indexOf(name) === -1) names.push(name);
  }
  return { ok: true, tools: names.map((n) => TRUSTED_BY_NAME[n]) };
}

/**
 * Server-authoritative tool availability for an authenticated user.
 * All authenticated users may REQUEST any trusted tool. Write tools are
 * PROPOSAL-ONLY: their `requiresApproval` flag is surfaced so callers keep the
 * confirmation + execution gate. Per-user capability filtering is deferred until
 * a permissions model exists — financial execution remains disabled in this phase.
 */
export function resolveAuthorizedTools(user, clientTools) {
  if (!user || !user.userId) {
    return { ok: false, reason: 'unauthenticated' };
  }
  const r = resolveTools(clientTools);
  if (!r.ok) return r;
  return {
    ok: true,
    tools: r.tools,
    writeTools: r.tools.filter((t) => WRITE_TOOL_NAMES.has(t.function.name)).map((t) => t.function.name),
  };
}
