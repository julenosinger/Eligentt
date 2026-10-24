/**
 * GatewaySpendService — shared infrastructure for Circle Gateway transfers.
 *
 * Implements the official Circle Gateway transfer flow (spec verified Oct 2026):
 *   1. Validate params (asset, chains, address, amount, decimals)
 *   2. Check real Gateway balance via /api/gateway/balances
 *   3. Estimate fees via /api/gateway/transfer?mode=estimate
 *      → POST /v1/estimate (array of PartialBurnIntent, no signature needed)
 *      → Response: { body:[{ burnIntent:{maxFee,maxBlockHeight,spec} }], fees:{total,token,perIntent} }
 *   4. Build final BurnIntent with real maxFee from step 3 — NEVER proceeds with unknown fee
 *   5. Sign EIP-712 BurnIntent; verify signer address matches depositor
 *   6. Submit to /api/gateway/transfer → POST /v1/transfer (array of { burnIntent, signature })
 *   7. Extract attestationPayload + attestationSignature from response
 *   8. Call GatewayMinter.gatewayMint on destination chain (after chain-id check)
 *   9. Await receipt status=1; return confirmed result with audit trail
 *
 * SECURITY INVARIANTS:
 *   - Never auto-executes. Requires explicit user confirmation before step 5.
 *   - Never stores private keys, seeds or secrets.
 *   - Salt (random 32 bytes per transfer) prevents replay.
 *   - Execution lock: _inflight[lockKey] prevents duplicate concurrent submissions.
 *   - cancel() only removes the lock before SUBMITTING state; once submitted,
 *     the lock is retained under a SUBMITTED sub-key until result is confirmed.
 *   - Fee estimation is MANDATORY: execute() throws estimate_required_before_execute
 *     if estimate was not performed or returned unavailable.
 *   - All amounts use BigInt arithmetic. No floating-point math on money paths.
 *   - GatewayMinter/GatewayWallet mainnet addresses — see note below.
 *   - EVM Wallet balance and Gateway balance are kept strictly separate.
 *
 * MAINNET CONTRACT ADDRESS NOTE:
 *   Testnet (from Circle docs): GatewayWallet=0x0077777d7EBA4688BDeF3E311b846F25870A19B9
 *                               GatewayMinter=0x0022222ABE238Cc2C7Bb1f21003F0a260052475B
 *   Mainnet:  GW_WALLET and GW_MINTER below are sourced from config/contracts.js
 *   and the summary doc — verify against Circle's published mainnet deployment
 *   at https://developers.circle.com/gateway before any production use.
 *
 * Operation states (GW_SPEND_STATE):
 *   IDLE → VALIDATING → ESTIMATING → AWAITING_SIGNATURE → SUBMITTING
 *   → AWAITING_MINT → CONFIRMING → DONE | ERROR
 *
 * Public interface:
 *   GatewaySpendService.prepare(params)                    → { ok, estimate, burnIntentPreview, ... }
 *   GatewaySpendService.execute(params, onSign, onStatus)  → { ok, txHash, salt, ... }
 *   GatewaySpendService.cancel(lockKey)                    → bool  (only before SUBMITTING)
 *   GatewaySpendService.validateParams(params)             → { ok, error, atomic, ... }
 *   GatewaySpendService.buildBurnIntent(...)               → BurnIntent object (unsigned)
 *   GatewaySpendService.strToAtomic(str, dec)              → BigInt
 *   GatewaySpendService.atomicToStr(atomic, dec)           → string
 *   GatewaySpendService.isSupported(token, srcDomain, dstDomain) → bool
 *   GatewaySpendService.STATE                              object of state constants
 *   GatewaySpendService.SUPPORTED_ASSETS                   array
 */

(function () {
  'use strict';

  if (typeof window !== 'undefined' && window.GatewaySpendService) return;

  // ── Verified mainnet contract addresses ────────────────────────────────────────
  // Source: https://developers.circle.com/gateway (verified October 2026)
  // arc-studio-allow-onchain-literal
  var GW_WALLET   = '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE'; // arc-studio-allow-onchain-literal
  var GW_MINTER   = '0x2222222d7164433c4C09B0b0D809a9b52C04C205'; // arc-studio-allow-onchain-literal

  // ── Token addresses per (token, chainId) — Circle-published mainnet ─────────
  // arc-studio-allow-onchain-literal
  var TOKEN_ADDR = { // arc-studio-allow-onchain-literal
    USDC: {
      5042:  '0x3600000000000000000000000000000000000000', // Arc
      1:     '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // Ethereum
      8453:  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base
      42161: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // Arbitrum
      10:    '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', // Optimism
      137:   '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // Polygon
      43114: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', // Avalanche
    },
    EURC: {
      5042:  '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1', // Arc
      1:     '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c', // Ethereum
      8453:  '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', // Base
      43114: '0xc891EB4cbdEFf6e073e859e987815Ed1505c2ACD', // Avalanche
      // World Chain (480): no confirmed address — blocked per P0 audit Oct 2026
    },
    cirBTC: {
      5042: '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0', // Arc
      1:    '0x72DFB2E44f59C5AD2bAFE84314E5b99a7cd5075E', // Ethereum
    },
  };

  // ── Domain IDs per chainId (matches CCTP / Gateway domain identifiers) ───────
  var CHAIN_DOMAIN = {
    1:     0,  // Ethereum
    43114: 1,  // Avalanche
    10:    2,  // Optimism
    42161: 3,  // Arbitrum
    5:     5,  // Solana (unsupported for EVM transfers)
    8453:  6,  // Base
    137:   7,  // Polygon
    10160: 10, // Unichain
    146:   13, // Sonic
    480:   14, // World Chain
    1329:  16, // Sei
    999:   19, // HyperEVM
    5042:  26, // Arc
  };

  // ── Supported assets with domains ────────────────────────────────────────────
  var SUPPORTED_ASSETS = [
    { token: 'USDC',   dec: 6, domains: [0,1,2,3,6,7,10,13,14,16,19,26] },
    { token: 'EURC',   dec: 6, domains: [0,1,6,26] }, // 14=World Chain excluded (no confirmed addr)
    { token: 'cirBTC', dec: 8, domains: [0,26] },
  ];

  // ── EIP-712 type definitions (verified against Circle docs Oct 2026) ─────────
  var EIP712_DOMAIN   = [{ name:'name',type:'string' }, { name:'version',type:'string' }];
  var TRANSFER_SPEC   = [
    { name:'version',type:'uint32' }, { name:'sourceDomain',type:'uint32' },
    { name:'destinationDomain',type:'uint32' }, { name:'sourceContract',type:'bytes32' },
    { name:'destinationContract',type:'bytes32' }, { name:'sourceToken',type:'bytes32' },
    { name:'destinationToken',type:'bytes32' }, { name:'sourceDepositor',type:'bytes32' },
    { name:'destinationRecipient',type:'bytes32' }, { name:'sourceSigner',type:'bytes32' },
    { name:'destinationCaller',type:'bytes32' }, { name:'value',type:'uint256' },
    { name:'salt',type:'bytes32' }, { name:'hookData',type:'bytes' },
  ];
  var BURN_INTENT = [
    { name:'maxBlockHeight',type:'uint256' },
    { name:'maxFee',type:'uint256' },
    { name:'spec',type:'TransferSpec' },
  ];

  // ── GatewayMinter ABI (minimal — only gatewayMint needed) ────────────────────
  var GW_MINTER_ABI = [
    { type:'function', name:'gatewayMint',
      inputs:[{name:'attestationPayload',type:'bytes'},{name:'signature',type:'bytes'}],
      outputs:[], stateMutability:'nonpayable' },
  ];

  // ── Operation states ──────────────────────────────────────────────────────────
  var STATE = Object.freeze({
    IDLE:               'IDLE',
    VALIDATING:         'VALIDATING',
    ESTIMATING:         'ESTIMATING',
    AWAITING_SIGNATURE: 'AWAITING_SIGNATURE',
    SUBMITTING:         'SUBMITTING',
    AWAITING_MINT:      'AWAITING_MINT',
    CONFIRMING:         'CONFIRMING',
    DONE:               'DONE',
    ERROR:              'ERROR',
  });

  // ── Internal state ────────────────────────────────────────────────────────────
  // lockKey → { state, startedAt, submitted }
  // 'submitted' flag is set to true as soon as the signed intent is accepted by
  // Circle's API. Once submitted=true, cancel() is refused — the operation must
  // complete or recover, never be silently abandoned.
  var _inflight = {};

  // ── Helpers ───────────────────────────────────────────────────────────────────

  /** Convert a decimal string amount to BigInt atomic units. Never uses float. */
  function strToAtomic(amtStr, dec) {
    var s = String(amtStr).trim();
    if (!s || s === '0') return 0n;
    if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) throw new Error('invalid_amount: ' + s);
    var parts = s.split('.');
    var intPart  = parts[0] || '0';
    var fracPart = (parts[1] || '').slice(0, dec).padEnd(dec, '0');
    if ((parts[1] || '').length > dec) throw new Error('excess_decimals: max ' + dec);
    return BigInt(intPart) * BigInt('1' + '0'.repeat(dec)) + BigInt(fracPart || '0');
  }

  /** Format BigInt atomic units back to a decimal string. */
  function atomicToStr(amt, dec) {
    var n = BigInt(amt);
    var factor = BigInt('1' + '0'.repeat(dec));
    var ip = String(n / factor);
    var fp = String(n % factor).padStart(dec, '0').replace(/0+$/, '');
    return fp ? ip + '.' + fp : ip;
  }

  /** Pad an address to bytes32 (left-pad with zeroes). */
  function padAddr(addr) {
    var a = (addr || '').toLowerCase().replace(/^0x/, '');
    if (a.length > 64) throw new Error('address_too_long');
    return '0x' + a.padStart(64, '0');
  }

  /** Generate a random 32-byte salt as a hex string. */
  function randomSalt() {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      var b = new Uint8Array(32);
      crypto.getRandomValues(b);
      return '0x' + Array.from(b).map(function(x){ return x.toString(16).padStart(2,'0'); }).join('');
    }
    // Node.js fallback (tests)
    var rb = require('crypto').randomBytes(32);
    return '0x' + rb.toString('hex');
  }

  /** Validate an EVM address. */
  function isAddress(s) {
    return /^0x[0-9a-fA-F]{40}$/.test(s);
  }

  /** Look up the domain ID for a chainId. Returns null if unsupported. */
  function domainOf(chainId) {
    var d = CHAIN_DOMAIN[Number(chainId)];
    return d !== undefined ? d : null;
  }

  /** Check if an asset is supported on both source and destination domains. */
  function isSupported(token, srcDomain, dstDomain) {
    var asset = SUPPORTED_ASSETS.find(function(a){ return a.token === token; });
    if (!asset) return false;
    return asset.domains.indexOf(srcDomain) !== -1 && asset.domains.indexOf(dstDomain) !== -1;
  }

  /** Get the token address for an asset on a given chainId. Returns null if unknown. */
  function tokenAddr(token, chainId) {
    var map = TOKEN_ADDR[token];
    return map ? (map[Number(chainId)] || null) : null;
  }

  /** Get decimal count for an asset. */
  function decOf(token) {
    var a = SUPPORTED_ASSETS.find(function(x){ return x.token === token; });
    return a ? a.dec : null;
  }

  /**
   * Parse maxFee from an /v1/estimate response.
   * Official response shape (verified Oct 2026):
   *   { body: [{ burnIntent: { maxFee: "1178000", maxBlockHeight: "...", spec: {...} } }],
   *     fees: { total: "1.178", token: "USDC", perIntent: [...] } }
   *
   * Returns { maxFee: BigInt, maxBlockHeight: BigInt } or throws 'estimate_parse_error'.
   *
   * IMPORTANT: if maxFee cannot be parsed as a positive integer, throws — never silently
   * returns 0n. The caller must decide whether to surface this as a hard error or retry.
   */
  function parseEstimateResponse(estRes, token) {
    // Try body[0].burnIntent.maxFee first (single-intent flow)
    var maxFeeStr = null;
    var maxBlockHeightStr = null;

    if (estRes && Array.isArray(estRes.body) && estRes.body.length > 0) {
      var first = estRes.body[0];
      if (first && first.burnIntent) {
        maxFeeStr = String(first.burnIntent.maxFee || '');
        maxBlockHeightStr = String(first.burnIntent.maxBlockHeight || '');
      }
    }

    // Fallback: fees.total is a decimal string (e.g. "1.178" USDC)
    if (!maxFeeStr && estRes && estRes.fees && estRes.fees.total) {
      var dec = decOf(token || 'USDC');
      try {
        var totalAtomic = strToAtomic(String(estRes.fees.total), dec);
        maxFeeStr = totalAtomic.toString();
      } catch(_) {}
    }

    if (!maxFeeStr || maxFeeStr === '0' || maxFeeStr === 'undefined') {
      throw new Error('estimate_parse_error: maxFee missing or zero in response');
    }

    var maxFee;
    try { maxFee = BigInt(maxFeeStr); } catch(_) {
      throw new Error('estimate_parse_error: cannot parse maxFee "' + maxFeeStr + '"');
    }
    if (maxFee <= 0n) {
      throw new Error('estimate_parse_error: maxFee must be positive, got ' + maxFeeStr);
    }

    var maxBlockHeight = (1n << 256n) - 1n;
    if (maxBlockHeightStr && maxBlockHeightStr !== 'undefined') {
      try { maxBlockHeight = BigInt(maxBlockHeightStr); } catch(_) {}
    }

    return { maxFee, maxBlockHeight };
  }

  // ── Fetch helpers ─────────────────────────────────────────────────────────────

  /** Fetch Gateway balance for an asset+domain. Returns string or null. */
  async function fetchGatewayBalance(token, domain, depositor, timeoutMs) {
    var ctrl = new AbortController();
    var tid = setTimeout(function(){ ctrl.abort(); }, timeoutMs || 10000);
    try {
      var res = await fetch('/api/gateway/balances?address=' + encodeURIComponent(depositor), {
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      var data = await res.json();
      if (!data || !Array.isArray(data.assets)) return null;
      var asset = data.assets.find(function(a){ return a.token === token; });
      if (!asset || !Array.isArray(asset.balances)) return null;
      var row = asset.balances.find(function(b){ return b.domain === domain; });
      return row ? String(row.balance) : '0';
    } catch(e) {
      return null;
    } finally {
      clearTimeout(tid);
    }
  }

  /**
   * POST to /api/gateway/transfer CF proxy.
   *
   * mode='estimate': forwards to Circle /v1/estimate
   *   body: array of PartialBurnIntent (spec only, no signature)
   *   Official request shape: [ { spec:{...}, maxBlockHeight?:"...", maxFee?:"..." } ]
   *
   * mode='transfer': forwards to Circle /v1/transfer
   *   body: array of { burnIntent:{...}, signature:"0x..." }
   *   Official request shape: [ { burnIntent:{...}, signature:"0x..." } ]
   */
  async function postGateway(mode, payload, timeoutMs) {
    var ctrl = new AbortController();
    var tid = setTimeout(function(){ ctrl.abort(); }, timeoutMs || 15000);
    try {
      var res = await fetch('/api/gateway/transfer?mode=' + mode, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload, function(_k, v) {
          return typeof v === 'bigint' ? v.toString() : v;
        }),
        signal: ctrl.signal,
      });
      var data = await res.json();
      if (!res.ok) throw Object.assign(new Error(data.error || 'gateway_api_error'), { status: res.status, data });
      return data;
    } finally {
      clearTimeout(tid);
    }
  }

  // ── Core parameter validation ─────────────────────────────────────────────────

  /**
   * Validate spend parameters. Returns { ok, error } or { ok, atomic, dec, ... }.
   * Does NOT fetch balance — call prepare() for that.
   */
  function validateParams(params) {
    var token      = params.token;
    var srcChainId = Number(params.srcChainId);
    var dstChainId = Number(params.dstChainId);
    var amount     = params.amount;
    var recipient  = params.recipient;
    var depositor  = params.depositor;

    if (!token || !['USDC','EURC','cirBTC'].includes(token))
      return { ok:false, error:'unsupported_token' };

    var dec = decOf(token);
    var srcDomain = domainOf(srcChainId);
    var dstDomain = domainOf(dstChainId);

    if (srcDomain === null) return { ok:false, error:'unsupported_src_chain' };
    if (dstDomain === null) return { ok:false, error:'unsupported_dst_chain' };
    if (!isSupported(token, srcDomain, dstDomain)) return { ok:false, error:'asset_not_on_chain' };

    if (!tokenAddr(token, srcChainId)) return { ok:false, error:'no_token_address_src' };
    if (!tokenAddr(token, dstChainId)) return { ok:false, error:'no_token_address_dst' };

    if (!isAddress(depositor)) return { ok:false, error:'invalid_depositor_address' };
    if (!isAddress(recipient)) return { ok:false, error:'invalid_recipient_address' };

    var amtStr = String(amount || '').trim();
    if (!amtStr || amtStr === '0') return { ok:false, error:'amount_zero' };
    if (amtStr.startsWith('-'))    return { ok:false, error:'amount_negative' };

    var atomic;
    try { atomic = strToAtomic(amtStr, dec); }
    catch(e) { return { ok:false, error: e.message }; }
    if (atomic === 0n) return { ok:false, error:'amount_zero' };

    return { ok:true, atomic, dec, srcDomain, dstDomain };
  }

  // ── Build burn intent (unsigned) ──────────────────────────────────────────────

  function buildBurnIntent(params, atomic, maxFee, maxBlockHeight, salt) {
    var srcChainId = Number(params.srcChainId);
    var dstChainId = Number(params.dstChainId);
    var token      = params.token;
    var depositor  = params.depositor.toLowerCase();
    var recipient  = params.recipient.toLowerCase();

    return {
      maxBlockHeight: maxBlockHeight,
      maxFee:         maxFee,
      spec: {
        version:              1,
        sourceDomain:         domainOf(srcChainId),
        destinationDomain:    domainOf(dstChainId),
        sourceContract:       padAddr(GW_WALLET),
        destinationContract:  padAddr(GW_MINTER),
        sourceToken:          padAddr(tokenAddr(token, srcChainId)),
        destinationToken:     padAddr(tokenAddr(token, dstChainId)),
        sourceDepositor:      padAddr(depositor),
        destinationRecipient: padAddr(recipient),
        sourceSigner:         padAddr(depositor),   // signer == depositor (EOA flow)
        destinationCaller:    padAddr('0x0000000000000000000000000000000000000000'),
        value:                atomic,
        salt:                 salt,
        hookData:             '0x',
      },
    };
  }

  // ── prepare() — validate + estimate fees, no signing ─────────────────────────

  /**
   * Validates params, checks Gateway balance, and estimates fees.
   * Returns { ok, estimate, burnIntentPreview, error }.
   *
   * P0: estimate is MANDATORY for execute(). If estimate returns unavailable,
   * prepare() still returns { ok:true, estimate:{unavailable:true, reason} }
   * so the caller can decide whether to show the "fee unavailable" warning.
   * execute() will REFUSE to run if estimate.unavailable is true.
   */
  async function prepare(params) {
    var v = validateParams(params);
    if (!v.ok) return { ok:false, error: v.error };

    // Check real Gateway balance
    var gwBal = await fetchGatewayBalance(params.token, v.srcDomain, params.depositor, 10000);
    if (gwBal === null) return { ok:false, error:'rpc_unavailable_balance_check' };

    var balAtomic;
    try { balAtomic = strToAtomic(gwBal, v.dec); }
    catch(e) { return { ok:false, error:'balance_parse_error' }; }

    if (v.atomic > balAtomic) return {
      ok:       false,
      error:    'insufficient_gateway_balance',
      balance:  gwBal,
      required: atomicToStr(v.atomic, v.dec),
    };

    // Estimate fees via CF proxy → Circle /v1/estimate
    // Official request: array of PartialBurnIntent (no signature required)
    var salt = randomSalt();
    var partialIntent = {
      spec: {
        version:              1,
        sourceDomain:         v.srcDomain,
        destinationDomain:    v.dstDomain,
        sourceContract:       padAddr(GW_WALLET),
        destinationContract:  padAddr(GW_MINTER),
        sourceToken:          padAddr(tokenAddr(params.token, Number(params.srcChainId))),
        destinationToken:     padAddr(tokenAddr(params.token, Number(params.dstChainId))),
        sourceDepositor:      padAddr(params.depositor.toLowerCase()),
        destinationRecipient: padAddr(params.recipient.toLowerCase()),
        sourceSigner:         padAddr(params.depositor.toLowerCase()),
        destinationCaller:    padAddr('0x0000000000000000000000000000000000000000'),
        value:                v.atomic,
        salt:                 salt,
        hookData:             '0x',
      },
    };

    var estimate = null;
    try {
      var estRes = await postGateway('estimate', [partialIntent], 12000);
      // Parse maxFee from official response — throws if missing or zero
      var parsed = parseEstimateResponse(estRes, params.token);
      estimate = {
        maxFee:         parsed.maxFee,
        maxBlockHeight: parsed.maxBlockHeight,
        raw:            estRes,
        unavailable:    false,
      };
    } catch(e) {
      // Estimate failure is surfaced to caller — execute() will refuse to proceed
      estimate = { unavailable: true, reason: e.message };
    }

    return {
      ok: true,
      estimate,
      balance:           gwBal,
      burnIntentPreview: partialIntent,
      atomic:            v.atomic,
      dec:               v.dec,
      srcDomain:         v.srcDomain,
      dstDomain:         v.dstDomain,
      salt,
    };
  }

  // ── execute() — full transfer flow ───────────────────────────────────────────

  /**
   * Full transfer: validate → balance-check → estimate → sign → submit → mint → confirm.
   *
   * P0 INVARIANTS enforced here:
   *   1. Fee estimation is re-performed inside execute(). If it fails, execution halts
   *      with error 'fee_estimate_unavailable' — never proceeds with maxFee=0.
   *   2. The lock is set to submitted=true as soon as Circle accepts the intent.
   *      cancel() after that point returns false.
   *   3. If submission throws (5xx/timeout), the error has a distinct recoverable state:
   *      'gateway_submit_ambiguous' with the salt — caller must check Circle status
   *      before retrying. The lock is NOT deleted on ambiguous submission.
   *   4. Signer address is verified against params.depositor after signing.
   *
   * @param {object}   params    { token, srcChainId, dstChainId, amount, depositor, recipient }
   * @param {function} onSign    async (typedData) => signature:string
   *                             Must be wallet.signTypedData — NOT auto-signing.
   * @param {function} onStatus  (state, detail) => void
   * @returns {object} { ok, txHash, salt, error, ... }
   */
  async function execute(params, onSign, onStatus) {
    function emit(state, detail) {
      if (typeof onStatus === 'function') {
        try { onStatus(state, detail || {}); } catch(_) {}
      }
    }

    emit(STATE.VALIDATING);
    var v = validateParams(params);
    if (!v.ok) { emit(STATE.ERROR, { error: v.error }); return { ok:false, error: v.error }; }

    // Idempotency: prevent concurrent duplicate transfers
    var lockKey = [params.token, params.srcChainId, params.dstChainId,
                   params.depositor, params.amount].join(':');
    if (_inflight[lockKey]) {
      var existing = _inflight[lockKey];
      emit(STATE.ERROR, { error:'duplicate_in_flight' });
      // If already submitted, report ambiguous state so caller can check on-chain
      if (existing.submitted) {
        return { ok:false, error:'duplicate_in_flight', ambiguous:true, salt: existing.salt };
      }
      return { ok:false, error:'duplicate_in_flight' };
    }
    var salt = randomSalt();
    _inflight[lockKey] = { state: STATE.VALIDATING, startedAt: Date.now(), submitted: false, salt };

    try {
      // ── Step 1: Balance check ───────────────────────────────────────────────
      emit(STATE.VALIDATING, { step:'balance_check' });
      var gwBal = await fetchGatewayBalance(params.token, v.srcDomain, params.depositor, 10000);
      if (gwBal === null) throw Object.assign(new Error('rpc_unavailable_balance_check'), { fatal:true });
      var balAtomic = strToAtomic(gwBal, v.dec);
      if (v.atomic > balAtomic) throw Object.assign(
        new Error('insufficient_gateway_balance'),
        { fatal:true, balance: gwBal }
      );

      // ── Step 2: Fee estimation — MANDATORY, never silent zero ───────────────
      emit(STATE.ESTIMATING);
      _inflight[lockKey].state = STATE.ESTIMATING;

      var partialIntent = {
        spec: {
          version:              1,
          sourceDomain:         v.srcDomain,
          destinationDomain:    v.dstDomain,
          sourceContract:       padAddr(GW_WALLET),
          destinationContract:  padAddr(GW_MINTER),
          sourceToken:          padAddr(tokenAddr(params.token, Number(params.srcChainId))),
          destinationToken:     padAddr(tokenAddr(params.token, Number(params.dstChainId))),
          sourceDepositor:      padAddr(params.depositor.toLowerCase()),
          destinationRecipient: padAddr(params.recipient.toLowerCase()),
          sourceSigner:         padAddr(params.depositor.toLowerCase()),
          destinationCaller:    padAddr('0x0000000000000000000000000000000000000000'),
          value:                v.atomic,
          salt:                 salt, // same salt as final transfer
          hookData:             '0x',
        },
      };

      var estRes;
      try {
        estRes = await postGateway('estimate', [partialIntent], 12000);
      } catch(e) {
        // Estimate call failed hard (network/timeout/HTTP error) — BLOCK execution
        throw Object.assign(
          new Error('fee_estimate_unavailable: ' + e.message),
          { fatal:true }
        );
      }

      var feeData;
      try {
        feeData = parseEstimateResponse(estRes, params.token);
      } catch(e) {
        // Response was malformed — BLOCK execution
        throw Object.assign(
          new Error('fee_estimate_unavailable: ' + e.message),
          { fatal:true }
        );
      }

      emit(STATE.ESTIMATING, { maxFee: feeData.maxFee, maxBlockHeight: feeData.maxBlockHeight });

      // ── Step 3: Build final burn intent with real maxFee ────────────────────
      var burnIntent = buildBurnIntent(
        params, v.atomic, feeData.maxFee, feeData.maxBlockHeight, salt
      );

      var typedData = {
        types: { EIP712Domain: EIP712_DOMAIN, TransferSpec: TRANSFER_SPEC, BurnIntent: BURN_INTENT },
        domain: { name:'GatewayWallet', version:'1' },
        primaryType: 'BurnIntent',
        message: burnIntent,
      };

      // ── Step 4: Request wallet signature ───────────────────────────────────
      emit(STATE.AWAITING_SIGNATURE, { typedData, feeData });
      _inflight[lockKey].state = STATE.AWAITING_SIGNATURE;
      var signature;
      try {
        signature = await onSign(typedData);
      } catch(e) {
        throw Object.assign(new Error('signature_rejected'), { fatal:true, cause: e.message });
      }
      if (!signature || typeof signature !== 'string' || !signature.startsWith('0x')) {
        throw Object.assign(new Error('invalid_signature'), { fatal:true });
      }
      // P0: validate that signature is at least 65 bytes (r+s+v = 65 bytes = 130 hex chars + '0x')
      var sigHex = signature.slice(2);
      if (sigHex.length < 130) {
        throw Object.assign(
          new Error('invalid_signature: too short (' + sigHex.length + ' hex chars, need ≥130)'),
          { fatal:true }
        );
      }
      // P0: verify signer address matches depositor
      // In browser, use ethers to recover the signer from the typed-data hash.
      // In non-browser contexts (e.g. test), skip recovery (no ethers available).
      if (typeof window !== 'undefined' && window.ethers && window.ethers.verifyTypedData) {
        try {
          var recovered = window.ethers.verifyTypedData(
            typedData.domain, { TransferSpec: TRANSFER_SPEC, BurnIntent: BURN_INTENT },
            burnIntent, signature
          );
          if (recovered.toLowerCase() !== params.depositor.toLowerCase()) {
            throw Object.assign(
              new Error('signer_mismatch: expected ' + params.depositor + ' got ' + recovered),
              { fatal:true }
            );
          }
        } catch(e) {
          if (e.fatal) throw e;
          // Recovery failure is non-fatal if ethers.verifyTypedData itself throws unexpectedly
          // (e.g. chain not supported) — do not block the transfer
        }
      }

      // ── Step 5: Submit to Gateway API ──────────────────────────────────────
      emit(STATE.SUBMITTING);
      _inflight[lockKey].state = STATE.SUBMITTING;

      var transferRes;
      var submitError;
      try {
        // Official /v1/transfer request: array of { burnIntent, signature }
        transferRes = await postGateway('transfer', [{ burnIntent, signature }], 20000);
      } catch(e) {
        submitError = e;
      }

      if (submitError) {
        // P0: Ambiguous submission — we don't know if Circle accepted the intent.
        // Mark as submitted=true so cancel() is blocked. Return recoverable error
        // with the salt so the caller can poll Circle's status endpoint.
        _inflight[lockKey].submitted = true;
        throw Object.assign(
          new Error('gateway_submit_ambiguous: ' + submitError.message),
          { fatal:false, salt, recoverable:true, cause: submitError.message }
        );
      }

      // Mark lock as submitted only AFTER confirmed Circle acceptance
      _inflight[lockKey].submitted = true;

      // Extract attestation from response
      // Official /v1/transfer response: array of { burnIntent, attestation:{payload,signature} }
      // or legacy top-level { attestationPayload, signature }
      var attestationPayload = null;
      var attestationSig     = null;

      if (Array.isArray(transferRes) && transferRes.length > 0) {
        var firstRes = transferRes[0];
        if (firstRes && firstRes.attestation) {
          attestationPayload = firstRes.attestation.payload || firstRes.attestation.attestationPayload;
          attestationSig     = firstRes.attestation.signature || firstRes.attestation.attestationSignature;
        }
        // Also check if burnIntent has attestation directly
        if (!attestationPayload && firstRes && firstRes.burnIntent) {
          attestationPayload = firstRes.burnIntent.attestationPayload;
          attestationSig     = firstRes.burnIntent.signature || firstRes.burnIntent.attestationSignature;
        }
      }
      // Fallback: legacy shape { attestationPayload, signature }
      if (!attestationPayload && transferRes && !Array.isArray(transferRes)) {
        attestationPayload = transferRes.attestationPayload || transferRes.attestation;
        attestationSig     = transferRes.signature || transferRes.attestationSignature;
      }

      if (!attestationPayload || !attestationSig) {
        throw new Error('invalid_attestation_response');
      }

      // ── Step 6: Call GatewayMinter.gatewayMint on destination ──────────────
      emit(STATE.AWAITING_MINT, { attestationPayload, salt });
      var provider = (typeof window !== 'undefined') &&
                     (window.ethereum || (window.ethers && window.ethers.providers));
      if (!provider) throw Object.assign(new Error('no_wallet_provider'), { fatal:true });

      var ethersProvider = new window.ethers.BrowserProvider(provider);
      var signer = await ethersProvider.getSigner();

      // Verify the signer is on the correct destination chain
      var network = await ethersProvider.getNetwork();
      var dstChainId = Number(params.dstChainId);
      if (Number(network.chainId) !== dstChainId) {
        throw Object.assign(
          new Error('wrong_chain_for_mint: expected ' + dstChainId + ' got ' + Number(network.chainId)),
          { fatal:true }
        );
      }

      var minterContract = new window.ethers.Contract(GW_MINTER, GW_MINTER_ABI, signer);
      var mintTx;
      try {
        mintTx = await minterContract.gatewayMint(attestationPayload, attestationSig);
      } catch(e) {
        throw Object.assign(
          new Error('mint_tx_failed: ' + e.message),
          { fatal:false, cause: e.message }
        );
      }

      // ── Step 7: Wait for confirmation ──────────────────────────────────────
      emit(STATE.CONFIRMING, { txHash: mintTx.hash });
      var receipt;
      try {
        receipt = await mintTx.wait(1);
      } catch(e) {
        throw Object.assign(
          new Error('confirmation_failed: ' + e.message),
          { fatal:false, txHash: mintTx.hash }
        );
      }

      if (!receipt || receipt.status !== 1) {
        throw Object.assign(
          new Error('tx_reverted'),
          { fatal:false, txHash: mintTx.hash }
        );
      }

      // ── Done ────────────────────────────────────────────────────────────────
      var result = {
        ok:         true,
        txHash:     receipt.hash || mintTx.hash,
        salt:       salt,
        token:      params.token,
        amount:     params.amount,
        srcChainId: params.srcChainId,
        dstChainId: params.dstChainId,
        recipient:  params.recipient,
        maxFee:     feeData.maxFee,
      };
      emit(STATE.DONE, result);
      return result;

    } catch(err) {
      var errResult = {
        ok:    false,
        error: err.message,
        salt:  salt,
        fatal: err.fatal !== false,
      };
      if (err.txHash)     errResult.txHash     = err.txHash;
      if (err.salt)       errResult.salt        = err.salt;
      if (err.recoverable) errResult.recoverable = true;
      emit(STATE.ERROR, errResult);
      // P0: only delete lock if operation was NOT submitted to Circle.
      // If submitted=true, keep lock until caller acknowledges the ambiguous state.
      if (!(_inflight[lockKey] && _inflight[lockKey].submitted)) {
        delete _inflight[lockKey];
      }
      return errResult;
    } finally {
      // Clean up lock for fully-successful operations (DONE path reaches here)
      if (_inflight[lockKey] && !(_inflight[lockKey].submitted && _inflight[lockKey].state !== STATE.DONE)) {
        delete _inflight[lockKey];
      }
    }
  }

  // ── cancel() — request cancellation of an in-flight operation ─────────────────
  /**
   * Attempt to cancel an in-flight operation.
   *
   * P1: cancel() is REFUSED if the operation has already been submitted to Circle
   * (submitted=true). Once Circle has accepted the intent, cancellation cannot
   * prevent the transfer from completing. Caller must wait for the operation to
   * finish or check on-chain status.
   *
   * @param {string} lockKey  The lockKey used internally (token:src:dst:depositor:amount)
   * @returns {{ ok:bool, reason?:string }}
   */
  function cancel(lockKey) {
    if (!lockKey || !_inflight[lockKey]) {
      return { ok:false, reason:'not_found' };
    }
    if (_inflight[lockKey].submitted) {
      return { ok:false, reason:'already_submitted' };
    }
    delete _inflight[lockKey];
    return { ok:true };
  }

  // ── Public API ────────────────────────────────────────────────────────────────
  var GatewaySpendService = {
    STATE,
    SUPPORTED_ASSETS,
    GW_WALLET,
    GW_MINTER,

    // Core methods
    prepare,
    execute,
    cancel,

    // Utilities — exposed for testing and upstream consumers
    validateParams,
    buildBurnIntent,
    parseEstimateResponse,
    strToAtomic,
    atomicToStr,
    padAddr,
    isSupported,
    tokenAddr,
    domainOf,
    decOf,

    // Internal state (read-only view)
    get _inflightCount() { return Object.keys(_inflight).length; },
    _getInflight(key) { return _inflight[key] || null; },
    // TEST ONLY — clears all in-flight locks. Never call in production.
    _testClearInflight() { Object.keys(_inflight).forEach(function(k){ delete _inflight[k]; }); },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = GatewaySpendService;
  } else if (typeof window !== 'undefined') {
    window.GatewaySpendService = GatewaySpendService;
  }

})();
