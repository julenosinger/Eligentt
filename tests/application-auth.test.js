import { describe, it, expect } from 'vitest';
import {
  verifyApplicationAuth,
  registerAuthStrategy,
  hasAuthStrategy,
  listAuthStrategies,
  AUTH_METHODS,
} from '../functions/api/application-auth.mjs';

function req(headers = {}) {
  return new Request('https://app.local/api/relayer', { method: 'POST', headers });
}

describe('Application Authentication — Phase 1 scaffolding', () => {
  it('exposes the modular method surface', () => {
    expect(AUTH_METHODS).toContain('apikey');
    expect(AUTH_METHODS).toContain('jwt');
    expect(AUTH_METHODS).toContain('hmac');
    expect(AUTH_METHODS).toContain('mtls');
    expect(listAuthStrategies()).toEqual(expect.arrayContaining(['internal', 'apikey', 'jwt', 'hmac', 'mtls']));
  });

  it('allows internal (same-origin / no external credential) traffic as ELLIGENT', async () => {
    const r = await verifyApplicationAuth(req(), {}, {});
    expect(r.ok).toBe(true);
    expect(r.method).toBe('internal');
    expect(r.application).toBe('ELLIGENT');
    expect(r.context.application).toBe('ELLIGENT');
  });

  it('attributes internal traffic to the requested application', async () => {
    const r = await verifyApplicationAuth(req(), {}, { applicationId: 'EXECDAAT' });
    expect(r.ok).toBe(true);
    expect(r.application).toBe('EXECDAAT');
  });

  it('detects an API-key request and fails closed when not configured', async () => {
    const r = await verifyApplicationAuth(req({ 'X-Api-Key': 'abc' }), {}, { applicationId: 'EXECDAAT' });
    expect(r.method).toBe('apikey');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_configured');
  });

  it('API-key request stays closed (not_implemented) even when configured this phase', async () => {
    const r = await verifyApplicationAuth(req({ 'X-Api-Key': 'abc' }), { APPLICATION_API_KEYS: '{"EXECDAAT":"x"}' }, {});
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_implemented');
  });

  it('detects a JWT bearer request and fails closed', async () => {
    const r = await verifyApplicationAuth(req({ Authorization: 'Bearer xyz' }), {}, {});
    expect(r.method).toBe('jwt');
    expect(r.ok).toBe(false);
  });

  it('detects HMAC and mTLS methods from headers', async () => {
    const hmac = await verifyApplicationAuth(req({ 'X-Signature': 'sig' }), {}, {});
    expect(hmac.method).toBe('hmac');
    expect(hmac.ok).toBe(false);
    const mtls = await verifyApplicationAuth(req({ 'X-Client-Cert-Verified': 'SUCCESS' }), {}, {});
    expect(mtls.method).toBe('mtls');
    expect(mtls.ok).toBe(false);
  });

  it('supports registering a custom strategy (future extensibility)', async () => {
    registerAuthStrategy('apikey', async (request) => {
      return request.headers.get('X-Api-Key') === 'secret'
        ? { ok: true, method: 'apikey', application: 'EXECDAAT' }
        : { ok: false, method: 'apikey', reason: 'bad_key' };
    });
    expect(hasAuthStrategy('apikey')).toBe(true);
    const good = await verifyApplicationAuth(req({ 'X-Api-Key': 'secret' }), {}, { applicationId: 'EXECDAAT' });
    expect(good.ok).toBe(true);
    expect(good.application).toBe('EXECDAAT');
    const bad = await verifyApplicationAuth(req({ 'X-Api-Key': 'nope' }), {}, {});
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe('bad_key');
  });

  it('throws on invalid strategy registration', () => {
    expect(() => registerAuthStrategy(123, () => {})).toThrow();
    expect(() => registerAuthStrategy('x', 'not-a-fn')).toThrow();
  });
});
