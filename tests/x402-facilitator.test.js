/**
 * x402-facilitator.test.js — Circle Facilitator Service adapter (Level 2)
 * ═══════════════════════════════════════════════════════════════════════════
 * Provider contract tests using injected (mock) HTTP transport. No live Circle
 * calls, no settlement. Covers capabilities parsing/validation, payload
 * construction, verify/settle/status transport, and error classification.
 */
import { describe, it, expect } from 'vitest';
import {
  facilitatorBaseUrl,
  facilitatorConfigured,
  verifyEnabled,
  settleEnabled,
  parseSupported,
  verifySupportedCapability,
  buildPaymentRequirements,
  buildPaymentPayload,
  buildVerificationRequest,
  fetchSupported,
  verifyPayment,
  settlePayment,
  getPaymentStatus,
  classifyError,
} from '../functions/api/x402/x402-facilitator.mjs';

const ARC_USDC = '0x3600000000000000000000000000000000000000';

function mockTransport(response) {
  return async () => response;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const supportedData = {
  x402Version: 2,
  kinds: [
    { x402Version: 2, scheme: 'exact', network: 'eip155:5042', asset: ARC_USDC, decimals: 6, extra: { name: 'USDC', version: '2' } },
    { x402Version: 2, scheme: 'upto', network: 'eip155:5042', asset: ARC_USDC, decimals: 6, extra: { name: 'USDC', version: '2', assetTransferMethod: 'permit2' } },
    { x402Version: 2, scheme: 'exact', network: 'eip155:8453', asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, extra: { name: 'USDC', version: '2' } },
  ],
  extensions: ['payment-identifier', 'settlement-status', 'eip2612GasSponsoring'],
  signers: {},
};

function makeAuthorizedIntent(over = {}) {
  return {
    intentId: crypto.randomUUID(),
    userId: 'user-1',
    walletAddress: '0x' + 'ab'.repeat(20),
    resourceUrl: 'https://api.example.com/premium',
    network: 'eip155:5042',
    chainId: 5042,
    assetAddress: ARC_USDC,
    tokenDecimals: 6,
    amountAtomic: '1000000',
    payTo: '0x' + 'cd'.repeat(20),
    maxTimeoutSeconds: 60,
    authorizationNonce: '0x' + '11'.repeat(32),
    authorizationSignature: '0x' + '22'.repeat(65),
    authorizationValidAfter: '0',
    authorizationValidBefore: '9999999999',
    ...over,
  };
}

describe('x402 facilitator — gates & config', () => {
  it('verify is gated; settle is always disabled', () => {
    expect(verifyEnabled({})).toBe(false);
    expect(verifyEnabled({ X402_FACILITATOR_VERIFY: 'true' })).toBe(false); // no key
    expect(verifyEnabled({ X402_FACILITATOR_VERIFY: 'true', CIRCLE_API_KEY: 'k' })).toBe(true);
    expect(settleEnabled()).toBe(false);
    expect(settleEnabled({ X402_SETTLEMENT_ENABLED: 'true' })).toBe(false);
    expect(facilitatorConfigured({})).toBe(false);
    expect(facilitatorConfigured({ CIRCLE_API_KEY: 'k' })).toBe(true);
    expect(facilitatorBaseUrl({})).toBe('https://api.circle.com');
  });
});

describe('x402 facilitator — capabilities', () => {
  it('parses a valid /supported response', () => {
    const parsed = parseSupported(supportedData);
    expect(parsed.ok).toBe(true);
    expect(parsed.capabilities.kinds).toHaveLength(3);
    expect(parsed.capabilities.kinds[0].asset).toBe(ARC_USDC.toLowerCase());
  });

  it('rejects a wrong x402 version', () => {
    const parsed = parseSupported({ x402Version: 3, kinds: [] });
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe('unsupported_protocol_version');
  });

  it('rejects a malformed capabilities response', () => {
    expect(parseSupported(null).ok).toBe(false);
    expect(parseSupported({ x402Version: 2 }).ok).toBe(false); // missing kinds
    expect(parseSupported({ x402Version: 2, kinds: 'nope' }).ok).toBe(false);
  });

  it('validates the Arc exact/USDC triple and rejects wrong network/scheme/asset/decimals', () => {
    const parsed = parseSupported(supportedData);
    const cap = parsed.capabilities;
    expect(verifySupportedCapability(cap, { network: 'eip155:5042', scheme: 'exact', asset: ARC_USDC, decimals: 6 }).ok).toBe(true);
    expect(verifySupportedCapability(cap, { network: 'eip155:1', scheme: 'exact', asset: ARC_USDC, decimals: 6 }).ok).toBe(false);       // wrong network
    expect(verifySupportedCapability(cap, { network: 'eip155:5042', scheme: 'upto', asset: ARC_USDC, decimals: 6 }).ok).toBe(true);     // upto also supported
    expect(verifySupportedCapability(cap, { network: 'eip155:5042', scheme: 'exact', asset: '0x' + '99'.repeat(20), decimals: 6 }).ok).toBe(false); // wrong asset
    expect(verifySupportedCapability(cap, { network: 'eip155:5042', scheme: 'exact', asset: ARC_USDC, decimals: 18 }).ok).toBe(false);  // decimals mismatch
  });
});

describe('x402 facilitator — payload construction (exact financial binding)', () => {
  it('builds payment requirements with the exact atomic amount (string, no Number)', () => {
    const intent = makeAuthorizedIntent();
    const req = buildPaymentRequirements(intent);
    expect(req.amount).toBe('1000000');
    expect(typeof req.amount).toBe('string');
    expect(req.network).toBe('eip155:5042');
    expect(req.asset).toBe(ARC_USDC);
    expect(req.extra.assetTransferMethod).toBe('eip3009');
  });

  it('builds the x402 v2 PaymentPayload binding the persisted signed terms', () => {
    const intent = makeAuthorizedIntent();
    const payload = buildPaymentPayload(intent, { paymentIdentifier: 'pay_123' });
    expect(payload.x402Version).toBe(2);
    expect(payload.payload.signature).toBe(intent.authorizationSignature);
    expect(payload.payload.authorization.from).toBe(intent.walletAddress);
    expect(payload.payload.authorization.to).toBe(intent.payTo);
    expect(payload.payload.authorization.value).toBe('1000000');
    expect(payload.payload.authorization.nonce).toBe(intent.authorizationNonce);
    expect(payload.extensions['payment-identifier'].info.id).toBe('pay_123');
  });

  it('builds a verification request wrapping the payload', () => {
    const intent = makeAuthorizedIntent();
    const req = buildVerificationRequest(buildPaymentPayload(intent));
    expect(req.x402Version).toBe(2);
    expect(req.paymentRequirements.amount).toBe('1000000');
  });
});

describe('x402 facilitator — verify transport (mocked)', () => {
  it('returns isValid:true on a valid provider response', async () => {
    const transport = mockTransport(jsonResponse(200, { data: { isValid: true } }));
    const res = await verifyPayment({ CIRCLE_API_KEY: 'k' }, { x402Version: 2 }, transport);
    expect(res.ok).toBe(true);
    expect(res.isValid).toBe(true);
  });

  it('returns isValid:false with an invalidReason', async () => {
    const transport = mockTransport(jsonResponse(200, { data: { isValid: false, invalidReason: 'invalid_exact_evm_payload_signature' } }));
    const res = await verifyPayment({ CIRCLE_API_KEY: 'k' }, { x402Version: 2 }, transport);
    expect(res.ok).toBe(true);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toBe('invalid_exact_evm_payload_signature');
  });

  it('classifies 401/403 as auth_rejected, 429 as rate_limited, 5xx as temporarily_unavailable', async () => {
    expect((await verifyPayment({ CIRCLE_API_KEY: 'k' }, {}, mockTransport(jsonResponse(401, {})))).error).toBe('auth_rejected');
    expect((await verifyPayment({ CIRCLE_API_KEY: 'k' }, {}, mockTransport(jsonResponse(403, {})))).error).toBe('auth_rejected');
    expect((await verifyPayment({ CIRCLE_API_KEY: 'k' }, {}, mockTransport(jsonResponse(429, {})))).error).toBe('rate_limited');
    expect((await verifyPayment({ CIRCLE_API_KEY: 'k' }, {}, mockTransport(jsonResponse(500, {})))).error).toBe('temporarily_unavailable');
    expect((await verifyPayment({ CIRCLE_API_KEY: 'k' }, {}, mockTransport(jsonResponse(404, {})))).error).toBe('capability_unsupported');
  });

  it('fails closed with missing credentials', async () => {
    const res = await verifyPayment({}, {}, mockTransport(jsonResponse(200, { data: { isValid: true } })));
    expect(res.ok).toBe(false);
    expect(res.error).toBe('config_unavailable');
  });

  it('classifies a malformed response', async () => {
    const res = await verifyPayment({ CIRCLE_API_KEY: 'k' }, {}, mockTransport(new Response('not json', { status: 200 })));
    expect(res.ok).toBe(false);
    expect(res.error).toBe('malformed_response');
  });

  it('never settles (transport method always disabled)', async () => {
    let called = false;
    const transport = async () => { called = true; return jsonResponse(200, {}); };
    const res = await settlePayment({ CIRCLE_API_KEY: 'k' }, {}, transport);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('settlement_disabled');
    expect(called).toBe(false);
  });

  it('classifyError maps provider codes', () => {
    expect(classifyError(401, {})).toBe('auth_rejected');
    expect(classifyError(429, {})).toBe('rate_limited');
    expect(classifyError(500, {})).toBe('temporarily_unavailable');
    expect(classifyError(409, { invalidReason: 'credential_bound_elsewhere' })).toBe('credential_bound_elsewhere');
  });
});
