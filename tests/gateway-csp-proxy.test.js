/**
 * Gateway Send 3.1.1 — CSP vs proxy regression guard
 * ═══════════════════════════════════════════════════════════════════════════════
 * Locks in the root-cause fix: the browser CSP `connect-src` must NOT allow a
 * direct client submission to `gateway-api.circle.com` (that would re-enable the
 * direct-submit bypass), and the protected Gateway transfer path must remain
 * same-origin ('self') so it is CSP-allowed and routes through the Cloudflare
 * proxy (Durable Object salt reservation).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const headers = fs.readFileSync(path.resolve(__dirname, '../public/_headers'), 'utf8');

describe('Gateway Send 3.1.1 — CSP / protected-proxy regression', () => {
  it('CSP connect-src does NOT allow direct client submission to gateway-api.circle.com', () => {
    // The direct Gateway API must not be reachable from the browser; transfers
    // must go through /api/gateway/transfer ('self').
    expect(headers).not.toContain('gateway-api.circle.com');
  });

  it('CSP connect-src allows the same-origin protected proxy', () => {
    // 'self' is present, so /api/gateway/transfer is reachable from the browser.
    expect(headers).toMatch(/connect-src\s+'self'/);
  });

  it('CSP connect-src still allowlists the other Circle APIs (api.circle.com, iris-api.circle.com)', () => {
    expect(headers).toContain('https://api.circle.com');
    expect(headers).toContain('https://iris-api.circle.com');
  });
});
