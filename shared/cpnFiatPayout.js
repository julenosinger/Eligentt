/**
 * cpnFiatPayout.js — Circle Payments Network (CPN) Fiat Payout integration
 *
 * Implements the OFI (Originating Financial Institution) side of the CPN workflow:
 *   1. Get quotes      → POST /api/cpn/quotes
 *   2. Create payment  → POST /api/cpn/payments
 *   3. Get tx object   → POST /api/cpn/payments/:id/transactions
 *   4. Submit signed tx → POST /api/cpn/payments/:id/transactions/:txId/submit
 *   5. Poll status     → GET  /api/cpn/payments/:id
 *
 * The browser-side module is stateless: all CPN_API_KEY usage happens server-side
 * in functions/api/cpn/[[route]].mjs. The frontend calls /api/cpn/* via the
 * Cloudflare Pages Function proxy.
 *
 * IMPORTANT: CPN requires Circle OFI onboarding before any live payment can be
 * processed. Without onboarding, quote requests return 403. The UI surfaces this
 * clearly and never silently swallows the error.
 *
 * Reference: https://developers.circle.com/cpn/fiat-payouts
 */
(function () {
  'use strict';

  // ── Supported destination currencies (ISO 4217) ─────────────────────────
  // BFI coverage varies. This list reflects currencies documented in CPN.
  var CPN_CURRENCIES = [
    { code: 'BRL', name: 'Brazilian Real',     flag: '🇧🇷', country: 'BR' },
    { code: 'MXN', name: 'Mexican Peso',        flag: '🇲🇽', country: 'MX' },
    { code: 'EUR', name: 'Euro',                flag: '🇪🇺', country: 'EU' },
    { code: 'GBP', name: 'British Pound',       flag: '🇬🇧', country: 'GB' },
    { code: 'PHP', name: 'Philippine Peso',     flag: '🇵🇭', country: 'PH' },
    { code: 'INR', name: 'Indian Rupee',        flag: '🇮🇳', country: 'IN' },
    { code: 'NGN', name: 'Nigerian Naira',      flag: '🇳🇬', country: 'NG' },
    { code: 'KES', name: 'Kenyan Shilling',     flag: '🇰🇪', country: 'KE' },
    { code: 'GHS', name: 'Ghanaian Cedi',       flag: '🇬🇭', country: 'GH' },
    { code: 'ZAR', name: 'South African Rand',  flag: '🇿🇦', country: 'ZA' },
    { code: 'ARS', name: 'Argentine Peso',      flag: '🇦🇷', country: 'AR' },
    { code: 'CLP', name: 'Chilean Peso',        flag: '🇨🇱', country: 'CL' },
    { code: 'COP', name: 'Colombian Peso',      flag: '🇨🇴', country: 'CO' },
    { code: 'SGD', name: 'Singapore Dollar',    flag: '🇸🇬', country: 'SG' },
    { code: 'THB', name: 'Thai Baht',           flag: '🇹🇭', country: 'TH' },
    { code: 'IDR', name: 'Indonesian Rupiah',   flag: '🇮🇩', country: 'ID' },
    { code: 'PKR', name: 'Pakistani Rupee',     flag: '🇵🇰', country: 'PK' },
    { code: 'TRY', name: 'Turkish Lira',        flag: '🇹🇷', country: 'TR' },
    { code: 'EGP', name: 'Egyptian Pound',      flag: '🇪🇬', country: 'EG' },
    { code: 'UAH', name: 'Ukrainian Hryvnia',   flag: '🇺🇦', country: 'UA' },
  ];

  // ── Payment status machine ──────────────────────────────────────────────
  // CPN statuses → display text + colour key
  var CPN_STATUS_MAP = {
    'PENDING_REVIEW':    { label: 'Pending Review',     color: 'yellow' },
    'PENDING_ONCHAIN':   { label: 'Awaiting Onchain TX', color: 'yellow' },
    'ONCHAIN_SUBMITTED': { label: 'TX Submitted',        color: 'blue'   },
    'ONCHAIN_CONFIRMED': { label: 'TX Confirmed',        color: 'blue'   },
    'FIAT_PENDING':      { label: 'Fiat Settlement',     color: 'teal'   },
    'COMPLETED':         { label: 'Completed',           color: 'green'  },
    'FAILED':            { label: 'Failed',              color: 'red'    },
    'REVERSED':          { label: 'Reversed',            color: 'red'    },
    'CANCELLED':         { label: 'Cancelled',           color: 'muted2' },
  };

  // ── Supported EVM chainIds for CPN onchain transactions ──────────────────
  // CPN only settles USDC on Circle-supported EVM chains. Any chainId outside
  // this set in a TX object from CPN is treated as invalid and rejected before
  // signing — it indicates either a bug or a tampered response.
  var CPN_ALLOWED_CHAIN_IDS = [
    1,      // Ethereum Mainnet
    5042,   // Arc Mainnet
    8453,   // Base Mainnet
    42161,  // Arbitrum One
    10,     // OP Mainnet
    137,    // Polygon PoS
    43114,  // Avalanche C-Chain
  ];

  // ── USDC contract addresses per chainId ──────────────────────────────────
  // CPN fiat payouts settle in USDC. The `to` address in the TX object returned
  // by CPN MUST be the canonical USDC contract for the target chain.
  // Any other `to` address (including a USDC look-alike or bridged token) is
  // rejected before signing — it indicates a tampered or misconfigured response.
  // Source: https://developers.circle.com/stablecoins/docs/usdc-on-main-networks
  var CPN_ALLOWED_USDC_CONTRACTS = {
    1:     '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // Ethereum
    5042:  '0x3600000000000000000000000000000000000000', // Arc Mainnet
    8453:  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // Base
    42161: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // Arbitrum One
    10:    '0x0b2c639c533813f4aa9d7837caf62653d097ff85', // OP Mainnet
    137:   '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', // Polygon PoS
    43114: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', // Avalanche C-Chain
  };

  // ── ERC-20 transfer() function selector ──────────────────────────────────
  // keccak256("transfer(address,uint256)") → 0xa9059cbb
  // CPN USDC transfers MUST use this selector. Any other selector indicates
  // the TX is not a standard ERC-20 transfer and is rejected before signing.
  var ERC20_TRANSFER_SELECTOR = '0xa9059cbb';

  // USDC has 6 decimals. 1 USDC = 1_000_000 (1e6) raw units.
  var USDC_DECIMALS = 6;

  // ── Internal helpers ────────────────────────────────────────────────────

  /**
   * POST/GET /api/cpn/<path> — always via the Pages Function proxy.
   * The proxy injects CPN_API_KEY server-side, never exposing it to the browser.
   * Includes the session cookie automatically (same-origin fetch with credentials).
   */
  async function _cpnFetch(method, path, body) {
    var url = '/api/cpn/' + path.replace(/^\//, '');
    var opts = {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', // sends HttpOnly session cookie
    };
    if (body != null) opts.body = JSON.stringify(body);
    var res = await fetch(url, opts);
    var json;
    try { json = await res.json(); } catch (_) { json = { error: 'Non-JSON response from CPN proxy' }; }
    if (!res.ok) {
      // Surface the real CPN error, e.g. "OFI not onboarded" (403)
      var msg = (json && (json.message || json.error)) || ('CPN API error ' + res.status);
      var err = new Error(msg);
      err.status = res.status;
      err.cpnCode = json && json.code;
      throw err;
    }
    return json;
  }

  // ── Decimal-exact USDC amount conversion ────────────────────────────────
  /**
   * _usdcStringToRaw — converts a human-readable USDC amount string to raw BigInt units
   * (6 decimal places) WITHOUT using parseFloat or binary float arithmetic.
   *
   * Examples:
   *   "100"        → 100000000n
   *   "100.50"     → 100500000n
   *   "0.000001"   → 1n            (1 raw unit — minimum)
   *   "100.1234567" → error        (more than 6 decimal places)
   *   "-5"          → error        (negative)
   *   "0"           → error        (zero not allowed as a payment amount)
   *   "1e3"         → error        (scientific notation rejected)
   *   ""            → error
   *
   * Returns a BigInt on success, or a string error message on failure.
   */
  function _usdcStringToRaw(s) {
    if (typeof s !== 'string') s = String(s);
    s = s.trim();
    // Reject empty, scientific notation, and anything not matching decimal number
    if (!s || /[eE]/.test(s) || !/^-?\d+(\.\d+)?$/.test(s))
      return 'Approved amount is not a valid decimal number (scientific notation not accepted)';
    // Reject negative
    if (s.startsWith('-'))
      return 'Approved amount must be a positive number';
    // Split on decimal point
    var parts = s.split('.');
    var intPart = parts[0] || '0';
    var fracPart = parts.length > 1 ? parts[1] : '';
    // Reject more than USDC_DECIMALS decimal places
    if (fracPart.length > USDC_DECIMALS)
      return 'Approved amount has more than ' + USDC_DECIMALS + ' decimal places — not supported by USDC';
    // Pad fractional part to exactly USDC_DECIMALS digits
    var fracPadded = fracPart.padEnd(USDC_DECIMALS, '0');
    // Combine to integer raw units
    var rawStr = intPart + fracPadded;
    // Remove leading zeros except for a single zero
    rawStr = rawStr.replace(/^0+/, '') || '0';
    var raw;
    try { raw = BigInt(rawStr); } catch (_) {
      return 'Approved amount could not be parsed as an integer after decimal conversion';
    }
    if (raw <= 0n)
      return 'Approved amount must be greater than zero';
    return raw;
  }

  // ── TX validation (before signing) ──────────────────────────────────────
  /**
   * validateTxObject — validates the onchain transaction object returned by CPN
   * against the operation and approval exactly as displayed to the user.
   * Rejects anything that does not match precisely — no tolerances, no silent
   * flexing. If a field cannot be validated, the function rejects with an error;
   * it never returns null when validation is ambiguous.
   *
   * Checks performed (all required):
   *   1. Structural:    transactionId, to (valid checksummed hex address), chainId, data
   *   2. Network:       chainId in CPN_ALLOWED_CHAIN_IDS
   *   3. Contract:      `to` must be exactly the canonical USDC contract for chainId
   *   4. Selector:      data starts with ERC-20 transfer() selector 0xa9059cbb
   *   4b. Length:       calldata long enough for transfer(address,uint256) parameters
   *   5. Recipient:     decoded recipient address from calldata matches approval.recipient
   *                     (checked when approval.recipient is supplied)
   *   6. Amount:        decoded calldata uint256 equals approved raw USDC exactly.
   *                     No tolerance is permitted — even 1 raw unit difference is
   *                     rejected. The caller must supply approval.amount in human-
   *                     readable USDC; the function converts to raw units for comparison.
   *   7. Native value:  any msg.value > 0 wei is rejected for a USDC transfer
   *                     (USDC transfers must send zero native value)
   *   8. From field:    if CPN embeds a `from`, it must match approval.walletAddress
   *
   * @param {object} txObj        raw TX object from CPN
   * @param {object} approval
   *   amount         {number|string} approved USDC amount (human-readable, e.g. "100.00")
   *   walletAddress  {string}        authenticated wallet address (from session)
   *   recipient      {string?}       expected ERC-20 transfer recipient address (optional)
   * @returns {string|null}  error message, or null if ALL checks pass
   */
  function validateTxObject(txObj, approval) {
    if (!txObj || typeof txObj !== 'object') return 'TX object missing or invalid';

    // 1. Required fields
    if (!txObj.transactionId || typeof txObj.transactionId !== 'string')
      return 'TX object missing transactionId';
    if (!txObj.to || typeof txObj.to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(txObj.to))
      return 'TX object has invalid or missing `to` address';
    if (txObj.chainId == null)
      return 'TX object missing chainId';

    // 2. ChainId in allowlist
    var chainId = Number(txObj.chainId);
    if (!Number.isFinite(chainId) || chainId <= 0)
      return 'TX object has invalid chainId: ' + txObj.chainId;
    if (CPN_ALLOWED_CHAIN_IDS.indexOf(chainId) === -1)
      return 'TX object chainId ' + chainId + ' is not an allowed CPN chain';

    // 3. Contract allowlist — `to` must be exactly the canonical USDC contract
    var allowedContract = CPN_ALLOWED_USDC_CONTRACTS[chainId];
    if (!allowedContract)
      return 'No known USDC contract for chainId ' + chainId + ' — cannot validate';
    if (txObj.to.toLowerCase() !== allowedContract.toLowerCase())
      return 'TX object `to` (' + txObj.to + ') is not the USDC contract for chain ' + chainId;

    // 4. Calldata: must be present, valid hex, and start with ERC-20 transfer() selector
    if (!txObj.data || typeof txObj.data !== 'string')
      return 'TX object missing data field (expected ERC-20 transfer calldata)';
    if (!/^0x[0-9a-fA-F]*$/.test(txObj.data))
      return 'TX object data field is not valid hex';
    var dataLow = txObj.data.toLowerCase();
    if (!dataLow.startsWith(ERC20_TRANSFER_SELECTOR))
      return 'TX calldata selector ' + dataLow.slice(0, 10) + ' does not match ERC-20 transfer() (' + ERC20_TRANSFER_SELECTOR + ')';
    // transfer(address,uint256) ABI-encoded: 4 selector + 32 address + 32 amount = 68 bytes
    // hex: 2 (0x) + 8 (selector) + 64 (address padded) + 64 (amount) = 138 chars minimum
    if (txObj.data.length < 138)
      return 'TX calldata too short to contain transfer(address,uint256) parameters';

    // 5. Recipient check: decode the address parameter from calldata (bytes 4–35, zero-padded)
    // calldata layout (hex, after 0x): 8 selector + 64 address_padded + 64 amount
    // address is right-justified in 32 bytes → last 20 bytes = chars 24–63 of the address slot
    var addrSlot = dataLow.slice(2 + 8, 2 + 8 + 64);       // 64 hex chars = 32 bytes
    var decodedRecipient = '0x' + addrSlot.slice(24);        // last 20 bytes = chars 24–63
    // Validate decoded address is well-formed (not zero address, correct length)
    if (decodedRecipient.length !== 42)
      return 'TX calldata recipient address could not be decoded (malformed)';
    if (decodedRecipient === '0x0000000000000000000000000000000000000000')
      return 'TX calldata recipient is the zero address — rejected';
    if (approval && approval.recipient) {
      if (decodedRecipient.toLowerCase() !== approval.recipient.toLowerCase())
        return 'TX calldata recipient (' + decodedRecipient + ') does not match ' +
               'approved recipient (' + approval.recipient + ')';
    }

    // 6. Amount: decode and compare EXACTLY to the approved amount — no tolerance.
    // Uses decimal-exact integer arithmetic (no parseFloat / binary float rounding).
    if (approval && approval.amount != null) {
      try {
        var amountHex64 = dataLow.slice(2 + 8 + 64, 2 + 8 + 64 + 64); // 64 hex chars = 32 bytes
        if (amountHex64.length !== 64)
          return 'TX calldata too short to decode transfer amount';
        var rawAmountBig = BigInt('0x' + amountHex64);
        // ── Decimal-exact conversion: no parseFloat, no binary float rounding ──
        // Converts a human-readable USDC string like "100.50" to raw integer units (6 decimals).
        // Rejects: non-numeric, negative, zero, more than 6 decimal places, ambiguous notation.
        var approvedRaw = _usdcStringToRaw(String(approval.amount));
        if (typeof approvedRaw === 'string') return approvedRaw; // error message
        // EXACT match required — no tolerance. Even 1 raw unit divergence is rejected.
        if (rawAmountBig !== approvedRaw) {
          return 'TX calldata amount (' + rawAmountBig.toString() + ' raw USDC) does not exactly match ' +
                 'approved amount (' + approvedRaw.toString() + ' raw USDC). ' +
                 'No tolerance is permitted.';
        }
      } catch (e) {
        return 'Could not decode transfer amount from calldata: ' + (e && e.message ? e.message : String(e));
      }
    } else {
      // approval.amount is required when calling from a sign path — reject if missing
      // so the caller cannot skip amount validation by omitting the field
      if (approval !== null && approval !== undefined) {
        return 'Approved amount not supplied — cannot validate TX calldata amount';
      }
    }

    // 7. Native value: USDC transfers must send zero native value.
    // Any non-zero value means the TX would also drain native gas — rejected.
    // CRITICAL: no fallback to 0n — a malformed/negative/non-numeric value is rejected
    // rather than silently treated as safe. The caller must supply a parseable value.
    var rawValueStr = txObj.value != null ? String(txObj.value).trim() : null;
    if (rawValueStr === null)
      return 'TX object is missing the `value` field — required for USDC transfer validation';
    if (!/^-?\d+$/.test(rawValueStr))
      return 'TX object `value` field is not a valid integer string: ' + rawValueStr;
    var rawValue;
    try { rawValue = BigInt(rawValueStr); } catch (_) {
      return 'TX object `value` field could not be parsed as BigInt: ' + rawValueStr;
    }
    if (rawValue < 0n)
      return 'TX object `value` is negative (' + rawValue.toString() + ') — rejected';
    if (rawValue > 0n)
      return 'TX object native value (' + rawValue.toString() + ' wei) must be zero for a USDC transfer — exceeds safety limit';

    // 8. From field mismatch
    if (approval && approval.walletAddress) {
      var approvedFrom = (approval.walletAddress || '').toLowerCase();
      if (txObj.from && txObj.from.toLowerCase() !== approvedFrom)
        return 'TX object `from` address does not match authenticated wallet';
    }

    return null; // all checks passed
  }

  /**
   * Validate required beneficiary fields before sending to CPN.
   * Returns null on success or an error string.
   */
  function validateBeneficiary(b) {
    if (!b) return 'Beneficiary data required';
    if (!b.currency || !CPN_CURRENCIES.find(function (c) { return c.code === b.currency; }))
      return 'Select a destination currency';
    if (!b.name || b.name.trim().length < 2) return 'Beneficiary name required (min 2 chars)';
    if (!b.bankName || b.bankName.trim().length < 2) return 'Bank name required';
    if (!b.accountNumber || b.accountNumber.trim().length < 4) return 'Account number required';
    if (!b.countryCode || b.countryCode.length !== 2) return 'Country code required (2-letter ISO)';
    return null;
  }

  /**
   * validateSender — basic sender KYC stub.
   * CPN requires the OFI to have completed KYC. This validates the fields
   * the OFI frontend must collect before calling createPayment.
   */
  function validateSender(s) {
    if (!s) return 'Sender info required';
    if (!s.name || s.name.trim().length < 2) return 'Sender name required';
    if (!s.countryCode || s.countryCode.length !== 2) return 'Sender country code required';
    return null;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * getQuotes — Step 1 of CPN workflow.
   *
   * @param {object} params
   *   amount       {string}  USDC amount as a decimal string e.g. "100.00"
   *   currency     {string}  ISO 4217 destination fiat code e.g. "BRL"
   *   countryCode  {string}  ISO 3166-1 alpha-2 e.g. "BR"
   * @returns {Promise<Array>} Array of quote objects from CPN
   */
  async function getQuotes(params) {
    if (!params || !params.amount) throw new Error('amount required');
    if (!params.currency) throw new Error('currency required');
    var body = {
      amount:      String(params.amount),
      sourceCurrency: 'USD',   // USDC is always USD-denominated
      destinationCurrency: params.currency,
      destinationCountry: params.countryCode || '',
    };
    var data = await _cpnFetch('POST', 'quotes', body);
    // CPN returns { quotes: [...] } — surface the array
    return (data && data.quotes) ? data.quotes : (Array.isArray(data) ? data : []);
  }

  /**
   * createPayment — Step 2 of CPN workflow.
   *
   * @param {object} params
   *   quoteId      {string}  quote.id from getQuotes
   *   amount       {string}  USDC amount
   *   currency     {string}  destination ISO 4217
   *   beneficiary  {object}  { name, bankName, accountNumber, countryCode, routingNumber? }
   *   sender       {object}  { name, countryCode }
   *   idempotencyKey {string} caller-generated UUID
   * @returns {Promise<object>} CPN payment object { id, status, ... }
   */
  async function createPayment(params) {
    var bErr = validateBeneficiary(params.beneficiary);
    if (bErr) throw new Error(bErr);
    var sErr = validateSender(params.sender);
    if (sErr) throw new Error(sErr);

    var body = {
      idempotencyKey: params.idempotencyKey || _cpnUuid(),
      quoteId: params.quoteId,
      amount: { amount: String(params.amount), currency: 'USD' },
      destinationCurrency: params.currency,
      beneficiaryDetails: {
        name: params.beneficiary.name.trim(),
        bankName: params.beneficiary.bankName.trim(),
        accountNumber: params.beneficiary.accountNumber.trim(),
        countryCode: params.beneficiary.countryCode,
        routingNumber: params.beneficiary.routingNumber || undefined,
        bankCode: params.beneficiary.bankCode || undefined,
      },
      senderDetails: {
        name: params.sender.name.trim(),
        countryCode: params.sender.countryCode,
      },
    };
    return _cpnFetch('POST', 'payments', body);
  }

  /**
   * getTransactionObject — Step 3: request the onchain TX to sign.
   *
   * @param {string} paymentId  CPN payment id
   * @param {string} walletAddress  OFI operational wallet address
   * @returns {Promise<object>} { transactionId, to, data, value, chainId, ... }
   */
  async function getTransactionObject(paymentId, walletAddress) {
    if (!paymentId) throw new Error('paymentId required');
    if (!walletAddress) throw new Error('walletAddress required');
    return _cpnFetch('POST', 'payments/' + paymentId + '/transactions', {
      walletAddress: walletAddress,
    });
  }

  /**
   * submitSignedTransaction — Step 4: send the signed tx back to CPN.
   *
   * @param {string} paymentId
   * @param {string} transactionId  from getTransactionObject
   * @param {string} signedTx       raw signed transaction hex
   * @returns {Promise<object>}
   */
  async function submitSignedTransaction(paymentId, transactionId, signedTx) {
    return _cpnFetch('POST',
      'payments/' + paymentId + '/transactions/' + transactionId + '/submit',
      { signedTransaction: signedTx }
    );
  }

  /**
   * getPaymentStatus — Step 5 / polling.
   *
   * @param {string} paymentId
   * @returns {Promise<object>} CPN payment object with latest status
   */
  async function getPaymentStatus(paymentId) {
    return _cpnFetch('GET', 'payments/' + paymentId, null);
  }

  /**
   * pollPaymentStatus — poll until a terminal state or timeout.
   *
   * @param {string}   paymentId
   * @param {Function} onUpdate  called with the payment object on each poll
   * @param {object}   options   { intervalMs=5000, timeoutMs=300000 }
   * @returns {Promise<object>} final payment object
   */
  async function pollPaymentStatus(paymentId, onUpdate, options) {
    var opts = options || {};
    var interval = opts.intervalMs || 5000;
    var timeout  = opts.timeoutMs  || 300000;
    var terminal = ['COMPLETED', 'FAILED', 'REVERSED', 'CANCELLED'];
    var started  = Date.now();
    while (true) {
      var payment = await getPaymentStatus(paymentId);
      if (typeof onUpdate === 'function') onUpdate(payment);
      if (terminal.indexOf(payment.status) !== -1) return payment;
      if (Date.now() - started > timeout) {
        var err = new Error('CPN payment polling timed out for ' + paymentId);
        err.payment = payment;
        throw err;
      }
      await new Promise(function (r) { setTimeout(r, interval); });
    }
  }

  // ── Full OFI execution flow ─────────────────────────────────────────────

  /**
   * executeFiatPayout — orchestrates the full 5-step CPN OFI flow.
   *
   * Steps performed:
   *   1. getQuotes
   *   2. caller selects a quote (quoteSelectionCallback)
   *   3. createPayment
   *   4. getTransactionObject
   *   5. signer signs → submitSignedTransaction
   *   6. pollPaymentStatus
   *
   * @param {object}   params
   *   amount             {string|number}  USDC amount
   *   currency           {string}         destination fiat ISO 4217
   *   beneficiary        {object}
   *   sender             {object}
   *   walletAddress      {string}
   *   signer             {object}         ethers Signer
   *   quoteSelectionCallback {Function}   async (quotes) => selectedQuote
   *   onStatusUpdate     {Function}       (payment) => void — called each poll
   *   onStep             {Function}       (stepName, detail) => void — progress hook
   *
   * @returns {Promise<object>} final CPN payment object
   */
  async function executeFiatPayout(params) {
    var onStep = params.onStep || function () {};

    // ── Fase 1.4: fail fast — the recipient binding is required before any work.
    // The approved recipient is the operation-bound destination disclosed by CPN,
    // NOT the TX object's own data. Without it, a tampered/redirected calldata
    // could never be caught, so we refuse to proceed (and never reach signing).
    if (!params.expectedRecipient) {
      var recErr = new Error('Expected recipient is required before signing — cannot validate TX calldata recipient');
      recErr.code = 'TX_RECIPIENT_REQUIRED';
      throw recErr;
    }

    // ── Step 1: get quotes ─────────────────────────────────────────────
    onStep('quote_fetch', { status: 'fetching' });
    var quotes = await getQuotes({
      amount: String(params.amount),
      currency: params.currency,
      countryCode: params.beneficiary && params.beneficiary.countryCode,
    });
    if (!quotes || quotes.length === 0) throw new Error('No CPN quotes available for ' + params.currency);
    onStep('quote_fetch', { status: 'received', count: quotes.length });

    // ── Step 2: quote selection (caller decides — UI shows a selector) ─
    var selectedQuote = await params.quoteSelectionCallback(quotes);
    if (!selectedQuote) throw new Error('No quote selected');
    onStep('quote_selected', { quoteId: selectedQuote.id, rate: selectedQuote.exchangeRate });

    // ── Step 3: create payment ─────────────────────────────────────────
    onStep('payment_create', { status: 'creating' });
    var payment = await createPayment({
      quoteId:        selectedQuote.id,
      amount:         String(params.amount),
      currency:       params.currency,
      beneficiary:    params.beneficiary,
      sender:         params.sender,
      idempotencyKey: _cpnUuid(),
    });
    onStep('payment_create', { status: 'created', paymentId: payment.id });

    // ── Step 4: get onchain tx object ──────────────────────────────────
    onStep('tx_object', { status: 'requesting' });
    var txObj = await getTransactionObject(payment.id, params.walletAddress);
    onStep('tx_object', { status: 'received', transactionId: txObj.transactionId });

    // ── Step 5a: validate TX object BEFORE signing ────────────────────
    // Never sign an arbitrary TX returned by an API — validate all fields first.
    // expectedRecipient is required (fail-fast check already ran at entry) and is
    // bound to the operation so a tampered/redirected calldata is caught here.
    var txApproval = {
      amount:        params.amount,
      walletAddress: params.walletAddress,
      recipient:     params.expectedRecipient,
    };
    var txErr = validateTxObject(txObj, txApproval);
    if (txErr) {
      var ve = new Error('TX validation failed before signing: ' + txErr);
      ve.code = 'TX_VALIDATION_FAILED';
      throw ve;
    }
    onStep('tx_validated', { transactionId: txObj.transactionId });

    // ── Step 5b: sign the validated transaction ────────────────────────
    // Fase 1.4: no fallback — value was already validated (must be "0" as a valid
    // BigInt). Parse it strictly; an invalid value would have thrown at Step 5a.
    onStep('tx_sign', { status: 'signing' });
    var tx = {
      to:       txObj.to,
      data:     txObj.data || '0x',
      value:    BigInt(txObj.value),
      chainId:  Number(txObj.chainId),
      gasLimit: txObj.gasLimit ? BigInt(txObj.gasLimit) : undefined,
    };
    var signedTx = await params.signer.signTransaction(tx);
    onStep('tx_sign', { status: 'signed' });

    onStep('tx_submit', { status: 'submitting' });
    await submitSignedTransaction(payment.id, txObj.transactionId, signedTx);
    onStep('tx_submit', { status: 'submitted' });

    // ── Step 6: poll until completion ─────────────────────────────────
    onStep('tx_confirm', { status: 'polling' });
    var finalPayment = await pollPaymentStatus(payment.id, function (p) {
      onStep('status_update', { status: p.status, payment: p });
      if (params.onStatusUpdate) params.onStatusUpdate(p);
    });
    onStep('completed', { status: finalPayment.status, payment: finalPayment });
    return finalPayment;
  }

  // ── Utilities ───────────────────────────────────────────────────────────

  /** Generate a v4-like UUID for idempotency keys */
  function _cpnUuid() {
    var d = Date.now();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (d + Math.random() * 16) % 16 | 0;
      d = Math.floor(d / 16);
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  /** Format a CPN status for display */
  function formatStatus(status) {
    return CPN_STATUS_MAP[status] || { label: status || 'Unknown', color: 'muted2' };
  }

  /** Get all supported currencies */
  function getSupportedCurrencies() {
    return CPN_CURRENCIES.slice();
  }

  // ── Export ──────────────────────────────────────────────────────────────
  var CPNFiatPayout = {
    // Core API calls
    getQuotes:                getQuotes,
    createPayment:            createPayment,
    getTransactionObject:     getTransactionObject,
    submitSignedTransaction:  submitSignedTransaction,
    getPaymentStatus:         getPaymentStatus,
    pollPaymentStatus:        pollPaymentStatus,
    // High-level orchestrator
    executeFiatPayout:        executeFiatPayout,
    // Helpers
    validateBeneficiary:      validateBeneficiary,
    validateSender:           validateSender,
    validateTxObject:         validateTxObject,
    formatStatus:             formatStatus,
    getSupportedCurrencies:   getSupportedCurrencies,
    CURRENCIES:               CPN_CURRENCIES,
    STATUS_MAP:               CPN_STATUS_MAP,
    ALLOWED_CHAIN_IDS:        CPN_ALLOWED_CHAIN_IDS,
    ALLOWED_USDC_CONTRACTS:   CPN_ALLOWED_USDC_CONTRACTS,
    ERC20_TRANSFER_SELECTOR:  ERC20_TRANSFER_SELECTOR,
    _usdcStringToRaw:         _usdcStringToRaw,  // exported for testing
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CPNFiatPayout;
  } else {
    window.CPNFiatPayout = CPNFiatPayout;
  }
})();
