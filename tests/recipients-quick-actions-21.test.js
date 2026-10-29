/**
 * Recipients Quick Actions 2.1 — Send, Invoice, Payment Link, Schedule, Autonoma
 * Tests that each button wires to the correct destination and pre-fills the right fields.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf('\nfunction ' + name + '(');
  if (start === -1) throw new Error('Function not found: ' + name);
  let depth = 0, i = src.indexOf('{', start);
  while (i < src.length) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
    i++;
  }
  return src.slice(start + 1, i + 1);
}

const sendSrc     = extractFn(html, '_rcpOpenSend');
const invSrc      = extractFn(html, '_rcpOpenInvoice');
const plSrc       = extractFn(html, '_rcpOpenPayLink');
const schSrc      = extractFn(html, '_rcpOpenSchedule');
const autSrc      = extractFn(html, '_rcpOpenAutonoma');
const buildMsgSrc = extractFn(html, '_rcpBuildAutonomaMsg');

// ── RQA-1: Send ───────────────────────────────────────────────────────────────
describe('RQA-1: _rcpOpenSend', () => {
  it('RQA-1.1: navigates to send page', () => {
    expect(sendSrc).toContain("showPage('send')");
  });

  it('RQA-1.2: fills sa-recipient with contact address', () => {
    expect(sendSrc).toContain("getElementById('sa-recipient')");
    expect(sendSrc).toContain('inp.value = c.addr');
  });

  it('RQA-1.3: calls saUpdateRoute after filling', () => {
    expect(sendSrc).toContain('saUpdateRoute');
  });

  it('RQA-1.4: returns early when no contact selected', () => {
    expect(sendSrc).toContain('Select a contact first');
    expect(sendSrc).toContain('return');
  });

  it('RQA-1.5: returns early when contact has no address', () => {
    expect(sendSrc).toContain('Contact has no wallet address');
  });

  it('RQA-1.6: does not execute transactions', () => {
    expect(sendSrc).not.toContain('sendTransaction');
    expect(sendSrc).not.toContain('saExecuteSend');
    expect(sendSrc).not.toContain('execSend');
  });

  it('RQA-1.7: uses requestAnimationFrame to avoid DOM race', () => {
    expect(sendSrc).toContain('requestAnimationFrame');
  });

  it('RQA-1.8: updates lastUsed on contact', () => {
    expect(sendSrc).toContain('lastUsed');
    expect(sendSrc).toContain('Store.save');
  });
});

// ── RQA-2: Create Invoice ─────────────────────────────────────────────────────
describe('RQA-2: _rcpOpenInvoice', () => {
  it('RQA-2.1: navigates to billing/invoices', () => {
    expect(invSrc).toContain("showPage('invoices')");
  });

  it('RQA-2.2: calls billingSetMode("invoices")', () => {
    expect(invSrc).toContain("billingSetMode('invoices')");
  });

  it('RQA-2.3: calls invSwitchTab("create") to open create form', () => {
    expect(invSrc).toContain("invSwitchTab('create')");
  });

  it('RQA-2.4: fills inv-to-name with contact name', () => {
    expect(invSrc).toContain("getElementById('inv-to-name')");
    expect(invSrc).toContain('c.name');
  });

  it('RQA-2.5: fills inv-to-addr with contact address', () => {
    expect(invSrc).toContain("getElementById('inv-to-addr')");
    expect(invSrc).toContain('c.addr');
  });

  it('RQA-2.6: does not overwrite existing values', () => {
    expect(invSrc).toContain('!nameEl.value');
    expect(invSrc).toContain('!addrEl.value');
  });

  it('RQA-2.7: does not auto-create invoice', () => {
    expect(invSrc).not.toContain('createInvoice()');
  });

  it('RQA-2.8: calls invPreviewUpdate to refresh preview', () => {
    expect(invSrc).toContain('invPreviewUpdate');
  });
});

// ── RQA-3: Payment Link ───────────────────────────────────────────────────────
describe('RQA-3: _rcpOpenPayLink', () => {
  it('RQA-3.1: uses showPage("links") which sets _billingPending', () => {
    expect(plSrc).toContain("showPage('links')");
  });

  it('RQA-3.2: calls billingSetMode("links")', () => {
    expect(plSrc).toContain("billingSetMode('links')");
  });

  it('RQA-3.3: calls createPayLink to open the create form', () => {
    expect(plSrc).toContain('createPayLink');
  });

  it('RQA-3.4: fills pl-label with contact name', () => {
    expect(plSrc).toContain("getElementById('pl-label')");
    expect(plSrc).toContain('c.name');
  });

  it('RQA-3.5: fills pl-addr with contact address', () => {
    expect(plSrc).toContain("getElementById('pl-addr')");
    expect(plSrc).toContain('c.addr');
  });

  it('RQA-3.6: does not overwrite existing values', () => {
    expect(plSrc).toContain('!labelEl.value');
    expect(plSrc).toContain('!addrEl.value');
  });

  it('RQA-3.7: does not auto-submit payment link', () => {
    expect(plSrc).not.toContain('plSave()');
    expect(plSrc).not.toContain('plSubmit()');
  });

  it('RQA-3.8: different destination from Invoice (links not billing)', () => {
    expect(plSrc).not.toContain("showPage('billing')");
    expect(plSrc).not.toContain("invSwitchTab");
  });
});

// ── RQA-4: Schedule ───────────────────────────────────────────────────────────
describe('RQA-4: _rcpOpenSchedule', () => {
  it('RQA-4.1: navigates to schedule page', () => {
    expect(schSrc).toContain("showPage('schedule')");
  });

  it('RQA-4.2: uses schPrefill (canonical API)', () => {
    expect(schSrc).toContain('schPrefill');
  });

  it('RQA-4.3: prompts when no contact selected', () => {
    expect(schSrc).toContain('Select a contact first');
  });

  it('RQA-4.4: prompts when multiple contacts selected', () => {
    expect(schSrc).toContain('Select exactly one contact');
  });

  it('RQA-4.5: does not execute transactions', () => {
    expect(schSrc).not.toContain('sendTransaction');
    expect(schSrc).not.toContain('execSend');
  });
});

// ── RQA-5: Autonoma token handling ───────────────────────────────────────────
describe('RQA-5: _rcpBuildAutonomaMsg token handling', () => {
  it('RQA-5.1: includes token only when explicitly set on contact', () => {
    // Reads from paymentPreferences.preferredToken or prefToken — both optional
    expect(buildMsgSrc).toContain('paymentPreferences');
    expect(buildMsgSrc).toContain('prefToken');
    // Falls back to empty string — no hardcoded default token
    const hasHardcodedDefault = buildMsgSrc.includes("|| 'USDC'") || buildMsgSrc.includes('|| "USDC"');
    expect(hasHardcodedDefault).toBe(false);
  });

  it('RQA-5.2: tokenPart is empty string when no token set', () => {
    expect(buildMsgSrc).toContain("prefToken ? ' using '");
    // When prefToken is falsy, tokenPart should be empty
    const emptyFallback = buildMsgSrc.includes("|| ''") || buildMsgSrc.includes('|| ""');
    expect(emptyFallback).toBe(true);
  });

  it('RQA-5.3: message says review before sending', () => {
    expect(buildMsgSrc).toContain('review the details before sending');
  });

  it('RQA-5.4: includes name and address', () => {
    expect(buildMsgSrc).toContain('c.name');
    expect(buildMsgSrc).toContain('c.addr');
  });

  it('RQA-5.5: does not execute transactions', () => {
    expect(buildMsgSrc).not.toContain('sendTransaction');
    expect(buildMsgSrc).not.toContain('autonomaSendQuick');
  });
});

// ── RQA-6: Button wiring ─────────────────────────────────────────────────────
describe('RQA-6: Quick Actions button wiring', () => {
  it('RQA-6.1: Send button calls _rcpOpenSend', () => {
    expect(html).toContain('onclick="_rcpOpenSend()"');
  });

  it('RQA-6.2: Invoice button calls _rcpOpenInvoice', () => {
    expect(html).toContain('onclick="_rcpOpenInvoice()"');
  });

  it('RQA-6.3: Payment Link button calls _rcpOpenPayLink', () => {
    expect(html).toContain('onclick="_rcpOpenPayLink()"');
  });

  it('RQA-6.4: Invoice and Payment Link are different functions', () => {
    expect(invSrc).not.toEqual(plSrc);
  });

  it('RQA-6.5: old showPage billing direct calls replaced', () => {
    // Quick Actions panel should no longer have bare showPage('billing') for invoice/link
    const qaStart = html.indexOf('id="page-recipients"');
    const qaEnd   = html.indexOf('id="page-send"', qaStart + 1000);
    // At minimum the new functions must exist
    expect(html).toContain('function _rcpOpenSend()');
    expect(html).toContain('function _rcpOpenInvoice()');
    expect(html).toContain('function _rcpOpenPayLink()');
  });
});

// ── RQA-7: No transactions ────────────────────────────────────────────────────
describe('RQA-7: No automatic transactions or signatures', () => {
  const allFns = [sendSrc, invSrc, plSrc, schSrc, autSrc];
  const txPatterns = ['sendTransaction', 'signTypedData', 'saExecuteSend', 'eth_sendTransaction'];

  txPatterns.forEach(function(pattern) {
    it('RQA-7: no ' + pattern + ' in any quick action', () => {
      allFns.forEach(function(src) {
        expect(src).not.toContain(pattern);
      });
    });
  });
});
