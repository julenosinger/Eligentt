/**
 * GatewaySpendService — shared infrastructure for Circle Gateway transfers.
 *
 * Implements the official Circle Gateway transfer flow:
 *   1. Validate params (asset, chains, address, amount, decimals)
 *   2. Check real Gateway balance via /api/gateway/balances
 *   3. Estimate fees via /api/gateway/transfer (estimate mode)
 *   4. Build EIP-712 BurnIntent and request wallet signature
 *   5. Submit signed intent to /api/gateway/transfer → receive attestation
 *   6. Call GatewayMinter.gatewayMint(attestationPayload, signature) on dest chain
 *   7. Poll for receipt and return confirmed result
 *
 * SECURITY INVARIANTS:
 *   - Never auto-executes. Requires explicit user confirmation at step 4.
 *   - Never stores private keys, seeds or secrets.
 *   - Salt (random 32 bytes per transfer) prevents replay.
 *   - Idempotency key stored in _GwSpend._inflight — no duplicate submissions.
 *   - All amounts use BigInt. Never uses parseFloat for monetary math.
 *   - GatewayMinter/GatewayWallet addresses verified from Circle docs (Oct 2026).
 *   - EVM Wallet balance and Gateway balance are kept strictly separate.
 *
 * Operation states (GW_SPEND_STATE):
 *   IDLE → VALIDATING → ESTIMATING → AWAITING_SIGNATURE → SUBMITTING
 *   → AWAITING_MINT → CONFIRMING → DONE | ERROR
 *
 * Public interface:
 *   GatewaySpendService.prepare(params)   → { estimate, burnIntentPreview }
 *   GatewaySpendService.execute(params, onSign, onStatus) → { txHash, specHash }
 *   GatewaySpendService.cancel(salt)
 *   GatewaySpendService.STATE              object of state constants
 *   GatewaySpendService.SUPPORTED_ASSETS   array of { token, dec, domains }
 *   GatewaySpendService.isSupported(token, srcDomain, dstDomain) → bool
 */

(function () {
  'use strict';

  if (typeof window !== 'undefined' && window.GatewaySpendService) return;

  // ── Verified mainnet contract addresses (Circle docs, October 2026) ──────────
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
      // World Chain (480): no confirmed address — blocked per P0 audit
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

  // ── EIP-712 type definitions ──────────────────────────────────────────────────
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
  var _inflight = {}; // salt → { state, startedAt }

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

  /** POST to /api/gateway/transfer CF proxy. */
  async function postTransfer(body, timeoutMs) {
    var ctrl = new AbortController();
    var tid = setTimeout(function(){ ctrl.abort(); }, timeoutMs || 15000);
    try {
      var res = await fetch('/api/gateway/transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body, function(_k, v) { return typeof v === 'bigint' ? v.toString() : v; }),
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
   * Validate spend parameters. Returns { ok, error } or throws.
   * Does NOT fetch balance — call prepare() for that.
   */
  function validateParams(params) {
    var token      = params.token;
    var srcChainId = Number(params.srcChainId);
    var dstChainId = Number(params.dstChainId);
    var amount     = params.amount;      // string decimal
    var recipient  = params.recipient;   // EVM address
    var depositor  = params.depositor;   // EVM address (wallet)

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
      maxBlockHeight: maxBlockHeight || ((1n << 256n) - 1n),
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
        sourceSigner:         padAddr(depositor),
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
   * Does NOT sign or submit anything.
   *
   * @param {object} params
   *   token, srcChainId, dstChainId, amount, recipient, depositor
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

    // Estimate fees via CF proxy
    var salt = randomSalt();
    var maxFee0 = 0n; // use 0 for estimate call (API returns actual fee in response)
    var intent = buildBurnIntent(params, v.atomic, maxFee0, (1n << 256n) - 1n, salt);
    var estimate = null;
    try {
      var estRes = await postTransfer({ estimate: true, requests:[{ burnIntent: intent, signature:'0x00' }] }, 12000);
      estimate = estRes;
    } catch(e) {
      // Estimate failure is non-fatal — proceed without fee estimate, show "unknown"
      estimate = { unavailable: true, reason: e.message };
    }

    return {
      ok: true,
      estimate,
      balance:          gwBal,
      burnIntentPreview: intent,
      atomic:           v.atomic,
      dec:              v.dec,
      srcDomain:        v.srcDomain,
      dstDomain:        v.dstDomain,
      salt,
    };
  }

  // ── execute() — full transfer flow ───────────────────────────────────────────

  /**
   * Full transfer: validate → sign → submit → mint → confirm.
   *
   * @param {object}   params    Same shape as prepare().
   * @param {function} onSign    async (typedData) => signature:string — called once for wallet signature
   * @param {function} onStatus  (state, detail) => void — called on each state transition
   * @returns {object} { ok, txHash, specHash, error }
   *
   * Caller must:
   *   1. Show the user all details from params.
   *   2. Call execute() only after explicit user confirmation.
   *   3. Provide onSign() that calls wallet.signTypedData — NOT auto-signing.
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
      emit(STATE.ERROR, { error:'duplicate_in_flight' });
      return { ok:false, error:'duplicate_in_flight' };
    }
    _inflight[lockKey] = { state: STATE.VALIDATING, startedAt: Date.now() };

    var salt = randomSalt();

    try {
      // ── Step 1: Re-check balance ────────────────────────────────────────────
      emit(STATE.VALIDATING, { step:'balance_check' });
      var gwBal = await fetchGatewayBalance(params.token, v.srcDomain, params.depositor, 10000);
      if (gwBal === null) throw Object.assign(new Error('rpc_unavailable_balance_check'), { fatal:true });
      var balAtomic = strToAtomic(gwBal, v.dec);
      if (v.atomic > balAtomic) throw Object.assign(
        new Error('insufficient_gateway_balance'),
        { fatal:true, balance: gwBal }
      );

      // ── Step 2: Estimate fees ───────────────────────────────────────────────
      emit(STATE.ESTIMATING);
      var feeIntent = buildBurnIntent(params, v.atomic, 0n, (1n << 256n) - 1n, randomSalt());
      var feeEstimate = { maxFee: 0n, unavailable: false };
      try {
        var estRes = await postTransfer({ estimate:true, requests:[{ burnIntent:feeIntent, signature:'0x00' }] }, 12000);
        if (estRes && estRes.maxFee) {
          feeEstimate.maxFee = BigInt(estRes.maxFee);
        }
      } catch(e) {
        feeEstimate.unavailable = true;
        feeEstimate.reason = e.message;
      }

      // ── Step 3: Build final burn intent with fee ────────────────────────────
      var burnIntent = buildBurnIntent(params, v.atomic, feeEstimate.maxFee, (1n << 256n) - 1n, salt);

      var typedData = {
        types: { EIP712Domain: EIP712_DOMAIN, TransferSpec: TRANSFER_SPEC, BurnIntent: BURN_INTENT },
        domain: { name:'GatewayWallet', version:'1' },
        primaryType: 'BurnIntent',
        message: burnIntent,
      };

      // ── Step 4: Request wallet signature ───────────────────────────────────
      emit(STATE.AWAITING_SIGNATURE, { typedData, feeEstimate });
      var signature;
      try {
        signature = await onSign(typedData);
      } catch(e) {
        throw Object.assign(new Error('signature_rejected'), { fatal:true, cause: e.message });
      }
      if (!signature || typeof signature !== 'string' || !signature.startsWith('0x')) {
        throw Object.assign(new Error('invalid_signature'), { fatal:true });
      }

      // ── Step 5: Submit to Gateway API via CF proxy ──────────────────────────
      emit(STATE.SUBMITTING);
      _inflight[lockKey].state = STATE.SUBMITTING;
      var transferRes;
      try {
        transferRes = await postTransfer({
          requests: [{ burnIntent, signature }],
        }, 20000);
      } catch(e) {
        // If submission threw with status 5xx/timeout, do NOT retry automatically
        throw Object.assign(new Error('gateway_submit_error: ' + e.message), {
          fatal: false, // not fatal — may retry with same salt
          cause: e.message,
        });
      }

      var attestationPayload = transferRes && (transferRes.attestationPayload || transferRes.attestation);
      var attestationSig     = transferRes && (transferRes.signature || transferRes.attestationSignature);
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
        throw Object.assign(new Error('wrong_chain_for_mint: expected ' + dstChainId + ' got ' + Number(network.chainId)), { fatal:true });
      }

      var minterContract = new window.ethers.Contract(GW_MINTER, GW_MINTER_ABI, signer);
      var mintTx;
      try {
        mintTx = await minterContract.gatewayMint(attestationPayload, attestationSig);
      } catch(e) {
        throw Object.assign(new Error('mint_tx_failed: ' + e.message), { fatal:false, cause: e.message });
      }

      // ── Step 7: Wait for confirmation ──────────────────────────────────────
      emit(STATE.CONFIRMING, { txHash: mintTx.hash });
      var receipt;
      try {
        receipt = await mintTx.wait(1);
      } catch(e) {
        throw Object.assign(new Error('confirmation_failed: ' + e.message), { fatal:false, txHash: mintTx.hash });
      }

      if (!receipt || receipt.status !== 1) {
        throw Object.assign(new Error('tx_reverted'), { fatal:false, txHash: mintTx.hash });
      }

      // ── Done ────────────────────────────────────────────────────────────────
      var result = {
        ok:       true,
        txHash:   receipt.hash || mintTx.hash,
        salt:     salt,
        token:    params.token,
        amount:   params.amount,
        srcChainId: params.srcChainId,
        dstChainId: params.dstChainId,
        recipient: params.recipient,
      };
      emit(STATE.DONE, result);
      return result;

    } catch(err) {
      var errResult = {
        ok:    false,
        error: err.message,
        salt:  salt,
        fatal: err.fatal !== false, // default fatal=true unless explicitly false
      };
      if (err.txHash) errResult.txHash = err.txHash;
      emit(STATE.ERROR, errResult);
      return errResult;
    } finally {
      delete _inflight[lockKey];
    }
  }

  // ── cancel() — mark an in-flight operation as cancelled ──────────────────────
  function cancel(lockKey) {
    if (lockKey && _inflight[lockKey]) {
      delete _inflight[lockKey];
      return true;
    }
    return false;
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
    strToAtomic,
    atomicToStr,
    padAddr,
    isSupported,
    tokenAddr,
    domainOf,
    decOf,

    // Internal state (read-only view)
    get _inflightCount() { return Object.keys(_inflight).length; },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = GatewaySpendService;
  } else if (typeof window !== 'undefined') {
    window.GatewaySpendService = GatewaySpendService;
  }

})();
