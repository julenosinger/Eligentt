/**
 * Autonoma 1.2.2 — Server-authoritative prompt & trusted tool registry.
 * ═══════════════════════════════════════════════════════════════════════════════
 * The backend owns the trusted system instructions and the authoritative tool
 * definitions. The client may NOT redefine system-level policy, tool descriptions,
 * or tool parameters — this is the single source of truth.
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
  '2. For any read operation (balance, history, routes), call the appropriate tool.',
  '3. For any write operation (send, swap, bridge, create), call the tool — it will ask for approval.',
  '4. Never invent balances, addresses, or transaction hashes.',
  '5. If the wallet is not connected, say so clearly.',
  '6. For multi-step workflows, describe each step before executing.',
  '7. Cross-chain routes use LI.FI. CCTP v2 is available for USDC bridging.',
  '8. Supported chains: Arc (5042), Ethereum (1), Base (8453), Arbitrum (42161), Optimism (10), Polygon (137).',
  '9. If a tool returns an error, explain it clearly without technical jargon.',
  '10. For "send to a name", resolve it from contacts if available, or ask for the address.',
].join('\n');

// Authoritative tool definitions (OpenAI function-calling format). Mirrors the
// frontend A2ToolRegistry but owned server-side.
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
      parameters: { type: 'object', properties: { limit: { type: 'number', default: 10 } } },
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
      description: 'Find routes for swapping or bridging tokens. Parameters: fromToken, toToken, amount, fromChain (optional), toChain (optional).',
      parameters: {
        type: 'object',
        properties: {
          fromToken: { type: 'string', required: true },
          toToken: { type: 'string', required: true },
          amount: { type: 'number', required: true },
          fromChain: { type: 'string', default: 'Arc' },
          toChain: { type: 'string', default: 'Arc' },
        },
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
  {
    type: 'function',
    function: {
      name: 'send',
      description: 'Send USDC, EURC, or cirBTC to a recipient. Parameters: to (address), amount (number), token (USDC|EURC|cirBTC, default USDC), memo (optional string).',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', required: true },
          amount: { type: 'number', required: true },
          token: { type: 'string', default: 'USDC', enum: ['USDC', 'EURC', 'cirBTC'] },
          memo: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'swap',
      description: 'Swap tokens. Parameters: fromToken (USDC|EURC|cirBTC), toToken (USDC|EURC|cirBTC), amount (number).',
      parameters: {
        type: 'object',
        properties: {
          fromToken: { type: 'string', required: true, enum: ['USDC', 'EURC', 'cirBTC'] },
          toToken: { type: 'string', required: true, enum: ['USDC', 'EURC', 'cirBTC'] },
          amount: { type: 'number', required: true },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bridge',
      description: 'Bridge tokens between chains. Parameters: fromChain, toChain, amount, token (default USDC).',
      parameters: {
        type: 'object',
        properties: {
          fromChain: { type: 'string', required: true },
          toChain: { type: 'string', required: true },
          amount: { type: 'number', required: true },
          token: { type: 'string', default: 'USDC' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_invoice',
      description: 'Create an invoice. Parameters: client (name or address), amount (number), currency (USDC|EURC|cirBTC), description (optional), due_days (optional, default 7).',
      parameters: {
        type: 'object',
        properties: {
          client: { type: 'string', required: true },
          amount: { type: 'number', required: true },
          currency: { type: 'string', default: 'USDC', enum: ['USDC', 'EURC', 'cirBTC'] },
          description: { type: 'string' },
          due_days: { type: 'number', default: 7 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_schedule',
      description: 'Schedule a recurring payment. Parameters: name, amount, recipient (address), frequency (once|daily|weekly|biweekly|monthly), token (default USDC).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', required: true },
          amount: { type: 'number', required: true },
          recipient: { type: 'string', required: true },
          frequency: { type: 'string', required: true, enum: ['once', 'daily', 'weekly', 'biweekly', 'monthly'] },
          token: { type: 'string', default: 'USDC' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_payment_link',
      description: 'Create a payment link. Parameters: label, amount (0 for open), token (default USDC), type (fixed|open|donation).',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', required: true },
          amount: { type: 'number', default: 0 },
          token: { type: 'string', default: 'USDC' },
          type: { type: 'string', default: 'fixed', enum: ['fixed', 'open', 'donation'] },
        },
      },
    },
  },
]);

export const TRUSTED_TOOL_NAMES = new Set(TRUSTED_TOOLS.map((t) => t.function.name));
const TRUSTED_BY_NAME = Object.fromEntries(TRUSTED_TOOLS.map((t) => [t.function.name, t]));

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
