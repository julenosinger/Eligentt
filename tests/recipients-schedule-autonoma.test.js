/**
 * Recipients → Schedule + Autonoma integration tests (Hotfix 2.0)
 * Tests _rcpOpenSchedule, _rcpOpenAutonoma, pending context, and layout.
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

const scheduleSrc   = extractFn(html, '_rcpOpenSchedule');
const autonomaSrc   = extractFn(html, '_rcpOpenAutonoma');
const buildMsgSrc   = extractFn(html, '_rcpBuildAutonomaMsg');
const consumeCtxSrc = extractFn(html, '_rcpConsumeAutonomaCtx');
const getCtxSrc     = extractFn(html, '_rcpGetActiveContact');
const addBatchSrc   = extractFn(html, '_rcpAddToBatchOnly');

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

  it('RSAI-2.2: uses schPrefill (canonical API) or scheduleCreateNew fallback', () => {
    // Must use schPrefill as primary path
    expect(scheduleSrc).toContain('schPrefill');
  });

  it('RSAI-2.3: fills address via schPrefill params object', () => {
    expect(scheduleSrc).toContain('address: c.addr');
  });

  it('RSAI-2.4: prefills name with contact name', () => {
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

  it('RSAI-2.7: shows toast and returns early when no contact selected (size=0)', () => {
    expect(scheduleSrc).toContain('n === 0');
    expect(scheduleSrc).toContain('toast(');
    expect(scheduleSrc).toContain('return');
  });

  it('RSAI-2.8: shows toast and returns when multiple contacts selected', () => {
    expect(scheduleSrc).toContain('n > 1');
    expect(scheduleSrc).toContain('toast(');
  });

  it('RSAI-2.9: uses requestAnimationFrame to avoid DOM race', () => {
    expect(scheduleSrc).toContain('requestAnimationFrame');
  });

  it('RSAI-2.10: updates lastUsed on contact', () => {
    expect(scheduleSrc).toContain('lastUsed');
    expect(scheduleSrc).toContain('Store.save');
  });
});

// ── RSAI-3: _rcpOpenAutonoma ─────────────────────────────────────────────────
describe('RSAI-3: _rcpOpenAutonoma', () => {
  it('RSAI-3.1: calls showPage("autonoma")', () => {
    expect(autonomaSrc).toContain("showPage('autonoma')");
  });

  it('RSAI-3.2: stores context in _rcpPendingAutonomaCtx before navigation', () => {
    expect(autonomaSrc).toContain('_rcpPendingAutonomaCtx');
    expect(autonomaSrc).toContain('msg:');
  });

  it('RSAI-3.3: calls _rcpBuildAutonomaMsg to build the message', () => {
    expect(autonomaSrc).toContain('_rcpBuildAutonomaMsg');
  });

  it('RSAI-3.4: _rcpBuildAutonomaMsg includes contact name', () => {
    expect(buildMsgSrc).toContain('c.name');
    expect(buildMsgSrc).toContain('prepare a payment to');
  });

  it('RSAI-3.5: _rcpBuildAutonomaMsg includes contact address', () => {
    expect(buildMsgSrc).toContain('c.addr');
    expect(buildMsgSrc).toContain('address:');
  });

  it('RSAI-3.6: _rcpBuildAutonomaMsg includes network/chain', () => {
    expect(buildMsgSrc).toContain('chainPart');
    expect(buildMsgSrc).toContain('CHAIN_NAMES');
  });

  it('RSAI-3.7: _rcpBuildAutonomaMsg includes preferred token', () => {
    expect(buildMsgSrc).toContain('tokenPart');
    expect(buildMsgSrc).toContain('prefToken');
  });

  it('RSAI-3.8: message says to review before sending', () => {
    expect(buildMsgSrc).toContain('review the details before sending');
  });

  it('RSAI-3.9: _rcpConsumeAutonomaCtx calls autonomaSendQuick with msg', () => {
    expect(consumeCtxSrc).toContain('autonomaSendQuick');
    expect(consumeCtxSrc).toContain('ctx.msg');
  });

  it('RSAI-3.10: _rcpConsumeAutonomaCtx clears pending context after use (consume once)', () => {
    expect(consumeCtxSrc).toContain('_rcpPendingAutonomaCtx = null');
  });

  it('RSAI-3.11: _rcpConsumeAutonomaCtx falls back to autonomaQuickAction', () => {
    expect(consumeCtxSrc).toContain('autonomaQuickAction');
  });

  it('RSAI-3.12: autonomaInit hooks _rcpConsumeAutonomaCtx to consume pending context', () => {
    // autonomaInit must call _rcpConsumeAutonomaCtx
    const initIdx = html.indexOf('window.autonomaInit = function()');
    const initEnd = html.indexOf('window.autonomaNewChat', initIdx);
    const initSrc = html.slice(initIdx, initEnd);
    expect(initSrc).toContain('_rcpConsumeAutonomaCtx');
  });

  it('RSAI-3.13: does not execute transactions or sign anything', () => {
    expect(autonomaSrc).not.toContain('sendTransaction');
    expect(autonomaSrc).not.toContain('signTypedData');
    expect(autonomaSrc).not.toContain('saExecuteSend');
    expect(autonomaSrc).not.toContain('execSend');
  });

  it('RSAI-3.14: opens autonoma normally without inventing context when no contact', () => {
    // When no contact, _rcpOpenAutonoma navigates without setting _rcpPendingAutonomaCtx
    // The pending ctx is only set when msg is truthy (requires a contact)
    expect(autonomaSrc).toContain('if (msg)');
    expect(autonomaSrc).toContain('_rcpPendingAutonomaCtx = {');
    expect(autonomaSrc).not.toContain("c.name + ' unknown'");
    // Falls back to autonomaQuickAction when no contact
    expect(autonomaSrc).toContain('if (!c && typeof autonomaQuickAction');
  });
});

// ── RSAI-4: Button wiring ─────────────────────────────────────────────────────
describe('RSAI-4: Quick Actions button wiring', () => {
  it('RSAI-4.1: Schedule button calls _rcpOpenSchedule', () => {
    expect(html).toContain('onclick="_rcpOpenSchedule()"');
  });

  it('RSAI-4.2: Ask Autonoma button calls _rcpOpenAutonoma', () => {
    expect(html).toContain('onclick="_rcpOpenAutonoma()"');
  });
});

// ── RSAI-5: Compact layout ────────────────────────────────────────────────────
describe('RSAI-5: Compact row layout', () => {
  it('RSAI-5.1: row uses 8px padding (compact)', () => {
    expect(html).toContain('padding:8px 10px');
  });

  it('RSAI-5.2: avatar is 32px (compact, down from 36px)', () => {
    // Avatar div in rcp row uses 32px
    const rowIdx = html.indexOf('class="rcp-row"');
    const rowEnd = html.indexOf('</div>', rowIdx + 2000);
    const rowSrc = html.slice(rowIdx, rowEnd);
    expect(rowSrc).toContain('width:32px;height:32px');
  });

  it('RSAI-5.3: action buttons are 24px (compact, down from 28px)', () => {
    expect(html).toContain('rcp-send-btn');
    const sendBtnIdx = html.indexOf('rcp-send-btn');
    const sendBtnCtx = html.slice(sendBtnIdx - 10, sendBtnIdx + 200);
    expect(sendBtnCtx).toContain('24px');
  });
});

// ── RSAI-6: No regression on Add to Batch ────────────────────────────────────
describe('RSAI-6: Regression — Add to Batch still intact', () => {
  it('RSAI-6.1: _rcpAddToBatchOnly validates address before adding', () => {
    expect(addBatchSrc).toContain('isAddr');
    expect(addBatchSrc).toContain('valid');
  });

  it('RSAI-6.2: _rcpAddToBatchOnly does not navigate away', () => {
    expect(addBatchSrc).not.toContain('showPage');
  });

  it('RSAI-6.3: _rcpAddToBatchOnly does not send transactions', () => {
    expect(addBatchSrc).not.toContain('sendTransaction');
    expect(addBatchSrc).not.toContain('saExecuteSend');
  });
});
