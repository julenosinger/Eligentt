/**
 * Bridge — TO CHAIN section: the static "After bridge fees" label was removed because it sat
 * directly above the wallet "Balance" row and read as if that balance were post-fee.
 * "You Receive" / "Minimum Received" in the rate box already describe the post-fee amount.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
const i = html.indexOf('<div class="brg-section brg-section-to">');
const j = html.indexOf('<!-- Route divider', i);
const toSection = html.slice(i, j);

describe('Bridge TO section', () => {
  it('no longer contains the misleading "After bridge fees" label (or its unused class)', () => {
    expect(toSection).not.toContain('After bridge fees');
    expect(toSection).not.toContain('brg-fees-label');
    expect(html).not.toContain('brg-fees-label');
  });
  it('keeps the order: chain row, then destination balance, then the (hidden) rate box', () => {
    const a = toSection.indexOf('class="chain-row brg-chain-row"');
    const b = toSection.indexOf('class="brg-bal-row"');
    const c = toSection.indexOf('id="bridge-rate-box"');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });
  it('all ids used by the bridge logic are untouched', () => {
    ['bridge-amount-out', 'bridge-amount-out-sym', 'bridge-to-bal', 'bridge-to-bal-sym', 'bridge-to-token-sel',
     'bridge-rate-box', 'bridge-protocol', 'bridge-fee-display', 'bridge-time', 'bridge-receive', 'bridge-min', 'to-chain-sel']
      .forEach(id => expect(toSection, id).toContain('id="' + id + '"'));
  });
  it('the post-fee information is still shown in the rate box', () => {
    expect(toSection).toContain('<span>You Receive</span>');
    expect(toSection).toContain('<span>Minimum Received</span>');
  });
});
