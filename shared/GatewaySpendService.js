/**
 * GatewaySpendService — shared infrastructure for Circle Gateway transfers.
 *
 * Implements the official Circle Gateway transfer flow (spec verified Oct 2026):
 *   Ref: https://developers.circle.com/gateway/howtos/transfer-unified-usdc-balance
 *
 *   1.  Validate params (asset, chains, address, amount, decimals).
 *   2.  Check real Gateway balance via /api/gateway/balances.
 *   3.  Build BurnIntent with:
 *         - maxBlockHeight = maxUint256 (per official docs)
 *         - maxFee = conservative per-asset constant (USDC: 2_010000n = 2.01 USDC,
 *                    EURC: 2_010000n, cirBTC: 210000n = 0.0021 cirBTC)
 *         NOTE: Circle does not publish a /v1/estimate endpoint in their official
 *         documentation. The previous implementation's /v1/estimate call was fabricated.
 *         This version uses the documented approach (hardcoded conservative maxFee).
 *         When Circle publishes an official fee-estimation API, update MAX_FEE_ATOMIC.
 *   4.  Sign EIP-712 BurnIntent with the wallet.
 *         - Signature is validated cryptographically (fail-closed: if verifier is
 *           unavailable, execution is blocked).
 *         - Signer must match depositor exactly.
 *         - Fields signed must match intent exactly — intent is frozen after signing.
 *   5.  Submit array of { burnIntent, signature } to /api/gateway/transfer.
 *         → Proxy forwards to Circle /v1/transfer.
 *         → Response: array of { burnIntent, attestation:{payload, signature} }.
 *   6.  Call GatewayMinter.gatewayMint(attestationPayload, sig) on destination chain.
 *   7.  Await receipt status=1; return confirmed result with audit trail.
 *
 * SECURITY INVARIANTS:
 *   - Never auto-executes. Requires explicit user confirmation before step 4.
 *   - Never stores private keys, seeds, or secrets.
 *   - Random 32-byte salt per transfer prevents replay at the protocol level.
 *   - In-browser lock (_inflight) prevents concurrent duplicate submissions in the
 *     same tab session.
 *   - CF proxy (transfer.js) records each salt in GATEWAY_OPS_KV BEFORE forwarding to
 *     Circle. If the salt already exists in KV, the proxy returns 'already_submitted'
 *     (409) and blocks the forward. This provides cross-session replay protection even
 *     after a page reload or browser crash.
 *   - Before submitting, execute() queries GET /api/gateway/transfer?salt=... to check
 *     whether the salt was already recorded in KV (e.g. from a previous crashed session).
 *   - cancel() is refused once the intent has been submitted to Circle.
 *   - Signer verification is MANDATORY and fail-closed: if ethers.verifyTypedData
 *     is not available, execution is blocked with 'sig_verifier_unavailable'.
 *   - BurnIntent is frozen (Object.freeze) before signing; any post-sign mutation
 *     triggers a fatal error.
 *   - All amounts use BigInt arithmetic. No floating-point math on money paths.
 *   - GatewayMinter/GatewayWallet addresses — see MAINNET ADDRESS NOTE below.
 *   - EVM Wallet balance and Gateway balance are kept strictly separate.
 *
 * MAINNET CONTRACT ADDRESS NOTE:
 *   Testnet (from Circle official how-to, Oct 2026):
 *     GatewayWallet  = 0x0077777d7EBA4688BDeF3E311b846F25870A19B9
 *     GatewayMinter  = 0x0022222ABE238Cc2C7Bb1f21003F0a260052475B
 *   Mainnet:
 *     Circle's official transfer how-to does not list mainnet addresses.
 *     GW_WALLET / GW_MINTER below are sourced from config/contracts.js and
 *     the project's consolidated address list. Verify against Circle's published
 *     mainnet deployment docs at https://developers.circle.com/gateway before
 *     any production use. If in doubt, block production until confirmed.
 *
 * PROXY ISOLAMENTO NOTE:
 *   The CF proxy (/api/gateway/transfer) forwards to Circle's permissionless API.
 *   Circle's API does not require authentication — any caller with a valid signed
 *   intent can submit it. This is by design (permissionless). The proxy cannot
 *   enforce "depositor address = authenticated user" without server-side auth that
 *   the current Elligentt architecture does not implement at the proxy layer.
 *   Replay protection is solely at the protocol level: each salt can only be used
 *   once, and the signature commits the signer's address (sourceSigner = depositor).
 *   A malicious caller cannot forge a signature for a different depositor.
 *
 * Operation states:
 *   IDLE → VALIDATING → AWAITING_SIGNATURE → SUBMITTING
 *   → AWAITING_MINT → CONFIRMING → DONE | ERROR
 *
 * Public interface:
 *   GatewaySpendService.prepare(params)                    → { ok, feePreview, ... }
 *   GatewaySpendService.execute(params, onSign, onStatus)  → { ok, txHash, salt, ... }
 *   GatewaySpendService.cancel(lockKey)                    → { ok, reason? }
 *   GatewaySpendService.validateParams(params)             → { ok, error, atomic, ... }
 *   GatewaySpendService.buildBurnIntent(...)               → BurnIntent (frozen)
 *   GatewaySpendService.strToAtomic(str, dec)             → BigInt
 *   GatewaySpendService.atomicToStr(atomic, dec)          → string
 *   GatewaySpendService.isSupported(token, srcDomain, dstDomain) → bool
 *   GatewaySpendService.maxFeeFor(token)                  → BigInt (conservative)
 *   GatewaySpendService.STATE                             object of state constants
 *   GatewaySpendService.SUPPORTED_ASSETS                  array
 */

(function () {
  'use strict';

  if (typeof window !== 'undefined' && window.GatewaySpendService) return;

  // ── Mainnet contract addresses (UNVERIFIED — do not treat as confirmed) ─────
  // arc-studio-allow-onchain-literal
  var GW_WALLET = '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE'; // arc-studio-allow-onchain-literal
  var GW_MINTER = '0x2222222d7164433c4C09B0b0D809a9b52C04C205'; // arc-studio-allow-onchain-literal
  // CAUTION: these addresses are sourced from config/contracts.js and project docs.
  // They are NOT verified against Circle's official mainnet deployment. Circle's
  // official transfer how-to only lists testnet addresses. Confirm mainnet
  // from https://developers.circle.com/gateway before production use.
  // Do not treat these as "verified" — production must block until confirmed.

  // ── Testnet contract addresses (Circle official docs, Oct 2026) ───────────────
  // arc-studio-allow-onchain-literal
  var GW_WALLET_TESTNET = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9'; // arc-studio-allow-onchain-literal
  var GW_MINTER_TESTNET = '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B'; // arc-studio-allow-onchain-literal

  // ── Conservative maxFee per asset ────────────────────────────────────────────
  // Source: Circle Gateway how-to example (MAX_FEE = 2_010000n for USDC).
  // These are CONSERVATIVE upper bounds. Actual fees are lower; maxFee is the
  // ceiling the user authorizes. No /v1/estimate endpoint in official docs.
  var MAX_FEE_ATOMIC = {
    USDC:   2010000n, // 2.01 USDC (6 decimals)
    EURC:   2010000n, // 2.01 EURC (6 decimals)
    cirBTC:    2100n, // 0.000021 cirBTC (8 decimals) — conservative estimate
  };

  // ── Token addresses per (token, chainId) — Circle-published mainnet ─────────
  // arc-studio-allow-onchain-literal
  var TOKEN_ADDR = { // arc-studio-allow-onchain-literal
    USDC: {
      5042:  '0x3600000000000000000000000000000000000000', // Arc mainnet
      1:     '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // Ethereum
      8453:  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base
      42161: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // Arbitrum
      10:    '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', // Optimism
      137:   '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // Polygon
      43114: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', // Avalanche
      1329:  '0x3894085Ef7Ff0f0aeDf52E2A2704928d1Ec074F', // Sei
      10160: '0x078D782b760a79bCdAce91da8A2ED4a1cfef3fdd', // Unichain (unconfirmed — may be stale)
    },
    EURC: {
      5042:  '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1', // Arc mainnet
      1:     '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c', // Ethereum
      8453:  '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', // Base
      43114: '0xc891EB4cbdEFf6e073e859e987815Ed1505c2ACD', // Avalanche
      // World Chain (480): no confirmed address — blocked (no Circle publish as of Oct 2026)
    },
    cirBTC: {
      5042: '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0', // Arc mainnet
      1:    '0x72DFB2E44f59C5AD2bAFE84314E5b99a7cd5075E', // Ethereum
    },
  };

  // ── Domain IDs per chainId (matches CCTP / Gateway domain identifiers) ───────
  var CHAIN_DOMAIN = {
    1:     0,  // Ethereum
    43114: 1,  // Avalanche
    10:    2,  // Optimism
    42161: 3,  // Arbitrum
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
    { token: 'EURC',   dec: 6, domains: [0,1,6,26] }, // 14=World Chain excluded (no confirmed addr Oct 2026)
    { token: 'cirBTC', dec: 8, domains: [0,26] },
  ];

  // ── EIP-712 type definitions (verified against Circle official how-to, Oct 2026) ─
  var EIP712_DOMAIN = [{ name:'name',type:'string' }, { name:'version',type:'string' }];
  var TRANSFER_SPEC = [
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

  // maxUint256 per official docs (maxBlockHeight = maxUint256 = no block expiry)
  var MAX_UINT256 = (1n << 256n) - 1n;

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
    AWAITING_SIGNATURE: 'AWAITING_SIGNATURE',
    SUBMITTING:         'SUBMITTING',
    AWAITING_MINT:      'AWAITING_MINT',
    CONFIRMING:         'CONFIRMING',
    DONE:               'DONE',
    ERROR:              'ERROR',
  });

  // ── In-browser in-flight lock ─────────────────────────────────────────────────
  // lockKey → { state, startedAt, submitted, salt }
  //
  // SCOPE: single browser tab session only. This lock prevents the user from
  // accidentally double-clicking "Confirm" or submitting the same intent twice
  // within the same page load. It does NOT protect against:
  //   - Cross-tab duplicates (use sessionStorage/BroadcastChannel if needed)
  //   - Cross-device / post-reload duplicates (protected at protocol level by salt)
  //   - Server-side race conditions (Circle's API is idempotent per salt+signer)
  //
  // Submitted entries (submitted=true) are retained until explicitly acknowledged
  // by the caller via resolveAmbiguous() or until the tab is closed.
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
    // Node.js fallback (tests only)
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
   * Conservative maxFee for an asset (BigInt atomic units).
   * Per Circle's official how-to: MAX_FEE = 2_010000n for USDC.
   * This is the amount the user pre-authorizes as the maximum fee that Circle
   * may deduct. Actual fees are typically much lower.
   */
  function maxFeeFor(token) {
    var fee = MAX_FEE_ATOMIC[token];
    if (!fee) throw new Error('unsupported_token_maxfee: ' + token);
    return fee;
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
   * Query KV/DO status for a salt before submitting.
   *
   * Returns one of three discriminated results:
   *   { found: false, unavailable: false }   — 404: salt not found, safe to proceed
   *   { found: false, unavailable: true  }   — network error / non-404 HTTP error:
   *                                            query FAILED; caller must decide whether
   *                                            to proceed (risky) or block (safe).
   *   { found: true,  status, ...record  }   — record found; inspect status before submitting
   *
   * The caller MUST NOT treat 'unavailable' as 'not_found'.
   * A failed query does not prove the salt is absent — it proves the query failed.
   */
  async function queryGatewaySalt(salt, depositor, timeoutMs) {
    var ctrl = new AbortController();
    var tid = setTimeout(function(){ ctrl.abort(); }, timeoutMs || 5000);
    try {
      var url = '/api/gateway/transfer?salt=' + encodeURIComponent(salt)
              + '&depositor=' + encodeURIComponent(depositor);
      var res = await fetch(url, { signal: ctrl.signal });
      // 404 = not found — salt is genuinely absent from persistence (safe to proceed)
      if (res.status === 404) return { found: false, unavailable: false };
      // Other non-2xx = query failed (KV down, DO unavailable, auth error, etc.)
      if (!res.ok) return { found: false, unavailable: true, httpStatus: res.status };
      var data = await res.json();
      return { found: true, unavailable: false, ...data };
    } catch(e) {
      // Network error or AbortError — query failed; treat as unavailable, NOT as not_found
      return { found: false, unavailable: true, error: e && e.message };
    } finally {
      clearTimeout(tid);
    }
  }

  /**
   * Update KV status after on-chain confirmation.
   * Returns { ok:true } or { ok:false, status, error } — the caller MUST check the
   * result. Never silently ignores a persistence failure.
   * MUST include depositor so the proxy can verify ownership before accepting the update.
   */
  async function patchGatewaySalt(salt, status, txHash, depositor) {
    var dep = depositor || '';
    try {
      var res = await fetch(
        '/api/gateway/transfer?salt=' + encodeURIComponent(salt)
        + (dep ? '&depositor=' + encodeURIComponent(dep) : ''),
        {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ status, txHash: txHash || null }),
        }
      );
      var data = null;
      try { data = await res.json(); } catch(_) { data = null; }
      if (!res.ok) {
        return { ok: false, status: res.status, error: (data && data.error) || 'patch_failed' };
      }
      return { ok: true, data };
    } catch(e) {
      return { ok: false, error: e && e.message ? e.message : 'network_error' };
    }
  }

  /**
   * confirmGatewaySalt — calls POST /api/gateway/transfer/confirm for server-side
   * RPC verification before writing 'confirmed' or 'failed'.
   * The proxy independently verifies the receipt on-chain.
   * Returns { ok:true, status } or { ok:false, error, recoverable }.
   * If RPC is not configured (503) the record stays at 'accepted' (safe).
   */
  async function confirmGatewaySalt(salt, txHash, depositor, dstChainId) {
    try {
      var res = await fetch('/api/gateway/transfer/confirm', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ salt, txHash, depositor, dstChainId }),
      });
      var data = null;
      try { data = await res.json(); } catch(_) { data = null; }
      if (res.ok) return { ok: true, status: (data && data.status) || 'confirmed', data };
      // 503 = RPC not configured — safe fallback: record stays at 'accepted'
      // 422 = chain not supported for confirm — same fallback
      // 404 = tx not mined yet — recoverable
      return {
        ok:          false,
        error:       (data && data.error) || 'confirm_failed',
        httpStatus:  res.status,
        recoverable: res.status === 503 || res.status === 422 || res.status === 404,
        data,
      };
    } catch(e) {
      return { ok: false, error: e && e.message ? e.message : 'network_error', recoverable: true };
    }
  }

  /**
   * POST to /api/gateway/transfer CF proxy (transfer only — no estimate endpoint).
   * Official /v1/transfer request: array of { burnIntent, signature }.
   */
  async function postGatewayTransfer(payload, timeoutMs) {
    var ctrl = new AbortController();
    var tid = setTimeout(function(){ ctrl.abort(); }, timeoutMs || 20000);
    try {
      var res = await fetch('/api/gateway/transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload, function(_k, v) {
          return typeof v === 'bigint' ? v.toString() : v;
        }),
        signal: ctrl.signal,
      });
      var data = await res.json();
      if (!res.ok) throw Object.assign(
        new Error(data.error || 'gateway_api_error'),
        { status: res.status, data }
      );
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

  // ── Build burn intent (unsigned, frozen) ──────────────────────────────────────

  /**
   * Build a BurnIntent object per the official Circle spec.
   * The returned object is frozen — any subsequent mutation throws in strict mode.
   *
   * Per Circle docs:
   *   maxBlockHeight = maxUint256 (no block expiry)
   *   maxFee         = conservative constant (2_010000n for USDC/EURC, caller provides)
   *   spec.version   = 1
   *   addresses are padded to bytes32
   *   destinationCaller = zeroAddress (permissionless mint on destination)
   */
  function buildBurnIntent(params, atomic, maxFee, salt) {
    var srcChainId = Number(params.srcChainId);
    var dstChainId = Number(params.dstChainId);
    var token      = params.token;
    var depositor  = params.depositor.toLowerCase();
    var recipient  = params.recipient.toLowerCase();

    var intent = {
      maxBlockHeight: MAX_UINT256,
      maxFee:         maxFee,
      spec: Object.freeze({
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
      }),
    };
    return Object.freeze(intent);
  }

  // ── Signature verification (fail-closed) ─────────────────────────────────────

  /**
   * Verify an EIP-712 signature against the BurnIntent.
   *
   * FAIL-CLOSED: if the verifier (ethers.verifyTypedData) is not available,
   * this function throws 'sig_verifier_unavailable' — execution is BLOCKED.
   * This prevents bypassing signature validation in environments where ethers
   * is not loaded.
   *
   * Throws on any failure — never returns false silently.
   */
  function verifyBurnIntentSignature(burnIntent, typedData, signature, expectedDepositor) {
    // Determine the verifier — prefer injected (for tests), then window.ethers
    var verifyFn = null;
    if (typeof globalThis !== 'undefined' && globalThis._gwVerifyTypedData) {
      verifyFn = globalThis._gwVerifyTypedData;
    } else if (typeof window !== 'undefined' && window.ethers && window.ethers.verifyTypedData) {
      verifyFn = window.ethers.verifyTypedData.bind(window.ethers);
    }

    if (!verifyFn) {
      throw Object.assign(
        new Error('sig_verifier_unavailable: ethers.verifyTypedData not loaded'),
        { fatal:true }
      );
    }

    var recovered;
    try {
      recovered = verifyFn(
        typedData.domain,
        { TransferSpec: TRANSFER_SPEC, BurnIntent: BURN_INTENT },
        burnIntent,
        signature
      );
    } catch(e) {
      // Recovery itself threw — treat as invalid signature, never skip
      throw Object.assign(
        new Error('sig_recovery_failed: ' + e.message),
        { fatal:true }
      );
    }

    if (!recovered || typeof recovered !== 'string') {
      throw Object.assign(
        new Error('sig_recovery_returned_invalid'),
        { fatal:true }
      );
    }

    if (recovered.toLowerCase() !== expectedDepositor.toLowerCase()) {
      throw Object.assign(
        new Error('signer_mismatch: expected ' + expectedDepositor + ' got ' + recovered),
        { fatal:true }
      );
    }
  }

  // ── prepare() — validate + balance check + fee preview ───────────────────────

  /**
   * Validates params, checks Gateway balance, returns fee preview.
   * Does NOT sign, submit, or create a lock.
   * Returns { ok, feePreview, balance, ... } or { ok:false, error }.
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

    var fee = maxFeeFor(params.token);

    return {
      ok:         true,
      balance:    gwBal,
      feePreview: {
        maxFee:          fee,
        maxFeeFormatted: atomicToStr(fee, v.dec),
        token:           params.token,
        note:            'Pre-authorized ceiling per Circle docs (MAX_FEE = 2_010000 for USDC). This is NOT a real-time fee quote. Circle deducts the actual fee (typically lower) and returns the remainder.',
      },
      atomic:     v.atomic,
      dec:        v.dec,
      srcDomain:  v.srcDomain,
      dstDomain:  v.dstDomain,
    };
  }

  // ── execute() — full transfer flow ───────────────────────────────────────────

  /**
   * Full transfer: validate → balance-check → build intent → sign → verify →
   * submit → mint → confirm.
   *
   * P0 INVARIANTS:
   *   1. maxFee is a documented conservative constant — never zero, never guessed.
   *   2. Signer verification is MANDATORY and fail-closed.
   *   3. BurnIntent is frozen before signing — cannot be mutated after.
   *   4. If submission throws (5xx/timeout), the result is 'gateway_submit_ambiguous'
   *      with the salt. The lock (submitted=true) is retained — caller must check
   *      Circle status before retrying with a new intent.
   *   5. cancel() is refused once submitted=true.
   *
   * @param {object}   params    { token, srcChainId, dstChainId, amount, depositor, recipient }
   * @param {function} onSign    async (typedData) => signature:string — must be wallet.signTypedData
   * @param {function} onStatus  (state, detail) => void
   * @returns {object} { ok, txHash, salt, ... }
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

    // In-browser duplicate-submission guard (same tab session)
    var lockKey = [params.token, params.srcChainId, params.dstChainId,
                   params.depositor, params.amount].join(':');

    if (_inflight[lockKey]) {
      var existing = _inflight[lockKey];
      emit(STATE.ERROR, { error:'duplicate_in_flight' });
      if (existing.submitted) {
        return { ok:false, error:'duplicate_in_flight', ambiguous:true, salt: existing.salt };
      }
      return { ok:false, error:'duplicate_in_flight' };
    }

    var salt = randomSalt();
    _inflight[lockKey] = { state: STATE.VALIDATING, startedAt: Date.now(), submitted: false, salt };

    // Track whether we reach the submitted state, for the finally cleanup
    var reachedSubmitted = false;

    try {
      // ── Step 1: Balance check ───────────────────────────────────────────────
      emit(STATE.VALIDATING, { step:'balance_check' });
      var gwBal = await fetchGatewayBalance(params.token, v.srcDomain, params.depositor, 10000);
      if (gwBal === null) throw Object.assign(
        new Error('rpc_unavailable_balance_check'), { fatal:true }
      );
      var balAtomic = strToAtomic(gwBal, v.dec);
      if (v.atomic > balAtomic) throw Object.assign(
        new Error('insufficient_gateway_balance'),
        { fatal:true, balance: gwBal }
      );

      // ── Step 2: Build frozen BurnIntent ────────────────────────────────────
      var maxFee     = maxFeeFor(params.token);
      var burnIntent = buildBurnIntent(params, v.atomic, maxFee, salt);
      // burnIntent is Object.freeze'd — any mutation throws in strict mode

      var typedData = {
        types: { EIP712Domain: EIP712_DOMAIN, TransferSpec: TRANSFER_SPEC, BurnIntent: BURN_INTENT },
        domain: { name:'GatewayWallet', version:'1' },
        primaryType: 'BurnIntent',
        message: burnIntent,
      };

      // ── Step 3: Request wallet signature ───────────────────────────────────
      emit(STATE.AWAITING_SIGNATURE, { typedData, maxFee, maxFeeFormatted: atomicToStr(maxFee, v.dec) });
      _inflight[lockKey].state = STATE.AWAITING_SIGNATURE;

      var signature;
      try {
        signature = await onSign(typedData);
      } catch(e) {
        throw Object.assign(new Error('signature_rejected: ' + e.message), { fatal:true });
      }

      // Basic format guard
      if (!signature || typeof signature !== 'string' || !signature.startsWith('0x')) {
        throw Object.assign(new Error('invalid_signature: not a hex string'), { fatal:true });
      }
      var sigHex = signature.slice(2);
      if (sigHex.length < 130) {
        throw Object.assign(
          new Error('invalid_signature: too short (' + sigHex.length + ' hex chars, need >=130)'),
          { fatal:true }
        );
      }

      // ── Step 4: Cryptographic signature verification (FAIL-CLOSED) ─────────
      // This throws if:
      //   a) ethers.verifyTypedData is not available  → sig_verifier_unavailable
      //   b) recovery fails                           → sig_recovery_failed
      //   c) recovered address != depositor           → signer_mismatch
      // There is NO fallback — block if verifier is unavailable.
      verifyBurnIntentSignature(burnIntent, typedData, signature, params.depositor);

      // ── Step 5a: KV/DO pre-submit check (cross-session replay guard) ─────────
      // Query whether this salt was already submitted in a previous session.
      //
      // Three outcomes from queryGatewaySalt():
      //   found:false + unavailable:false  → 404: genuinely new salt, safe to proceed
      //   found:false + unavailable:true   → query FAILED (KV/DO down or network error)
      //                                       Block with 'kv_query_unavailable'.
      //                                       Do NOT treat as 'not found' — we cannot
      //                                       confirm the salt is absent.
      //   found:true                       → record exists; inspect status
      emit(STATE.SUBMITTING);
      _inflight[lockKey].state = STATE.SUBMITTING;

      var kvRecord = await queryGatewaySalt(salt, params.depositor, 5000);

      // Query failed — block (fail-safe): cannot confirm salt is new
      if (kvRecord.unavailable) {
        throw Object.assign(
          new Error('kv_query_unavailable: persistence check failed — cannot confirm salt is new'),
          { fatal:true, salt, recoverable:false }
        );
      }

      if (kvRecord.found && kvRecord.status) {
        reachedSubmitted = true;
        _inflight[lockKey].submitted = true;
        _inflight[lockKey].state     = STATE.ERROR;
        if (kvRecord.status === 'confirmed') {
          throw Object.assign(
            new Error('already_confirmed: salt was already minted on-chain'),
            { fatal:true, salt, recoverable:false }
          );
        }
        if (kvRecord.status === 'accepted' ||
            kvRecord.status === 'submitting' ||
            kvRecord.status === 'ambiguous') {
          throw Object.assign(
            new Error('gateway_submit_ambiguous: salt exists in KV with status ' + kvRecord.status),
            { fatal:false, salt, recoverable:true, kvStatus: kvRecord.status }
          );
        }
        // "rejected" status — Circle definitively refused. Safe to retry with NEW salt.
        throw Object.assign(
          new Error('salt_was_rejected: previous submission rejected — generate new intent'),
          { fatal:false, salt, recoverable:false }
        );
      }
      // kvRecord.found === false AND unavailable === false → 404, genuinely new, proceed

      // ── Step 5b: Submit to Gateway API ─────────────────────────────────────
      var transferRes;
      var submitError;
      try {
        transferRes = await postGatewayTransfer([{ burnIntent, signature }], 20000);
      } catch(e) {
        submitError = e;
      }

      if (submitError) {
        // P0: Ambiguous — Circle may or may not have accepted the intent.
        // Mark submitted=true so cancel() is blocked.
        // Return recoverable error with salt — caller must check Circle status.
        reachedSubmitted = true;
        _inflight[lockKey].submitted = true;
        _inflight[lockKey].state     = STATE.ERROR;
        throw Object.assign(
          new Error('gateway_submit_ambiguous: ' + submitError.message),
          { fatal:false, salt, recoverable:true }
        );
      }

      // Circle confirmed acceptance — mark submitted
      reachedSubmitted = true;
      _inflight[lockKey].submitted = true;

      // ── Step 6: Extract attestation ────────────────────────────────────────
      var attestationPayload = null;
      var attestationSig     = null;

      if (Array.isArray(transferRes) && transferRes.length > 0) {
        var firstRes = transferRes[0];
        if (firstRes && firstRes.attestation) {
          attestationPayload = firstRes.attestation.payload
                            || firstRes.attestation.attestationPayload;
          attestationSig     = firstRes.attestation.signature
                            || firstRes.attestation.attestationSignature;
        }
        if (!attestationPayload && firstRes && firstRes.burnIntent) {
          attestationPayload = firstRes.burnIntent.attestationPayload;
          attestationSig     = firstRes.burnIntent.signature
                            || firstRes.burnIntent.attestationSignature;
        }
      }
      if (!attestationPayload && transferRes && !Array.isArray(transferRes)) {
        attestationPayload = transferRes.attestationPayload || transferRes.attestation;
        attestationSig     = transferRes.signature || transferRes.attestationSignature;
      }

      if (!attestationPayload || !attestationSig) {
        throw Object.assign(new Error('invalid_attestation_response'), { fatal:true });
      }

      // ── Step 7: Call GatewayMinter.gatewayMint on destination ──────────────
      emit(STATE.AWAITING_MINT, { attestationPayload, salt });
      var provider = (typeof window !== 'undefined') &&
                     (window.ethereum || (window.ethers && window.ethers.providers));
      if (!provider) throw Object.assign(new Error('no_wallet_provider'), { fatal:true });

      var ethersProvider = new window.ethers.BrowserProvider(provider);
      var signer = await ethersProvider.getSigner();

      // Verify the signer is on the correct destination chain
      var network    = await ethersProvider.getNetwork();
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

      // ── Step 8: Wait for confirmation ──────────────────────────────────────
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
        // Transition: accepted → failed.
        // Fase 2.1: use server-side /confirm endpoint so the proxy can independently
        // verify the revert on-chain (RPC receipt check). The client's receipt is used
        // as a hint, but the server re-fetches and verifies independently.
        // If confirmGatewaySalt fails, the record stays at 'accepted' (safe — blocks
        // re-submission). Surface the failure so the caller can reconcile manually.
        var failedPersist = await confirmGatewaySalt(salt, mintTx.hash, params.depositor, params.dstChainId);
        throw Object.assign(
          new Error('tx_reverted'),
          { fatal:false, txHash: mintTx.hash, persist: failedPersist }
        );
      }

      // ── Transition: accepted → confirmed ────────────────────────────────────
      // Fase 2.1: use server-side /confirm endpoint. The proxy independently calls
      // eth_getTransactionReceipt via GATEWAY_RPC_URLS env binding and verifies:
      //   - receipt exists on the correct chain
      //   - receipt.to === GatewayMinter for that chain
      //   - receipt.status === 0x1 (success)
      // Client-provided txHash is verified server-side — client cannot fabricate status.
      // If confirmGatewaySalt fails (RPC unavailable, etc.), the record stays at
      // 'accepted' (safe — blocks re-submission). Surface the warning; mint is valid.
      var confirmPersist = await confirmGatewaySalt(salt, receipt.hash || mintTx.hash, params.depositor, params.dstChainId);

      // ── Done ────────────────────────────────────────────────────────────────
      var result = {
        ok:         true,
        txHash:     receipt.hash || mintTx.hash,
        salt,
        token:      params.token,
        amount:     params.amount,
        srcChainId: params.srcChainId,
        dstChainId: params.dstChainId,
        recipient:  params.recipient,
        maxFee,
        persist:    confirmPersist,
      };
      if (!confirmPersist.ok) result.persistenceWarning = true;
      emit(STATE.DONE, result);
      return result;

    } catch(err) {
      var errResult = {
        ok:    false,
        error: err.message,
        salt,
        fatal: err.fatal !== false,
      };
      if (err.txHash)      errResult.txHash      = err.txHash;
      if (err.recoverable) errResult.recoverable = true;
      emit(STATE.ERROR, errResult);
      // Only delete lock if NOT submitted (ambiguous or fully committed)
      if (!reachedSubmitted) {
        delete _inflight[lockKey];
      }
      return errResult;

    } finally {
      // Success path: reachedSubmitted=true but we returned ok:true (not via catch).
      // The catch path handles all error cases. The finally only runs after the
      // success path's `return result`. At that point, submitted=true and we should
      // clean up — the transfer completed successfully.
      // Ambiguous path: submitted=true + catch returned early → lock retained.
      // Check: if lock exists AND submitted=true AND we exited via the success return
      // (no errResult), clean up.
      if (_inflight[lockKey] && _inflight[lockKey].submitted) {
        // The state was not set to ERROR by the ambiguous path — clean up.
        if (_inflight[lockKey].state !== STATE.ERROR) {
          delete _inflight[lockKey];
        }
        // Otherwise leave it (ambiguous — caller must resolveAmbiguous).
      }
    }
  }

  // ── cancel() ─────────────────────────────────────────────────────────────────

  /**
   * Cancel an in-flight operation.
   * Refused if submitted=true (Circle may have accepted the intent).
   */
  function cancel(lockKey) {
    if (!lockKey || !_inflight[lockKey]) return { ok:false, reason:'not_found' };
    if (_inflight[lockKey].submitted) return { ok:false, reason:'already_submitted' };
    delete _inflight[lockKey];
    return { ok:true };
  }

  /**
   * Acknowledge and release an ambiguous submission lock.
   * Call this ONLY after verifying on-chain that the transfer was NOT minted,
   * or after Circle confirms the intent was rejected. Do not call blindly.
   */
  function resolveAmbiguous(lockKey, wasCompleted) {
    if (!lockKey || !_inflight[lockKey]) return { ok:false, reason:'not_found' };
    if (!_inflight[lockKey].submitted)   return { ok:false, reason:'not_submitted' };
    var entry = _inflight[lockKey];
    delete _inflight[lockKey];
    return { ok:true, salt: entry.salt, wasCompleted };
  }

  // ── Public API ────────────────────────────────────────────────────────────────
  var GatewaySpendService = {
    STATE,
    SUPPORTED_ASSETS,
    GW_WALLET,
    GW_MINTER,
    GW_WALLET_TESTNET,
    GW_MINTER_TESTNET,

    // Core methods
    prepare,
    execute,
    cancel,
    resolveAmbiguous,

    // Utilities
    validateParams,
    buildBurnIntent,
    strToAtomic,
    atomicToStr,
    padAddr,
    isSupported,
    tokenAddr,
    domainOf,
    decOf,
    maxFeeFor,
    queryGatewaySalt,
    patchGatewaySalt,
    confirmGatewaySalt,

    // Internal state (read-only)
    get _inflightCount() { return Object.keys(_inflight).length; },
    _getInflight(key) { return _inflight[key] || null; },
  };

  // TEST ONLY — never call in production code
  if (typeof process !== 'undefined' && process.env && process.env.NODE_ENV !== 'production') {
    GatewaySpendService._testClearInflight = function() {
      Object.keys(_inflight).forEach(function(k){ delete _inflight[k]; });
    };
    GatewaySpendService._testSetVerifier = function(fn) {
      if (typeof globalThis !== 'undefined') globalThis._gwVerifyTypedData = fn;
    };
    GatewaySpendService._testClearVerifier = function() {
      if (typeof globalThis !== 'undefined') delete globalThis._gwVerifyTypedData;
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = GatewaySpendService;
  } else if (typeof window !== 'undefined') {
    window.GatewaySpendService = GatewaySpendService;
  }

})();
