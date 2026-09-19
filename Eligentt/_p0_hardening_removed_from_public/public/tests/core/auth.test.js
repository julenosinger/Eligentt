import { describe, it, expect } from 'vitest';
import { authenticate, detectAuthMethod, isMethodEnabled, CORE_AUTH_METHODS, ENABLED_METHODS } from '../../functions/api/core/auth.mjs';

function req(headers = {}) {
  return new Request('https://app.local/api/core/v1/quote', { method: 'POST', headers });
}

describe('Core API — authentication layer', () => {
  it('only internal is enabled in this phase', () => {
    expect(ENABLED_METHODS).toEqual(['internal']);
    expect(isMethodEnabled('internal')).toBe(true);
    expect(isMethodEnabled('apikey')).toBe(false);
    expect(isMethodEnabled('jwt')).toBe(false);
    expect(CORE_AUTH_METHODS).toEqual(expect.arrayContaining(['internal', 'apikey', 'jwt', 'hmac', 'mtls', 'bearer']));
  });

  it('detects methods from headers', () => {
    expect(detectAuthMethod(req())).toBe('internal');
    expect(detectAuthMethod(req({ 'X-Api-Key': 'k' }))).toBe('apikey');
    expect(detectAuthMethod(req({ 'X-Signature': 's' }))).toBe('hmac');
    expect(detectAuthMethod(req({ 'X-Client-Cert-Verified': 'SUCCESS' }))).toBe('mtls');
    expect(detectAuthMethod(req({ Authorization: 'Bearer a.b.c' }))).toBe('jwt');
    expect(detectAuthMethod(req({ Authorization: 'Bearer opaque' }))).toBe('bearer');
  });

  it('authenticates internal traffic as the resolved application', async () => {
    const r = await authenticate(req(), {}, {});
    expect(r.ok).toBe(true);
    expect(r.method).toBe('internal');
    expect(r.application).toBe('ELLIGENT');
  });

  it('attributes internal traffic to the requested application context', async () => {
    const r = await authenticate(req(), {}, { applicationId: 'EXECDAAT', clientId: 'acme' });
    expect(r.ok).toBe(true);
    expect(r.application).toBe('EXECDAAT');
    expect(r.context.client).toBe('acme');
  });

  it('fails closed for any prepared-but-not-enabled external scheme', async () => {
    for (const h of [{ 'X-Api-Key': 'k' }, { Authorization: 'Bearer a.b.c' }, { 'X-Signature': 's' }, { 'X-Client-Cert-Verified': 'ok' }]) {
      const r = await authenticate(req(h), {}, {});
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('not_enabled');
    }
  });
});
