/**
 * CPN Fiat Payout — Fase 1 Security & Integrity test suite
 *
 * Covers:
 *  1.  shared/cpnFiatPayout.js — module structure, validation, helpers
 *  2.  shared/cpnFiatPayout.js — validateTxObject (new — blocks bad TX before sign)
 *  3.  functions/api/cpn/[[route]].mjs — session auth (new), path/method allowlist,
 *       idempotency guard (new), body-size cap (new), key isolation, no mock
 *  4.  index.html — CPN UI elements, JS functions
 *  5.  index.html — security: TX validation before sign (new), idempotency key
 *       persistence (new), credentials:same-origin on all CPN fetches (new)
 *  6.  index.html — send button dispatch
 *  7.  index.html — 5-step OFI payment flow
 *  8.  Security: CPN_API_KEY never in browser
 *  9.  .dev.vars.example — configuration documented
 *  10. Shared sync
 *  11. Regression guards — existing Send Assets + Batch flows unaffected
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
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

  it('exposes getQuotes, createPayment, getTransactionObject, submitSignedTransaction, getPaymentStatus, pollPaymentStatus', () => {
    ['getQuotes', 'createPayment', 'getTransactionObject', 'submitSignedTransaction', 'getPaymentStatus', 'pollPaymentStatus'].forEach(fn => {
      expect(cpnModule).toContain(fn + ':');
      expect(cpnModule).toMatch(new RegExp('function ' + fn + '\\b'));
    });
  });

  it('exposes executeFiatPayout high-level orchestrator', () => {
    expect(cpnModule).toContain('executeFiatPayout:');
    expect(cpnModule).toContain('async function executeFiatPayout');
  });

  it('exposes validateBeneficiary, validateSender, and validateTxObject (new)', () => {
    expect(cpnModule).toContain('validateBeneficiary:');
    expect(cpnModule).toContain('validateSender:');
    expect(cpnModule).toContain('validateTxObject:');
  });

  it('exposes ALLOWED_CHAIN_IDS list', () => {
    expect(cpnModule).toContain('ALLOWED_CHAIN_IDS:');
    expect(cpnModule).toContain('CPN_ALLOWED_CHAIN_IDS');
  });

  it('exposes STATUS_MAP with all terminal states', () => {
    ["'COMPLETED'", "'FAILED'", "'REVERSED'", "'CANCELLED'"].forEach(s => {
      expect(cpnModule).toContain(s);
    });
  });

  it('getSupportedCurrencies returns a copy of the array', () => {
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
  it('returns null on valid beneficiary', () => {
    expect(cpnModule).toContain('function validateBeneficiary(b)');
    expect(cpnModule).toContain('return null;');
  });
});

describe('shared/cpnFiatPayout.js — validateSender', () => {
  it('rejects missing sender name', () => { expect(cpnModule).toContain("'Sender name required'"); });
  it('rejects missing sender country', () => { expect(cpnModule).toContain("'Sender country code required'"); });
});

// ── 3. cpnFiatPayout.js — validateTxObject (security: TX validation) ─────────
describe('shared/cpnFiatPayout.js — validateTxObject (pre-sign validation)', () => {
  it('function is defined', () => {
    expect(cpnModule).toContain('function validateTxObject(txObj, approval)');
  });

  it('rejects missing `to` address', () => {
    expect(cpnModule).toContain("'TX object has invalid or missing `to` address'");
  });

  it('rejects invalid `to` address format (not 0x + 40 hex)', () => {
    expect(cpnModule).toContain('/^0x[0-9a-fA-F]{40}$/.test(txObj.to)');
  });

  it('rejects missing chainId', () => {
    expect(cpnModule).toContain("'TX object missing chainId'");
  });

  it('rejects chainId not in CPN_ALLOWED_CHAIN_IDS', () => {
    expect(cpnModule).toContain("'TX object chainId ' + chainId + ' is not an allowed CPN chain'");
    expect(cpnModule).toContain('CPN_ALLOWED_CHAIN_IDS.indexOf(chainId) === -1');
  });

  it('contains Arc Mainnet (5042) and Ethereum (1) in allowed chain list', () => {
    expect(cpnModule).toContain('5042,');
    expect(cpnModule).toContain('1,');
  });

  it('rejects non-hex data field', () => {
    expect(cpnModule).toContain("'TX object data field is not valid hex'");
  });

  it('rejects excessive native value (value-draining protection)', () => {
    expect(cpnModule).toContain("'TX object native value (' + rawValue.toString() + ' wei) exceeds safety limit");
    expect(cpnModule).toContain("BigInt('10000000000000000')");
  });

  it('rejects `from` mismatch with authenticated wallet', () => {
    expect(cpnModule).toContain("'TX object `from` address does not match authenticated wallet'");
    expect(cpnModule).toContain('txObj.from.toLowerCase() !== approved');
  });

  it('missing transactionId is rejected', () => {
    expect(cpnModule).toContain("'TX object missing transactionId'");
  });

  it('is called inside executeFiatPayout before signer.signTransaction', () => {
    const execFn = cpnModule.slice(
      cpnModule.indexOf('async function executeFiatPayout'),
      cpnModule.indexOf('// ── Utilities')
    );
    const validateIdx = execFn.indexOf('validateTxObject(');
    const signIdx     = execFn.indexOf('signer.signTransaction(');
    expect(validateIdx).toBeGreaterThan(-1);
    expect(signIdx).toBeGreaterThan(-1);
    // Validation must come BEFORE signing
    expect(validateIdx).toBeLessThan(signIdx);
  });

  it('throws TX_VALIDATION_FAILED error code when validation fails', () => {
    expect(cpnModule).toContain("ve.code = 'TX_VALIDATION_FAILED'");
  });
});

// ── 4. cpnFiatPayout.js — proxy calls use credentials:same-origin ─────────────
describe('shared/cpnFiatPayout.js — session cookie forwarded', () => {
  it('_cpnFetch includes credentials: same-origin so session cookie is sent', () => {
    expect(cpnModule).toContain("credentials: 'same-origin'");
  });

  it('does not call api.circle.com directly', () => {
    expect(cpnModule).not.toContain('api.circle.com');
  });
});

// ── 5. Pages Function — session authentication ───────────────────────────────
describe('functions/api/cpn/[[route]].mjs — session auth (Fase 1 security)', () => {
  it('verifySession function is defined', () => {
    expect(cpnProxy).toContain('async function verifySession(request, env)');
  });

  it('verifySession reads session token from cookie or Authorization header', () => {
    expect(cpnProxy).toContain('elligente_sid=');
    expect(cpnProxy).toContain('Authorization');
    expect(cpnProxy).toContain('extractSessionToken');
  });

  it('verifySession checks AUTH_KV — fail-closed when KV unavailable', () => {
    expect(cpnProxy).toContain('env.AUTH_KV');
    expect(cpnProxy).toContain("'Auth service unavailable'");
    expect(cpnProxy).toContain('503');
  });

  it('rejects missing or short session token with 401', () => {
    expect(cpnProxy).toContain("'Session token required'");
    expect(cpnProxy).toContain('401');
  });

  it('rejects expired/invalid session with 401', () => {
    expect(cpnProxy).toContain("'Session expired or invalid'");
  });

  it('userId is read from the session, never from the request body', () => {
    // userId must only come from the verified KV session object
    expect(cpnProxy).toContain('session.userId');
    // The body should not be the source of userId
    expect(cpnProxy).not.toContain('bodyJson.userId');
    expect(cpnProxy).not.toContain("body.userId");
  });

  it('session auth runs for all non-health paths before CPN_API_KEY is checked', () => {
    // Only look inside the onRequest handler body for the call order
    const handler = cpnProxy.slice(cpnProxy.indexOf('export async function onRequest'));
    const healthIdx  = handler.indexOf("cpnPath === 'health'");
    // Use the await call, not the function definition
    const sessionIdx = handler.indexOf('await verifySession(');
    // The apiKey variable assignment (the key check)
    const keyIdx     = handler.indexOf("const apiKey = env && env.CPN_API_KEY");
    // Expected order: health (public, no auth) → session auth → key check
    expect(healthIdx).toBeGreaterThan(-1);
    expect(sessionIdx).toBeGreaterThan(healthIdx);
    expect(keyIdx).toBeGreaterThan(sessionIdx);
  });
});

// ── 6. Pages Function — method enforcement ───────────────────────────────────
describe('functions/api/cpn/[[route]].mjs — per-path method enforcement', () => {
  it('ROUTE_TABLE is defined with per-path allowed methods', () => {
    expect(cpnProxy).toContain('const ROUTE_TABLE');
    expect(cpnProxy).toContain('method:');
  });

  it('GET /payments/:id is allowed (poll)', () => {
    expect(cpnProxy).toContain("method: 'GET'");
  });

  it('POST is required for quotes, payments, transactions, submit', () => {
    const postCount = (cpnProxy.match(/method: 'POST'/g) || []).length;
    expect(postCount).toBeGreaterThanOrEqual(4);
  });

  it('returns 405 when method does not match allowed method for path', () => {
    expect(cpnProxy).toContain('405');
    expect(cpnProxy).toContain("'Method not allowed for this CPN path'");
  });

  it('returns 400 when path not in allowlist', () => {
    expect(cpnProxy).toContain("'CPN path not allowed'");
    expect(cpnProxy).toContain('400');
  });
});

// ── 7. Pages Function — idempotency guard ────────────────────────────────────
describe('functions/api/cpn/[[route]].mjs — idempotency (prevents duplicate payments)', () => {
  it('checkIdempotency reads from AUTH_KV', () => {
    expect(cpnProxy).toContain('async function checkIdempotency(env, userId, idempotencyKey)');
    expect(cpnProxy).toContain('cpn_idem:');
  });

  it('recordIdempotency writes paymentId to AUTH_KV after success', () => {
    expect(cpnProxy).toContain('async function recordIdempotency(env, userId, idempotencyKey, paymentId)');
    expect(cpnProxy).toContain('expirationTtl: IDEM_TTL_SECONDS');
  });

  it('rejects payment creation without idempotencyKey', () => {
    expect(cpnProxy).toContain("'idempotencyKey is required (8–128 chars)'");
  });

  it('returns IDEMPOTENT_REPLAY (200) instead of creating duplicate payment', () => {
    expect(cpnProxy).toContain("status: 'IDEMPOTENT_REPLAY'");
    expect(cpnProxy).toContain("idempotent: true");
    expect(cpnProxy).toContain("'Payment already created with this idempotencyKey'");
  });

  it('idempotency key is scoped to userId (prevents cross-user collision)', () => {
    expect(cpnProxy).toContain('`cpn_idem:${userId}:${idempotencyKey}`');
  });
});

// ── 8. Pages Function — body size cap ────────────────────────────────────────
describe('functions/api/cpn/[[route]].mjs — body size cap', () => {
  it('MAX_BODY_BYTES constant is defined', () => {
    expect(cpnProxy).toContain('MAX_BODY_BYTES');
    expect(cpnProxy).toContain('32 * 1024');
  });

  it('readBodySafe rejects oversized bodies with 413', () => {
    expect(cpnProxy).toContain('async function readBodySafe(request)');
    expect(cpnProxy).toContain("'Request body too large'");
    expect(cpnProxy).toContain('413');
  });

  it('rejects non-JSON bodies', () => {
    expect(cpnProxy).toContain("'Invalid JSON body'");
  });
});

// ── 9. Pages Function — key isolation + safe errors ──────────────────────────
describe('functions/api/cpn/[[route]].mjs — key isolation and safe error messages', () => {
  it('exports onRequest handler', () => {
    expect(cpnProxy).toContain('export async function onRequest');
  });

  it('CPN_API_KEY only injected as Authorization header, never in response body', () => {
    expect(cpnProxy).toContain("'Bearer ' + apiKey");
    expect(cpnProxy).not.toContain('JSON.stringify(apiKey)');
    expect(cpnProxy).not.toContain('body: apiKey');
  });

  it('strips apiKey / Authorization fields from upstream response before forwarding', () => {
    expect(cpnProxy).toContain('delete upstreamJson.apiKey');
    expect(cpnProxy).toContain('delete upstreamJson.Authorization');
  });

  it('network errors are caught without leaking internal stack or address', () => {
    expect(cpnProxy).toContain("code: 'NETWORK_ERROR'");
    // Must NOT use String(networkErr) in the response
    expect(cpnProxy).not.toContain('String(networkErr)');
  });

  it('safeUpstreamError provides generic messages for each HTTP status', () => {
    expect(cpnProxy).toContain('function safeUpstreamError(status)');
    expect(cpnProxy).toContain("'CPN authentication failed'");
    expect(cpnProxy).toContain("'CPN access denied — OFI onboarding required'");
  });

  it('returns 503 when CPN_API_KEY is not configured', () => {
    expect(cpnProxy).toContain("'CPN not configured'");
    expect(cpnProxy).toContain('503');
  });

  it('health endpoint does not require auth and does not reveal key value', () => {
    expect(cpnProxy).toContain("cpnPath === 'health'");
    // configured is a boolean derived from the key, not the key value itself
    expect(cpnProxy).toContain("configured: !!(env && env.CPN_API_KEY)");
    expect(cpnProxy).not.toContain("configured: apiKey");
  });

  it('has no mock mode', () => {
    expect(cpnProxy).not.toContain('CPN_SANDBOX_MOCK');
    expect(cpnProxy).not.toContain('mockResponse');
    expect(cpnProxy).not.toContain('_mock');
    expect(cpnProxy).not.toContain("'mock-quote-001'");
  });

  it('CORS includes Vary: Origin header', () => {
    expect(cpnProxy).toContain("'Vary': 'Origin'");
  });
});

// ── 10. index.html — CPN UI elements ─────────────────────────────────────────
describe('index.html — CPN UI elements present', () => {
  it('CPN toggle button exists', () => { expect(html).toContain('id="sa-cpn-toggle"'); });
  it('CPN form hidden by default', () => { expect(html).toMatch(/id="sa-cpn-form"[^>]*style="display:none"/); });
  it('OFI onboarding notice exists', () => {
    expect(html).toContain('id="sa-cpn-notice"');
    expect(html).toContain('developers.circle.com/cpn/fiat-payouts');
  });
  it('all beneficiary + sender fields exist', () => {
    ['sa-cpn-currency','sa-cpn-bene-name','sa-cpn-bank-name','sa-cpn-account',
     'sa-cpn-country','sa-cpn-routing','sa-cpn-sender-name','sa-cpn-sender-country']
      .forEach(id => expect(html).toContain('id="' + id + '"'));
  });
  it('quote UI elements exist', () => {
    expect(html).toContain('id="sa-cpn-quote-preview"');
    expect(html).toContain('id="sa-cpn-quotes-list"');
    expect(html).toContain('id="sa-cpn-selected-quote"');
    expect(html).toContain('id="sa-cpn-quote-btn"');
  });
  it('CPN route preview rows exist in right panel', () => {
    ['sa-rt-cpn-rows','sa-rt-cpn-currency','sa-rt-cpn-rate','sa-rt-cpn-receives',
     'sa-rt-cpn-settlement','sa-rt-cpn-status']
      .forEach(id => expect(html).toContain('id="' + id + '"'));
  });
});

// ── 11. index.html — CPN JS functions ────────────────────────────────────────
describe('index.html — CPN JS functions', () => {
  it('saToggleCPN, saFetchCPNQuotes, saExecuteCPNPayout are defined', () => {
    expect(html).toContain('function saToggleCPN()');
    expect(html).toContain('async function saFetchCPNQuotes()');
    expect(html).toContain('async function saExecuteCPNPayout()');
  });

  it('_saCPNValidate checks wallet, amount, currency, beneficiary, quote', () => {
    expect(html).toContain('function _saCPNValidate()');
    ["'Connect wallet first'", "'Select destination currency'",
     "'Enter beneficiary name'", "'Enter bank name'",
     "'Fetch and select a quote first'"].forEach(s => expect(html).toContain(s));
  });

  it('_saCPNPoll polls until terminal state with timeout', () => {
    expect(html).toContain('async function _saCPNPoll');
    expect(html).toContain("'COMPLETED', 'FAILED', 'REVERSED', 'CANCELLED'");
    expect(html).toContain('CPN payment polling timed out');
  });

  it('_saCPNStatusLabel maps all statuses', () => {
    expect(html).toContain('function _saCPNStatusLabel');
    ['PENDING_REVIEW','FIAT_PENDING','ONCHAIN_CONFIRMED'].forEach(s => expect(html).toContain(s));
  });

  it('_cpnUuidFE generates a v4-like UUID', () => {
    expect(html).toContain('function _cpnUuidFE()');
    expect(html).toContain('xxxx-4xxx-yxxx');
  });
});

// ── 12. index.html — security: TX validation before sign ─────────────────────
describe('index.html — TX validation before signing (Fase 1 security)', () => {
  it('_saCPNValidateTxObject function is defined', () => {
    expect(html).toContain('function _saCPNValidateTxObject(txObj, opts)');
  });

  it('rejects invalid `to` address', () => {
    expect(html).toContain("'TX object has invalid `to` address'");
    expect(html).toContain('/^0x[0-9a-fA-F]{40}$/.test(txObj.to)');
  });

  it('rejects chainId not in _CPN_ALLOWED_CHAIN_IDS', () => {
    expect(html).toContain('_CPN_ALLOWED_CHAIN_IDS');
    expect(html).toContain("'TX object chainId ' + cid + ' is not an allowed CPN chain'");
  });

  it('rejects non-hex data field', () => {
    expect(html).toContain("'TX data field is not valid hex'");
  });

  it('rejects excessive native value', () => {
    expect(html).toContain("'TX native value exceeds safety limit (possible value-draining TX)'");
    expect(html).toContain("BigInt('10000000000000000')");
  });

  it('rejects `from` mismatch with authenticated wallet', () => {
    expect(html).toContain("'TX `from` does not match authenticated wallet'");
    expect(html).toContain('opts.walletAddress');
  });

  it('_saCPNValidateTxObject is called before signer.signTransaction in saExecuteCPNPayout', () => {
    const payoutFn = html.slice(
      html.indexOf('async function saExecuteCPNPayout()'),
      html.indexOf('// ── TX validation (client-side mirror')
    );
    const validateIdx = payoutFn.indexOf('_saCPNValidateTxObject(');
    const signIdx     = payoutFn.indexOf('signer.signTransaction(');
    expect(validateIdx).toBeGreaterThan(-1);
    expect(signIdx).toBeGreaterThan(-1);
    // validation must precede signing
    expect(validateIdx).toBeLessThan(signIdx);
  });

  it('throws before signing when validation fails', () => {
    expect(html).toContain("throw new Error('TX validation failed: ' + txValidationError)");
  });
});

// ── 13. index.html — idempotency key management ──────────────────────────────
describe('index.html — idempotency key stability (prevents duplicate payments)', () => {
  it('_saCPNIdempotencyKey is declared as a module-level variable', () => {
    expect(html).toContain('let _saCPNIdempotencyKey = null');
  });

  it('key is generated only when null (not regenerated on retry)', () => {
    // Pattern: generate iff currently null
    expect(html).toContain('if (!_saCPNIdempotencyKey)');
    expect(html).toContain('_saCPNIdempotencyKey = _cpnUuidFE()');
  });

  it('key is reused as idemKey throughout the same payout attempt', () => {
    expect(html).toContain('var idemKey = _saCPNIdempotencyKey');
    expect(html).toContain('idempotencyKey:      idemKey');
  });

  it('key is cleared ONLY on confirmed success (COMPLETED), not on error', () => {
    const payoutFn = html.slice(
      html.indexOf('async function saExecuteCPNPayout()'),
      html.indexOf('// ── TX validation (client-side mirror')
    );
    // Success path clears the key
    expect(payoutFn).toContain('_saCPNIdempotencyKey = null');
    // The null assignment must be inside the isComplete block, not in the catch
    const successClear = payoutFn.indexOf('_saCPNIdempotencyKey = null');
    const catchBlock   = payoutFn.indexOf('} catch (e)');
    expect(successClear).toBeLessThan(catchBlock);
  });

  it('key is cleared when user cancels CPN mode (saToggleCPN exit path)', () => {
    const toggleFn = html.slice(
      html.indexOf('function saToggleCPN()'),
      html.indexOf('// Local set_ helper')
    );
    expect(toggleFn).toContain('_saCPNIdempotencyKey = null');
  });

  it('server handles IDEMPOTENT_REPLAY without treating it as an error', () => {
    expect(html).toContain("wasReplay = paymentData.idempotent === true");
    expect(html).toContain("'Resuming existing payment…'");
  });
});

// ── 14. index.html — credentials:same-origin on all CPN fetches ──────────────
describe('index.html — session cookie sent with all CPN requests', () => {
  it('saFetchCPNQuotes includes credentials:same-origin', () => {
    expect(html).toContain("credentials: 'same-origin'");
  });

  it('payment creation fetch includes credentials:same-origin', () => {
    const payoutFn = html.slice(
      html.indexOf('async function saExecuteCPNPayout()'),
      html.indexOf('// ── TX validation (client-side mirror')
    );
    const count = (payoutFn.match(/credentials:\s*'same-origin'/g) || []).length;
    // creation + txObject + submit = at least 3
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it('poll fetch includes credentials:same-origin', () => {
    const pollFn = html.slice(
      html.indexOf('async function _saCPNPoll'),
      html.indexOf('function _saCPNStatusLabel')
    );
    expect(pollFn).toContain("credentials: 'same-origin'");
  });
});

// ── 15. index.html — send button dispatch ────────────────────────────────────
describe('index.html — send button dispatch', () => {
  it('send button calls saDispatchSend()', () => {
    expect(html).toContain('onclick="saDispatchSend()"');
  });

  it('saDispatchSend routes to CPN or normal send', () => {
    expect(html).toContain('function saDispatchSend()');
    const block = html.slice(html.indexOf('function saDispatchSend()'), html.indexOf('function saDispatchSend()') + 300);
    expect(block).toContain('saExecuteCPNPayout()');
    expect(block).toContain('saExecuteSend()');
  });

  it('saExecuteSend is preserved (not removed)', () => {
    expect(html).toContain('async function saExecuteSend()');
  });
});

// ── 16. index.html — 5-step OFI flow ─────────────────────────────────────────
describe('index.html — 5-step OFI payment flow in saExecuteCPNPayout', () => {
  it('uses pre-fetched quote (no duplicate quote call inside payout fn)', () => {
    const payoutFn = html.slice(
      html.indexOf('async function saExecuteCPNPayout()'),
      html.indexOf('// ── TX validation (client-side mirror')
    );
    expect(payoutFn).not.toContain('saFetchCPNQuotes()');
  });

  it('signs with signer.signTransaction, never signer.sendTransaction', () => {
    const payoutFn = html.slice(
      html.indexOf('async function saExecuteCPNPayout()'),
      html.indexOf('// ── TX validation (client-side mirror')
    );
    expect(payoutFn).toContain('signer.signTransaction(rawTx)');
    expect(payoutFn).not.toContain('signer.sendTransaction');
  });

  it('validates TX before signing (not after)', () => {
    const payoutFn = html.slice(
      html.indexOf('async function saExecuteCPNPayout()'),
      html.indexOf('// ── TX validation (client-side mirror')
    );
    const validateIdx = payoutFn.indexOf('_saCPNValidateTxObject(');
    const signIdx     = payoutFn.indexOf('signer.signTransaction(');
    expect(validateIdx).toBeLessThan(signIdx);
  });

  it('does not mark payment complete until COMPLETED status from poll', () => {
    expect(html).toContain("finalPayment.status === 'COMPLETED'");
    expect(html).not.toContain("'Completed!' // on payment create");
  });

  it('logs type cpn-fiat to activity, without bank account number', () => {
    expect(html).toContain("type: 'cpn-fiat'");
    // account number must not appear in the saLogTx call
    const logCall = html.slice(
      html.lastIndexOf('saLogTx({', html.indexOf('// ── CPN polling')),
      html.indexOf('// ── CPN polling')
    );
    expect(logCall).not.toContain('accountNumber');
    expect(logCall).not.toContain('sa-cpn-account');
  });
});

// ── 17. Security — CPN_API_KEY never in browser ───────────────────────────────
describe('Security — CPN_API_KEY never exposed to the browser', () => {
  it('index.html has no hardcoded CPN_API_KEY value', () => {
    expect(html).not.toMatch(/CPN_API_KEY\s*=\s*["'][a-zA-Z0-9_-]{10,}/);
  });

  it('index.html has no hardcoded Bearer token for CPN', () => {
    const bearerMatches = html.match(/Bearer\s+[a-zA-Z0-9_.-]{20,}/g) || [];
    bearerMatches.forEach(m => { expect(m).not.toMatch(/Bearer\s+cfut_/); });
  });

  it('cpnFiatPayout.js only calls /api/cpn/* (never api.circle.com)', () => {
    expect(cpnModule).not.toContain('api.circle.com');
    expect(cpnModule).toContain('/api/cpn/');
  });

  it('Pages Function is the only place Bearer token is assembled', () => {
    expect(cpnProxy).toContain("'Bearer ' + apiKey");
    expect(cpnProxy).not.toMatch(/Bearer\s+[a-zA-Z0-9_-]{20,}/);
  });

  it('Pages Function does not log apiKey, CPN_API_KEY, or Authorization headers', () => {
    // No console.log/warn/error with the key variable in scope
    expect(cpnProxy).not.toContain('console.log(apiKey)');
    expect(cpnProxy).not.toContain('console.log(CPN_API_KEY)');
  });
});

// ── 18. .dev.vars.example — configuration ────────────────────────────────────
describe('.dev.vars.example — CPN configuration', () => {
  it('documents CPN_API_KEY', () => { expect(devVarsEx).toContain('CPN_API_KEY='); });
  it('explains there is no mock mode', () => { expect(devVarsEx).toContain('no mock mode'); });
  it('links to CPN docs', () => { expect(devVarsEx).toContain('developers.circle.com/cpn'); });
  it('explains OFI onboarding requirement', () => { expect(devVarsEx).toContain('OFI onboarding'); });
});

// ── 19. Shared sync ───────────────────────────────────────────────────────────
describe('Shared sync — public/shared/cpnFiatPayout.js identical to shared/', () => {
  it('public copy exists and is non-empty', () => {
    const pub = readFileSync(path.join(ROOT, 'public/shared/cpnFiatPayout.js'), 'utf8');
    expect(pub.length).toBeGreaterThan(100);
  });

  it('public copy is byte-for-byte identical to source', () => {
    const src = readFileSync(path.join(ROOT, 'shared/cpnFiatPayout.js'), 'utf8');
    const pub = readFileSync(path.join(ROOT, 'public/shared/cpnFiatPayout.js'), 'utf8');
    expect(pub).toBe(src);
  });
});

// ── 20. Regression guards ─────────────────────────────────────────────────────
describe('Regression guards — existing Send Assets and Batch flows unaffected', () => {
  it('saExecuteSend preserved', () => { expect(html).toContain('async function saExecuteSend()'); });
  it('saUpdateRoute preserved',  () => { expect(html).toContain('function saUpdateRoute()'); });
  it('saSelectAsset preserved',  () => { expect(html).toContain('function saSelectAsset('); });
  it('saRefreshBalance preserved',() => { expect(html).toContain('async function saRefreshBalance()'); });
  it('saExecuteCrossChain preserved', () => { expect(html).toContain('function saExecuteCrossChain()'); });
  it('saExecuteCCTPCrossChain preserved', () => { expect(html).toContain('async function saExecuteCCTPCrossChain()'); });
  it('saLogTx preserved',        () => { expect(html).toContain('function saLogTx('); });
  it('sa-recipient field preserved', () => { expect(html).toContain('id="sa-recipient"'); });
  it('sa-dest-network preserved',    () => { expect(html).toContain('id="sa-dest-network"'); });
  it('CPN form hidden by default',   () => { expect(html).toMatch(/id="sa-cpn-form"[^>]*style="display:none"/); });
  it('CPN route rows hidden by default', () => { expect(html).toMatch(/id="sa-rt-cpn-rows"[^>]*style="display:none"/); });
  it('Swap page unaffected',     () => { expect(html).toContain('id="page-swap"'); });
  it('Bridge page unaffected',   () => { expect(html).toContain('id="page-bridge"'); });
  it('Schedule page unaffected', () => { expect(html).toContain('id="page-schedule"'); });
  it('Batch page unaffected',    () => { expect(html).toContain('id="page-batch"'); });
});
