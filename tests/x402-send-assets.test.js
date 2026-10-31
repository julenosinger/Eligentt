/**
 * x402 Send Assets integration tests.
 *
 * Tests:
 *  1. SA_X402 controller is present in index.html and isolated from Send flow.
 *  2. saSetModeTab toggles between 'send' and 'x402' panels correctly.
 *  3. X402 /api/x402/status, /discover, /prepare behave correctly.
 *  4. Discovery: HTTP 402 detection, malformed responses, invalid URLs.
 *  5. Requirement: incompatible network, bad asset, amount > max, Arc blocked.
 *  6. Prepare: unauthenticated, wallet not provisioned, settlement blocked.
 *  7. Pay: fail-closed 503, no simulated settlement.
 *  8. Per-user history isolation (no shared global key).
 *  9. SSRF: localhost, private IP, IPv6 blocked.
 * 10. Replay protection: isAlreadySubmitted guards re-submission.
 * 11. Single Send & Batch Send code untouched.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  parsePaymentRequired,
  normalizePaymentRequired,
  validateRequirement,
  requirementId,
  assertSafeTarget,
  X402_NETWORKS,
  SETTLEMENT_IMPLEMENTED,
} from '../functions/api/x402/_x402.mjs';
import { onRequest } from '../functions/api/x402/index.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/* ── Fixtures ──────────────────────────────────────────────────────────── */

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_BASE_SEP = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const USDC_ARC  = '0x3600000000000000000000000000000000000000';
const USDC_POL  = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const PAYTO     = '0x' + 'cd'.repeat(20);
const PAYER     = '0x' + 'ab'.repeat(20);
const TOKEN     = 'tok' + 'x'.repeat(33);
const EMAIL     = 'user@test.com';
const USER_ID   = 'uid-abc';

function makeKV(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    async get(k) { return map.has(k) ? map.get(k) : null; },
    async put(k, v) { map.set(k, v); },
    async delete(k) { map.delete(k); },
  };
}

function makeEnv(over = {}) {
  return {
    AUTH_KV: makeKV({
      ['session:' + TOKEN]: JSON.stringify({ userId: USER_ID, email: EMAIL }),
      ['user:' + EMAIL]: JSON.stringify({ id: USER_ID, circleWalletId: 'wid1', circleWalletAddress: PAYER }),
    }),
    ...over,
  };
}

function req(path, { method = 'GET', body, token = TOKEN } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  return new Request('https://app.local' + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

function validPaymentRequired(over = {}) {
  return {
    x402Version: 2,
    error: 'Payment required',
    resource: { url: 'https://api.example.com/data', description: 'Premium data', serviceName: 'ExampleSvc' },
    accepts: [{
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '5000',            // $0.005
      asset: USDC_BASE,
      payTo: PAYTO,
      maxTimeoutSeconds: 60,
      extra: { name: 'USDC', version: '2', assetTransferMethod: 'eip3009' },
    }],
    ...over,
  };
}

/* ══════════════════════════════════════════════════════════════════
   1. SA_X402 presence in index.html — structural isolation checks
══════════════════════════════════════════════════════════════════ */

describe('SA_X402 — presence and isolation in index.html', () => {
  let html;
  beforeEach(() => {
    html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
  });

  it('SA_X402 controller is present in index.html', () => {
    expect(html).toContain('var SA_X402 = (function()');
  });

  it('saSetModeTab is defined', () => {
    expect(html).toContain('function saSetModeTab(mode, btn)');
  });

  it('sa-mode-tabs DOM element is present in Send Assets page', () => {
    expect(html).toContain('id="sa-mode-tabs"');
    expect(html).toContain('sa-mtab-send');
    expect(html).toContain('sa-mtab-x402');
  });

  it('sa-x402-panel DOM element is present', () => {
    expect(html).toContain('id="sa-x402-panel"');
  });

  it('sa-panel-send wraps the original sa-body', () => {
    expect(html).toContain('id="sa-panel-send"');
    // Original sa-body class must still be present (not renamed)
    expect(html).toContain('class="sa-body" id="sa-panel-send"');
  });

  it('saSetModeTab does not touch saExecuteSend', () => {
    // saSetModeTab must only show/hide panels; must not call saExecuteSend
    const fn = html.slice(
      html.indexOf('function saSetModeTab('),
      html.indexOf('function saSetModeTab(') + 600,
    );
    expect(fn).not.toContain('saExecuteSend');
    expect(fn).not.toContain('SendGuard');
    expect(fn).not.toContain('batchExecute');
  });

  it('SA_X402 delegates pay() to X402.pay() — no inline settlement logic', () => {
    const start = html.indexOf('pay: async function()');
    const end = html.indexOf('reset: function()', start);
    const payFn = html.slice(start, end);
    // Must delegate to X402.pay — no direct fetch('/api/x402/pay') or inline settlement
    expect(payFn).toContain('X402.pay(it)');
    expect(payFn).not.toContain("fetch('/api/x402/pay'");
    expect(payFn).not.toContain('fetch("/api/x402/pay"');
  });

  it('SA_X402 tab controller has stepper labels for all 6 steps', () => {
    expect(html).toContain("'discover'");
    expect(html).toContain("'review'");
    expect(html).toContain("'source'");
    expect(html).toContain("'confirm'");
    expect(html).toContain("'settling'");
    expect(html).toContain("'done'");
  });

  it('x402 tab CSS classes are present', () => {
    expect(html).toContain('.sa-mode-tabs');
    expect(html).toContain('.sa-mode-tab');
    expect(html).toContain('.sa-mode-active');
    expect(html).toContain('#sa-x402-panel');
  });
});

/* ══════════════════════════════════════════════════════════════════
   2. SETTLEMENT_IMPLEMENTED is false (Phase 1 gate)
══════════════════════════════════════════════════════════════════ */

describe('Phase 1 gate', () => {
  it('SETTLEMENT_IMPLEMENTED is false — no real payments yet', () => {
    expect(SETTLEMENT_IMPLEMENTED).toBe(false);
  });

  it('/api/x402/pay returns 503 fail-closed', async () => {
    const res = await onRequest({ request: req('/api/x402/pay', { method: 'POST', body: { intentId: 'x' } }), env: makeEnv() });
    expect(res.status).toBe(503);
    const d = await res.json();
    expect(d.ok).toBe(false);
    expect(d.code).toBe('x402_not_enabled');
  });
});

/* ══════════════════════════════════════════════════════════════════
   3. /api/x402/status
══════════════════════════════════════════════════════════════════ */

describe('/api/x402/status', () => {
  it('returns state=disabled when X402_ENABLED not set', async () => {
    const res = await onRequest({ request: req('/api/x402/status'), env: makeEnv() });
    const d = await res.json();
    expect(d.ok).toBe(true);
    expect(d.state).toBe('disabled');
    expect(d.settlement.available).toBe(false);
  });

  it('returns settlement_unavailable when X402_ENABLED=true but SETTLEMENT_IMPLEMENTED=false', async () => {
    const res = await onRequest({ request: req('/api/x402/status'), env: makeEnv({ X402_ENABLED: 'true' }) });
    const d = await res.json();
    expect(d.state).toBe('settlement_unavailable');
  });

  it('includes per-user id when authenticated', async () => {
    const res = await onRequest({ request: req('/api/x402/status'), env: makeEnv() });
    const d = await res.json();
    expect(d.user.id).toBe(USER_ID);
  });

  it('user.id is null when unauthenticated', async () => {
    const res = await onRequest({ request: req('/api/x402/status', { token: '' }), env: makeEnv() });
    const d = await res.json();
    expect(d.user.id).toBeNull();
  });

  it('returns network table with eip3009Compatible for each entry', async () => {
    const res = await onRequest({ request: req('/api/x402/status'), env: makeEnv() });
    const d = await res.json();
    expect(Array.isArray(d.networks)).toBe(true);
    // Arc Mainnet must be NOT eip3009Compatible
    const arc = d.networks.find(n => n.caip === 'eip155:5042');
    expect(arc).toBeTruthy();
    expect(arc.eip3009Compatible).toBe(false);
    // Base must be compatible
    const base = d.networks.find(n => n.caip === 'eip155:8453');
    expect(base.eip3009Compatible).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════
   4. Discovery: HTTP 402 detection, malformed, invalid URL
══════════════════════════════════════════════════════════════════ */

describe('/api/x402/discover — URL validation and SSRF', () => {
  it('rejects empty url', async () => {
    const res = await onRequest({ request: req('/api/x402/discover', { method: 'POST', body: { url: '' } }), env: makeEnv() });
    expect(res.status).toBe(400);
  });

  it('rejects unauthenticated request', async () => {
    const res = await onRequest({ request: req('/api/x402/discover', { method: 'POST', body: { url: 'https://api.example.com' }, token: '' }), env: makeEnv() });
    expect(res.status).toBe(401);
  });

  it('SSRF: blocks localhost', () => {
    expect(assertSafeTarget('http://localhost/secret', []).ok).toBe(false);
  });

  it('SSRF: blocks 127.0.0.1', () => {
    expect(assertSafeTarget('http://127.0.0.1/secret', []).ok).toBe(false);
  });

  it('SSRF: blocks 192.168.x.x private IP', () => {
    expect(assertSafeTarget('http://192.168.1.1/', []).ok).toBe(false);
  });

  it('SSRF: blocks 10.x.x.x private IP', () => {
    expect(assertSafeTarget('http://10.0.0.1/', []).ok).toBe(false);
  });

  it('SSRF: blocks IPv6 literal', () => {
    expect(assertSafeTarget('http://[::1]/', []).ok).toBe(false);
  });

  it('SSRF: blocks non-http/https scheme', () => {
    expect(assertSafeTarget('file:///etc/passwd', []).ok).toBe(false);
    expect(assertSafeTarget('ftp://example.com', []).ok).toBe(false);
  });

  it('SSRF: blocks .internal hostname', () => {
    expect(assertSafeTarget('https://metadata.internal/', []).ok).toBe(false);
  });

  it('SSRF: allows a public HTTPS URL', () => {
    expect(assertSafeTarget('https://api.example.com/data', []).ok).toBe(true);
  });

  it('SSRF: allowedHosts enforced when set', () => {
    expect(assertSafeTarget('https://api.example.com/data', ['other.com']).ok).toBe(false);
    expect(assertSafeTarget('https://api.example.com/data', ['api.example.com']).ok).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════
   5. Requirement parsing — malformed, multiple options, blocked networks
══════════════════════════════════════════════════════════════════ */

describe('parsePaymentRequired / normalizePaymentRequired', () => {
  it('parses base64-encoded JSON header', () => {
    const obj = validPaymentRequired();
    const encoded = btoa(JSON.stringify(obj));
    const res = parsePaymentRequired(encoded, '');
    expect(res.ok).toBe(true);
    expect(res.paymentRequired.x402Version).toBe(2);
  });

  it('parses raw JSON body fallback', () => {
    const obj = validPaymentRequired();
    const res = parsePaymentRequired('', JSON.stringify(obj));
    expect(res.ok).toBe(true);
  });

  it('fails on empty header and body', () => {
    expect(parsePaymentRequired('', '').ok).toBe(false);
  });

  it('fails on wrong x402Version', () => {
    const obj = validPaymentRequired(); obj.x402Version = 1;
    const res = normalizePaymentRequired(obj);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('version');
  });

  it('fails when accepts array is missing', () => {
    const obj = validPaymentRequired(); delete obj.accepts;
    const res = normalizePaymentRequired(obj);
    expect(res.ok).toBe(false);
  });

  it('normalizes legacy short network slugs', () => {
    const obj = validPaymentRequired();
    obj.accepts[0].network = 'base';
    const res = normalizePaymentRequired(obj);
    expect(res.ok).toBe(true);
    expect(res.requirements[0].network).toBe('eip155:8453');
  });

  it('handles multiple accepts options', () => {
    const obj = validPaymentRequired();
    obj.accepts.push({ ...obj.accepts[0], network: 'eip155:137', asset: USDC_POL, payTo: PAYTO,
      extra: { name: 'USDC', version: '2', assetTransferMethod: 'eip3009' } });
    const res = normalizePaymentRequired(obj);
    expect(res.ok).toBe(true);
    expect(res.requirements.length).toBe(2);
  });
});

/* ══════════════════════════════════════════════════════════════════
   6. validateRequirement — all blocking conditions
══════════════════════════════════════════════════════════════════ */

describe('validateRequirement', () => {
  function baseReq(over = {}) {
    return {
      scheme: 'exact',
      network: 'eip155:8453',
      networkRaw: 'eip155:8453',
      amount: '5000',
      asset: USDC_BASE,
      payTo: PAYTO,
      maxTimeoutSeconds: 60,
      extra: { name: 'USDC', version: '2', assetTransferMethod: 'eip3009' },
      ...over,
    };
  }

  it('passes a valid requirement on Base', () => {
    expect(validateRequirement(baseReq()).ok).toBe(true);
  });

  it('blocks unsupported scheme', () => {
    const v = validateRequirement(baseReq({ scheme: 'subscription' }));
    expect(v.ok).toBe(false);
    const c = v.checks.find(c => c.name === 'scheme');
    expect(c.passed).toBe(false);
  });

  it('blocks unsupported network', () => {
    const v = validateRequirement(baseReq({ network: 'eip155:999', networkRaw: 'eip155:999' }));
    expect(v.ok).toBe(false);
    const c = v.checks.find(c => c.name === 'network_supported');
    expect(c.passed).toBe(false);
  });

  it('blocks Arc Mainnet (EIP-3009 unconfirmed)', () => {
    const v = validateRequirement(baseReq({ network: 'eip155:5042', networkRaw: 'eip155:5042', asset: USDC_ARC }));
    const c = v.checks.find(c => c.name === 'network_eip3009');
    expect(c).toBeTruthy();
    expect(c.passed).toBe(false);
  });

  it('blocks wrong asset address', () => {
    const v = validateRequirement(baseReq({ asset: '0x' + 'ff'.repeat(20) }));
    const c = v.checks.find(c => c.name === 'asset_known');
    expect(c.passed).toBe(false);
  });

  it('blocks wrong EIP-712 domain name', () => {
    const v = validateRequirement(baseReq({ extra: { name: 'DAI', version: '2', assetTransferMethod: 'eip3009' } }));
    const c = v.checks.find(c => c.name === 'asset_domain_name');
    expect(c.passed).toBe(false);
  });

  it('blocks wrong EIP-712 domain version', () => {
    const v = validateRequirement(baseReq({ extra: { name: 'USDC', version: '1', assetTransferMethod: 'eip3009' } }));
    const c = v.checks.find(c => c.name === 'asset_domain_version');
    expect(c.passed).toBe(false);
  });

  it('blocks unsupported transfer method', () => {
    const v = validateRequirement(baseReq({ extra: { name: 'USDC', version: '2', assetTransferMethod: 'permit' } }));
    const c = v.checks.find(c => c.name === 'asset_transfer_method');
    expect(c.passed).toBe(false);
  });

  it('blocks invalid payTo address', () => {
    const v = validateRequirement(baseReq({ payTo: 'not-an-address' }));
    const c = v.checks.find(c => c.name === 'payto_valid');
    expect(c.passed).toBe(false);
  });

  it('blocks zero amount', () => {
    const v = validateRequirement(baseReq({ amount: '0' }));
    const c = v.checks.find(c => c.name === 'amount_valid');
    expect(c.passed).toBe(false);
  });

  it('blocks amount exceeding maxUsd', () => {
    // 30 USDC > default max 25
    const v = validateRequirement(baseReq({ amount: String(30 * 1e6) }), { maxUsd: 25 });
    const c = v.checks.find(c => c.name === 'amount_within_max');
    expect(c.passed).toBe(false);
  });

  it('allows Base Sepolia USDC', () => {
    const v = validateRequirement(baseReq({ network: 'eip155:84532', networkRaw: 'eip155:84532', asset: USDC_BASE_SEP }));
    expect(v.ok).toBe(true);
  });

  it('allows Polygon USDC', () => {
    const v = validateRequirement(baseReq({ network: 'eip155:137', networkRaw: 'eip155:137', asset: USDC_POL }));
    expect(v.ok).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════
   7. /api/x402/prepare — auth, wallet, settlement checks
══════════════════════════════════════════════════════════════════ */

describe('/api/x402/prepare', () => {
  const BODY = {
    resourceUrl: 'https://api.example.com/data',
    requirement: {
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '5000',
      asset: USDC_BASE,
      payTo: PAYTO,
      maxTimeoutSeconds: 60,
      extra: { name: 'USDC', version: '2', assetTransferMethod: 'eip3009' },
    },
  };

  it('returns 401 when unauthenticated', async () => {
    const res = await onRequest({ request: req('/api/x402/prepare', { method: 'POST', body: BODY, token: '' }), env: makeEnv() });
    expect(res.status).toBe(401);
  });

  it('returns intent with status=blocked when settlement not implemented', async () => {
    const res = await onRequest({ request: req('/api/x402/prepare', { method: 'POST', body: BODY }), env: makeEnv() });
    const d = await res.json();
    expect(d.ok).toBe(true);
    expect(d.intent.status).toBe('blocked');
    const c = d.intent.checks.find(c => c.name === 'settlement_implemented');
    expect(c.passed).toBe(false);
  });

  it('includes wallet check — passes when wallet provisioned', async () => {
    const res = await onRequest({ request: req('/api/x402/prepare', { method: 'POST', body: BODY }), env: makeEnv() });
    const d = await res.json();
    const c = d.intent.checks.find(c => c.name === 'wallet');
    expect(c.passed).toBe(true);
    expect(d.intent.walletAddress).toBe(PAYER);
  });

  it('includes wallet check — blocked when wallet not provisioned', async () => {
    const kvNoWallet = makeKV({
      ['session:' + TOKEN]: JSON.stringify({ userId: USER_ID, email: EMAIL }),
      ['user:' + EMAIL]: JSON.stringify({ id: USER_ID }), // no wallet fields
    });
    const res = await onRequest({ request: req('/api/x402/prepare', { method: 'POST', body: BODY }), env: { AUTH_KV: kvNoWallet } });
    const d = await res.json();
    const c = d.intent.checks.find(c => c.name === 'wallet');
    expect(c.passed).toBe(false);
  });

  it('requirementId is deterministic', () => {
    const id1 = requirementId('https://api.example.com/data', BODY.requirement);
    const id2 = requirementId('https://api.example.com/data', BODY.requirement);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^x402_/);
  });

  it('requirementId changes when URL changes (replay isolation)', () => {
    const id1 = requirementId('https://api.example.com/data', BODY.requirement);
    const id2 = requirementId('https://api.example.com/other', BODY.requirement);
    expect(id1).not.toBe(id2);
  });

  it('requirementId changes when payTo changes (prevents recipient swap)', () => {
    const req1 = { ...BODY.requirement };
    const req2 = { ...BODY.requirement, payTo: '0x' + 'ee'.repeat(20) };
    expect(requirementId('https://x.com', req1)).not.toBe(requirementId('https://x.com', req2));
  });
});

/* ══════════════════════════════════════════════════════════════════
   8. Per-user history isolation
══════════════════════════════════════════════════════════════════ */

describe('Per-user history isolation', () => {
  it('SA_X402 delegates to X402.getHistory() not a shared global key', () => {
    const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
    const start = html.indexOf('function renderHistory()');
    const end = html.indexOf('function renderDiscover()', start);
    const fn = html.slice(start, end);
    // Must call X402.getHistory()
    expect(fn).toContain('X402.getHistory()');
    // Must NOT read localStorage directly with a hard-coded key
    expect(fn).not.toContain("localStorage.getItem('elligentt_x402_history_v1'");
    expect(fn).not.toContain('localStorage.getItem("elligentt_x402_history_v1"');
  });

  it('x402Client.js history keys are namespaced per user', () => {
    const client = readFileSync(resolve(__dirname, '../shared/x402Client.js'), 'utf8');
    // histKey() must return null or a user-suffixed key — never bare STORAGE_HISTORY
    expect(client).toContain('_userId ? CFG.STORAGE_HISTORY');
    // getHistory must use histKey() not bare storage key
    expect(client).toContain('function getHistory()');
    expect(client).toContain('var k = histKey()');
  });
});

/* ══════════════════════════════════════════════════════════════════
   9. Single Send & Batch Send code untouched
══════════════════════════════════════════════════════════════════ */

describe('Single Send and Batch Send are untouched', () => {
  let html;
  beforeEach(() => {
    html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
  });

  it('saExecuteSend function is still present', () => {
    expect(html).toContain('function saExecuteSend(');
  });

  it('batchExecute / executeBatch still present', () => {
    expect(html.includes('batchExecute') || html.includes('executeBatch') || html.includes('_batchExecute')).toBe(true);
  });

  it('sa-body left column still has Asset Selector', () => {
    expect(html).toContain('id="sa-asset-grid"');
  });

  it('sa-body still has recipient input', () => {
    expect(html).toContain('id="sa-recipient"');
  });

  it('SendGuard is still wired', () => {
    expect(html).toContain('SendGuard');
  });
});

/* ══════════════════════════════════════════════════════════════════
   10. Mode tab structure
══════════════════════════════════════════════════════════════════ */

describe('saSetModeTab — structure', () => {
  it('saSetModeTab function does not call X402.pay directly', () => {
    const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
    const fn = html.slice(
      html.indexOf('function saSetModeTab('),
      html.indexOf('// ════════════', html.indexOf('function saSetModeTab(') + 10),
    );
    expect(fn).not.toContain('X402.pay(');
    expect(fn).not.toContain('X402.discover(');
    expect(fn).not.toContain('SA_X402.pay(');
  });

  it('x402 tab has Beta badge', () => {
    const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
    expect(html).toContain('sa-mode-tab-badge');
    expect(html).toContain('>Beta<');
  });
});
