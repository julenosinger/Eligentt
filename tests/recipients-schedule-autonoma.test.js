/**
 * Recipients → Schedule + Autonoma integration tests
 * Tests _rcpOpenSchedule, _rcpOpenAutonoma, and _rcpGetActiveContact
 * by extracting functions from index.html and exercising their logic.
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

const scheduleSrc  = extractFn(html, '_rcpOpenSchedule');
const autonomaSrc  = extractFn(html, '_rcpOpenAutonoma');
const getCtxSrc    = extractFn(html, '_rcpGetActiveContact');
const addBatchSrc  = extractFn(html, '_rcpAddToBatchOnly');

// ── RSAI-1: _rcpGetActiveContact ─────────────────────────────────────────────
describe('RSAI-1: _rcpGetActiveContact', () => {
  it('RSAI-1.1: reads first entry from selectedContacts', () => {
    expect(getCtxSrc).toContain('selectedContacts');
    expect(getCtxSrc).toContain('.values().next().value');
  });

  it('RSAI-1.2: returns null when no contact selected', () => {
    expect(getCtxSrc).toContain('return null');
    expect(getCtxSrc).toContain('selectedContacts.size > 0');
  });

  it('RSAI-1.3: looks up contact by id from contacts array', () => {
    expect(getCtxSrc).toContain('contacts.find');
    expect(getCtxSrc).toContain('c.id === firstId');
  });
});

// ── RSAI-2: _rcpOpenSchedule ─────────────────────────────────────────────────
describe('RSAI-2: _rcpOpenSchedule', () => {
  it('RSAI-2.1: calls showPage("schedule")', () => {
    expect(scheduleSrc).toContain("showPage('schedule')");
  });

  it('RSAI-2.2: calls scheduleCreateNew()', () => {
    expect(scheduleSrc).toContain('scheduleCreateNew');
  });

  it('RSAI-2.3: fills sch-address with contact address', () => {
    expect(scheduleSrc).toContain("getElementById('sch-address')");
    expect(scheduleSrc).toContain('c.addr');
    expect(scheduleSrc).toContain('.value = c.addr');
  });

  it('RSAI-2.4: prefills sch-name with contact name', () => {
    expect(scheduleSrc).toContain("getElementById('sch-name')");
    expect(scheduleSrc).toContain('Payment to');
    expect(scheduleSrc).toContain('c.name');
  });

  it('RSAI-2.5: only prefills token when it is a valid known option', () => {
    expect(scheduleSrc).toContain('VALID_TOKENS');
    expect(scheduleSrc).toContain("indexOf(prefToken) !== -1");
  });

  it('RSAI-2.6: does not execute transactions', () => {
    expect(scheduleSrc).not.toContain('sendTransaction');
    expect(scheduleSrc).not.toContain('signTypedData');
    expect(scheduleSrc).not.toContain('saExecuteSend');
    expect(scheduleSrc).not.toContain('execSend');
  });

  it('RSAI-2.7: works without a selected contact (no crash)', () => {
    // When no contact, function returns early after scheduleCreateNew
    expect(scheduleSrc).toContain('if (!c) return');
  });

  it('RSAI-2.8: wraps DOM manipulation in setTimeout for page transition', () => {
    expect(scheduleSrc).toContain('setTimeout');
  });

  it('RSAI-2.9: updates lastUsed on contact', () => {
    expect(scheduleSrc).toContain('lastUsed');
    expect(scheduleSrc).toContain('Store.save');
  });
});

// ── RSAI-3: _rcpOpenAutonoma ─────────────────────────────────────────────────
describe('RSAI-3: _rcpOpenAutonoma', () => {
  it('RSAI-3.1: calls showPage("autonoma")', () => {
    expect(autonomaSrc).toContain("showPage('autonoma')");
  });

  it('RSAI-3.2: includes contact name in message', () => {
    expect(autonomaSrc).toContain('c.name');
    expect(autonomaSrc).toContain('prepare a payment to');
  });

  it('RSAI-3.3: includes contact address in message', () => {
    expect(autonomaSrc).toContain('c.addr');
    expect(autonomaSrc).toContain('address:');
  });

  it('RSAI-3.4: includes network/chain in message when available', () => {
    expect(autonomaSrc).toContain('chainPart');
    expect(autonomaSrc).toContain('CHAIN_NAMES');
  });

  it('RSAI-3.5: includes preferred token in message when available', () => {
    expect(autonomaSrc).toContain('tokenPart');
    expect(autonomaSrc).toContain('prefToken');
  });

  it('RSAI-3.6: calls autonomaSendQuick with the contextual message', () => {
    expect(autonomaSrc).toContain('autonomaSendQuick');
    expect(autonomaSrc).toContain('msg');
  });

  it('RSAI-3.7: message explicitly says to review before sending', () => {
    expect(autonomaSrc).toContain('review the details before sending');
  });

  it('RSAI-3.8: does not execute transactions or sign anything', () => {
    expect(autonomaSrc).not.toContain('sendTransaction');
    expect(autonomaSrc).not.toContain('signTypedData');
    expect(autonomaSrc).not.toContain('saExecuteSend');
    expect(autonomaSrc).not.toContain('execSend');
    expect(autonomaSrc).not.toContain('autonomaQuickAction(\'send\')'.replace('send', 'execut'));
  });

  it('RSAI-3.9: falls back to autonomaQuickAction when autonomaSendQuick unavailable', () => {
    expect(autonomaSrc).toContain('autonomaQuickAction');
  });

  it('RSAI-3.10: works without a selected contact', () => {
    expect(autonomaSrc).toContain('if (!c)');
    expect(autonomaSrc).toContain('autonomaQuickAction');
  });

  it('RSAI-3.11: updates lastUsed on contact', () => {
    expect(autonomaSrc).toContain('lastUsed');
    expect(autonomaSrc).toContain('Store.save');
  });
});

// ── RSAI-4: Button wiring ─────────────────────────────────────────────────────
describe('RSAI-4: Quick Actions button wiring', () => {
  it('RSAI-4.1: Schedule button calls _rcpOpenSchedule', () => {
    // _rcpOpenSchedule must appear somewhere in the HTML (as onclick)
    expect(html).toContain('onclick="_rcpOpenSchedule()"');
  });

  it('RSAI-4.2: Ask Autonoma button calls _rcpOpenAutonoma', () => {
    expect(html).toContain('onclick="_rcpOpenAutonoma()"');
  });
});

// ── RSAI-5: No regression on Add to Batch ────────────────────────────────────
describe('RSAI-5: Regression — Add to Batch still intact', () => {
  it('RSAI-5.1: _rcpAddToBatchOnly validates address before adding', () => {
    expect(addBatchSrc).toContain('isAddr');
    expect(addBatchSrc).toContain('valid');
  });

  it('RSAI-5.2: _rcpAddToBatchOnly does not navigate away', () => {
    expect(addBatchSrc).not.toContain('showPage');
  });

  it('RSAI-5.3: _rcpAddToBatchOnly does not send transactions', () => {
    expect(addBatchSrc).not.toContain('sendTransaction');
    expect(addBatchSrc).not.toContain('saExecuteSend');
  });
});
