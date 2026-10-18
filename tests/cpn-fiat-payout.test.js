/**
 * CPN Fiat Payout — test suite
 *
 * Covers:
 *  1. shared/cpnFiatPayout.js — module structure, validation, helpers
 *  2. functions/api/cpn/[[route]].mjs — proxy structure, path allowlist
 *  3. index.html — UI elements, JS functions, send-button dispatch
 *  4. Regression guards — existing Send Assets flow not affected
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const cpnModule = readFileSync(path.join(ROOT, 'shared/cpnFiatPayout.js'), 'utf8');
const cpnProxy  = readFileSync(path.join(ROOT, 'functions/api/cpn/[[route]].mjs'), 'utf8');
const devVarsEx = readFileSync(path.join(ROOT, '.dev.vars.example'), 'utf8');

// ── 1. cpnFiatPayout.js — module structure ───────────────────────────────────
describe('shared/cpnFiatPayout.js — module structure', () => {
  it('exports CPNFiatPayout as window or module.exports', () => {
    expect(cpnModule).toMatch(/window\.CPNFiatPayout\s*=/);
    expect(cpnModule).toMatch(/module\.exports\s*=/);
  });

  it('exposes getQuotes function', () => {
    expect(cpnModule).toContain('getQuotes:');
    expect(cpnModule).toContain('async function getQuotes');
  });

  it('exposes createPayment function', () => {
    expect(cpnModule).toContain('createPayment:');
    expect(cpnModule).toContain('async function createPayment');
  });

  it('exposes getTransactionObject function', () => {
    expect(cpnModule).toContain('getTransactionObject:');
    expect(cpnModule).toContain('async function getTransactionObject');
  });

  it('exposes submitSignedTransaction function', () => {
    expect(cpnModule).toContain('submitSignedTransaction:');
    expect(cpnModule).toContain('async function submitSignedTransaction');
  });

  it('exposes getPaymentStatus function', () => {
    expect(cpnModule).toContain('getPaymentStatus:');
    expect(cpnModule).toContain('async function getPaymentStatus');
  });

  it('exposes pollPaymentStatus function', () => {
    expect(cpnModule).toContain('pollPaymentStatus:');
    expect(cpnModule).toContain('async function pollPaymentStatus');
  });

  it('exposes executeFiatPayout high-level orchestrator', () => {
    expect(cpnModule).toContain('executeFiatPayout:');
    expect(cpnModule).toContain('async function executeFiatPayout');
  });

  it('exposes validateBeneficiary and validateSender', () => {
    expect(cpnModule).toContain('validateBeneficiary:');
    expect(cpnModule).toContain('validateSender:');
  });

  it('exposes getSupportedCurrencies returning an array', () => {
    expect(cpnModule).toContain('getSupportedCurrencies:');
    expect(cpnModule).toContain('return CPN_CURRENCIES.slice()');
  });

  it('exposes STATUS_MAP with all CPN terminal states', () => {
    expect(cpnModule).toContain("'COMPLETED'");
    expect(cpnModule).toContain("'FAILED'");
    expect(cpnModule).toContain("'REVERSED'");
    expect(cpnModule).toContain("'CANCELLED'");
  });
});

// ── 2. cpnFiatPayout.js — validation logic ───────────────────────────────────
describe('shared/cpnFiatPayout.js — validateBeneficiary', () => {
  it('returns error when currency missing', () => {
    expect(cpnModule).toContain("'Select a destination currency'");
  });

  it('returns error when name too short', () => {
    expect(cpnModule).toContain("'Beneficiary name required (min 2 chars)'");
  });

  it('returns error when bank name missing', () => {
    expect(cpnModule).toContain("'Bank name required'");
  });

  it('returns error when account number missing', () => {
    expect(cpnModule).toContain("'Account number required'");
  });

  it('returns error when country code invalid', () => {
    expect(cpnModule).toContain("'Country code required (2-letter ISO)'");
  });

  it('returns null on valid beneficiary', () => {
    // validateBeneficiary returns null when all fields are present
    expect(cpnModule).toContain('function validateBeneficiary(b)');
    expect(cpnModule).toContain('return null;');
  });
});

describe('shared/cpnFiatPayout.js — validateSender', () => {
  it('requires sender name', () => {
    expect(cpnModule).toContain("'Sender name required'");
  });

  it('requires sender country code', () => {
    expect(cpnModule).toContain("'Sender country code required'");
  });
});

// ── 3. cpnFiatPayout.js — proxy path structure ───────────────────────────────
describe('shared/cpnFiatPayout.js — proxy API calls', () => {
  it('calls /api/cpn/quotes (not the Circle API directly)', () => {
    expect(cpnModule).toContain("'/api/cpn/'");
    expect(cpnModule).not.toContain("api.circle.com/v2/cpn");
  });

  it('does NOT include any API key or secret value in the module', () => {
    // No hardcoded Bearer tokens
    expect(cpnModule).not.toMatch(/Bearer\s+[a-zA-Z0-9_-]{10,}/);
    // CPN_API_KEY may appear in comments explaining it is server-side only —
    // but must NOT appear as an assignment or value expression
    expect(cpnModule).not.toMatch(/CPN_API_KEY\s*[:=]\s*["'`]/);
    expect(cpnModule).not.toMatch(/env\.CPN_API_KEY/);
  });

  it('forwards POST body as JSON', () => {
    expect(cpnModule).toContain("JSON.stringify(body)");
  });

  it('throws a descriptive error when CPN API returns non-ok status', () => {
    expect(cpnModule).toContain('var msg = (json && (json.message || json.error))');
    expect(cpnModule).toContain('var err = new Error(msg)');
    expect(cpnModule).toContain('err.status = res.status');
  });
});

// ── 4. CPN Pages Function proxy ──────────────────────────────────────────────
describe('functions/api/cpn/[[route]].mjs — proxy structure', () => {
  it('exports onRequest handler', () => {
    expect(cpnProxy).toContain('export async function onRequest');
  });

  it('proxies to api.circle.com/v2/cpn', () => {
    expect(cpnProxy).toContain('https://api.circle.com/v2/cpn');
  });

  it('injects Authorization: Bearer header from env.CPN_API_KEY', () => {
    expect(cpnProxy).toContain("'Bearer ' + apiKey");
    expect(cpnProxy).toContain('env && env.CPN_API_KEY');
  });

  it('CPN_API_KEY is read from env, never a constant string', () => {
    // Should not contain a hardcoded token
    expect(cpnProxy).not.toMatch(/Bearer\s+[a-zA-Z0-9_-]{10,}/);
  });

  it('returns 503 when CPN_API_KEY is not configured', () => {
    expect(cpnProxy).toContain("'CPN not configured'");
    expect(cpnProxy).toContain('503');
  });

  it('has no mock mode — no CPN_SANDBOX_MOCK branch', () => {
    expect(cpnProxy).not.toContain('CPN_SANDBOX_MOCK');
    expect(cpnProxy).not.toContain('mockResponse');
    expect(cpnProxy).not.toContain('_mock');
  });

  it('has no hardcoded mock data', () => {
    expect(cpnProxy).not.toContain("'mock-quote-001'");
    expect(cpnProxy).not.toContain("mock-payment-");
    expect(cpnProxy).not.toContain("mock-tx-");
  });

  it('validates paths against an allowlist (no arbitrary upstream calls)', () => {
    expect(cpnProxy).toContain('ALLOWED_PATHS');
    expect(cpnProxy).toContain('isAllowedPath');
    expect(cpnProxy).toContain("'CPN path not allowed'");
  });

  it('handles CORS preflight (OPTIONS)', () => {
    expect(cpnProxy).toContain("request.method === 'OPTIONS'");
    expect(cpnProxy).toContain('Access-Control-Allow-Origin');
  });

  it('includes /health path (no key needed)', () => {
    expect(cpnProxy).toContain("cpnPath === 'health'");
    expect(cpnProxy).toContain("configured: hasKey");
  });

  it('forwards quotes, payments, transactions, submit paths', () => {
    expect(cpnProxy).toContain('/^quotes$/');
    expect(cpnProxy).toContain('/^payments$/');
    expect(cpnProxy).toContain('/^payments\\/');
    expect(cpnProxy).toContain('transactions');
    expect(cpnProxy).toContain('submit');
  });

  it('does not expose the API key in the response body', () => {
    // The proxy must not echo back env.CPN_API_KEY in any response path
    expect(cpnProxy).not.toContain('JSON.stringify(apiKey)');
    expect(cpnProxy).not.toContain('body: apiKey');
  });
});

// ── 5. index.html — UI elements ──────────────────────────────────────────────
describe('index.html — CPN UI elements present', () => {
  it('CPN toggle button exists', () => {
    expect(html).toContain('id="sa-cpn-toggle"');
  });

  it('CPN form container exists and is hidden by default', () => {
    expect(html).toContain('id="sa-cpn-form"');
    expect(html).toMatch(/id="sa-cpn-form"[^>]*style="display:none"/);
  });

  it('OFI onboarding notice exists', () => {
    expect(html).toContain('id="sa-cpn-notice"');
    expect(html).toContain('developers.circle.com/cpn/fiat-payouts');
  });

  it('destination currency selector exists', () => {
    expect(html).toContain('id="sa-cpn-currency"');
  });

  it('beneficiary name field exists', () => {
    expect(html).toContain('id="sa-cpn-bene-name"');
  });

  it('bank name field exists', () => {
    expect(html).toContain('id="sa-cpn-bank-name"');
  });

  it('account number field exists', () => {
    expect(html).toContain('id="sa-cpn-account"');
  });

  it('country code field exists', () => {
    expect(html).toContain('id="sa-cpn-country"');
  });

  it('routing / SWIFT field exists (optional)', () => {
    expect(html).toContain('id="sa-cpn-routing"');
  });

  it('sender name field exists (travel rule)', () => {
    expect(html).toContain('id="sa-cpn-sender-name"');
  });

  it('sender country field exists (travel rule)', () => {
    expect(html).toContain('id="sa-cpn-sender-country"');
  });

  it('live quote preview container exists', () => {
    expect(html).toContain('id="sa-cpn-quote-preview"');
  });

  it('quotes list container exists', () => {
    expect(html).toContain('id="sa-cpn-quotes-list"');
  });

  it('selected quote display exists', () => {
    expect(html).toContain('id="sa-cpn-selected-quote"');
  });

  it('Get Live FX Quote button exists', () => {
    expect(html).toContain('id="sa-cpn-quote-btn"');
    expect(html).toContain('saFetchCPNQuotes()');
  });

  it('CPN route preview rows in right panel', () => {
    expect(html).toContain('id="sa-rt-cpn-rows"');
    expect(html).toContain('id="sa-rt-cpn-currency"');
    expect(html).toContain('id="sa-rt-cpn-rate"');
    expect(html).toContain('id="sa-rt-cpn-receives"');
    expect(html).toContain('id="sa-rt-cpn-settlement"');
    expect(html).toContain('id="sa-rt-cpn-status"');
  });
});

// ── 6. index.html — CPN JS functions ─────────────────────────────────────────
describe('index.html — CPN JS functions', () => {
  it('saToggleCPN is defined', () => {
    expect(html).toContain('function saToggleCPN()');
  });

  it('saFetchCPNQuotes is defined', () => {
    expect(html).toContain('async function saFetchCPNQuotes()');
  });

  it('saExecuteCPNPayout is defined', () => {
    expect(html).toContain('async function saExecuteCPNPayout()');
  });

  it('saDispatchSend routes to CPN or normal send', () => {
    expect(html).toContain('function saDispatchSend()');
    expect(html).toContain('if (_saCPNMode)');
    expect(html).toContain('saExecuteCPNPayout()');
    expect(html).toContain('saExecuteSend()');
  });

  it('_saCPNValidate checks all required fields', () => {
    expect(html).toContain('function _saCPNValidate()');
    expect(html).toContain("'Connect wallet first'");
    expect(html).toContain("'Select destination currency'");
    expect(html).toContain("'Enter beneficiary name'");
    expect(html).toContain("'Enter bank name'");
    expect(html).toContain("'Fetch and select a quote first'");
  });

  it('_saCPNPoll polls until terminal state', () => {
    expect(html).toContain('async function _saCPNPoll');
    expect(html).toContain("'COMPLETED', 'FAILED', 'REVERSED', 'CANCELLED'");
    expect(html).toContain('CPN payment polling timed out');
  });

  it('_saCPNStatusLabel maps all CPN statuses', () => {
    expect(html).toContain('function _saCPNStatusLabel');
    expect(html).toContain('PENDING_REVIEW');
    expect(html).toContain('FIAT_PENDING');
    expect(html).toContain('ONCHAIN_CONFIRMED');
  });

  it('_cpnUuidFE generates idempotency key', () => {
    expect(html).toContain('function _cpnUuidFE()');
    expect(html).toContain('xxxx-4xxx-yxxx');
  });

  it('_saCPNPopulateCurrencies is defined and idempotent', () => {
    expect(html).toContain('function _saCPNPopulateCurrencies()');
    expect(html).toContain('sel.options.length > 1) return');
  });

  it('_saCPNSelectQuote updates route preview', () => {
    expect(html).toContain('function _saCPNSelectQuote');
    expect(html).toContain("set_('sa-rt-cpn-rate'");
    expect(html).toContain("set_('sa-rt-cpn-receives'");
  });

  it('saToggleCPN shows/hides CPN form and CPN route rows together', () => {
    expect(html).toContain("form.style.display = ''");
    expect(html).toContain("cpnRows.style.display = ''");
    expect(html).toContain("form.style.display = 'none'");
    expect(html).toContain("cpnRows.style.display = 'none'");
  });

  it('saToggleCPN hides recipient and dest-network rows in CPN mode', () => {
    expect(html).toContain("recipientRow.style.display = 'none'");
    expect(html).toContain("destNetworkRow.style.display = 'none'");
  });

  it('saUpdateRoute is patched to honour CPN validation', () => {
    expect(html).toContain('var _saUpdateRouteOrig = saUpdateRoute');
    expect(html).toContain('saUpdateRoute = function()');
    expect(html).toContain("'Ready to send via CPN'");
  });
});

// ── 7. index.html — send button dispatch ─────────────────────────────────────
describe('index.html — send button uses saDispatchSend (not saExecuteSend directly)', () => {
  it('send button calls saDispatchSend()', () => {
    expect(html).toContain('onclick="saDispatchSend()"');
  });

  it('saExecuteSend is still defined (not removed)', () => {
    expect(html).toContain('async function saExecuteSend()');
  });

  it('saDispatchSend calls saExecuteCPNPayout when _saCPNMode is true', () => {
    const block = html.slice(html.indexOf('function saDispatchSend()'), html.indexOf('function saDispatchSend()') + 200);
    expect(block).toContain('saExecuteCPNPayout()');
    expect(block).toContain('saExecuteSend()');
  });
});

// ── 8. CPN payment flow — 5-step OFI workflow ────────────────────────────────
describe('CPN payment flow — 5-step OFI workflow in saExecuteCPNPayout', () => {
  it('Step 1: uses _saCPNSelectedQuote (no duplicate quote fetch)', () => {
    expect(html).toContain('_saCPNSelectedQuote');
    // saExecuteCPNPayout should not call saFetchCPNQuotes — it uses pre-fetched quote
    const payoutFn = html.slice(
      html.indexOf('async function saExecuteCPNPayout()'),
      html.indexOf('// ── CPN polling')
    );
    expect(payoutFn).not.toContain('saFetchCPNQuotes()');
  });

  it('Step 2: POSTs to /api/cpn/payments with idempotencyKey', () => {
    expect(html).toContain("'/api/cpn/payments'");
    expect(html).toContain('idempotencyKey:');
    expect(html).toContain('_cpnUuidFE()');
  });

  it('Step 3: POSTs to /api/cpn/payments/:id/transactions', () => {
    expect(html).toContain("'/api/cpn/payments/' + _saCPNPaymentId + '/transactions'");
  });

  it('Step 4: signs transaction via signer.signTransaction (not sendTransaction)', () => {
    expect(html).toContain('signer.signTransaction(rawTx)');
    // Must NOT send first — must sign then submit to CPN
    const payoutFn = html.slice(
      html.indexOf('async function saExecuteCPNPayout()'),
      html.indexOf('// ── END CPN FIAT PAYOUT')
    );
    const signIdx = payoutFn.indexOf('signer.signTransaction');
    const sendIdx = payoutFn.indexOf('signer.sendTransaction');
    // sendTransaction should not appear in the CPN payout path
    expect(sendIdx).toBe(-1);
    expect(signIdx).toBeGreaterThan(-1);
  });

  it('Step 5: submits signed tx to /api/cpn/payments/:id/transactions/:txId/submit', () => {
    expect(html).toContain("'/api/cpn/payments/' + _saCPNPaymentId + '/transactions/' + txObjData.transactionId + '/submit'");
  });

  it('Step 6: polls via _saCPNPoll until terminal state', () => {
    expect(html).toContain('await _saCPNPoll(_saCPNPaymentId');
  });

  it('logs the CPN payout to saLogTx with type cpn-fiat', () => {
    expect(html).toContain("type: 'cpn-fiat'");
    expect(html).toContain("network: 'CPN'");
  });
});

// ── 9. Security — CPN_API_KEY never in browser ───────────────────────────────
describe('Security — CPN_API_KEY never exposed to the browser', () => {
  it('index.html does not contain CPN_API_KEY as a value', () => {
    expect(html).not.toMatch(/CPN_API_KEY\s*=\s*["'][a-zA-Z0-9_-]{10,}/);
  });

  it('index.html does not hardcode a Bearer token for CPN', () => {
    // The inline HTML/JS must not contain any hardcoded Bearer token string
    const bearerMatches = html.match(/Bearer\s+[a-zA-Z0-9_.-]{20,}/g) || [];
    // Allow "Bearer " + variable (like "Bearer ' + apiKey" in cpnProxy) — but not a literal key
    bearerMatches.forEach(m => {
      expect(m).not.toMatch(/Bearer\s+cfut_/);
    });
  });

  it('cpnFiatPayout.js only calls /api/cpn/* (server-side proxy)', () => {
    expect(cpnModule).not.toContain('api.circle.com');
    expect(cpnModule).toContain('/api/cpn/');
  });

  it('Pages Function is the only place the CPN_API_KEY is injected', () => {
    expect(cpnProxy).toContain("'Bearer ' + apiKey");
    expect(cpnProxy).toContain('env && env.CPN_API_KEY');
    // Must never hardcode the key
    expect(cpnProxy).not.toMatch(/Bearer\s+[a-zA-Z0-9_-]{20,}/);
  });
});

// ── 10. .dev.vars.example — CPN config documented ────────────────────────────
describe('.dev.vars.example — CPN configuration', () => {
  it('documents CPN_API_KEY', () => {
    expect(devVarsEx).toContain('CPN_API_KEY=');
  });

  it('explains there is no mock mode', () => {
    expect(devVarsEx).toContain('no mock mode');
  });

  it('links to CPN docs', () => {
    expect(devVarsEx).toContain('developers.circle.com/cpn');
  });

  it('explains OFI onboarding requirement', () => {
    expect(devVarsEx).toContain('OFI onboarding');
  });
});

// ── 11. shared/cpnFiatPayout.js synced to public/ ────────────────────────────
describe('Shared sync — public/shared/cpnFiatPayout.js is identical to shared/', () => {
  it('public copy exists', () => {
    const publicCopy = readFileSync(path.join(ROOT, 'public/shared/cpnFiatPayout.js'), 'utf8');
    expect(publicCopy.length).toBeGreaterThan(100);
  });

  it('public copy is identical to source', () => {
    const sourceCopy = readFileSync(path.join(ROOT, 'shared/cpnFiatPayout.js'), 'utf8');
    const publicCopy = readFileSync(path.join(ROOT, 'public/shared/cpnFiatPayout.js'), 'utf8');
    expect(publicCopy).toBe(sourceCopy);
  });
});

// ── 12. Regression guards — existing Send Assets flow unaffected ──────────────
describe('Regression guards — existing Send Assets flow', () => {
  it('saExecuteSend is still defined (not replaced)', () => {
    expect(html).toContain('async function saExecuteSend()');
  });

  it('saUpdateRoute is still defined', () => {
    expect(html).toContain('function saUpdateRoute()');
  });

  it('saSelectAsset is still defined', () => {
    expect(html).toContain('function saSelectAsset(');
  });

  it('saRefreshBalance is still defined', () => {
    expect(html).toContain('async function saRefreshBalance()');
  });

  it('saExecuteCrossChain is still defined', () => {
    expect(html).toContain('function saExecuteCrossChain()');
  });

  it('saExecuteCCTPCrossChain is still defined', () => {
    expect(html).toContain('async function saExecuteCCTPCrossChain()');
  });

  it('saLogTx is still defined', () => {
    expect(html).toContain('function saLogTx(');
  });

  it('saRenderActivity is still defined', () => {
    expect(html).toContain('function saRenderActivity()');
  });

  it('sa-recipient field still exists (used in crypto mode)', () => {
    expect(html).toContain('id="sa-recipient"');
  });

  it('sa-dest-network select still exists (used in crypto mode)', () => {
    expect(html).toContain('id="sa-dest-network"');
  });

  it('CPN form is hidden by default (display:none)', () => {
    expect(html).toMatch(/id="sa-cpn-form"[^>]*style="display:none"/);
  });

  it('CPN route rows are hidden by default', () => {
    expect(html).toMatch(/id="sa-rt-cpn-rows"[^>]*style="display:none"/);
  });

  it('Swap page not affected', () => {
    expect(html).toContain('id="page-swap"');
  });

  it('Bridge page not affected', () => {
    expect(html).toContain('id="page-bridge"');
  });

  it('Schedule page not affected', () => {
    expect(html).toContain('id="page-schedule"');
  });

  it('Batch page not affected', () => {
    expect(html).toContain('id="page-batch"');
  });
});
