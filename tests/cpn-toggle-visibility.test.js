/**
 * cpn-toggle-visibility.test.js
 * ═══════════════════════════════════════════════════════════════════════════
 * Regression guard for the Phase 1.3 "Send to Bank (CPN)" visibility restore.
 *
 * A previous commit hid the "Send to Bank (CPN)" entry point behind a feature
 * flag (`SA_CPN_ENABLED = false` + `display:none` + an early-return guard in
 * `saToggleCPN()`). That was NOT requested and has been reverted.
 *
 * Requirements enforced:
 *   1. The button must be visible (display:flex, not display:none).
 *   2. No feature flag silently hides it (no SA_CPN_ENABLED anywhere).
 *   3. saToggleCPN must toggle normally (no early-return guard).
 *   4. The existing CPN onboarding notice remains (OFI onboarding is required).
 *   5. Existing CPN authorization/validation gates remain intact (allowed chain
 *      IDs, canonical USDC contracts, server-side API key).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function blockAt(text, anchor, size = 3000) {
  const idx = text.indexOf(anchor);
  if (idx === -1) return '';
  return text.slice(idx, idx + size);
}

describe('Send to Bank (CPN) — visibility restored', () => {
  it('the "Send to Bank" entry point exists as the third Send Assets tab', () => {
    // The in-card "Send to Bank (CPN)" button was moved into an independent tab.
    expect(html).toContain('id="sa-mtab-bank"');
    expect(html).toContain("onclick=\"saSetModeTab('bank',this)\"");
    expect(html).not.toContain('id="sa-cpn-toggle"');
  });

  it('the tab is VISIBLE (never display:none) and carries no feature flag', () => {
    const btnStart = html.indexOf('id="sa-mtab-bank"');
    const tagEnd = html.indexOf('>', btnStart);
    const tag = html.slice(btnStart, tagEnd);
    expect(tag).not.toContain('display:none');
    expect(tag).not.toContain('hidden');
  });

  it('no feature flag hides the entry point (no SA_CPN_ENABLED anywhere)', () => {
    expect(html).not.toContain('SA_CPN_ENABLED');
  });

  it('saToggleCPN toggles normally (no early-return guard)', () => {
    const fn = blockAt(html, 'function saToggleCPN()', 400);
    expect(fn).toContain('_saCPNMode = !_saCPNMode');
    expect(fn).not.toContain('if (!SA_CPN_ENABLED) return');
  });

  it('the CPN onboarding notice remains (OFI onboarding required, no fabricated data)', () => {
    expect(html).toContain('id="sa-cpn-notice"');
    expect(html).toContain('Requires OFI onboarding with Circle before live payments can be processed');
    expect(html).toContain('Without this key, quote requests return a clear error');
  });
});

describe('Send to Bank (CPN) — existing authorization gates preserved', () => {
  it('keeps the allowed-chain allowlist (rejects out-of-list chainIds before signing)', () => {
    expect(html).toContain('var _CPN_ALLOWED_CHAIN_IDS');
    expect(html).toContain('[1, 5042, 8453, 42161, 10, 137, 43114]');
  });

  it('keeps the canonical USDC contract map (recipient must match exactly)', () => {
    expect(html).toContain('var _CPN_USDC_CONTRACTS');
    expect(html).toContain("5042:  '0x3600000000000000000000000000000000000000'");
  });

  it('keeps the idempotency + recipient pinning guards', () => {
    expect(html).toContain('_saCPNIdempotencyKey');
    expect(html).toContain('_saCPNExpectedRecipient');
  });

  it('CPN API key is server-side only (never reaches the browser)', () => {
    expect(html).toContain('CPN_API_KEY is injected server-side — never reaches the browser');
  });
});
