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

  // ── Internal helpers ────────────────────────────────────────────────────

  /**
   * POST/GET /api/cpn/<path> — always via the Pages Function proxy.
   * The proxy injects CPN_API_KEY server-side, never exposing it to the browser.
   */
  async function _cpnFetch(method, path, body) {
    var url = '/api/cpn/' + path.replace(/^\//, '');
    var opts = {
      method: method,
      headers: { 'Content-Type': 'application/json' },
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

    // ── Step 5: sign and submit ────────────────────────────────────────
    onStep('tx_sign', { status: 'signing' });
    // Build the tx from the CPN object
    var tx = {
      to:       txObj.to,
      data:     txObj.data,
      value:    txObj.value   ? BigInt(txObj.value) : 0n,
      chainId:  txObj.chainId ? Number(txObj.chainId) : undefined,
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
    formatStatus:             formatStatus,
    getSupportedCurrencies:   getSupportedCurrencies,
    CURRENCIES:               CPN_CURRENCIES,
    STATUS_MAP:               CPN_STATUS_MAP,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CPNFiatPayout;
  } else {
    window.CPNFiatPayout = CPNFiatPayout;
  }
})();
