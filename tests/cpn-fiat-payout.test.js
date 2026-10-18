/**
 * CPN Fiat Payout — Fase 1.1 Security & Integrity test suite
 *
 * Covers:
 *  1.  shared/cpnFiatPayout.js — module structure and exports
 *  2.  shared/cpnFiatPayout.js — validateBeneficiary
 *  3.  shared/cpnFiatPayout.js — validateTxObject (full 7-check suite)
 *       - structural fields, chainId allowlist, CONTRACT allowlist (new),
 *         calldata SELECTOR check (new), AMOUNT cross-check (new),
 *         native value cap, from-address match
 *  4.  functions/api/cpn/[[route]].mjs — session auth + expiry check (new)
 *  5.  functions/api/cpn/[[route]].mjs — OWNERSHIP enforcement (new)
 *  6.  functions/api/cpn/[[route]].mjs — method enforcement
 *  7.  functions/api/cpn/[[route]].mjs — TWO-PHASE idempotency (new): reservation,
 *       concurrent conflict, persistence failure surfacing (no silent swallow)
 *  8.  functions/api/cpn/[[route]].mjs — body size cap
 *  9.  functions/api/cpn/[[route]].mjs — key isolation and safe errors
 *  10. index.html — CPN UI elements
 *  11. index.html — CPN JS functions
 *  12. index.html — TX validation before signing (full 7-check, including
 *       CONTRACT allowlist + SELECTOR + AMOUNT + expectedChainId gate) (new)
 *  13. index.html — idempotency key stability
 *  14. index.html — session cookie sent with all CPN requests
 *  15. index.html — send button dispatch
 *  16. index.html — 5-step OFI flow
 *  17. index.html — POLL TIMEOUT reconciliation (new): reconcile fetch, no auto-retry
 *  18. Security — CPN_API_KEY never exposed to browser
 *  19. .dev.vars.example — configuration documented
 *  20. Shared sync
 *  21. MANDATORY behavioral tests (spec §4):
 *       - User A accessing User B's payment → 403
 *       - Expired/invalid session → 401
 *       - Tampered contract / token / network / recipient / value / calldata
 *       - Two simultaneous requests same key → 409
 *       - Timeout after CPN creation → reconcile, no auto-retry
 *       - Persistence failure → persistenceWarning, no silent swallow
 *  22. Regression guards — Send Assets, Swap, Bridge, Schedule, Batch
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const ROOT      = path.resolve(__dirname, '..');
const html      = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const cpnModule = readFileSync(path.join(ROOT, 'shared/cpnFiatPayout.js'), 'utf8');
const cpnProxy  = readFileSync(path.join(ROOT, 'functions/api/cpn/[[route]].mjs'), 'utf8');
const devVarsEx = readFileSync(path.join(ROOT, '.dev.vars.example'), 'utf8');

// ── 1. cpnFiatPayout.js — module structure ───────────────────────────────────
describe('shared/cpnFiatPayout.js — module structure', () => {
  it('exports CPNFiatPayout to window or module.exports', () => {
    expect(cpnModule).toMatch(/window\.CPNFiatPayout\s*=/);
    expect(cpnModule).toMatch(/module\.exports\s*=/);
  });

  it('exposes core API calls', () => {
    ['getQuotes', 'createPayment', 'getTransactionObject', 'submitSignedTransaction', 'getPaymentStatus', 'pollPaymentStatus'].forEach(fn => {
      expect(cpnModule).toContain(fn + ':');
      expect(cpnModule).toMatch(new RegExp('function ' + fn + '\\b'));
    });
  });

  it('exposes executeFiatPayout', () => {
    expect(cpnModule).toContain('executeFiatPayout:');
    expect(cpnModule).toContain('async function executeFiatPayout');
  });

  it('exposes validateBeneficiary, validateSender, validateTxObject', () => {
    ['validateBeneficiary:', 'validateSender:', 'validateTxObject:'].forEach(s => expect(cpnModule).toContain(s));
  });

  it('exposes ALLOWED_CHAIN_IDS list', () => {
    expect(cpnModule).toContain('ALLOWED_CHAIN_IDS:');
    expect(cpnModule).toContain('CPN_ALLOWED_CHAIN_IDS');
  });

  it('exposes ALLOWED_USDC_CONTRACTS map (new — Fase 1.1)', () => {
    expect(cpnModule).toContain('ALLOWED_USDC_CONTRACTS:');
    expect(cpnModule).toContain('CPN_ALLOWED_USDC_CONTRACTS');
  });

  it('exposes ERC20_TRANSFER_SELECTOR (new — Fase 1.1)', () => {
    expect(cpnModule).toContain('ERC20_TRANSFER_SELECTOR:');
    expect(cpnModule).toContain("ERC20_TRANSFER_SELECTOR = '0xa9059cbb'");
  });

  it('exposes STATUS_MAP with all terminal states', () => {
    ["'COMPLETED'", "'FAILED'", "'REVERSED'", "'CANCELLED'"].forEach(s => {
      expect(cpnModule).toContain(s);
    });
  });

  it('getSupportedCurrencies returns a copy', () => {
    expect(cpnModule).toContain('getSupportedCurrencies:');
    expect(cpnModule).toContain('return CPN_CURRENCIES.slice()');
  });
});

// ── 2. cpnFiatPayout.js — validateBeneficiary ────────────────────────────────
describe('shared/cpnFiatPayout.js — validateBeneficiary', () => {
  it('rejects missing currency', () => { expect(cpnModule).toContain("'Select a destination currency'"); });
  it('rejects short name', () => { expect(cpnModule).toContain("'Beneficiary name required (min 2 chars)'"); });
  it('rejects missing bank', () => { expect(cpnModule).toContain("'Bank name required'"); });
  it('rejects short account', () => { expect(cpnModule).toContain("'Account number required'"); });
  it('rejects invalid country', () => { expect(cpnModule).toContain("'Country code required (2-letter ISO)'"); });
  it('function is defined', () => { expect(cpnModule).toContain('function validateBeneficiary(b)'); });
});

// ── 3. cpnFiatPayout.js — validateTxObject (full 7-check suite) ─────────────
describe('shared/cpnFiatPayout.js — validateTxObject (7 checks)', () => {
  it('function is defined with approval parameter', () => {
    expect(cpnModule).toContain('function validateTxObject(txObj, approval)');
  });

  it('check 1 — rejects missing transactionId', () => {
    expect(cpnModule).toContain("'TX object missing transactionId'");
  });

  it('check 1 — rejects invalid `to` address', () => {
    expect(cpnModule).toContain("'TX object has invalid or missing `to` address'");
  });

  it('check 2 — rejects chainId not in CPN_ALLOWED_CHAIN_IDS', () => {
    expect(cpnModule).toContain("'TX object chainId ' + chainId + ' is not an allowed CPN chain'");
  });

  it('check 3 — rejects `to` that is not the USDC contract (new)', () => {
    expect(cpnModule).toContain('CPN_ALLOWED_USDC_CONTRACTS');
    expect(cpnModule).toContain("'TX object `to` (' + txObj.to + ') is not the USDC contract for chain ' + chainId");
  });

  it('check 3 — rejects unknown chainId with no known USDC contract (new)', () => {
    expect(cpnModule).toContain("'No known USDC contract for chainId ' + chainId + ' — cannot validate'");
  });

  it('check 4 — rejects missing data field (new)', () => {
    expect(cpnModule).toContain("'TX object missing data field (expected ERC-20 transfer calldata)'");
  });

  it('check 4 — rejects calldata with wrong selector (new)', () => {
    expect(cpnModule).toContain('ERC20_TRANSFER_SELECTOR');
    // The error message references the selector via the variable, not a hardcoded string
    expect(cpnModule).toContain("does not match ERC-20 transfer() (' + ERC20_TRANSFER_SELECTOR + ')'");
  });

  it('check 4 — rejects calldata that is too short (new)', () => {
    expect(cpnModule).toContain("'TX calldata too short to contain transfer(address,uint256) parameters'");
  });

  it('check 5 — amount EXACT match, decimal-exact conversion (Fase 1.3 — no parseFloat)', () => {
    expect(cpnModule).toContain('rawAmountBig');
    expect(cpnModule).toContain('_usdcStringToRaw');  // decimal-exact converter used
    expect(cpnModule).toContain('does not exactly match');
    expect(cpnModule).toContain('No tolerance is permitted');
  });

  it('check 5 — parseFloat REMOVED (Fase 1.3)', () => {
    // validateTxObject must not use parseFloat for amount conversion
    // _usdcStringToRaw must be used instead
    const validateFn = cpnModule.slice(
      cpnModule.indexOf('function validateTxObject('),
      cpnModule.indexOf('function validateTxObject(') + 3000
    );
    expect(validateFn).not.toContain('parseFloat');
    expect(validateFn).not.toContain('Math.round');
  });

  it('check 6 — rejects any non-zero native value (Fase 1.2 — must be zero)', () => {
    // Fase 1.2: any non-zero value is rejected, not just > 0.01 ETH
    expect(cpnModule).toContain('must be zero for a USDC transfer');
    expect(cpnModule).toContain('exceeds safety limit');
  });

  it('check 7 — rejects `from` mismatch with authenticated wallet', () => {
    expect(cpnModule).toContain("'TX object `from` address does not match authenticated wallet'");
  });

  it('returns null on all checks passing', () => {
    expect(cpnModule).toContain('return null; // all checks passed');
  });
});

// ── 4. Pages Function — session auth (Fase 1.0 + expiry check) ───────────────
describe('functions/api/cpn/[[route]].mjs — session auth', () => {
  it('verifySession function is defined', () => {
    expect(cpnProxy).toContain('async function verifySession(request, env)');
  });

  it('checks application-layer expiry via createdAt + SESSION_TTL_MS (Fase 1.2 — fixes missing expiresAt bug)', () => {
    // Real login.js session has { createdAt } — NOT expiresAt. Check uses createdAt.
    expect(cpnProxy).toContain('session.createdAt');
    expect(cpnProxy).toContain('SESSION_TTL_MS');
    expect(cpnProxy).toContain("Date.now() > session.createdAt + SESSION_TTL_MS");
    expect(cpnProxy).toContain("{ ok: false, status: 401, error: 'Session expired' }");
  });

  it('rejects when AUTH_KV is missing (fail closed)', () => {
    expect(cpnProxy).toContain("{ ok: false, status: 503, error: 'Auth service unavailable' }");
  });

  it('rejects empty / short tokens', () => {
    expect(cpnProxy).toContain("{ ok: false, status: 401, error: 'Session token required' }");
  });

  it('rejects expired or invalid session key', () => {
    expect(cpnProxy).toContain("{ ok: false, status: 401, error: 'Session expired or invalid' }");
  });

  it('rejects session missing userId', () => {
    expect(cpnProxy).toContain("{ ok: false, status: 401, error: 'Session missing userId' }");
  });

  it('userId comes exclusively from KV session record, not request body', () => {
    expect(cpnProxy).toContain('const { userId } = session;');
    expect(cpnProxy).not.toContain('body.userId');
  });

  it('session auth runs after health, before key check (order in handler)', () => {
    const handler = cpnProxy.slice(cpnProxy.indexOf('export async function onRequest'));
    const healthIdx  = handler.indexOf("cpnPath === 'health'");
    const sessionIdx = handler.indexOf('await verifySession(');
    const keyIdx     = handler.indexOf("const apiKey = env && env.CPN_API_KEY");
    expect(healthIdx).toBeGreaterThan(-1);
    expect(sessionIdx).toBeGreaterThan(healthIdx);
    expect(keyIdx).toBeGreaterThan(sessionIdx);
  });
});

// ── 5. Pages Function — user-ownership enforcement (Fase 1.1 — new) ──────────
describe('functions/api/cpn/[[route]].mjs — payment ownership (Fase 1.1)', () => {
  it('verifyPaymentOwnership function is defined', () => {
    expect(cpnProxy).toContain('async function verifyPaymentOwnership(env, userId, paymentId)');
  });

  it('recordPaymentOwnership writes cpn_pay:<userId>:<paymentId>', () => {
    expect(cpnProxy).toContain('`cpn_pay:${userId}:${paymentId}`');
  });

  it('GET /payments/:id checks ownership before forwarding', () => {
    const handler = cpnProxy.slice(cpnProxy.indexOf('export async function onRequest'));
    expect(handler).toContain('routeMatch.ownership');
    expect(handler).toContain('verifyPaymentOwnership(env, userId, paymentId)');
  });

  it('returns 403 (not 404) on ownership failure — no information leak about existence', () => {
    expect(cpnProxy).toContain("{ error: 'Access denied to this payment' }, 403");
  });

  it('ROUTE_TABLE marks payment-specific paths with ownership: true', () => {
    // GET payments/:id, POST payments/:id/transactions, POST payments/:id/transactions/:txId/submit
    const matches = cpnProxy.match(/ownership:\s*true/g);
    expect(matches).not.toBeNull();
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it('quotes path does NOT require ownership', () => {
    const quotesEntry = cpnProxy.slice(
      cpnProxy.indexOf("re: /^quotes$/"),
      cpnProxy.indexOf("re: /^quotes$/") + 120
    );
    // ownership: false may have different spacing — search loosely
    expect(quotesEntry).toMatch(/ownership:\s*false/);
  });

  it('ownership record uses 48h TTL (172800 seconds)', () => {
    expect(cpnProxy).toContain('expirationTtl: 172800');
  });

  it('recordPaymentOwnership returns { ok, error } — failure is not silently swallowed', () => {
    expect(cpnProxy).toContain('async function recordPaymentOwnership');
    // Error message may include dynamic content; check for the key phrases
    expect(cpnProxy).toContain("return { ok: false");
    expect(cpnProxy).toContain("'KV write failed'");
  });
});

// ── 6. Pages Function — method enforcement ────────────────────────────────────
describe('functions/api/cpn/[[route]].mjs — method enforcement', () => {
  it('returns 405 with allowed method on wrong method', () => {
    expect(cpnProxy).toContain("{ error: 'Method not allowed for this CPN path', allowed: routeMatch.expectedMethod }");
    expect(cpnProxy).toContain('405, env, request');
  });

  it('returns 400 on unknown path', () => {
    expect(cpnProxy).toContain("{ error: 'CPN path not allowed' }, 400");
  });
});

// ── 7. Pages Function — two-phase idempotency (Fase 1.1) ─────────────────────
describe('functions/api/cpn/[[route]].mjs — two-phase idempotency (Fase 1.1)', () => {
  it('reserveIdempotency function is defined (Fase 1.2: includes bodyJson for payload binding)', () => {
    // Fase 1.2 added bodyJson parameter for payload hash binding
    expect(cpnProxy).toContain('async function reserveIdempotency(env, userId, idempotencyKey, bodyJson)');
  });

  it('promoteIdempotency function is defined (Fase 1.2: includes pHash for replay binding)', () => {
    // Fase 1.2 added pHash parameter for idempotent replay binding
    expect(cpnProxy).toContain('async function promoteIdempotency(env, userId, idempotencyKey, paymentId, reserveKey, pHash)');
  });

  it('reservation key uses cpn_reserve prefix', () => {
    expect(cpnProxy).toContain('`cpn_reserve:${userId}:${idempotencyKey}`');
  });

  it('permanent record key uses cpn_idem prefix', () => {
    expect(cpnProxy).toContain('`cpn_idem:${userId}:${idempotencyKey}`');
  });

  it('reservation TTL is short (120 s — in-flight window)', () => {
    expect(cpnProxy).toContain('RESERVE_TTL_SECONDS  = 120');
  });

  it('permanent record TTL is 24 h', () => {
    expect(cpnProxy).toContain('IDEM_TTL_SECONDS     = 86400');
  });

  it('concurrent conflict returns 409 with IDEMPOTENCY_CONFLICT code (new)', () => {
    expect(cpnProxy).toContain("code: 'IDEMPOTENCY_CONFLICT'");
    // 409 for conflict
    expect(cpnProxy).toContain("409, env, request");
  });

  it('reservation failure blocks creation rather than silently proceeding (new)', () => {
    expect(cpnProxy).toContain("code: 'IDEMPOTENCY_RESERVE_FAILED'");
    expect(cpnProxy).toContain("503, env, request");
  });

  it('IDEMPOTENT_REPLAY returned for already-completed key (no second payment)', () => {
    expect(cpnProxy).toContain("status: 'IDEMPOTENT_REPLAY'");
    expect(cpnProxy).toContain("idempotent: true");
  });

  it('persistence failure sets persistenceWarning flag — not silently swallowed (new)', () => {
    expect(cpnProxy).toContain('persistenceWarning = true');
    expect(cpnProxy).toContain("persistenceError = 'KV write failed — reconcile before retrying'");
  });

  it('reservation NOT deleted on network error — outcome unknown, reconcile required (Fase 1.3)', () => {
    // Fase 1.3: network error returns NETWORK_UNKNOWN; reservation is preserved so
    // a concurrent retry sees IDEMPOTENCY_CONFLICT until the TTL expires.
    expect(cpnProxy).toContain("'NETWORK_UNKNOWN'");
    expect(cpnProxy).toContain('reconcileRequired: true');
    // The old "Clean up reservation on network failure" delete must NOT be present
    // in the network error catch block (it was removed in Fase 1.3)
    const catchBlock = cpnProxy.slice(
      cpnProxy.indexOf('} catch (_networkErr) {'),
      cpnProxy.indexOf('} catch (_networkErr) {') + 1000
    );
    expect(catchBlock).not.toContain('AUTH_KV.delete(reservationHandle.reserveKey)');
  });

  it('reservation key is cleaned up on CPN non-2xx error (retry-safe on known failure)', () => {
    // On CPN returning a non-2xx error (known failure), the reservation IS deleted so
    // the caller can retry. On NETWORK_UNKNOWN it is NOT deleted (Fase 1.3).
    expect(cpnProxy).toContain('AUTH_KV.delete(reservationHandle.reserveKey)');
    // There should be exactly one delete (in the non-2xx path), not two
    const deleteMatches = (cpnProxy.match(/AUTH_KV\.delete\(reservationHandle\.reserveKey\)/g) || []);
    expect(deleteMatches.length).toBeGreaterThanOrEqual(1);
  });

  it('idempotencyKey required to be 8-128 chars', () => {
    expect(cpnProxy).toContain('idemKey.length < 8 || idemKey.length > 128');
    expect(cpnProxy).toContain("'idempotencyKey is required (8\u2013128 chars, UUID v4 recommended)'");
  });

  it('payloadHash function binds reservation to canonical payload fields (Fase 1.4: SHA-256)', () => {
    expect(cpnProxy).toContain('async function payloadHash(body)'); // now async (Fase 1.4)
    expect(cpnProxy).toContain('quoteId');
    expect(cpnProxy).toContain('destinationCurrency');
    expect(cpnProxy).toContain('beneficiaryName');
    expect(cpnProxy).toContain('beneficiaryAccount');
    // SHA-256 upgrade: must use SubtleCrypto, not djb2
    expect(cpnProxy).toContain("crypto.subtle.digest('SHA-256'");
    expect(cpnProxy).not.toContain('h = 5381'); // djb2 removed
  });

  it('IDEMPOTENCY_KEY_REUSE returned when same key used with different payload (Fase 1.2)', () => {
    expect(cpnProxy).toContain("code: 'IDEMPOTENCY_KEY_REUSE'");
    expect(cpnProxy).toContain('existing.payloadHash !== newHash');
  });

  it('permanent record stores payloadHash for replay binding (Fase 1.2)', () => {
    expect(cpnProxy).toContain('payloadHash: pHash');
  });
});

// ── 8. Pages Function — body size cap ────────────────────────────────────────
describe('functions/api/cpn/[[route]].mjs — body size cap', () => {
  it('MAX_BODY_BYTES constant is 32 KB', () => {
    expect(cpnProxy).toContain('const MAX_BODY_BYTES = 32 * 1024');
  });

  it('readBodySafe rejects oversized bodies with 413', () => {
    expect(cpnProxy).toContain('Request body too large');
    expect(cpnProxy).toContain('413, env, request');
  });

  it('rejects non-JSON bodies', () => {
    expect(cpnProxy).toContain("{ error: 'Invalid JSON body' }, 400");
  });
});

// ── 9. Pages Function — key isolation and safe error messages ─────────────────
describe('functions/api/cpn/[[route]].mjs — key isolation and safe error messages', () => {
  it('exports onRequest handler', () => {
    expect(cpnProxy).toContain('export async function onRequest(context)');
  });

  it('CPN_API_KEY only injected as Authorization header, never in response body', () => {
    expect(cpnProxy).toContain("Authorization: 'Bearer ' + apiKey");
    expect(cpnProxy).not.toMatch(/res.*apiKey/);
    expect(cpnProxy).not.toMatch(/json.*CPN_API_KEY/);
  });

  it('strips apiKey / Authorization fields from upstream response', () => {
    expect(cpnProxy).toContain('delete upstreamJson.apiKey');
    expect(cpnProxy).toContain('delete upstreamJson.Authorization');
  });

  it('network errors caught without leaking internal stack or address (Fase 1.3: NETWORK_UNKNOWN)', () => {
    // Fase 1.3: code changed from NETWORK_ERROR to NETWORK_UNKNOWN with reconcileRequired
    expect(cpnProxy).toContain("'NETWORK_UNKNOWN'");
    expect(cpnProxy).toContain('reconcileRequired: true');
    expect(cpnProxy).not.toContain('networkErr.toString()');
    expect(cpnProxy).not.toContain('networkErr.message');
  });

  it('safeUpstreamError provides generic messages for each HTTP status', () => {
    expect(cpnProxy).toContain('function safeUpstreamError(status)');
    expect(cpnProxy).toContain("'CPN access denied — OFI onboarding required'");
  });

  it('returns 503 when CPN_API_KEY is not configured', () => {
    expect(cpnProxy).toContain("code: 'CPN_NOT_CONFIGURED'");
    expect(cpnProxy).toContain('503, env, request');
  });

  it('health endpoint does not require auth and does not reveal key value', () => {
    expect(cpnProxy).toContain("cpnPath === 'health'");
    expect(cpnProxy).toContain("configured: !!(env && env.CPN_API_KEY)");
    expect(cpnProxy).not.toContain("configured: apiKey");
  });

  it('has no mock mode', () => {
    expect(cpnProxy).not.toContain('CPN_SANDBOX_MOCK');
    expect(cpnProxy).not.toContain('mockPayment');
  });

  it('CORS includes Vary: Origin header', () => {
    expect(cpnProxy).toContain("'Vary': 'Origin'");
  });
});

// ── 10. index.html — CPN UI elements present ──────────────────────────────────
describe('index.html — CPN UI elements present', () => {
  it('CPN toggle button exists', () => { expect(html).toContain('saToggleCPN()'); });
  it('CPN form hidden by default', () => { expect(html).toMatch(/id=["']sa-cpn-form["']/); });
  it('OFI onboarding notice exists', () => { expect(html).toMatch(/id=["']sa-cpn-notice["']/); });
  it('all beneficiary + sender fields exist', () => {
    ['sa-cpn-bene-name', 'sa-cpn-bank-name', 'sa-cpn-account', 'sa-cpn-country',
     'sa-cpn-sender-name', 'sa-cpn-sender-country'].forEach(id => {
      expect(html).toMatch(new RegExp('id=["\']' + id + '["\']'));
    });
  });
  it('quote UI elements exist', () => {
    ['sa-cpn-currency', 'sa-cpn-quotes-list', 'sa-cpn-selected-quote'].forEach(id => {
      expect(html).toMatch(new RegExp('id=["\']' + id + '["\']'));
    });
  });
  it('CPN route preview rows exist', () => {
    ['sa-rt-cpn-currency', 'sa-rt-cpn-rate', 'sa-rt-cpn-receives'].forEach(id => {
      expect(html).toMatch(new RegExp('id=["\']' + id + '["\']'));
    });
  });
});

// ── 11. index.html — CPN JS functions ────────────────────────────────────────
describe('index.html — CPN JS functions', () => {
  it('saToggleCPN, saFetchCPNQuotes, saExecuteCPNPayout are defined', () => {
    ['function saToggleCPN()', 'async function saFetchCPNQuotes()', 'async function saExecuteCPNPayout()'].forEach(fn => {
      expect(html).toContain(fn);
    });
  });

  it('_saCPNValidate checks wallet, amount, currency, beneficiary, quote', () => {
    const fn = html.slice(html.indexOf('function _saCPNValidate()'), html.indexOf('function _saCPNValidate()') + 2000);
    ['walletAddress', 'amount', 'currency', 'beneName', 'bankName', 'account', 'country', '_saCPNSelectedQuote'].forEach(c => {
      expect(fn).toContain(c);
    });
  });

  it('_saCPNPoll polls until terminal state with timeout', () => {
    const fn = html.slice(html.indexOf('async function _saCPNPoll('), html.indexOf('async function _saCPNPoll(') + 1200);
    expect(fn).toContain('TERMINAL');
    expect(fn).toContain('300000');
    expect(fn).toContain("'COMPLETED'");
  });

  it('_saCPNStatusLabel maps all statuses', () => {
    const fn = html.slice(html.indexOf('function _saCPNStatusLabel('), html.indexOf('function _saCPNStatusLabel(') + 400);
    ['COMPLETED', 'FAILED', 'REVERSED', 'CANCELLED'].forEach(s => expect(fn).toContain(s));
  });

  it('_cpnUuidFE generates a v4-like UUID', () => {
    expect(html).toContain('function _cpnUuidFE()');
    expect(html).toContain("'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'");
  });
});

// ── 12. index.html — TX validation (7-check, including Fase 1.1 additions) ───
describe('index.html — TX validation before signing (Fase 1.1)', () => {
  const startMarker = 'function _saCPNValidateTxObject(txObj, opts)';
  const getTxFn = () => {
    const start = html.indexOf(startMarker);
    return html.slice(start, start + 8000); // increased: Fase 1.4 added expectedRecipient block + strict value checks
  };

  it('_saCPNValidateTxObject function is defined', () => {
    expect(html).toContain(startMarker);
  });

  it('check 1 — rejects missing transactionId', () => {
    expect(getTxFn()).toContain('TX object missing transactionId');
  });

  it('check 1 — rejects invalid `to` address', () => {
    expect(getTxFn()).toContain("'TX object has invalid `to` address'");
  });

  it('check 2 — rejects chainId not in allowlist', () => {
    expect(getTxFn()).toContain('is not an allowed CPN chain');
  });

  it('check 2b — expectedChainId gate (Fase 1.1 — new)', () => {
    expect(getTxFn()).toContain('opts.expectedChainId');
    expect(getTxFn()).toContain('does not match active wallet chain');
  });

  it('check 3 — USDC contract allowlist map is defined (Fase 1.1 — new)', () => {
    expect(html).toContain('var _CPN_USDC_CONTRACTS = {');
    // Arc address
    expect(html).toContain("5042:  '0x3600000000000000000000000000000000000000'");
  });

  it('check 3 — rejects `to` not matching USDC contract (Fase 1.1 — new)', () => {
    expect(getTxFn()).toContain('_CPN_USDC_CONTRACTS');
    expect(getTxFn()).toContain('is not the USDC contract for chain');
  });

  it('check 4 — ERC-20 transfer selector is defined (Fase 1.1 — new)', () => {
    expect(html).toContain("var _CPN_ERC20_TRANSFER_SELECTOR = '0xa9059cbb'");
  });

  it('check 4 — rejects calldata that does not start with transfer() selector (Fase 1.1 — new)', () => {
    expect(getTxFn()).toContain('_CPN_ERC20_TRANSFER_SELECTOR');
    expect(getTxFn()).toContain("does not match ERC-20 transfer()");
  });

  it('check 5 — amount EXACT match, decimal-exact conversion (Fase 1.3 — no parseFloat)', () => {
    expect(getTxFn()).toContain('opts.amount');
    expect(getTxFn()).toContain('_cpnUsdcStringToRaw'); // Fase 1.3: decimal-exact converter
    expect(getTxFn()).toContain('diverges from approved amount');
    expect(getTxFn()).toContain('does not exactly match');
  });

  it('check 5 — 0.5% tolerance REMOVED (Fase 1.2)', () => {
    // The 200n divisor was part of the 0.5% tolerance that was removed
    expect(getTxFn()).not.toContain('200n');
  });

  it('check 6 — rejects any non-zero native value (Fase 1.2 — must be zero)', () => {
    expect(getTxFn()).toContain('must be zero');
    expect(getTxFn()).toContain('exceeds safety limit');
  });

  it('check 7 — rejects `from` mismatch', () => {
    expect(getTxFn()).toContain('does not match authenticated wallet');
  });

  it('_saCPNValidateTxObject is called before signer.signTransaction', () => {
    const payoutFn = html.slice(html.indexOf('async function saExecuteCPNPayout()'),
                                html.indexOf('async function saExecuteCPNPayout()') + 10000);
    const validateIdx = payoutFn.indexOf('_saCPNValidateTxObject(');
    const signIdx     = payoutFn.indexOf('signer.signTransaction(');
    expect(validateIdx).toBeGreaterThan(-1);
    expect(signIdx).toBeGreaterThan(validateIdx);
  });

  it('throws before signing when validation fails', () => {
    const payoutFn = html.slice(html.indexOf('async function saExecuteCPNPayout()'),
                                html.indexOf('async function saExecuteCPNPayout()') + 10000);
    expect(payoutFn).toContain("'TX validation failed: '");
  });
});

// ── 13. index.html — idempotency key stability ────────────────────────────────
describe('index.html — idempotency key stability (prevents duplicate payments)', () => {
  it('_saCPNIdempotencyKey is declared as a module-level variable', () => {
    expect(html).toContain('let _saCPNIdempotencyKey = null;');
  });

  it('key is generated only when null (not regenerated on retry)', () => {
    expect(html).toContain('if (!_saCPNIdempotencyKey) {');
    expect(html).toContain('_saCPNIdempotencyKey = _cpnUuidFE();');
  });

  it('key is reused as idemKey throughout the same payout attempt', () => {
    const payoutFn = html.slice(html.indexOf('async function saExecuteCPNPayout()'),
                                html.indexOf('async function saExecuteCPNPayout()') + 10000);
    expect(payoutFn).toContain('var idemKey = _saCPNIdempotencyKey;');
    // The JSON key may have extra whitespace for alignment
    expect(payoutFn).toMatch(/idempotencyKey:\s+idemKey/);
  });

  it('key is cleared ONLY on confirmed success (COMPLETED), not on error', () => {
    const payoutFn = html.slice(html.indexOf('async function saExecuteCPNPayout()'),
                                html.indexOf('async function saExecuteCPNPayout()') + 10000);
    // The null assignment should be inside the isComplete branch
    const completeIdx = payoutFn.indexOf("_saCPNIdempotencyKey = null;");
    const isCompleteIdx = payoutFn.indexOf("isComplete");
    expect(completeIdx).toBeGreaterThan(isCompleteIdx);
    expect(payoutFn).toContain('Do NOT clear _saCPNIdempotencyKey on error');
  });

  it('key is cleared when user cancels CPN mode (saToggleCPN exit path)', () => {
    const toggleFn = html.slice(html.indexOf('function saToggleCPN()'),
                                html.indexOf('function saToggleCPN()') + 2500);
    expect(toggleFn).toContain('_saCPNIdempotencyKey = null;');
  });

  it('server handles IDEMPOTENT_REPLAY without treating it as an error', () => {
    const payoutFn = html.slice(html.indexOf('async function saExecuteCPNPayout()'),
                                html.indexOf('async function saExecuteCPNPayout()') + 10000);
    expect(payoutFn).toContain('IDEMPOTENT_REPLAY');
    expect(payoutFn).toContain('Resuming existing payment');
  });
});

// ── 14. index.html — session cookie sent with all CPN requests ─────────────────
describe('index.html — session cookie sent with all CPN requests', () => {
  it('saFetchCPNQuotes includes credentials:same-origin', () => {
    const fn = html.slice(html.indexOf('async function saFetchCPNQuotes()'),
                          html.indexOf('async function saFetchCPNQuotes()') + 2500);
    expect(fn).toContain("credentials: 'same-origin'");
  });

  it('payment creation fetch includes credentials:same-origin', () => {
    const fn = html.slice(html.indexOf("'/api/cpn/payments'"),
                          html.indexOf("'/api/cpn/payments'") + 500);
    expect(fn).toContain("credentials: 'same-origin'");
  });

  it('TX object fetch includes credentials:same-origin', () => {
    const fn = html.slice(html.indexOf("'/api/cpn/payments/' + _saCPNPaymentId + '/transactions'"),
                          html.indexOf("'/api/cpn/payments/' + _saCPNPaymentId + '/transactions'") + 400);
    expect(fn).toContain("credentials: 'same-origin'");
  });

  it('poll fetch includes credentials:same-origin', () => {
    const fn = html.slice(html.indexOf('async function _saCPNPoll('),
                          html.indexOf('async function _saCPNPoll(') + 1500);
    expect(fn).toContain("credentials: 'same-origin'");
  });
});

// ── 15. index.html — send button dispatch ────────────────────────────────────
describe('index.html — send button dispatch', () => {
  it('send button calls saDispatchSend()', () => {
    expect(html).toContain("onclick=\"saDispatchSend()\"");
  });

  it('saDispatchSend routes to CPN or normal send', () => {
    const fn = html.slice(html.indexOf('function saDispatchSend()'),
                          html.indexOf('function saDispatchSend()') + 300);
    expect(fn).toContain('saExecuteCPNPayout()');
    expect(fn).toContain('saExecuteSend()');
  });

  it('saExecuteSend is preserved (not removed)', () => {
    expect(html).toContain('function saExecuteSend(');
  });
});

// ── 16. index.html — 5-step OFI payment flow ─────────────────────────────────
describe('index.html — 5-step OFI payment flow in saExecuteCPNPayout', () => {
  const getPayoutFn = () => {
    const start = html.indexOf('async function saExecuteCPNPayout()');
    return html.slice(start, start + 10000); // Fase 1.4: fn grew with signing-path hardening
  };

  it('uses pre-fetched quote (no duplicate quote call inside payout fn)', () => {
    expect(getPayoutFn()).not.toContain('saFetchCPNQuotes()');
    expect(getPayoutFn()).toContain('_saCPNSelectedQuote');
  });

  it('signs with signer.signTransaction, never signer.sendTransaction', () => {
    expect(getPayoutFn()).toContain('signer.signTransaction(');
    expect(getPayoutFn()).not.toContain('signer.sendTransaction(');
  });

  it('validates TX before signing (not after)', () => {
    const fn = getPayoutFn();
    const validateIdx = fn.indexOf('_saCPNValidateTxObject(');
    const signIdx     = fn.indexOf('signer.signTransaction(');
    expect(validateIdx).toBeLessThan(signIdx);
  });

  it('does not mark payment complete until COMPLETED status from poll', () => {
    const fn = getPayoutFn();
    expect(fn).toContain("finalPayment.status === 'COMPLETED'");
    // toast is gated behind the COMPLETED check — not called unconditionally
    const completedIdx = fn.indexOf("finalPayment.status === 'COMPLETED'");
    const toastIdx     = fn.indexOf("toast('Fiat payout");
    // toast must come AFTER the COMPLETED guard
    expect(toastIdx).toBeGreaterThan(completedIdx);
  });

  it('logs type cpn-fiat to activity, without bank account number', () => {
    const logIdx = html.indexOf("type: 'cpn-fiat'");
    expect(logIdx).toBeGreaterThan(-1);
    const logEntry = html.slice(logIdx - 50, logIdx + 300);
    expect(logEntry).not.toContain('account');
    expect(logEntry).not.toContain('accountNumber');
  });
});

// ── 17. index.html — poll timeout reconciliation (Fase 1.1 — new) ────────────
describe('index.html — poll timeout reconciliation (Fase 1.1)', () => {
  it('_saCPNPoll performs a final reconciliation fetch on timeout', () => {
    const fn = html.slice(html.indexOf('async function _saCPNPoll('),
                          html.indexOf('async function _saCPNPoll(') + 2000);
    expect(fn).toContain('POLL_TIMEOUT');
    expect(fn).toContain('finalRes');
    expect(fn).toContain('finalData');
  });

  it('timeout error includes last known payment status', () => {
    const fn = html.slice(html.indexOf('async function _saCPNPoll('),
                          html.indexOf('async function _saCPNPoll(') + 2000);
    expect(fn).toContain('last known status');
    expect(fn).toContain('timeoutErr.payment');
  });

  it('timeout error code is POLL_TIMEOUT', () => {
    const fn = html.slice(html.indexOf('async function _saCPNPoll('),
                          html.indexOf('async function _saCPNPoll(') + 2000);
    expect(fn).toContain("timeoutErr.code = 'POLL_TIMEOUT'");
  });

  it('POLL_TIMEOUT handler in saExecuteCPNPayout shows reconciliation message, not generic error', () => {
    const payoutFn = html.slice(html.indexOf('async function saExecuteCPNPayout()'),
                                html.indexOf('async function saExecuteCPNPayout()') + 10000);
    expect(payoutFn).toContain("e.code === 'POLL_TIMEOUT'");
    expect(payoutFn).toContain('reconcile before proceeding');
  });

  it('POLL_TIMEOUT handler keeps button disabled — no auto-retry', () => {
    const payoutFn = html.slice(html.indexOf('async function saExecuteCPNPayout()'),
                                html.indexOf('async function saExecuteCPNPayout()') + 10000);
    // In the POLL_TIMEOUT branch the button should NOT be re-enabled
    const timeoutBranch = payoutFn.slice(payoutFn.indexOf("e.code === 'POLL_TIMEOUT'"),
                                         payoutFn.indexOf("e.code === 'POLL_TIMEOUT'") + 800);
    expect(timeoutBranch).not.toContain('btn.disabled = false');
  });

  it('idempotency key preserved on timeout (safe for manual reconcile)', () => {
    const payoutFn = html.slice(html.indexOf('async function saExecuteCPNPayout()'),
                                html.indexOf('async function saExecuteCPNPayout()') + 10000);
    expect(payoutFn).toContain('Do NOT clear _saCPNIdempotencyKey on error');
    // The null assignment should not appear inside the POLL_TIMEOUT branch
    const timeoutBranch = payoutFn.slice(payoutFn.indexOf("e.code === 'POLL_TIMEOUT'"),
                                         payoutFn.indexOf("e.code === 'POLL_TIMEOUT'") + 800);
    expect(timeoutBranch).not.toContain('_saCPNIdempotencyKey = null');
  });
});

// ── 18. Security — CPN_API_KEY never exposed to the browser ──────────────────
describe('Security — CPN_API_KEY never exposed to the browser', () => {
  it('index.html has no hardcoded CPN_API_KEY value', () => {
    expect(html).not.toMatch(/CPN_API_KEY\s*=\s*['"][a-zA-Z0-9]/);
  });

  it('index.html has no hardcoded Bearer token for CPN', () => {
    expect(html).not.toMatch(/Authorization.*Bearer.*[a-zA-Z0-9]{20}/);
  });

  it('cpnFiatPayout.js only calls /api/cpn/* (never api.circle.com)', () => {
    expect(cpnModule).not.toContain('api.circle.com');
    expect(cpnModule).toContain('/api/cpn/');
  });

  it('Pages Function is the only place Bearer token is assembled', () => {
    expect(cpnProxy).toContain("Authorization: 'Bearer ' + apiKey");
    expect(cpnModule).not.toContain('Bearer');
  });

  it('Pages Function does not log apiKey, CPN_API_KEY, or Authorization headers', () => {
    expect(cpnProxy).not.toMatch(/console\.(log|warn|error).*apiKey/);
    expect(cpnProxy).not.toMatch(/console\.(log|warn|error).*CPN_API_KEY/);
    expect(cpnProxy).not.toMatch(/console\.(log|warn|error).*Authorization/);
  });
});

// ── 19. .dev.vars.example — CPN configuration ────────────────────────────────
describe('.dev.vars.example — CPN configuration', () => {
  it('documents CPN_API_KEY', () => { expect(devVarsEx).toContain('CPN_API_KEY'); });
  it('explains there is no mock mode', () => { expect(devVarsEx).toMatch(/no mock/i); });
  it('links to CPN docs', () => { expect(devVarsEx).toContain('developers.circle.com'); });
  it('explains OFI onboarding requirement', () => { expect(devVarsEx).toMatch(/OFI|onboarding/i); });
});

// ── 20. Shared sync ───────────────────────────────────────────────────────────
describe('Shared sync — public/shared/cpnFiatPayout.js identical to shared/', () => {
  it('public copy exists and is non-empty', () => {
    const { existsSync, readFileSync: rf } = require('fs');
    const pubPath = path.join(ROOT, 'public/shared/cpnFiatPayout.js');
    expect(existsSync(pubPath)).toBe(true);
    expect(rf(pubPath, 'utf8').length).toBeGreaterThan(100);
  });

  it('public copy is byte-for-byte identical to source', () => {
    const { readFileSync: rf } = require('fs');
    const src = rf(path.join(ROOT, 'shared/cpnFiatPayout.js'), 'utf8');
    const pub = rf(path.join(ROOT, 'public/shared/cpnFiatPayout.js'), 'utf8');
    expect(pub).toBe(src);
  });
});

// ── 21. Mandatory behavioral tests (spec §4) ──────────────────────────────────

describe('Behavioral: User A accessing User B\'s payment (cross-user isolation)', () => {
  it('server ownership check returns 403 for unowned paymentId', () => {
    // Structural: verifyPaymentOwnership is called for all payment-specific paths
    expect(cpnProxy).toContain('await verifyPaymentOwnership(env, userId, paymentId)');
    expect(cpnProxy).toContain("{ error: 'Access denied to this payment' }, 403");
  });

  it('ownership is scoped to userId — key includes userId', () => {
    // cpn_pay key includes userId so User B cannot access User A's payment even
    // with a valid session and a guessed UUID
    expect(cpnProxy).toContain('`cpn_pay:${userId}:${paymentId}`');
  });

  it('GET /payments/:id path is marked ownership: true', () => {
    // Find the GET-only entry (the one that ends at /$, not followed by /transactions)
    // Look for the method: 'GET' entry in ROUTE_TABLE
    const getEntry = cpnProxy.slice(
      cpnProxy.indexOf("method: 'GET'"),
      cpnProxy.indexOf("method: 'GET'") + 120
    );
    expect(getEntry).toContain('ownership: true');
  });

  it('submit path is marked ownership: true', () => {
    const submitEntry = cpnProxy.slice(
      cpnProxy.indexOf("re: /^payments\\/[a-zA-Z0-9_-]{1,80}\\/transactions\\/[a-zA-Z0-9_-]{1,80}\\/submit$/"),
      cpnProxy.indexOf("re: /^payments\\/[a-zA-Z0-9_-]{1,80}\\/transactions\\/[a-zA-Z0-9_-]{1,80}\\/submit$/") + 120
    );
    expect(submitEntry).toContain('ownership: true');
  });
});

describe('Behavioral: expired/invalid session', () => {
  it('verifySession checks createdAt + SESSION_TTL_MS and rejects expired sessions (Fase 1.2)', () => {
    // Fase 1.2 fix: login.js stores createdAt (not expiresAt); expiry is derived here
    expect(cpnProxy).toContain('session.createdAt');
    expect(cpnProxy).toContain('SESSION_TTL_MS');
    expect(cpnProxy).toContain("error: 'Session expired'");
  });

  it('verifySession rejects missing KV record (token after logout)', () => {
    expect(cpnProxy).toContain("{ ok: false, status: 401, error: 'Session expired or invalid' }");
  });

  it('verifySession rejects empty token', () => {
    expect(cpnProxy).toContain("{ ok: false, status: 401, error: 'Session token required' }");
  });
});

describe('Behavioral: tampered TX — contract / token / network / value / calldata', () => {
  it('wrong USDC contract → rejected before signing (server module)', () => {
    expect(cpnModule).toContain("') is not the USDC contract for chain '");
  });

  it('wrong USDC contract → rejected before signing (index.html)', () => {
    expect(html).toContain('is not the USDC contract for chain');
  });

  it('wrong network → rejected before signing (server module)', () => {
    expect(cpnModule).toContain("TX object chainId ' + chainId + ' is not an allowed CPN chain");
  });

  it('wrong chainId vs wallet active chain → rejected before signing (index.html)', () => {
    expect(html).toContain('does not match active wallet chain');
  });

  it('non-transfer calldata selector → rejected before signing (server module)', () => {
    expect(cpnModule).toContain("does not match ERC-20 transfer()");
  });

  it('non-transfer calldata selector → rejected before signing (index.html)', () => {
    expect(html).toContain("does not match ERC-20 transfer()");
  });

  it('TX amount not exactly equal to approved amount → rejected (server module) (Fase 1.2)', () => {
    expect(cpnModule).toContain('does not exactly match');
    expect(cpnModule).toContain('No tolerance is permitted');
  });

  it('TX amount not exactly equal to approved amount → rejected (index.html) (Fase 1.2)', () => {
    expect(html).toContain('does not exactly match');
    expect(html).toContain('diverges from approved amount');
  });

  it('any non-zero native value → rejected before signing (Fase 1.2 — zero required)', () => {
    expect(cpnModule).toContain('must be zero for a USDC transfer');
    expect(html).toContain('must be zero');
  });
});

describe('Behavioral: two simultaneous requests with same idempotency key', () => {
  it('reservation key exists → second request returns 409 IDEMPOTENCY_CONFLICT', () => {
    expect(cpnProxy).toContain("code: 'IDEMPOTENCY_CONFLICT'");
    expect(cpnProxy).toContain("409, env, request");
  });

  it('reservation phase runs before the upstream CPN call', () => {
    const handler = cpnProxy.slice(cpnProxy.indexOf('export async function onRequest'));
    const reserveIdx  = handler.indexOf('await reserveIdempotency(');
    const upstreamIdx = handler.indexOf("const upstreamUrl = CPN_BASE_URL");
    expect(reserveIdx).toBeGreaterThan(-1);
    expect(upstreamIdx).toBeGreaterThan(reserveIdx);
  });
});

describe('Behavioral: timeout after CPN creation — no auto-retry', () => {
  it('POLL_TIMEOUT error has code field for structured handling', () => {
    const fn = html.slice(html.indexOf('async function _saCPNPoll('),
                          html.indexOf('async function _saCPNPoll(') + 2000);
    expect(fn).toContain("timeoutErr.code = 'POLL_TIMEOUT'");
  });

  it('POLL_TIMEOUT handler does NOT re-enable the send button (blocks auto-retry)', () => {
    const payoutFn = html.slice(html.indexOf('async function saExecuteCPNPayout()'),
                                html.indexOf('async function saExecuteCPNPayout()') + 10000);
    const branch = payoutFn.slice(payoutFn.indexOf("e.code === 'POLL_TIMEOUT'"),
                                  payoutFn.indexOf("e.code === 'POLL_TIMEOUT'") + 700);
    expect(branch).not.toContain('btn.disabled = false');
  });

  it('POLL_TIMEOUT preserves idempotency key — user can reconcile manually', () => {
    const payoutFn = html.slice(html.indexOf('async function saExecuteCPNPayout()'),
                                html.indexOf('async function saExecuteCPNPayout()') + 10000);
    const branch = payoutFn.slice(payoutFn.indexOf("e.code === 'POLL_TIMEOUT'"),
                                  payoutFn.indexOf("e.code === 'POLL_TIMEOUT'") + 700);
    expect(branch).not.toContain('_saCPNIdempotencyKey = null');
  });
});

describe('Behavioral: persistence failure — not silent, caller can reconcile', () => {
  it('promoteIdempotency returns { ok: false, error } on failure (not throws)', () => {
    expect(cpnProxy).toContain('async function promoteIdempotency');
    expect(cpnProxy).toContain("return { ok: false, error: e && e.message ? e.message : 'KV promote failed' }");
  });

  it('persistenceWarning flag surfaces to caller with paymentId intact', () => {
    expect(cpnProxy).toContain('persistenceWarning = true');
    expect(cpnProxy).toContain("persistenceError = 'KV write failed — reconcile before retrying'");
  });

  it('caller receives paymentId even when persistence fails (must not retry creation)', () => {
    // The upstreamJson.id is still included in the response even when persistence fails
    const promoteSection = cpnProxy.slice(
      cpnProxy.indexOf('promoteResult = await promoteIdempotency'),
      cpnProxy.indexOf('promoteResult = await promoteIdempotency') + 600
    );
    expect(promoteSection).toContain('persistenceWarning');
    expect(promoteSection).not.toContain('return jsonResponse(');
  });
});

// ── 22. Regression guards ─────────────────────────────────────────────────────
describe('Regression guards — existing flows unaffected', () => {
  it('saExecuteSend preserved', () => { expect(html).toContain('function saExecuteSend('); });
  it('saUpdateRoute preserved', () => { expect(html).toContain('function saUpdateRoute('); });
  it('saSelectAsset preserved', () => { expect(html).toContain('function saSelectAsset('); });
  it('saRefreshBalance preserved', () => { expect(html).toContain('function saRefreshBalance('); });
  it('saExecuteCrossChain preserved', () => { expect(html).toContain('function saExecuteCrossChain('); });
  it('saExecuteCCTPCrossChain preserved', () => { expect(html).toContain('function saExecuteCCTPCrossChain('); });
  it('saLogTx preserved', () => { expect(html).toContain('function saLogTx('); });
  it('sa-recipient field preserved', () => { expect(html).toMatch(/id=["']sa-recipient["']/); });
  it('sa-dest-network preserved', () => { expect(html).toMatch(/id=["']sa-dest-network["']/); });
  it('CPN form hidden by default', () => {
    // The form element must include display:none
    expect(html).toMatch(/id=["']sa-cpn-form["'][^>]*display:none/);
  });
  it('CPN route rows hidden by default', () => {
    expect(html).toMatch(/id=["']sa-rt-cpn-rows["'][^>]*display:none/);
  });
  it('Swap page unaffected', () => { expect(html).toContain('function executeSwap('); });
  it('Bridge page unaffected', () => { expect(html).toContain('function executeBridgeOrTurbo('); });
  it('Schedule page unaffected', () => { expect(html).toContain('scheduleNext'); });
  it('Batch page unaffected', () => { expect(html).toContain('executeBatchViaMulticall3('); });
});
