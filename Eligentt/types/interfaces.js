/**
 * Elligentt TypeScript Type Definitions — Core Interfaces (Phase 10)
 * JSDoc-annotated type definitions. Foundation for gradual TS migration.
 * Attached to: window.Types (reference only, not executable)
 */
var ElligenttTypes = /** @type {const} */ ({
  /**
   * @typedef {Object} WalletState
   * @property {string|null} address - Connected wallet address
   * @property {number} chainId - Active chain ID
   * @property {string} walletType - 'metamask' | 'coinbase' | 'rabby' | 'injected' | 'walletconnect'
   * @property {boolean} connected - Wallet connection status
   */

  /**
   * @typedef {Object} Intent
   * @property {string} id - Unique intent ID (AIW-<timestamp>)
   * @property {string} op - Operation: 'payment' | 'swap' | 'bridge' | 'transfer' | 'recurring' | 'multisend'
   * @property {string} name - Human-readable name
   * @property {number} amount - Token amount
   * @property {string} token - Token symbol: 'USDC' | 'EURC' | 'cirBTC'
   * @property {string} to - Recipient address
   * @property {string} network - Target network ID
   * @property {number} nonce - Replay protection nonce
   * @property {number} deadline - Unix timestamp expiration
   * @property {string} status - 'validating' | 'approved' | 'rejected' | 'executing' | 'executed' | 'failed' | 'cancelled'
   * @property {Array} checks - Validation check results
   */

  /**
   * @typedef {Object} Schedule
   * @property {string} id - Unique schedule ID
   * @property {string} type - Schedule operation type
   * @property {string} name - Schedule name
   * @property {string} token - Token symbol
   * @property {number} amount - Amount per execution
   * @property {string} freq - 'once' | 'daily' | 'weekly' | 'biweekly' | 'monthly'
   * @property {string} nextRun - ISO datetime string
   * @property {string} status - 'Active' | 'Paused' | 'Completed' | 'Cancelled'
   */

  /**
   * @typedef {Object} Agent
   * @property {string} id - Unique agent ID
   * @property {string} name - Display name
   * @property {string} version - Semantic version
   * @property {string} type - 'ai' | 'runtime' | 'third-party'
   * @property {string} status - 'registered' | 'initialized' | 'running' | 'stopped'
   * @property {string} health - 'initializing' | 'healthy' | 'degraded' | 'error'
   * @property {string[]} capabilities - Agent capability IDs
   * @property {{ executions: number, failures: number, avgLatencyMs: number }} metrics
   */

  /**
   * @typedef {Object} Plugin
   * @property {string} id - Unique plugin ID
   * @property {string} version - Semantic version
   * @property {string[]} dependencies - Required plugin IDs
   * @property {function} initialize - Init hook
   * @property {function} start - Start hook
   * @property {function} stop - Stop hook
   * @property {function} destroy - Destroy hook
   * @property {function} health - Health check function
   * @property {function} diagnostics - Diagnostics function
   * @property {function} capabilities - Returns capability IDs
   */

  /**
   * @typedef {Object} Execution
   * @property {string} id - Execution trace ID (EXEC_<timestamp>)
   * @property {string} op - Operation type
   * @property {Object} params - Operation parameters
   * @property {number} started - Start timestamp
   * @property {string} status - 'executing' | 'completed' | 'failed'
   * @property {*} result - Execution result
   */

  /**
   * @typedef {Object} VaultAllocation
   * @property {number} locked - Locked balance
   * @property {number} automation - Automation budget
   * @property {number} treasury - Treasury allocation
   * @property {number} operational - Derived usable balance
   */

  /**
   * @typedef {Object} ParityResult
   * @property {boolean} match - Legacy == New
   * @property {*} legacyOutput - Legacy function output
   * @property {*} newOutput - New architecture output
   * @property {string} diff - Difference description if mismatch
   */

  /**
   * @typedef {Object} DiagnosticReport
   * @property {string} generatedAt - ISO timestamp
   * @property {Object} health - ModuleHealth summary
   * @property {Object} performance - MetricsManager summary
   * @property {Object} queues - QueueManager stats
   * @property {Object} agents - AgentManager metrics
   * @property {Object} plugins - PluginRegistry count
   * @property {Object} rpc - RPCService metrics
   * @property {Object} storage - CacheManager metrics
   * @property {Object} resources - ResourceManager snapshot
   * @property {Object} heartbeat - HeartbeatManager status
   */

  /**
   * @typedef {Object} SecurityCheck
   * @property {string} check - Check name
   * @property {boolean} passed - Whether check passed
   * @property {string} reason - Human-readable reason
   */

  // Runtime reference (non-executable type registry)
  $$types: {
    WalletState: null,
    Intent: null,
    Schedule: null,
    Agent: null,
    Plugin: null,
    Execution: null,
    VaultAllocation: null,
    ParityResult: null,
    DiagnosticReport: null,
    SecurityCheck: null
  }
});

// Attach for reference
window.ElligenttTypes = ElligenttTypes;
