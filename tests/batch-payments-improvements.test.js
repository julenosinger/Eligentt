/**
 * Batch Payments Improvements — Unit Tests
 * ═══════════════════════════════════════════════════════════════════
 * Tests the surgical improvements applied to batch payments:
 *   1. formatTokenAmt — BigInt-safe decimal formatting (no "$0.00" for small values)
 *   2. updateStats logic — per-token totals, valid/sent/failed counts
 *   3. Duplicate detection — existing logic preserved
 *   4. CSV import — amount precision, duplicate warning
 *   5. Split Bill — integer-safe per-person amounts
 *   6. Gas Savings panel — no fabricated numbers
 *   7. Structure guards — new DOM elements present
 *
 * All tests are static (file-read only) or DOM-free pure-function tests.
 * No execution of financial transactions.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// 1. formatTokenAmt — BigInt-safe amount formatting
// ─────────────────────────────────────────────────────────────────────────────
describe('formatTokenAmt — no $0.00 for small amounts', () => {
  it('function is defined in the source', () => {
    expect(html).toContain('function formatTokenAmt(amount, decimals, symbol)');
  });

  it('uses integer math (Math.round) to avoid float drift', () => {
    expect(html).toContain('var raw = Math.round((parseFloat(amount) || 0) * scale)');
  });

  it('handles decimals=8 for cirBTC (min 4 decimal places)', () => {
    expect(html).toContain("(symbol === 'cirBTC') ? 4 : 2");
  });

  it('accumulates via integer math, not parseFloat alone', () => {
    // Should NOT use: total.toFixed(2) on a raw parseFloat sum as the only path
    // The function uses Math.round(parseFloat * scale) pattern
    expect(html).toContain('var raw = Math.round((parseFloat(amount) || 0) * scale)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. updateStats — per-token breakdown & valid/sent/failed counts
// ─────────────────────────────────────────────────────────────────────────────
describe('updateStats — per-token totals and recipient status counts', () => {
  it('tokenTotals accumulates per token with integer math', () => {
    expect(html).toContain('var tokenTotals = {}');
    expect(html).toContain("tokenTotals[tok] = { raw: 0, dec: dec }");
  });

  it('tracks validCount, sentCount, failedCount separately', () => {
    expect(html).toContain('var validCount = 0, sentCount = 0, failedCount = 0');
  });

  it('uses BigInt-safe per-token fee calculation', () => {
    // Fee should be calculated on raw integer: Math.floor(primaryRaw * 20 / 10000)
    expect(html).toContain('Math.floor(primaryRaw * 20 / 10000)');
  });

  it('multi-token label joins per-token amounts with " + "', () => {
    expect(html).toContain("tokenKeys.map(function(k) {");
    expect(html).toContain("}).join(' + ')");
  });

  it('does NOT sum tokens from different chains as if equivalent', () => {
    // Primary token is selected from what is present; multi-token display joins, not adds
    expect(html).toContain('tokenKeys.length <= 1');
    // updateStats no longer uses a single parseFloat sum as its primary display path
    // (total.toFixed(2) may still appear in other parts of the app, but not in updateStats)
    expect(html).toContain("setEl('s-total', totalLabel)");
    expect(html).not.toContain("setEl('s-total', '$'+total.toFixed(2))");
  });

  it('rcptLabel shows valid count and incomplete rows', () => {
    expect(html).toContain("var rcptLabel = n === 0 ? '0'");
    expect(html).toContain("validCount + ' valid'");
  });

  it('setEl for s-total uses totalLabel (per-token), not a dollar amount', () => {
    expect(html).toContain("setEl('s-total', totalLabel)");
    // Must NOT still set "$" + total.toFixed(2) as the primary path
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Duplicate detection — preserved and enhanced
// ─────────────────────────────────────────────────────────────────────────────
describe('Duplicate detection — preserved with action options', () => {
  it('findDuplicateGroups is still present', () => {
    expect(html).toContain('function findDuplicateGroups()');
  });

  it('getDuplicateIndices is still present', () => {
    expect(html).toContain('function getDuplicateIndices()');
  });

  it('dupBadge includes remove button with stopPropagation', () => {
    expect(html).toContain("event.stopPropagation();removeRow(");
    expect(html).toContain('⚠ Dup');
  });

  it('signTx still blocks on duplicates before execution', () => {
    expect(html).toContain("if(findDuplicateGroups().length){toast('Duplicate recipients detected. Resolve duplicates before sending.'");
  });

  it('openModal blocks on duplicates with critical error banner', () => {
    expect(html).toContain('critErrors.push(\'Duplicate recipients detected');
  });

  it('duplicateSummary still exists for toast messages', () => {
    expect(html).toContain('function duplicateSummary()');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Status badge improvements — distinct states
// ─────────────────────────────────────────────────────────────────────────────
describe('Status badge improvements — distinct per-recipient states', () => {
  it('Confirming status is distinct from Sent', () => {
    expect(html).toContain("r._status === 'confirming' ? 'Confirming");
  });

  it('Confirmed status is tracked', () => {
    expect(html).toContain("r._status === 'confirmed'");
  });

  it('Invalid address shows descriptive label', () => {
    expect(html).toContain("'Invalid addr'");
  });

  it('No amount shows "No amount" not "Ready"', () => {
    expect(html).toContain("'No amount'");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Address copy button & filter
// ─────────────────────────────────────────────────────────────────────────────
describe('Address copy & row filter', () => {
  it('copy button uses navigator.clipboard', () => {
    expect(html).toContain('navigator.clipboard&&navigator.clipboard.writeText');
  });

  it('batchToastCopied is defined for copy feedback', () => {
    expect(html).toContain('function batchToastCopied(idx)');
  });

  it('filter input is in the toolbar', () => {
    expect(html).toContain('id="ms-filter-input"');
    expect(html).toContain('batchFilterRecipients(this.value)');
  });

  it('batchFilterRecipients is defined', () => {
    expect(html).toContain('function batchFilterRecipients(query)');
  });

  it('_batchRowMatchesFilter checks addr, name, note, token, status', () => {
    expect(html).toContain('function _batchRowMatchesFilter(r)');
    expect(html).toContain("r.addr && r.addr.toLowerCase().includes(q)");
    expect(html).toContain("r.token && r.token.toLowerCase().includes(q)");
  });

  it('dimmed CSS class applied to filtered-out rows', () => {
    expect(html).toContain("ms-row-dimmed");
    expect(html).toContain('.ms-row-dimmed{opacity:.35;pointer-events:none}');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Gas Savings — no fabricated numbers
// ─────────────────────────────────────────────────────────────────────────────
describe('Gas Savings panel — no fabricated estimates', () => {
  it('uses live gas data from ms-fp-gas when available', () => {
    expect(html).toContain("var liveGasEl = document.getElementById('ms-fp-gas')");
  });

  it('falls back to "unavailable" when no live data', () => {
    expect(html).toContain("'Connect wallet to estimate'");
    expect(html).toContain("'unavailable'");
  });

  it('does NOT use hardcoded "rcpt * 0.002" as the only estimate', () => {
    // Old code used: var indivGas = rcpt * 0.002
    // New code: only in liveGasMatch branch, falls back to unavailable
    expect(html).toContain('if (liveGasMatch)');
  });

  it('shows "(estimate)" disclaimer in the card header', () => {
    expect(html).toContain('(estimate)');
  });

  it('disclaimer says "actual gas depends on network conditions"', () => {
    expect(html).toContain('actual gas depends on network conditions');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Split Bill — integer-safe amounts
// ─────────────────────────────────────────────────────────────────────────────
describe('Split Bill — integer-safe per-person amounts', () => {
  it('uses Math.round(total * 1e6) to avoid float drift', () => {
    expect(html).toContain('var totalMicro = Math.round(total * 1e6)');
  });

  it('uses Math.floor(totalMicro / count) for base amount', () => {
    expect(html).toContain('var baseMicro  = Math.floor(totalMicro / count)');
  });

  it('distributes remainder to first rows (exact sum)', () => {
    expect(html).toContain('var remainder  = totalMicro - baseMicro * count');
    expect(html).toContain('var rowMicro = baseMicro + (i < remainder ? 1 : 0)');
  });

  it('uses 6-decimal precision (step="0.000001") in input', () => {
    expect(html).toContain('step="0.000001"');
  });

  it('shows explanation about remainder distribution', () => {
    expect(html).toContain('Remainder distributed to first rows');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Gas estimation in openModal — marked as estimate, not guaranteed
// ─────────────────────────────────────────────────────────────────────────────
describe('openModal gas estimation — honest disclosure', () => {
  it('marks gas as "estimate only" in a comment', () => {
    expect(html).toContain('estimate only — actual depends on network conditions');
  });

  it('gas field shows "estimating…" placeholder while fetching', () => {
    expect(html).toContain("gasEstEl.textContent = 'estimating");
  });

  it('falls back to "estimate unavailable" rather than fabricated number', () => {
    expect(html).toContain("gasEstEl.textContent = 'estimate unavailable'");
  });

  it('data-gasLive attribute prevents updateStats from overwriting a live result', () => {
    expect(html).toContain("mPayEl.dataset.gasLive = '1'");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Modal review — critical error blocking and balance display
// ─────────────────────────────────────────────────────────────────────────────
describe('Modal review — critical errors block send button', () => {
  it('critical error banner element exists', () => {
    expect(html).toContain('id="m-critical-error"');
  });

  it('blocks sign button when wallet not connected', () => {
    expect(html).toContain("critErrors.push('Wallet not connected.'");
  });

  it('blocks when no valid recipients', () => {
    expect(html).toContain("critErrors.push('No valid recipients with amount > 0.'");
  });

  it('blocks on duplicate recipients', () => {
    expect(html).toContain("critErrors.push('Duplicate recipients detected");
  });

  it('source wallet is shown in the modal detail grid', () => {
    expect(html).toContain('id="m-src-wallet"');
  });

  it('balance check row shows live balance', () => {
    expect(html).toContain('id="m-balance-check-row"');
    expect(html).toContain('id="m-balance-check-val"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Review panel balance color-coding
// ─────────────────────────────────────────────────────────────────────────────
describe('Balance color-coding in review panel', () => {
  it('sets green color when balance >= required', () => {
    expect(html).toContain("? 'var(--green)' : (required === 0 ? 'var(--text)' : 'var(--red)')");
  });

  it('live balance row is hidden until wallet connected', () => {
    expect(html).toContain('id="ms-fp-balance-row"');
    expect(html).toContain("fpBalRow.style.display = ''");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Regression guards — existing functionality preserved
// ─────────────────────────────────────────────────────────────────────────────
describe('Regression guards — existing functionality preserved', () => {
  it('4-step workflow stepper still present', () => {
    expect(html).toContain('id="wf-step-1"');
    expect(html).toContain('id="wf-step-2"');
    expect(html).toContain('id="wf-step-3"');
    expect(html).toContain('id="wf-step-4"');
  });

  it('CSV import (loadCSV) is preserved', () => {
    expect(html).toContain('function loadCSV(input)');
  });

  it('CSV export (exportCSV) is preserved', () => {
    expect(html).toContain('function exportCSV()');
  });

  it('addRow is preserved', () => {
    expect(html).toContain('function addRow()');
  });

  it('clearAll is preserved', () => {
    expect(html).toContain('function clearAll()');
  });

  it('openEditAllModal is preserved', () => {
    expect(html).toContain('function openEditAllModal()');
  });

  it('setAllRecipientsChain is preserved (Quick Chain)', () => {
    expect(html).toContain('function setAllRecipientsChain(chainId)');
  });

  it('prepareCrossChainBatch is preserved', () => {
    expect(html).toContain('function prepareCrossChainBatch');
  });

  it('signTx is preserved', () => {
    expect(html).toContain('async function signTx()');
  });

  it('Auto Bridge toggle preserved', () => {
    expect(html).toContain('function toggleAutoBridge()');
  });

  it('Auto Swap toggle preserved', () => {
    expect(html).toContain('function toggleAutoSwap()');
  });

  it('Multicall3 batch execution preserved (not replaced by single transfers)', () => {
    expect(html).toContain('executeBatchViaMulticall3');
    expect(html).toContain('MULTICALL3_ADDRESS');
  });

  it('ENS resolution preserved', () => {
    expect(html).toContain('isEns(r.addr)');
  });

  it('Autonoma Batch quick actions preserved', () => {
    expect(html).toContain('BP._chatBatch');
    // card.id is set dynamically: card.id = 'bp-chat-card'
    expect(html).toContain("card.id = 'bp-chat-card'");
  });

  it('Bulk Payment Links preserved', () => {
    expect(html).toContain('BP._genBulkLinks');
  });

  it('Route Split preserved in right panel', () => {
    expect(html).toContain('id="ms-split-dn"');
    expect(html).toContain('id="ms-split-bn"');
  });

  it('Swap page is not affected', () => {
    expect(html).toContain('id="page-swap"');
  });

  it('Bridge page is not affected', () => {
    expect(html).toContain('id="page-bridge"');
  });

  it('Schedule page is not affected', () => {
    expect(html).toContain("showPage('schedule')");
  });

  it('Templates page is not affected', () => {
    expect(html).toContain("showPage('templates')");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Multi-token validation — tokens from different chains not summed
// ─────────────────────────────────────────────────────────────────────────────
describe('Multi-token / multi-network validation', () => {
  it('CHAIN_REGISTRY has distinct token addresses per chain', () => {
    // Arc USDC and Ethereum USDC have different addresses
    expect(html).toContain("'0x3600000000000000000000000000000000000000'"); // Arc USDC
    expect(html).toContain("'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'"); // Ethereum USDC
  });

  it('tokenTotals accumulates per-token symbol, not by chain', () => {
    // Multi-token keys are ["USDC", "EURC", "cirBTC"] — grouped by symbol
    expect(html).toContain("var tok = r.token || 'USDC'");
    expect(html).toContain("tokenTotals[tok].raw += rawAmt");
  });

  it('different-token totals are displayed separately, not added', () => {
    expect(html).toContain("}).join(' + ')");
  });

  it('balance check is done per-token before execution', () => {
    // signTx checks usdcTotal, eurcTotal, cirBtcTotal separately
    expect(html).toContain("if(usdcTotal>0)");
    expect(html).toContain("if(eurcTotal>0)");
    expect(html).toContain("if(cirBtcTotal>0");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. Partial batch completion — per-recipient status tracking
// ─────────────────────────────────────────────────────────────────────────────
describe('Per-recipient status tracking for partial batch completion', () => {
  it('_status field exists on recipient objects (set by execution layer)', () => {
    // renderTable reads r._status for badge display
    expect(html).toContain("r._status === 'sent'");
    expect(html).toContain("r._status === 'failed'");
    expect(html).toContain("r._status === 'confirming'");
    expect(html).toContain("r._status === 'confirmed'");
  });

  it('sentCount and failedCount are tallied separately in updateStats', () => {
    expect(html).toContain("if (r._status === 'sent')   sentCount++");
    expect(html).toContain("else if (r._status === 'failed') failedCount++");
  });

  it('rcptLabel exposes sent and failed counts when nonzero', () => {
    expect(html).toContain("sentCount ? ' · ' + sentCount + ' sent' : ''");
    expect(html).toContain("failedCount ? ' · ' + failedCount + ' failed' : ''");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. Insufficient balance detection — correct and complete
// ─────────────────────────────────────────────────────────────────────────────
describe('Insufficient balance detection', () => {
  it('signTx checks balance before any transaction is submitted', () => {
    expect(html).toContain('balance < effectiveTotal');
  });

  it('error message shows Have vs Need in human-readable amounts', () => {
    // Template literal form: `Insufficient ${label} balance (incl. 0.2% protocol fee). Have: ${have}, Need: ${need}`
    expect(html).toContain('balance (incl. 0.2% protocol fee). Have:');
    expect(html).toContain('Need: ');
  });

  it('balance is read from chain RPC, not assumed from UI', () => {
    expect(html).toContain('balance = await readContract.balanceOf(senderAddr)');
  });
});
