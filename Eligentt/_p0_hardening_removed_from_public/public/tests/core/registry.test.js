import { describe, it, expect } from 'vitest';
import { getApplication, listApplications, registerApplication, updateApplication, APP_STATUS, AUTH_MODES } from '../../functions/api/core/registry.mjs';
import { createSecretRecord } from '../../functions/api/core/application-secret.mjs';

function mockKV() {
  const store = new Map();
  return {
    async get(k) { return store.get(k) ?? null; },
    async put(k, v) { store.set(k, v); },
    async list({ prefix = '', limit = 1000 } = {}) {
      return { keys: Array.from(store.keys()).filter(k => k.startsWith(prefix)).slice(0, limit).map(name => ({ name })) };
    },
  };
}

describe('Core API — application registry', () => {
  it('returns the ELLIGENT seed as active/internal even with no KV', async () => {
    const app = await getApplication({}, 'ELLIGENT');
    expect(app.applicationId).toBe('ELLIGENT');
    expect(app.status).toBe(APP_STATUS.ACTIVE);
    expect(app.authMode).toBe('internal');
    expect(app.permissions).toContain('execute:write');
  });

  it('seeds EXECDAAT as ACTIVE / hmac for production go-live', async () => {
    const app = await getApplication({}, 'execdaat');
    expect(app.applicationId).toBe('EXECDAAT');
    expect(app.status).toBe(APP_STATUS.ACTIVE);
    expect(app.authMode).toBe('hmac');
    expect(app.core).toBe(false);
    expect(app.permissions).toContain('execute:write');
    // Secret is referenced only by fingerprint — never the plaintext.
    expect(app.allowedOrigins).toContain('https://execdaat.xyz');
  });

  it('never exposes an EXECDAAT secret value (fingerprint only)', async () => {
    const app = await getApplication({}, 'EXECDAAT');
    const pub = (await import('../../functions/api/core/registry.mjs')).publicApplication(app);
    expect(pub.secret.fingerprint).toBeTruthy();
    expect(pub.secret.hash).toBeUndefined();
    expect(pub.secret.ciphertext).toBeUndefined();
  });

  it('returns a conservative prepared default for unknown apps', async () => {
    const app = await getApplication({}, 'brand_new');
    expect(app.applicationId).toBe('BRAND_NEW');
    expect(app.status).toBe(APP_STATUS.PREPARED);
  });

  it('lists seeded applications', async () => {
    const apps = await listApplications({});
    const ids = apps.map(a => a.applicationId);
    expect(ids).toContain('ELLIGENT');
    expect(ids).toContain('EXECDAAT');
    expect(ids).toContain('FUTURE_APP');
  });

  it('registers and persists an application (KV overlay)', async () => {
    const env = { CORE_KV: mockKV() };
    const secret = await createSecretRecord('registry-secret-1');
    const rec = await registerApplication(env, {
      applicationId: 'partner1', displayName: 'Partner One', status: 'prepared',
      authMode: 'apikey', rateLimits: { requestsPerMin: 50 }, secret,
    });
    expect(rec.applicationId).toBe('PARTNER1');
    // Public projection must not leak the secret hash/salt.
    expect(rec.secret.hash).toBeUndefined();
    expect(rec.secret.fingerprint).toBe(secret.fingerprint);

    const readBack = await getApplication(env, 'partner1');
    expect(readBack.displayName).toBe('Partner One');
    expect(readBack.rateLimits.requestsPerMin).toBe(50);
  });

  it('updates an application', async () => {
    const env = { CORE_KV: mockKV() };
    await registerApplication(env, { applicationId: 'partner2', displayName: 'P2' });
    const updated = await updateApplication(env, 'partner2', { displayName: 'P2 renamed', status: 'suspended' });
    expect(updated.displayName).toBe('P2 renamed');
    expect(updated.status).toBe('suspended');
  });

  it('exposes AUTH_MODES including prepared schemes', () => {
    expect(AUTH_MODES).toEqual(expect.arrayContaining(['internal', 'apikey', 'jwt', 'hmac', 'mtls', 'bearer']));
  });
});
